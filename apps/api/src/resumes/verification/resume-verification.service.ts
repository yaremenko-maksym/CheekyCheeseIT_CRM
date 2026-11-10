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
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  RESUME_TEMPLATE_NAMES,
  normalizeResumeLayout,
  resumeContentSchema,
  resumeFactsSchema,
  resumeStagedEditedPathsSchema,
  resumeVerificationErrorCodeSchema,
  resumeVerificationReportSchema,
  type ResumeFacts,
  type ResumeLayoutOptions,
  type ResumeTemplateName,
  type SeniorResumeDto,
} from '@crm/shared'
import { apiError } from '../../common/api-error'
import { DatabaseService } from '../../database/database.service'
import { seniorResumes, teamMembers, type SeniorResume } from '../../database/schema'
import { S3Service } from '../../documents/s3.service'
import { resolveTemplateName } from '../resume-typst.service'
import { contentToFacts } from './derive-content'

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

/** Clearing the staged columns: four NULLs and an empty edited-paths list. */
const CLEARED_STAGED = {
  stagedContent: null,
  stagedLayout: null,
  stagedTemplateName: null,
  stagedPdfS3Key: null,
  stagedEditedPaths: [],
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
  // Stryker disable next-line MethodExpression: equivalent — only the first least-used name is read, and a whole catalog after the tail repeats names already met
  const order = [...RESUME_TEMPLATE_NAMES.slice(start), ...RESUME_TEMPLATE_NAMES.slice(0, start)]
  const least = Math.min(...order.map((name) => counts[name] ?? 0))
  return order.find((name) => (counts[name] ?? 0) === least) ?? 'classic'
}

@Injectable()
export class ResumeVerificationService {
  private readonly logger = new Logger(ResumeVerificationService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
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
    const sameStatus = eq(seniorResumes.verificationStatus, row.verificationStatus)
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
      .where(and(draftWriteGuard(row), sameStatus))
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
  async deleteStagedObject(key: string | null): Promise<void> {
    if (!key) return
    try {
      await this.s3.delete(key)
    } catch {
      this.logger.warn(`Staged resume PDF not deleted: ${key}`)
    }
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
