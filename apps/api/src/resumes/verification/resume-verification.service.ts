/**
 * ResumeVerificationService — the verification half of a senior resume
 * (verified base resume, spec §3/§4/§8): the facts write, the template write,
 * the status rule every write obeys, and the DTO fields.
 *
 * One-way DI (ruling P6): SeniorResumesService injects this service and keeps
 * RBAC (`assertAccess`) and the render queue; nothing here calls back into it.
 * Methods take an already-authorised row and return the updated row.
 *
 * The status rule (Task 13):
 *   - busy (QUEUED / CHECKING, or VERIFIED with a template run in flight) →
 *     409 RESUME_VERIFICATION_BUSY, row unchanged. The check sits in each
 *     UPDATE's WHERE, so it cannot race a run starting between read and write.
 *   - facts / content / extraction result → bump `version`, DRAFT, staged
 *     columns cleared (their object deleted after commit).
 *   - layout / template on VERIFIED → a template run starts (P1: start UPDATE
 *     only, the runner is Task 16); live look and status stay.
 *   - layout / template on AWAITING_CONFIRM → DRAFT + the staged cleanup.
 *   - layout / template on DRAFT / FAILED → written, `version` bumped.
 */
import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  RESUME_LIMITS,
  RESUME_TEMPLATE_NAMES,
  checkResumeCompleteness,
  isLatinScript,
  normalizeResumeLayout,
  resumeContentSchema,
  resumeFactsSchema,
  resumeStagedEditedPathsSchema,
  resumeVerificationErrorCodeSchema,
  resumeVerificationReportSchema,
  type ConfirmResumeInput,
  type EditStagedFieldInput,
  type RegenerateStagedFieldInput,
  type ResumeContent,
  type ResumeFacts,
  type ResumeLayoutOptions,
  type ResumeTemplateName,
  type SeniorResumeDto,
} from '@crm/shared'
import { apiError } from '../../common/api-error'
import { DatabaseService } from '../../database/database.service'
import { S3Service } from '../../documents/s3.service'
import { seniorResumes, teamMembers, type SeniorResume } from '../../database/schema'
import { resolveTemplateName } from '../resume-typst.service'
import { hasContact } from './content-gates'
import { contentToFacts } from './derive-content'
import {
  CLEARED_STAGED,
  deleteStagedQuietly,
  loadOwnerContacts,
  regenerateTarget,
  VerificationRunner,
} from './verification-runner'

/** An extraction in flight owns the row's facts (P5a). */
const EXTRACTION_BUSY: SeniorResume['status'][] = ['QUEUED', 'RUNNING']

type VerificationDtoFields = Pick<
  SeniorResumeDto,
  | 'facts'
  | 'verificationStatus'
  | 'verificationErrorCode'
  | 'verificationReport'
  | 'verifiedVersion'
  | 'verifiedAt'
  | 'verifiedByName'
  | 'staged'
  | 'verificationBusy'
>

/**
 * An edit path (P10): `summary` or `experience.<i>.bullets.<j>`, in bounds of `content`. Returns
 * the text cap of that path (P8), or `null` when the path names no staged text.
 */
export function editPathCap(path: string, content: ResumeContent): number | null {
  if (path === 'summary') return RESUME_LIMITS.summary
  const bullet = /^experience\.(\d+)\.bullets\.(\d+)$/u.exec(path)
  if (!bullet) return null
  const bullets = content.experience[Number(bullet[1])]?.bullets
  return bullets !== undefined && Number(bullet[2]) < bullets.length ? RESUME_LIMITS.bullet : null
}

/** A regenerate path (P10): `summary` or `experience.<i>.bullets`, in bounds of `content`. */
export function isRegeneratePath(path: string, content: ResumeContent): boolean {
  const target = regenerateTarget(path)
  return target === 'summary' || (target !== null && target < content.experience.length)
}

/** `content` with the text at a valid edit path replaced. */
function withText(content: ResumeContent, path: string, text: string): ResumeContent {
  if (path === 'summary') return { ...content, summary: text }
  const [, i, , j] = path.split('.').map(Number)
  return {
    ...content,
    experience: content.experience.map((item, at) =>
      at === i ? { ...item, bullets: item.bullets.map((b, k) => (k === j ? text : b)) } : item,
    ),
  }
}

