import { Injectable, Logger } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import {
  normalizeResumeLayout,
  resumeContentSchema,
  resumeFactsSchema,
  resumeStagedEditedPathsSchema,
  resumeVerificationReportSchema,
  type ResumeContent,
  type ResumeTemplateName,
  type ResumeVerificationErrorCode,
  type ResumeVerificationReport,
} from '@crm/shared'
import { DatabaseService } from '../../database/database.service'
import { seniorResumes, userEmails, users, type SeniorResume } from '../../database/schema'
import { S3Service } from '../../documents/s3.service'
import { WORKER_ADAPTER_TIMEOUT_MS } from '../../job-sourcing/structuring/model-extraction-wiring'
import { ResumeTextExtractionService } from '../resume-text-extraction.service'
import { resolveTemplateName, ResumeTypstService } from '../resume-typst.service'
import type { ContactContext } from './contact-scan'
import {
  cleanedNotes,
  RunFailure,
  writeGatedContent,
  writeGatedField,
  type ContentDeps,
  type ContentInput,
  type GateResult,
  type WrittenContent,
} from './content-gates'
import { deriveFrozenContent } from './derive-content'
import { ResumeEntailmentClient, ResumeWriterClient, VisualCheckClient } from './inference-clients'
import { renderAccepted, visualGate, type Accepted, type RenderDeps } from './render-gates'
import { CLEARED_RUN, CLEARED_STAGED, deleteStagedQuietly, stagedPdfKey } from './run-columns'
import { claimTemplateRun, promoteTemplateRun, templateContent } from './template-run'

/** A run past this is STALLED, checked before every model call (P2). */
export const VERIFICATION_RUN_BUDGET_MS = 20 * 60_000
/** When a CHECKING row is surely abandoned: the budget, one model call, a minute of slack (Task 16). */
export const VERIFICATION_DEADLINE_MS =
  VERIFICATION_RUN_BUDGET_MS + WORKER_ADAPTER_TIMEOUT_MS + 60_000

export { CLEARED_STAGED, deleteStagedQuietly, stagedPdfKey } from './run-columns'

export type ResumeOwnerContacts = { displayName: string; email: string; contacts: ContactContext[] }

/** Kinds that start from the staged result of an earlier run instead of writing everything anew. */
const FROM_STAGED = new Set<string | null>(['staged-edit', 'item'])
/** Kinds rendered with the staged look; a template run renders the requested one (Task 16). */
const STAGED_LOOK = new Set<string | null>([...FROM_STAGED, 'template'])

/**
 * `summary` → 'summary', `experience.<i>.bullets` → i; anything else → null. Indexes are canonical
 * (no leading zero), so an accepted path has one spelling and exact-string path matching holds.
 */
export function regenerateTarget(path: string | null): 'summary' | number | null {
  if (path === 'summary') return 'summary'
  const item = /^experience\.(0|[1-9]\d*)\.bullets$/u.exec(String(path))
  return item ? Number(item[1]) : null
}

/**
 * The header contacts and one contact context per distinct name (display and legal), each with
 * every email of the user. The one builder of contact contexts for a resume owner.
 */
