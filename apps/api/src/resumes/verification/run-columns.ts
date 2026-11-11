import type { Logger } from '@nestjs/common'
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
