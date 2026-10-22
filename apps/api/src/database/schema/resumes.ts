/**
 * Senior resumes.
 */
import { relations } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  type ResumeContent,
  type ResumeLayoutOptions,
} from '@crm/shared'
import { resumeExtractionStatusEnum, resumeRenderStatusEnum } from './enums'
import { users } from './users'

// ---------------------------------------------------------------------------
// Senior resume (task-resume-base)
// ---------------------------------------------------------------------------

/**
 * One canonical resume per senior. The uploaded file is an INPUT only: after
 * a single AI extraction the system works with `content` (JSONB), never with
 * the file. `version` grows on every content save so task-resume-tailoring can
 * detect vacancy-tailored variants built from a now-stale base.
 *
 * `user_id` is UNIQUE — enforced at the DB level, so two concurrent
 * "create my resume" requests can never produce two rows (the loser gets a
 * unique-violation, which the service turns into a re-read).
 */
export const seniorResumes = pgTable(
  'senior_resumes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ResumeContent (packages/shared). UNTRUSTED — validated on read + write. */
    content: jsonb('content').$type<ResumeContent>().notNull().default(EMPTY_RESUME_CONTENT),
    status: resumeExtractionStatusEnum('status').notNull().default('READY'),
    /** ResumeFailureCode (packages/shared) — set together with `error_message`. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** When the Cloudflare daily allowance resets (QUOTA_EXCEEDED only). */
    quotaResetsAt: timestamp('quota_resets_at', { withTimezone: true }),
    /** Set when a RUNNING extraction started — drives the stuck-sweep cron. */
    extractionStartedAt: timestamp('extraction_started_at', { withTimezone: true }),
    /**
     * Identifies WHICH extraction attempt currently owns this row.
     *
     * Generated when a run claims the row and required (unchanged) by that
     * run's terminal write. Anything that supersedes the run — a second upload,
     * a pasted text, a manual save — clears it, so the superseded run finds no
     * matching row and discards its result instead of overwriting newer data
     * with the contents of a file that has already been deleted.
     */
    extractionRunId: uuid('extraction_run_id'),
    /** Neurons/tokens spent on the last extraction — makes the spend visible. */
    lastExtractionTokens: integer('last_extraction_tokens'),
    /** Private R2/S3 key of the original file — served only via our endpoint. */
    sourceS3Key: text('source_s3_key'),
    sourceFileName: text('source_file_name'),
    sourceFileSizeBytes: integer('source_file_size_bytes'),
    sourceMimeType: text('source_mime_type'),
    version: integer('version').notNull().default(0),

    // --- layout half of the "template + data" split (task-resume-template) ---
    /**
     * The senior's own Typst template. NULL = the one shipped in the repo.
     *
     * A template is executable typesetting code, and NO ENDPOINT WRITES THIS
     * COLUMN — personal templates are authored by the designer as a separate
     * task, through a path that does not exist yet. That is deliberate: the
     * editable surface for a human is `layout` below, an enumerated set of
     * switches, so the render can never be steered by text a user (or a model)
     * supplies. The renderer sandboxes the template anyway (`--root` on a
     * scratch directory), but the first line of defence is that nothing can
     * put anything here.
     */
    templateSource: text('template_source'),
    /** Display label for the template. Never its source. */
    templateName: text('template_name'),
    /** ResumeLayoutOptions — section order, hidden sections, density, font scale. */
    layout: jsonb('layout').$type<ResumeLayoutOptions>().notNull().default(DEFAULT_RESUME_LAYOUT),

    // --- rendered PDF (built by a job, never inside a request) ---------------
    /** Private S3 key of the rendered PDF, or NULL when none exists yet. */
    pdfS3Key: text('pdf_s3_key'),
    /**
     * SHA-256 of the exact render input the stored PDF was built from.
     *
     * Freshness is decided by COMPARING this with the fingerprint of the
     * current content+layout+template rather than by trusting a version
     * counter: the render is deterministic, so equal fingerprints really do
     * mean equal bytes, and a stale PDF can never be served as the current one.
     */
    pdfFingerprint: text('pdf_fingerprint'),
    pdfRenderStatus: resumeRenderStatusEnum('pdf_render_status').notNull().default('IDLE'),
    /** Russian, user-safe — set together with `pdf_render_status = 'FAILED'`. */
    pdfRenderError: text('pdf_render_error'),
    /** Set while a render is RUNNING; drives the stuck-render sweep. */
    pdfRenderStartedAt: timestamp('pdf_render_started_at', { withTimezone: true }),
    /**
     * Which render attempt owns the row, exactly as `extraction_run_id` does
     * for extraction: a slow render that has been superseded by a newer save
     * must discard its result instead of overwriting fresher bytes.
     */
    pdfRenderRunId: uuid('pdf_render_run_id'),

    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The stuck-RUNNING sweep filters on exactly this pair.
    index('idx_senior_resumes_status').on(t.status, t.extractionStartedAt),
    // The abandoned-QUEUED sweep filters on a DIFFERENT pair: a QUEUED row has
    // no `extraction_started_at` (nothing ever claimed it), so it can only be
    // aged by `updated_at`. The index above does not serve that query at all.
    index('idx_senior_resumes_status_updated_at').on(t.status, t.updatedAt),
    // The stuck-RENDER sweep asks a third question again: which renders have
    // been RUNNING too long. Same shape as the extraction sweep, own columns.
    index('idx_senior_resumes_render_status').on(t.pdfRenderStatus, t.pdfRenderStartedAt),
  ],
)

export const seniorResumesRelations = relations(seniorResumes, ({ one }) => ({
  user: one(users, {
    fields: [seniorResumes.userId],
    references: [users.id],
    relationName: 'seniorResumeOwner',
  }),
  updatedBy: one(users, {
    fields: [seniorResumes.updatedByUserId],
    references: [users.id],
    relationName: 'seniorResumeEditor',
  }),
}))

export type SeniorResume = typeof seniorResumes.$inferSelect

export type NewSeniorResume = typeof seniorResumes.$inferInsert