export async function loadOwnerContacts(
  db: DatabaseService,
  userId: string,
): Promise<ResumeOwnerContacts | null> {
  const [user] = await db.db
    .select({
      displayName: users.displayName,
      email: users.email,
      legalFullName: users.legalFullName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) return null
  const extra = await db.db
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(eq(userEmails.userId, userId))
  const emails = [...new Set([user.email, ...extra.map((e) => e.email)])]
  // A blank name adds no match: namePatterns drops an empty source.
  const names = [...new Set([user.displayName, user.legalFullName])].filter(
    (name): name is string => name !== null,
  )
  return {
    displayName: user.displayName,
    email: user.email,
    contacts: names.map((fullName) => ({ fullName, emails })),
  }
}

/**
 * The check run of a submitted resume (Task 14), off the request path: claim, write and gate the AI
 * fields, render, ATS and layout with repair, the vision check, then stage the PDF for confirmation.
 * Every terminal write is a compare-and-set on `run_id`, so a superseded run writes nothing.
 * Logs carry ids, codes and keys only: never model text, names or emails.
 */
@Injectable()
export class VerificationRunner {
  private readonly logger = new Logger(VerificationRunner.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly typst: ResumeTypstService,
    private readonly extraction: ResumeTextExtractionService,
    private readonly writer: ResumeWriterClient,
    private readonly vision: VisualCheckClient,
    private readonly entailment: ResumeEntailmentClient,
  ) {}

  /** Never rejects: the caller fires it with `void`. An unexpected error ends the run STALLED. */
  async run(resumeId: string, runId: string): Promise<void> {
    try {
      await this.execute(resumeId, runId)
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown'
      this.logger.error(`Verification run ${runId} of resume ${resumeId} crashed (${name})`)
      try {
        await this.fail(resumeId, runId, 'STALLED', { gates: [], fallbacks: [] })
      } catch {
        this.logger.error(`Verification run ${runId} of resume ${resumeId}: FAILED not written`)
      }
      await this.deleteQuietly(stagedPdfKey(resumeId, runId))
    }
  }

  private async execute(resumeId: string, runId: string): Promise<void> {
    const row = await this.claim(resumeId, runId)
    if (!row) return
    const startedAt = Date.now()
    const beforeModelCall = () => {
      if (Date.now() - startedAt > VERIFICATION_RUN_BUDGET_MS) throw new RunFailure('STALLED')
    }
    const gates: GateResult[] = []
    let fallbacks: string[] = []
    try {
      const facts = resumeFactsSchema.safeParse(row.facts)
      if (!facts.success) throw new RunFailure('INCOMPLETE')
      const owner = await this.ownerOf(row.userId)
      const frozen = deriveFrozenContent(facts.data)
      const template = row.verificationKind === 'template'
      // A staged-edit, item or template run renders the staged look.
      const stagedLook = STAGED_LOOK.has(row.verificationKind)
      const templateName = resolveTemplateName(
        stagedLook ? row.stagedTemplateName : row.templateName,
      )

      // A template run re-renders the confirmed content: no writer, no entailment, no content gate.
      let content: ResumeContent
      let locked: string[] = []
      if (template) {
        ;({ content, locked } = templateContent(row))
      } else {
        const written = await this.written(
          row,
          {
            facts: facts.data,
            frozen,
            contacts: owner.contacts,
            template: templateName,
            now: new Date(),
          },
          { writer: this.writer, entailment: this.entailment, beforeModelCall },
        )
        gates.push(written.gate)
        fallbacks = written.fallbacks
        content = written.content
      }

      const notes: ResumeContent = {
        ...frozen,
        experience: frozen.experience.map((item, i) => ({
          ...item,
          // Stryker disable next-line OptionalChaining: equivalent — frozen is derived from facts item by item, so index i exists
          bullets: cleanedNotes(facts.data.experience[i]?.notes ?? []),
        })),
      }
      const deps: RenderDeps = {
        typst: this.typst,
        extraction: this.extraction,
        vision: this.vision,
        beforeModelCall,
      }
      const accepted = await renderAccepted(
        {
          displayName: owner.displayName,
          email: owner.email,
          content,
          layout: normalizeResumeLayout(stagedLook ? row.stagedLayout : row.layout),
          templateName,
          notes,
          fallbacks: [...fallbacks, ...locked],
          editedPaths: (
            resumeStagedEditedPathsSchema.safeParse(row.stagedEditedPaths).data ?? []
          ).map((edit) => edit.path),
        },
        deps,
      )
      gates.push(...accepted.gates)
      // The locked paths are no fallbacks: the report keeps what the confirmed content holds.
      if (!template) fallbacks = accepted.fallbacks
      gates.push(await visualGate(accepted, templateName, owner.contacts, deps))

      const report = { gates, fallbacks }
      if (!template) {
        await this.stage(
          row,
          runId,
          accepted,
          templateName,
          report,
          FROM_STAGED.has(row.verificationKind),
        )
        return
      }
      await promoteTemplateRun(this.templateDeps(), row.id, runId, {
        accepted,
        templateName,
        report,
        owner,
      })
    } catch (err) {
      if (!(err instanceof RunFailure)) throw err
      this.logger.warn(`Verification run ${runId} of resume ${resumeId} failed: ${err.code}`)
      await this.fail(resumeId, runId, err.code, { gates: [...gates, ...err.gates], fallbacks })
    }
  }

  /**
   * Stages 3 and 4 by run kind: `full` writes everything; `item` writes `verification_target_path`
   * only and keeps the other staged texts; `staged-edit` writes nothing (spec §4 step 6: no writer,
   * no entailment). The staged kinds carry the earlier run's fallbacks and content findings forward,
   * except those of `verification_target_path`: that text was just rewritten, by the model or a person.
   */
  private async written(
    row: SeniorResume,
    input: ContentInput,
    deps: ContentDeps,
  ): Promise<WrittenContent> {
    if (!FROM_STAGED.has(row.verificationKind)) return writeGatedContent(input, deps)
    const staged = resumeContentSchema.safeParse(row.stagedContent)
    if (!staged.success) throw new RunFailure('INCOMPLETE')
    const previous = resumeVerificationReportSchema.safeParse(row.verificationReport).data
    const target = row.verificationTargetPath
    const keep = <T extends string | { path: string }>(list: T[]) =>
      list.filter((entry) => (typeof entry === 'string' ? entry : entry.path) !== target)
    let next: { content: ResumeContent; items: GateResult['items']; fallbacks: string[] } = {
      content: staged.data,
      items: [],
      fallbacks: [],
    }
    if (row.verificationKind === 'item') {
      const field = regenerateTarget(target)
      if (field === null) throw new RunFailure('INCOMPLETE')
      const fresh = await writeGatedField(input, deps, field, staged.data)
      next = { content: fresh.content, items: fresh.gate.items, fallbacks: fresh.fallbacks }
    }
    const items = [
      ...keep(previous?.gates.find((g) => g.gate === 'content')?.items ?? []),
      ...next.items,
    ]
    return {
      content: next.content,
      gate: { gate: 'content', ok: items.length === 0, items },
      fallbacks: [...keep(previous?.fallbacks ?? []), ...next.fallbacks],
    }
  }

  /** Stage 1: QUEUED to CHECKING on this run id, else a template run; `undefined` when another run owns the row. */
  private async claim(resumeId: string, runId: string): Promise<SeniorResume | undefined> {
    const own = and(eq(seniorResumes.id, resumeId), eq(seniorResumes.verificationRunId, runId))
    const [row] = await this.db.db
      .update(seniorResumes)
      .set({ verificationStatus: 'CHECKING', verificationStartedAt: new Date() })
      .where(and(own, eq(seniorResumes.verificationStatus, 'QUEUED')))
      .returning()
    return row ?? claimTemplateRun(this.db, own)
  }

  private templateDeps() {
    return { db: this.db, s3: this.s3, typst: this.typst, logger: this.logger }
  }

  private async ownerOf(userId: string): Promise<ResumeOwnerContacts> {
    const owner = await loadOwnerContacts(this.db, userId)
    if (!owner) throw new RunFailure('INCOMPLETE')
    return owner
  }

  /**
   * Stage 9: upload, then a compare-and-set on the run id and on `version = base_version` writes the
   * staged columns. A lost CAS deletes the upload; a won one deletes the object it replaced.
   */
  private async stage(
    row: SeniorResume,
    runId: string,
    accepted: Accepted,
    templateName: ResumeTemplateName,
    report: ResumeVerificationReport,
    keepEditedPaths: boolean,
  ): Promise<void> {
    const key = stagedPdfKey(row.id, runId)
    await this.s3.upload(key, accepted.pdf, 'application/pdf', 'RESUME')
    const replaced = await this.db.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ key: seniorResumes.stagedPdfS3Key })
        .from(seniorResumes)
        .where(eq(seniorResumes.id, row.id))
        .for('update')
      const [won] = await tx
        .update(seniorResumes)
        .set({
          stagedContent: accepted.content,
          stagedLayout: accepted.layout,
          stagedTemplateName: templateName,
          stagedPdfS3Key: key,
          // A staged-edit or item run keeps the record of what a person wrote (Task 15).
          ...(keepEditedPaths ? {} : { stagedEditedPaths: [] }),
          verificationStatus: 'AWAITING_CONFIRM',
          verificationErrorCode: null,
          verificationReport: report,
        })
        .where(
          and(
            eq(seniorResumes.id, row.id),
            eq(seniorResumes.verificationRunId, runId),
            eq(seniorResumes.verificationStatus, 'CHECKING'),
            sql`${seniorResumes.version} = ${seniorResumes.verificationBaseVersion}`,
          ),
        )
        .returning({ id: seniorResumes.id })
      return won ? { old: current?.key ?? null } : null
    })
    if (replaced === null) {
      this.logger.warn(`Verification run ${runId} of resume ${row.id} superseded: ${key} dropped`)
      await this.deleteQuietly(key)
    } else if (replaced.old !== key) {
      await this.deleteQuietly(replaced.old)
    }
  }

  /**
   * FAILED on this run id: run fields and staged columns cleared, the old object deleted after commit.
   * A template run keeps VERIFIED and the live columns (Task 16): its CAS also needs the base version.
   */
  private async fail(
    resumeId: string,
    runId: string,
    code: ResumeVerificationErrorCode,
    report: ResumeVerificationReport,
  ): Promise<void> {
    const old = await this.db.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ key: seniorResumes.stagedPdfS3Key, kind: seniorResumes.verificationKind })
        .from(seniorResumes)
        .where(eq(seniorResumes.id, resumeId))
        .for('update')
      const template = current?.kind === 'template'
      const [won] = await tx
        .update(seniorResumes)
        .set({
          ...(template ? {} : { verificationStatus: 'FAILED' as const }),
          verificationErrorCode: code,
          verificationReport: report,
          ...CLEARED_RUN,
          ...CLEARED_STAGED,
        })
        .where(
          and(
            eq(seniorResumes.id, resumeId),
            eq(seniorResumes.verificationRunId, runId),
            template
              ? sql`${seniorResumes.version} = ${seniorResumes.verificationBaseVersion}`
              : undefined,
          ),
        )
        .returning({ id: seniorResumes.id })
      return won ? (current?.key ?? null) : null
    })
    await this.deleteQuietly(old)
  }

  private deleteQuietly(key: string | null): Promise<void> {
    return deleteStagedQuietly(this.s3, this.logger, key)
  }
}
