/**
 * How a verification run ends when it does not pass: the FAILED write, or a quiet stop once the run
 * no longer owns its row (CD-3). Moved out of the runner so the runner stays one screenful per stage.
 */
import type { Logger } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import type { ResumeVerificationErrorCode, ResumeVerificationReport } from '@crm/shared'
import type { DatabaseService } from '../../database/database.service'
import { seniorResumes } from '../../database/schema'
import type { S3Service } from '../../documents/s3.service'
import { CLEARED_RUN, CLEARED_STAGED, deleteStagedQuietly, storedFallbacks } from './run-columns'

type RunEndDeps = { db: DatabaseService; s3: Pick<S3Service, 'delete'>; logger: Logger }

/**
 * Thrown before a model call when the row was deleted, swept or given to another run (CD-3). The run
 * stops without a FAILED write: the row is not its own any more. Model calls all come before the
 * run's upload, so there is no object of its own to delete either.
 */
export class RunLost extends Error {}

/** True while `runId` still owns the row: the read before every model call (CD-3). */
export async function ownsRun(db: DatabaseService, resumeId: string, runId: string) {
  const [row] = await db.db
    .select({ id: seniorResumes.id })
    .from(seniorResumes)
    .where(and(eq(seniorResumes.id, resumeId), eq(seniorResumes.verificationRunId, runId)))
  return row !== undefined
}

/**
 * FAILED on this run id: run fields and staged columns cleared, the old object deleted after commit.
 * A template run keeps VERIFIED and the live columns (Task 16): its CAS also needs the base version.
 */
export async function failRun(
  deps: RunEndDeps,
  resumeId: string,
  runId: string,
  code: ResumeVerificationErrorCode,
  report: ResumeVerificationReport,
): Promise<{ old: string | null; live: string | null } | null> {
  const won = await deps.db.db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        key: seniorResumes.stagedPdfS3Key,
        kind: seniorResumes.verificationKind,
        live: seniorResumes.pdfS3Key,
        report: seniorResumes.verificationReport,
      })
      .from(seniorResumes)
      .where(eq(seniorResumes.id, resumeId))
      .for('update')
    const template = current?.kind === 'template'
    const [updated] = await tx
      .update(seniorResumes)
      .set({
        ...(template ? {} : { verificationStatus: 'FAILED' as const }),
        verificationErrorCode: code,
        // CD-6: a template row stays VERIFIED, so it keeps the confirmed run's fallbacks.
        verificationReport: template
          ? { ...report, fallbacks: storedFallbacks(current.report) }
          : report,
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
    return updated ? { old: current?.key ?? null, live: current?.live ?? null } : null
  })
  if (won !== null) await deleteStagedQuietly(deps.s3, deps.logger, won.old)
  return won
}