/** True while a run owns the row: every write answers 409 then. */
export function isVerificationBusy(
  row: Pick<SeniorResume, 'verificationStatus' | 'verificationRunId'>,
): boolean {
  if (row.verificationStatus === 'QUEUED' || row.verificationStatus === 'CHECKING') return true
  // A VERIFIED row holds a run id only while a template run is in flight (Task 16).
  return row.verificationStatus === 'VERIFIED' && row.verificationRunId !== null
}

/** SQL twin of `!isVerificationBusy(row)`, for a write's WHERE. */
export function notVerificationBusy(): SQL {
  return and(
    notInArray(seniorResumes.verificationStatus, ['QUEUED', 'CHECKING']),
    sql`(${ne(seniorResumes.verificationStatus, 'VERIFIED')} OR ${isNull(seniorResumes.verificationRunId)})`,
  ) as SQL
}

/**
 * The guard of a write that resets to DRAFT: the row is not busy and still
 * holds the staged key we read, so the object deleted after commit is exactly
 * the one this UPDATE unlinked (a run landing in between makes it 0 rows).
 */
export function draftWriteGuard(row: Pick<SeniorResume, 'id' | 'stagedPdfS3Key'>): SQL {
  return and(
    eq(seniorResumes.id, row.id),
    notVerificationBusy(),
    sql`${seniorResumes.stagedPdfS3Key} IS NOT DISTINCT FROM ${row.stagedPdfS3Key}`,
  ) as SQL
}

/**
 * The guard of a layout/template write: `draftWriteGuard` plus a compare-and-set
 * on the status that chose the branch, so a row that moved in between is a miss.
 */
export function lookWriteGuard(
  row: Pick<SeniorResume, 'id' | 'stagedPdfS3Key' | 'verificationStatus'>,
): SQL {
  return and(
    draftWriteGuard(row),
    eq(seniorResumes.verificationStatus, row.verificationStatus),
  ) as SQL
}

/** Back to DRAFT: version bumped, run fields and staged columns cleared. */
export function draftReset() {
  return {
    version: sql`${seniorResumes.version} + 1`,
    verificationStatus: 'DRAFT' as const,
    verificationRunId: null,
    verificationKind: null,
    verificationTargetPath: null,
    verificationBaseVersion: null,
    verificationQueuedAt: null,
    verificationStartedAt: null,
    verificationErrorCode: null,
    verificationReport: null,
    ...CLEARED_STAGED,
  }
}

/**
 * The template for a new resume: the catalog name least used among the
 * senior's team members, ties broken by `sha256(userId) mod 4` (spec §6) —
 * the walk starts at that catalog index, so neighbours differ deterministically.
 */
export function pickTemplateName(
  counts: Partial<Record<ResumeTemplateName, number>>,
  userId: string,
): ResumeTemplateName {
  const hash = createHash('sha256').update(userId).digest('hex')
  const start = Number(BigInt(`0x${hash}`) % BigInt(RESUME_TEMPLATE_NAMES.length))
  const order = [
    ...RESUME_TEMPLATE_NAMES.slice(start),
    // Stryker disable next-line MethodExpression: equivalent — only the first least-used name is read, and a whole catalog after the tail repeats names already met
    ...RESUME_TEMPLATE_NAMES.slice(0, start),
  ]
  const least = Math.min(...order.map((name) => counts[name] ?? 0))
  return order.find((name) => (counts[name] ?? 0) === least) ?? 'classic'
}

@Injectable()
export class ResumeVerificationService {
  private readonly logger = new Logger(ResumeVerificationService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly runner: VerificationRunner,
  ) {}

