/**
 * HR's edit of a published tailored variant (spec §9, plan Task 12, D21): `applyEdit` merges the
 * edited fields over the snapshot and claims a re-render in the request transaction; `renderEdit`
 * runs after the commit, off the request path. The re-render runs the deterministic gates only
 * (glyph, render, ATS, layout knobs): HR is the author, so no edited path is ever reverted, no
 * content is dropped and there is no visual check.
 */
import { randomUUID } from 'node:crypto'
import type { Logger } from '@nestjs/common'
import type {
  ResumeContent,
  ResumeLayoutOptions,
  ResumeTemplateName,
  TailoredEditRequest,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { ZodError } from 'zod'
import type { DatabaseService } from '../database/database.service'
import type { S3Service } from '../documents/s3.service'
import { headerContacts } from '../resumes/resume-typst.service'
import { RunFailure } from '../resumes/verification/content-gates'
import { renderAccepted, type RenderDeps } from '../resumes/verification/render-gates'
import { deleteStagedQuietly } from '../resumes/verification/run-columns'
import { editPdfKey } from './tailored-keys'
import { countBasePages } from './tailored-prepare'
import { tailoredPageLimit } from './tailored-render'
import { isRenderStalled, isTailoredActive, toTailoredCode } from './tailored-run'

type Db = Pick<DatabaseService['db'], 'execute' | 'transaction'>

/**
 * A1: the ceiling when the base's live PDF is missing or unreadable; otherwise the edit takes the
 * run's limit from the base page count (D5, `tailoredPageLimit`).
 */
export const EDIT_MAX_PAGES = 2

const ACTIVE = sql`('QUEUED', 'RUNNING')`

/** Every path HR may edit: all of them are HR-authored after a save, so none is reverted. */
export function editedPathsOf(content: ResumeContent): string[] {
  return ['summary', ...content.experience.map((_, i) => `experience.${i}.bullets`)]
}

/**
 * One transaction: the row `FOR UPDATE`; nothing published, or a run or a render active, is
 * `null` (409); bullets for another item count are a 400. Then one conditional UPDATE, still only
 * while no run and no render is active, writes the merged content and claims the render
 * (`pdf_status` RUNNING, a fresh `pdf_render_id`), so the sweep's 2 min rule covers a restart.
 */
export async function applyEdit(
  db: Pick<Db, 'transaction'>,
  p: { rowId: string; userId: string; edit: TailoredEditRequest },
): Promise<{ renderId: string } | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(
      sql`SELECT content, run_status, pdf_status FROM tailored_resumes WHERE id = ${p.rowId}::uuid FOR UPDATE`,
    )
    const row = rows[0]
    if (row === undefined) return null
    const content = row['content'] as ResumeContent | null
    if (content === null) return null
    if (isTailoredActive(row['run_status']) || isTailoredActive(row['pdf_status'])) return null
    const { edit } = p
    if (edit.bullets.length !== content.experience.length) {
      throw new ZodError([
        {
          code: 'custom',
          path: ['bullets'],
          message: 'bullets must hold one list per experience item, in order',
          input: edit.bullets,
        },
      ])
    }
    const merged: ResumeContent = {
      ...content,
      summary: edit.summary,
      skills: edit.skills,
      experience: content.experience.map((item, i) => ({
        ...item,
        bullets: edit.bullets[i] as string[],
      })),
    }
    const renderId = randomUUID()
    const at = new Date().toISOString()
    const { rows: updated } = await tx.execute(
      sql`UPDATE tailored_resumes SET content = ${JSON.stringify(merged)}::jsonb,
             cover_letter = ${edit.coverLetter}, edited_by_user_id = ${p.userId}::uuid,
             edited_at = ${at}::timestamptz, pdf_status = 'RUNNING',
             pdf_render_id = ${renderId}::uuid, pdf_render_started_at = ${at}::timestamptz,
             pdf_render_error = NULL, updated_at = ${at}::timestamptz
           WHERE id = ${p.rowId}::uuid AND (run_status IS NULL OR run_status NOT IN ${ACTIVE}) AND pdf_status NOT IN ${ACTIVE}
           RETURNING id`,
    )
    return updated.length === 0 ? null : { renderId }
  })
}

export type EditRenderDeps = {
  db: Db
  s3: Pick<S3Service, 'upload' | 'delete' | 'getObject'>
  logger: Logger
  typst: RenderDeps['typst']
  extraction: RenderDeps['extraction']
  now: () => Date
}

/** The edit render never calls a model (D21): no vision, no budget to check. */
const NO_MODEL: Pick<RenderDeps, 'vision' | 'beforeModelCall'> = {
  vision: {
    check: () => Promise.reject(new Error('an edit render never runs the visual check')),
  },
  beforeModelCall: () => Promise.resolve(),
}

/**
 * After the commit of `applyEdit`. Owns the render only while `pdf_render_id` is `renderId` and
 * RUNNING: the PDF goes under its own key, then a CAS writes READY and the new key, and the
 * previous object is deleted after the commit. Lost → its own object is deleted. Any failure →
 * FAILED with the code, the previous key kept. Never rejects; logs carry ids and codes only.
 */
