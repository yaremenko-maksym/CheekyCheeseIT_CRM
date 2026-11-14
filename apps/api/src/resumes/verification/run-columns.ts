import { createHash } from 'node:crypto'
import type { Logger } from '@nestjs/common'
import { z } from 'zod'
import { resumeVerificationReportSchema } from '@crm/shared'
import type { S3Service } from '../../documents/s3.service'

/** Clearing the staged columns: four NULLs and an empty edited-paths list. */
export const CLEARED_STAGED = {
  stagedContent: null,
  stagedLayout: null,
  stagedTemplateName: null,
  stagedPdfS3Key: null,
  stagedEditedPaths: [],
}

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