  /** PUT facts: bump `version`, DRAFT, staged cleared; also disowns an extraction in flight. */
  async saveFacts(row: SeniorResume, facts: ResumeFacts, viewerId: string): Promise<SeniorResume> {
    const validated = resumeFactsSchema.parse(facts)
    const [updated] = await this.db.db
      .update(seniorResumes)
      .set({
        facts: validated,
        ...draftReset(),
        // Same as a manual content save: the human decided, so a model that
        // started earlier must not land its facts on top of this a moment later.
        status: 'READY',
        errorCode: null,
        errorMessage: null,
        quotaResetsAt: null,
        extractionStartedAt: null,
        extractionRunId: null,
        updatedByUserId: viewerId,
        updatedAt: new Date(),
      })
      .where(draftWriteGuard(row))
      .returning()
    if (!updated) return this.resolveMiss(row.id)
    await this.deleteStagedObject(row.stagedPdfS3Key)
    return updated
  }

  /** PUT template — the status rule for a look change, see `writeLook`. */
  setTemplate(row: SeniorResume, name: ResumeTemplateName, viewerId: string) {
    return this.writeLook(row, { templateName: name }, viewerId)
  }

  /** PUT layout — the status rule for a look change, see `writeLook`. */
  setLayout(row: SeniorResume, layout: ResumeLayoutOptions, viewerId: string) {
    return this.writeLook(row, { layout: normalizeResumeLayout(layout) }, viewerId)
  }

  /**
   * A layout or template write. The UPDATE is a compare-and-set on the status
   * that chose the branch; a row that moved in between answers 409.
   * Returns the row; on VERIFIED the live look is unchanged (nothing to render).
   */
  private async writeLook(
    row: SeniorResume,
    look: { layout?: ResumeLayoutOptions; templateName?: ResumeTemplateName },
    viewerId: string,
  ): Promise<SeniorResume> {
    const stamp = { updatedByUserId: viewerId, updatedAt: new Date() }
    let set: PgUpdateSetSource<typeof seniorResumes>
    if (row.verificationStatus === 'VERIFIED') {
      // P1: start a template run into the staged columns; the runner is Task 16.
      // Writing the live look here would break `verified_version = version`.
      set = {
        verificationRunId: randomUUID(),
        verificationKind: 'template',
        verificationBaseVersion: sql`${seniorResumes.version}`,
        verificationQueuedAt: new Date(),
        verificationStartedAt: null,
        verificationErrorCode: null,
        verificationReport: null,
        stagedContent: sql`${seniorResumes.content}`,
        stagedLayout: look.layout ?? normalizeResumeLayout(row.layout ?? DEFAULT_RESUME_LAYOUT),
        stagedTemplateName: look.templateName ?? resolveTemplateName(row.templateName),
        ...stamp,
      }
    } else if (row.verificationStatus === 'AWAITING_CONFIRM') {
      // The staged PDF was rendered with the old look: discard it.
      set = { ...look, ...draftReset(), ...stamp }
    } else {
      set = { ...look, version: sql`${seniorResumes.version} + 1`, ...stamp }
    }

    const [updated] = await this.db.db
      .update(seniorResumes)
      .set(set)
      .where(lookWriteGuard(row))
      .returning()
    if (!updated) return this.resolveMiss(row.id)
    if (row.verificationStatus === 'AWAITING_CONFIRM') {
      await this.deleteStagedObject(row.stagedPdfS3Key)
    }
    return updated
  }

  /**
   * A guarded UPDATE matched nothing: 404 when the row is gone, else 409 —
   * a run owns it (or started between our read and our write).
   */
  async resolveMiss(resumeId: string): Promise<never> {
    const [row] = await this.db.db
      .select({ id: seniorResumes.id })
      .from(seniorResumes)
      .where(eq(seniorResumes.id, resumeId))
      .limit(1)
    if (!row) throw new NotFoundException('Резюме не найдено')
    throw apiError('RESUME_VERIFICATION_BUSY', HttpStatus.CONFLICT)
  }

  /** After commit. A failure is logged (key only) and never fails the request. */
  deleteStagedObject(key: string | null): Promise<void> {
    return deleteStagedQuietly(this.s3, this.logger, key)
  }

