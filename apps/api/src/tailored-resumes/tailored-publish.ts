import { randomUUID } from 'node:crypto'
import type { Logger } from '@nestjs/common'
import { and, eq, gte } from 'drizzle-orm'
import type { ResumeTemplateName, TailoredVerification } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { seniorResumes, tailoredResumes } from '../database/schema'
import type { S3Service } from '../documents/s3.service'
import type { Accepted } from '../resumes/verification/render-gates'
import { deleteStagedQuietly } from '../resumes/verification/run-columns'
import { runPdfKey } from './tailored-keys'
import { TAILORED_RUN_DEADLINE_MS } from './tailored-run'

export type RunResult = {
  accepted: Accepted
  coverLetter: string
  verification: TailoredVerification
  baseResumeId: string
  baseVersion: number
  opportunityRevision: number
  templateName: ResumeTemplateName
}

export type PublishDeps = {
  db: DatabaseService['db']
  s3: Pick<S3Service, 'upload' | 'delete'>
  logger: Logger
  /** The clock the run deadline is measured on (the sweep's `isStalled` uses the same rule). */
  now?: () => Date
}

export type PublishOutcome = 'PUBLISHED' | 'LOST' | 'BASE_CHANGED'

/**
 * The run's end (spec §8): the PDF uploaded under the run's own key first, then one transaction —
 * the row locked and compare-and-set on this run id, RUNNING and within the run deadline (SR-L-1:
 * past it the sweep may already have reaped the run and the orphan sweep its object); the base
 * row `FOR SHARE`, still VERIFIED at the run's version, else BASE_CHANGED with nothing published.
 * The previous PDF is deleted only after the commit; LOST and BASE_CHANGED delete the run's own.
 */
export async function publishRun(
  deps: PublishDeps,
  p: { rowId: string; runId: string; runBaseVersion: number; result: RunResult },
): Promise<PublishOutcome> {
  const key = runPdfKey(p.rowId, p.runId)
  const { result } = p
  await deps.s3.upload(key, result.accepted.pdf, 'application/pdf', 'RESUME')
  const now = deps.now?.() ?? new Date()
  const oldest = new Date(now.getTime() - TAILORED_RUN_DEADLINE_MS)

  const outcome = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        pdfS3Key: tailoredResumes.pdfS3Key,
        requestedBy: tailoredResumes.runRequestedByUserId,
      })
      .from(tailoredResumes)
      .where(
        and(
          eq(tailoredResumes.id, p.rowId),
          eq(tailoredResumes.runId, p.runId),
          eq(tailoredResumes.runStatus, 'RUNNING'),
          gte(tailoredResumes.runStartedAt, oldest),
        ),
      )
      .for('update')
    if (row === undefined) return { kind: 'LOST' as const }

    const [base] = await tx
      .select({
        status: seniorResumes.verificationStatus,
        version: seniorResumes.version,
        verifiedVersion: seniorResumes.verifiedVersion,
      })
      .from(seniorResumes)
      .where(eq(seniorResumes.id, result.baseResumeId))
      .for('share')
    if (
      base?.status !== 'VERIFIED' ||
      base.version !== p.runBaseVersion ||
      base.verifiedVersion !== p.runBaseVersion
    ) {
      await tx
        .update(tailoredResumes)
        .set({ runStatus: 'FAILED', runErrorCode: 'BASE_CHANGED', runStage: null, updatedAt: now })
        .where(eq(tailoredResumes.id, p.rowId))
      return { kind: 'BASE_CHANGED' as const }
    }

    await tx
      .update(tailoredResumes)
      .set({
        baseResumeId: result.baseResumeId,
        baseVersion: p.runBaseVersion,
        opportunityRevision: result.opportunityRevision,
        content: result.accepted.content,
        coverLetter: result.coverLetter,
        layout: result.accepted.layout,
        templateName: result.templateName,
        verification: result.verification,
        runStatus: 'SUCCEEDED',
        runStage: null,
        runErrorCode: null,
        pdfStatus: 'READY',
        pdfRenderId: randomUUID(),
        pdfRenderStartedAt: null,
        pdfRenderError: null,
        pdfS3Key: key,
        generatedByUserId: row.requestedBy,
        generatedAt: now,
        editedByUserId: null,
        editedAt: null,
        updatedAt: now,
      })
      .where(eq(tailoredResumes.id, p.rowId))
    return { kind: 'PUBLISHED' as const, previous: row.pdfS3Key }
  })

  if (outcome.kind === 'PUBLISHED') {
    if (outcome.previous !== key) await deleteStagedQuietly(deps.s3, deps.logger, outcome.previous)
  } else {
    deps.logger.warn(
      JSON.stringify({
        event: 'tailored_resume_publish_refused',
        runId: p.runId,
        rowId: p.rowId,
        outcome: outcome.kind,
      }),
    )
    await deleteStagedQuietly(deps.s3, deps.logger, key)
  }
  return outcome.kind
}
