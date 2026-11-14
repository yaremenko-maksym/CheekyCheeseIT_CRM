import { createHash } from 'node:crypto'
import type { Logger } from '@nestjs/common'
import { z } from 'zod'
import {
  resumeVerificationReportSchema,
  type ResumeContent,
  type ResumeLayoutOptions,
  type ResumeVerificationReport,
} from '@crm/shared'
import type { S3Service } from '../../documents/s3.service'

/** Clearing the staged columns: NULLs, an empty edited-paths list and no snapshot. */
export const CLEARED_STAGED = {
  stagedContent: null,
  stagedLayout: null,
  stagedTemplateName: null,
  stagedPdfS3Key: null,
  stagedEditedPaths: [],
  stagedPrevious: null,
}

/** The run codes no content, render, fact or ATS gate produced: a provider or the run budget. */
export const INFRA_CODES: ReadonlySet<string> = new Set([
  'VISUAL_CHECK_UNAVAILABLE',
  'WRITER_UNAVAILABLE',
  'ENTAILMENT_UNAVAILABLE',
  'STALLED',
])

/**
 * Where a run failure came from, for the log only (FR-A-2): the provider route or model, the coded
 * reason it answered and its HTTP status. Never a message: a provider message can echo the input.
 */
export type RunOrigin = { provider: string | null; reason: string; status?: number }

type StagedRow = {
  stagedContent: unknown
  stagedLayout: unknown
  stagedTemplateName: string | null
  stagedPdfS3Key: string | null
  stagedEditedPaths: unknown
  verificationRunId: string | null
  verificationKind: string | null
  verificationTargetPath: string | null
  verificationBaseVersion: number | null
  verificationReport: unknown
}

/**
 * The AWAITING_CONFIRM result a staged run replaces (FR-A-2): the staged columns plus the run fields
 * and report the confirm reads. It is restored whole, so checked text always goes with its own PDF.
 */
export const stagedSnapshot = (row: StagedRow) => ({
  content: row.stagedContent,
  layout: row.stagedLayout,
  templateName: row.stagedTemplateName,
  pdfKey: row.stagedPdfS3Key,
  editedPaths: row.stagedEditedPaths,
  runId: row.verificationRunId,
  kind: row.verificationKind,
  targetPath: row.verificationTargetPath,
  baseVersion: row.verificationBaseVersion,
  report: row.verificationReport,
})

const isObject = (v: unknown) => typeof v === 'object' && v !== null
const snapshotSchema = z.object({
  // A kept result is a staged one: content, a PDF and the run the confirm names. The parts are
  // stored as the run wrote them, so they go back as they are.
  content: z.custom<ResumeContent>(isObject),
  layout: z.custom<ResumeLayoutOptions | null>((v) => v === null || isObject(v)),
  templateName: z.string().nullable(),
  pdfKey: z.string(),
  editedPaths: z.custom<{ path: string; userId: string }[]>(Array.isArray),
  runId: z.string(),
  kind: z.string().nullable(),
  targetPath: z.string().nullable(),
  baseVersion: z.number().int().nullable(),
  report: z.custom<(ResumeVerificationReport & { ownerKey?: string }) | null>(
    (v) => v === null || isObject(v),
  ),
})
export type StagedSnapshot = z.infer<typeof snapshotSchema>

/** A stored snapshot, or null when there is none or it is unreadable (then nothing is restored). */
export const readSnapshot = (stored: unknown): StagedSnapshot | null =>
  snapshotSchema.safeParse(stored).data ?? null

/** The columns that put a snapshot back, all of them at once. */
export const restoredColumns = (s: StagedSnapshot) => ({
  verificationRunId: s.runId,
  verificationKind: s.kind,
  verificationTargetPath: s.targetPath,
  verificationBaseVersion: s.baseVersion,
  verificationReport: s.report,
  stagedContent: s.content,
  stagedLayout: s.layout,
  stagedTemplateName: s.templateName,
  stagedPdfS3Key: s.pdfKey,
  stagedEditedPaths: s.editedPaths,
  stagedPrevious: null,
})

/** Clearing the run fields a terminal write ends: the row is no longer owned by a run. */
export const CLEARED_RUN = {
  verificationRunId: null,
  verificationKind: null,
  verificationTargetPath: null,
  verificationBaseVersion: null,
}

/** Where a run's staged PDF lives: derived from the ids, so a crashed run can still clean up. */
export const stagedPdfKey = (resumeId: string, runId: string): string =>
  `resumes/${resumeId}/staged/${runId}.pdf`

/** A stored report's fallbacks, read through its schema: a malformed report has none (SR-L-4). */
export const storedFallbacks = (report: unknown): string[] =>
  resumeVerificationReportSchema.safeParse(report).data?.fallbacks ?? []

/**
 * The owner part of a staged render input (P11): a hash of the name and email the staged PDF shows.
 * The run stores it in the report; the confirm compares it with the owner it reads, so a profile
 * change between the run and the confirm is stale. A hash keeps a copy of the contacts out of the row.
 */
export const renderOwnerKey = (owner: { displayName: string; email: string }): string =>
  createHash('sha256')
    .update(JSON.stringify([owner.displayName, owner.email]))
    .digest('hex')

/** The owner key a run stored in its report; none on a report from before it (always stale). */
export const storedOwnerKey = (report: unknown): string | null =>
  z.object({ ownerKey: z.string() }).safeParse(report).data?.ownerKey ?? null

/** After commit. A failure is logged (key only) and never fails the caller. */
export async function deleteStagedQuietly(
  s3: Pick<S3Service, 'delete'>,
  logger: Logger,
  key: string | null,
): Promise<void> {
  if (!key) return
  try {
    await s3.delete(key)
  } catch {
    logger.warn(`Staged resume PDF not deleted: ${key}`)
  }
}