  /**
   * POST submit (202): from DRAFT, FAILED or AWAITING_CONFIRM, queue a full check run and start it off
   * the request path. 422 for a custom template or incomplete facts (P7: no issue list), 409 while a
   * check or an extraction runs (P5a). From AWAITING_CONFIRM the old staged object goes after commit.
   */
  async submit(row: SeniorResume, displayName: string, viewerId: string): Promise<SeniorResume> {
    if (row.templateSource !== null) {
      throw apiError('RESUME_CUSTOM_TEMPLATE', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    if (isVerificationBusy(row) || EXTRACTION_BUSY.includes(row.status)) {
      throw apiError('RESUME_VERIFICATION_BUSY', HttpStatus.CONFLICT)
    }
    const facts = this.factsOf(row)
    if (checkResumeCompleteness(facts, { displayName, now: new Date() }).length > 0) {
      throw apiError('RESUME_INCOMPLETE', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    const runId = randomUUID()
    const [updated] = await this.db.db
      .update(seniorResumes)
      .set({
        // Stored as checked: a legacy row's mapped facts become its facts, unchanged.
        facts,
        verificationStatus: 'QUEUED',
        verificationRunId: runId,
        verificationKind: 'full',
        verificationTargetPath: null,
        verificationBaseVersion: sql`${seniorResumes.version}`,
        verificationQueuedAt: new Date(),
        verificationStartedAt: null,
        verificationErrorCode: null,
        verificationReport: null,
        ...CLEARED_STAGED,
        updatedByUserId: viewerId,
        updatedAt: new Date(),
      })
      .where(
        and(
          draftWriteGuard(row),
          inArray(seniorResumes.verificationStatus, ['DRAFT', 'FAILED', 'AWAITING_CONFIRM']),
          notInArray(seniorResumes.status, EXTRACTION_BUSY),
          isNull(seniorResumes.templateSource),
          eq(seniorResumes.version, row.version),
        ),
      )
      .returning()
    if (!updated) return this.resolveMiss(row.id)
    await this.deleteStagedObject(row.stagedPdfS3Key)
    void this.runner.run(row.id, runId)
    return updated
  }

  /**
   * POST confirm (ADMIN/HR; the caller checks the role). One compare-and-set UPDATE on the run id,
   * the version, AWAITING_CONFIRM and no custom template promotes the staged result to the live
   * columns and sets VERIFIED with `verified_version` = the new version. `pdfFingerprint` is the
   * caller's fingerprint of the promoted render input (P11): the live PDF endpoint then serves the
   * checked PDF instead of re-rendering it. A miss is 409 RESUME_CONFIRM_STALE. The replaced live
   * PDF object goes after commit.
   */
  async confirm(
    row: SeniorResume,
    input: ConfirmResumeInput,
    viewerId: string,
    pdfFingerprint: string,
  ): Promise<SeniorResume> {
    // The fingerprint was taken from this read, so it must be the staged result being confirmed.
    if (row.verificationStatus !== 'AWAITING_CONFIRM' || row.verificationRunId !== input.runId) {
      throw apiError('RESUME_CONFIRM_STALE', HttpStatus.CONFLICT)
    }
    const now = new Date()
    const result = await this.db.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ key: seniorResumes.pdfS3Key })
        .from(seniorResumes)
        .where(eq(seniorResumes.id, row.id))
        .for('update')
      // Every right-hand side reads the pre-update row, so both versions get version + 1.
      const [won] = await tx
        .update(seniorResumes)
        .set({
          content: sql`${seniorResumes.stagedContent}`,
          layout: sql`${seniorResumes.stagedLayout}`,
          templateName: sql`${seniorResumes.stagedTemplateName}`,
          pdfS3Key: sql`${seniorResumes.stagedPdfS3Key}`,
          pdfFingerprint,
          pdfRenderStatus: 'READY',
          pdfRenderError: null,
          pdfRenderRunId: null,
          pdfRenderStartedAt: null,
          version: sql`${seniorResumes.version} + 1`,
          verifiedVersion: sql`${seniorResumes.version} + 1`,
          verifiedAt: now,
          verifiedByUserId: viewerId,
          verificationStatus: 'VERIFIED',
          verificationRunId: null,
          verificationKind: null,
          verificationTargetPath: null,
          verificationBaseVersion: null,
          verificationQueuedAt: null,
          verificationStartedAt: null,
          verificationErrorCode: null,
          ...CLEARED_STAGED,
          updatedByUserId: viewerId,
          updatedAt: now,
        })
        .where(
          and(
            eq(seniorResumes.id, row.id),
            eq(seniorResumes.verificationRunId, input.runId),
            eq(seniorResumes.version, input.version),
            eq(seniorResumes.verificationStatus, 'AWAITING_CONFIRM'),
            isNull(seniorResumes.templateSource),
          ),
        )
        .returning()
      return won ? { row: won, old: current?.key ?? null } : null
    })
    if (!result) throw apiError('RESUME_CONFIRM_STALE', HttpStatus.CONFLICT)
    await this.deleteStagedObject(result.old)
    return result.row
  }