export async function renderEdit(
  deps: EditRenderDeps,
  rowId: string,
  renderId: string,
): Promise<void> {
  try {
    await renderOwned(deps, rowId, renderId)
  } catch (err: unknown) {
    const code = err instanceof RunFailure ? toTailoredCode(err.code) : 'INTERNAL_ERROR'
    if (!(err instanceof RunFailure)) {
      const name = err instanceof Error ? err.name : 'unknown'
      deps.logger.error(`Tailored edit render ${renderId} of row ${rowId} crashed (${name})`)
    }
    await deps.db
      .execute(
        sql`UPDATE tailored_resumes SET pdf_status = 'FAILED', pdf_render_error = ${code},
               pdf_render_started_at = NULL, updated_at = now()
             WHERE id = ${rowId}::uuid AND pdf_render_id = ${renderId}::uuid AND pdf_status = 'RUNNING'`,
      )
      .catch(() => {
        deps.logger.error(`Tailored edit render ${renderId} of row ${rowId}: FAILED not written`)
      })
  }
}

/** The run's page limit from the base's live PDF; EDIT_MAX_PAGES, logged, when it cannot be read. */
async function editPageLimit(
  deps: EditRenderDeps,
  rowId: string,
  baseKey: unknown,
): Promise<number> {
  if (typeof baseKey === 'string') {
    try {
      return tailoredPageLimit(await countBasePages(deps, baseKey))
    } catch {
      // the fallback below; the read error itself may carry the key, so only the event is logged
    }
  }
  deps.logger.warn(JSON.stringify({ event: 'tailored_resume_edit_page_limit_fallback', rowId }))
  return EDIT_MAX_PAGES
}

async function renderOwned(deps: EditRenderDeps, rowId: string, renderId: string): Promise<void> {
  const { rows } = await deps.db.execute(
    sql`SELECT t.content, t.layout, t.template_name, u.display_name, u.email, u.phone, u.telegram,
               s.pdf_s3_key AS base_pdf_s3_key
          FROM tailored_resumes t JOIN users u ON u.id = t.senior_user_id
          LEFT JOIN senior_resumes s ON s.id = t.base_resume_id
         WHERE t.id = ${rowId}::uuid AND t.pdf_render_id = ${renderId}::uuid AND t.pdf_status = 'RUNNING'`,
  )
  const row = rows[0]
  if (row === undefined) return
  const content = row['content'] as ResumeContent
  const accepted = await renderAccepted(
    {
      // The header is the current user row at every render (spec §5); the body is the snapshot.
      displayName: String(row['display_name']),
      email: String(row['email']),
      ...headerContacts({
        phone: row['phone'] as string | null,
        telegram: row['telegram'] as string | null,
      }),
      content,
      layout: row['layout'] as ResumeLayoutOptions,
      templateName: row['template_name'] as ResumeTemplateName,
      notes: content,
      fallbacks: [],
      editedPaths: editedPathsOf(content),
      maxPages: await editPageLimit(deps, rowId, row['base_pdf_s3_key']),
    },
    { typst: deps.typst, extraction: deps.extraction, ...NO_MODEL },
  )
  const key = editPdfKey(rowId, renderId)
  await deps.s3.upload(key, accepted.pdf, 'application/pdf', 'RESUME')
  let outcome: { kind: 'READY'; previous: string | null } | { kind: 'LOST' }
  try {
    outcome = await deps.db.transaction(async (tx) => {
      const { rows: owned } = await tx.execute(
        sql`SELECT pdf_s3_key, pdf_render_started_at FROM tailored_resumes
             WHERE id = ${rowId}::uuid AND pdf_render_id = ${renderId}::uuid AND pdf_status = 'RUNNING' FOR UPDATE`,
      )
      const mine = owned[0]
      if (mine === undefined) return { kind: 'LOST' as const }
      // SR-L-2: past the sweep's stall rule the render is lost, like C1 on publish (text from execute).
      const started = mine['pdf_render_started_at']
      // Stryker disable next-line ConditionalExpression: equivalent — new Date(null) is the epoch, which the stall rule also calls stalled, so a null start is LOST either way
      const since = started == null ? null : new Date(started as string | Date)
      if (isRenderStalled({ pdfStatus: 'RUNNING', pdfRenderStartedAt: since }, deps.now())) {
        return { kind: 'LOST' as const }
      }
      await tx.execute(
        sql`UPDATE tailored_resumes SET pdf_status = 'READY', pdf_s3_key = ${key},
               layout = ${JSON.stringify(accepted.layout)}::jsonb, pdf_render_error = NULL,
               pdf_render_started_at = NULL, updated_at = now()
             WHERE id = ${rowId}::uuid AND pdf_render_id = ${renderId}::uuid AND pdf_status = 'RUNNING'`,
      )
      return { kind: 'READY' as const, previous: (mine['pdf_s3_key'] ?? null) as string | null }
    })
  } catch (err: unknown) {
    await deleteStagedQuietly(deps.s3, deps.logger, key)
    throw err
  }
  if (outcome.kind === 'LOST') {
    deps.logger.warn(JSON.stringify({ event: 'tailored_resume_edit_render_lost', rowId, renderId }))
    await deleteStagedQuietly(deps.s3, deps.logger, key)
    return
  }
  // a previous key equal to this one cannot happen: every render id is fresh
  await deleteStagedQuietly(deps.s3, deps.logger, outcome.previous)
}
