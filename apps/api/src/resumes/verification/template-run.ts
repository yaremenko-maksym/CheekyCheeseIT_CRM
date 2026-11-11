/**
 * The `template` kind of the verification run (Task 16): a look change on a VERIFIED resume. The start
 * UPDATE (Task 13, `writeLook`) copies the live content and the requested look into the staged columns;
 * the run re-renders that content as is (stages 5–8), and a pass promotes the new PDF and look while the
 * row stays VERIFIED. A failure is written by the runner's `fail` with the status kept.
 */
import type { Logger } from '@nestjs/common'
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import {
  resumeContentSchema,
  type ResumeContent,
  type ResumeTemplateName,
  type ResumeVerificationReport,
} from '@crm/shared'
import type { DatabaseService } from '../../database/database.service'
import { seniorResumes, type SeniorResume } from '../../database/schema'
import type { S3Service } from '../../documents/s3.service'
import type { ResumeTypstService } from '../resume-typst.service'
import { RunFailure } from './content-gates'
import type { Accepted } from './render-gates'
import {
  CLEARED_RUN,
  CLEARED_STAGED,
  deleteStagedQuietly,
  stagedPdfKey,
  storedFallbacks,
} from './run-columns'

/**
 * The content a template run renders: the staged copy of the live, confirmed content. Every AI path
 * counts as a fallback already, so an ATS failure there fails the run instead of rewriting a text
 * nobody confirms again.
 */
export function templateContent(row: Pick<SeniorResume, 'stagedContent' | 'verificationReport'>): {
  content: ResumeContent
  locked: string[]
  fallbacks: string[]
} {
  const staged = resumeContentSchema.safeParse(row.stagedContent)
  if (!staged.success) throw new RunFailure('INCOMPLETE')
  return {
    content: staged.data,
    locked: ['summary', ...staged.data.experience.map((_, i) => `experience.${i}.bullets`)],
    // The confirmed run's fallbacks: a template run reports them, its locked paths are no new ones.
    fallbacks: storedFallbacks(row.verificationReport),
  }
}

/**
 * Stage 1 of a template run: the row stays VERIFIED, so the claim is the start time, set once on the
 * run id (`own`). `undefined` when another run owns the row or this one was claimed already.
 */
export async function claimTemplateRun(
  db: DatabaseService,
  own: SQL | undefined,
): Promise<SeniorResume | undefined> {
  const [row] = await db.db
    .update(seniorResumes)
    .set({ verificationStartedAt: new Date() })
    .where(
      and(
        own,
        eq(seniorResumes.verificationStatus, 'VERIFIED'),
        eq(seniorResumes.verificationKind, 'template'),
        isNull(seniorResumes.verificationStartedAt),
      ),
    )
    .returning()
  return row
}

export interface TemplatePass {
  accepted: Pick<Accepted, 'pdf' | 'content' | 'layout'>
  templateName: ResumeTemplateName
  report: ResumeVerificationReport
  owner: { displayName: string; email: string }
}

/**
 * Pass: upload, then one compare-and-set on the run id, VERIFIED, `version = base_version` and no
 * custom template promotes the PDF and the look, bumps `version` and `verified_version` together and
 * clears the run. A lost CAS deletes the upload; a won one deletes the live object it replaced.
 */
export async function promoteTemplateRun(
  deps: {
    db: DatabaseService
    s3: Pick<S3Service, 'upload' | 'delete'>
    typst: Pick<ResumeTypstService, 'fingerprint'>
    logger: Logger
  },
  resumeId: string,
  runId: string,
  pass: TemplatePass,
): Promise<void> {
  const { accepted, templateName } = pass
  // P11: the input `renderInputFor` builds for the promoted row, so the live PDF is served as is.
  const fingerprint = deps.typst.fingerprint({
    displayName: pass.owner.displayName,
    email: pass.owner.email,
    content: accepted.content,
    layout: accepted.layout,
    templateName,
    templateSource: null,
  })
  const key = stagedPdfKey(resumeId, runId)
  await deps.s3.upload(key, accepted.pdf, 'application/pdf', 'RESUME')
  const replaced = await deps.db.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ key: seniorResumes.pdfS3Key })
      .from(seniorResumes)
      .where(eq(seniorResumes.id, resumeId))
      .for('update')
    // Every right-hand side reads the pre-update row, so both versions get version + 1.
    const [won] = await tx
      .update(seniorResumes)
      .set({
        layout: accepted.layout,
        templateName,
        pdfS3Key: key,
        pdfFingerprint: fingerprint,
        pdfRenderStatus: 'READY',
        pdfRenderError: null,
        pdfRenderRunId: null,
        pdfRenderStartedAt: null,
        version: sql`${seniorResumes.version} + 1`,
        verifiedVersion: sql`${seniorResumes.version} + 1`,
        verificationErrorCode: null,
        verificationReport: pass.report,
        ...CLEARED_RUN,
        ...CLEARED_STAGED,
      })
      .where(
        and(
          eq(seniorResumes.id, resumeId),
          eq(seniorResumes.verificationRunId, runId),
          eq(seniorResumes.verificationStatus, 'VERIFIED'),
          sql`${seniorResumes.version} = ${seniorResumes.verificationBaseVersion}`,
          isNull(seniorResumes.templateSource),
        ),
      )
      .returning({ id: seniorResumes.id })
    return won ? { old: current?.key ?? null } : null
  })
  if (replaced === null) {
    deps.logger.warn(`Template run ${runId} of resume ${resumeId} superseded: ${key} dropped`)
    await deleteStagedQuietly(deps.s3, deps.logger, key)
  } else if (replaced.old !== key) {
    await deleteStagedQuietly(deps.s3, deps.logger, replaced.old)
  }
}