  /**
   * PUT staged: a person rewrites one staged text (P10 edit path, P8 cap). The text must be Latin
   * and hold no contact of the senior, else 422 RESUME_STAGED_TEXT_INVALID with the reason only
   * (P7: the matched text is never echoed). A `staged-edit` run then re-checks the staged result
   * without the writer and entailment gates; the path is recorded in `staged_edited_paths`.
   */
  async editStagedField(
    row: SeniorResume,
    input: EditStagedFieldInput,
    viewerId: string,
  ): Promise<SeniorResume> {
    const staged = this.stagedOf(row, input.runId)
    const cap = editPathCap(input.path, staged)
    if (cap === null || input.text.length > cap) throw new BadRequestException()
    if (!isLatinScript(input.text)) {
      throw apiError('RESUME_STAGED_TEXT_INVALID', HttpStatus.UNPROCESSABLE_ENTITY, {
        reason: 'NON_LATIN',
      })
    }
    const owner = await loadOwnerContacts(this.db, row.userId)
    if (hasContact(input.text, owner?.contacts ?? [])) {
      throw apiError('RESUME_STAGED_TEXT_INVALID', HttpStatus.UNPROCESSABLE_ENTITY, {
        reason: 'CONTACT_IN_TEXT',
      })
    }
    const edited = this.editedPathsOf(row).filter((e) => e.path !== input.path)
    return this.startStagedRun(row, input.runId, 'staged-edit', input.path, {
      stagedContent: withText(staged, input.path, input.text),
      stagedEditedPaths: [...edited, { path: input.path, userId: viewerId }],
    })
  }

  /**
   * POST staged/regenerate: an `item` run rewrites one staged path (`summary` or
   * `experience.<i>.bullets`) and keeps the other staged texts. Every human edit under the path
   * leaves `staged_edited_paths`: the model text replaces it.
   */
  async regenerateStagedField(
    row: SeniorResume,
    input: RegenerateStagedFieldInput,
  ): Promise<SeniorResume> {
    const staged = this.stagedOf(row, input.runId)
    if (!isRegeneratePath(input.path, staged)) throw new BadRequestException()
    return this.startStagedRun(row, input.runId, 'item', input.path, {
      stagedEditedPaths: this.editedPathsOf(row).filter(
        (e) => e.path !== input.path && !e.path.startsWith(`${input.path}.`),
      ),
    })
  }

  /**
   * The staged content of the run the caller saw. Staged columns change only with the run id, so
   * a patch computed from this read is exact once the start UPDATE matches the same run id.
   */
  private stagedOf(row: SeniorResume, runId: string): ResumeContent {
    if (row.verificationStatus !== 'AWAITING_CONFIRM' || row.verificationRunId !== runId) {
      throw apiError('RESUME_CONFIRM_STALE', HttpStatus.CONFLICT)
    }
    const staged = resumeContentSchema.safeParse(row.stagedContent)
    if (!staged.success) throw apiError('RESUME_CONFIRM_STALE', HttpStatus.CONFLICT)
    return staged.data
  }

  private editedPathsOf(row: SeniorResume) {
    return resumeStagedEditedPathsSchema.safeParse(row.stagedEditedPaths).data ?? []
  }

  /**
   * The start UPDATE of a staged-edit or item run, like submit's: QUEUED with a new run id, the
   * kind, the target path and `base_version = version`. It matches the run id the caller saw and
   * AWAITING_CONFIRM (0 rows → 409 RESUME_CONFIRM_STALE). The staged PDF stays until stage 9
   * replaces it, so the last one is still shown. The run starts off the request path.
   */
  private async startStagedRun(
    row: SeniorResume,
    seenRunId: string,
    kind: 'staged-edit' | 'item',
    path: string,
    staged: PgUpdateSetSource<typeof seniorResumes>,
  ): Promise<SeniorResume> {
    const runId = randomUUID()
    const [updated] = await this.db.db
      .update(seniorResumes)
      .set({
        ...staged,
        verificationStatus: 'QUEUED',
        verificationRunId: runId,
        verificationKind: kind,
        verificationTargetPath: path,
        verificationBaseVersion: sql`${seniorResumes.version}`,
        verificationQueuedAt: new Date(),
        verificationStartedAt: null,
        verificationErrorCode: null,
      })
      .where(
        and(
          eq(seniorResumes.id, row.id),
          eq(seniorResumes.verificationRunId, seenRunId),
          eq(seniorResumes.verificationStatus, 'AWAITING_CONFIRM'),
        ),
      )
      .returning()
    if (!updated) throw apiError('RESUME_CONFIRM_STALE', HttpStatus.CONFLICT)
    void this.runner.run(row.id, runId)
    return updated
  }

  /** Template for a new resume (spec §6), from the senior's active team members. */
  async templateForNewResume(userId: string): Promise<ResumeTemplateName> {
    const peers = this.db.db
      .selectDistinct({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(
        and(
          isNull(teamMembers.leftAt),
          ne(teamMembers.userId, userId),
          inArray(
            teamMembers.teamId,
            this.db.db
              .select({ teamId: teamMembers.teamId })
              .from(teamMembers)
              .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt))),
          ),
        ),
      )
    const rows = await this.db.db
      .select({ templateName: seniorResumes.templateName })
      .from(seniorResumes)
      .where(inArray(seniorResumes.userId, peers))
    const counts: Partial<Record<ResumeTemplateName, number>> = {}
    for (const { templateName } of rows) {
      const name = resolveTemplateName(templateName)
      counts[name] = (counts[name] ?? 0) + 1
    }
    return pickTemplateName(counts, userId)
  }

  /** The verification fields of the DTO. Reads never write. */
  async toDtoFields(row: SeniorResume): Promise<VerificationDtoFields> {
    const verifier = row.verifiedByUserId
      ? await this.db.db.query.users.findFirst({
          where: (tbl, { eq: equals }) => equals(tbl.id, row.verifiedByUserId as string),
          columns: { displayName: true },
        })
      : undefined
    const runId = row.verificationRunId
    return {
      facts: this.factsOf(row),
      verificationStatus: row.verificationStatus,
      verificationErrorCode:
        resumeVerificationErrorCodeSchema.safeParse(row.verificationErrorCode).data ?? null,
      verificationReport:
        resumeVerificationReportSchema.safeParse(row.verificationReport).data ?? null,
      verifiedVersion: row.verifiedVersion,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      verifiedByName: verifier?.displayName ?? null,
      // P4: only a staged PDF makes a confirm step; a template run shows none.
      staged:
        row.stagedPdfS3Key !== null && runId !== null
          ? {
              runId,
              content:
                resumeContentSchema.safeParse(row.stagedContent).data ?? EMPTY_RESUME_CONTENT,
              layout: normalizeResumeLayout(row.stagedLayout ?? DEFAULT_RESUME_LAYOUT),
              templateName: resolveTemplateName(row.stagedTemplateName),
              pdfAvailable: true,
              editedPaths:
                resumeStagedEditedPathsSchema.safeParse(row.stagedEditedPaths).data ?? [],
            }
          : null,
      verificationBusy: isVerificationBusy(row),
    }
  }

  /** Stored facts, or — for a legacy row never saved since — mapped from content. */
  private factsOf(row: SeniorResume): ResumeFacts {
    if (row.facts !== null) {
      const parsed = resumeFactsSchema.safeParse(row.facts)
      if (parsed.success) return parsed.data
      this.logger.warn('Stored resume facts failed validation — mapping from content')
    }
    return contentToFacts(resumeContentSchema.safeParse(row.content).data ?? EMPTY_RESUME_CONTENT)
  }
}
