/**
 * A resume + cover letter tailored to one job opportunity for one senior (tailored-resume spec §8).
 * One row per (opportunity, senior). The published variant (`content` … `verification`) is written
 * only by a successful run's publish or by HR's edit; the run columns and the PDF columns are kept
 * apart from it, so a failed or in-flight run never touches what HR already has.
 *
 * Prod DDL: `drizzle/manual/2026-11-21_tailored_resumes.sql`, applied by the deploy before the grants.
 * Nothing writes the table until `TAILORED_RESUME_ENABLED` is true.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  ResumeContent,
  ResumeLayoutOptions,
  ResumeRenderStatus,
  TailoredResumeErrorCode,
  TailoredRunStage,
  TailoredRunStatus,
  TailoredVerification,
} from '@crm/shared'
import { jobOpportunities } from './job-opportunities'
import { seniorResumes } from './resumes'
import { users } from './users'

export const tailoredResumes = pgTable(
  'tailored_resumes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobOpportunityId: uuid('job_opportunity_id')
      .notNull()
      .references(() => jobOpportunities.id, { onDelete: 'cascade' }),
    seniorUserId: uuid('senior_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The verified base the published variant was built from; null until the first publish. */
    baseResumeId: uuid('base_resume_id').references(() => seniorResumes.id, {
      onDelete: 'cascade',
    }),
    baseVersion: integer('base_version'),
    opportunityRevision: integer('opportunity_revision'),
    /** The published variant: tailored fields merged over the frozen base. Null = nothing published. */
    content: jsonb('content').$type<ResumeContent>(),
    coverLetter: text('cover_letter'),
    layout: jsonb('layout').$type<ResumeLayoutOptions>(),
    templateName: text('template_name'),
    /** Gate results and flags only, never posting text or model text. */
    verification: jsonb('verification').$type<TailoredVerification>(),

    // The generation run, separate from the published variant.
    runStatus: text('run_status').$type<TailoredRunStatus>(),
    runId: uuid('run_id'),
    /** The base `version` the run started from; publish refuses when it moved (BASE_CHANGED). */
    runBaseVersion: integer('run_base_version'),
    runStage: text('run_stage').$type<TailoredRunStage>(),
    runQueuedAt: timestamp('run_queued_at', { withTimezone: true }),
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    runErrorCode: text('run_error_code').$type<TailoredResumeErrorCode>(),
    runRequestedByUserId: uuid('run_requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // The PDF, separate from the run: an HR edit re-renders without a run.
    pdfStatus: text('pdf_status').$type<ResumeRenderStatus>().notNull().default('IDLE'),
    /** Owner of an edit re-render; every rendered-PDF write compare-and-sets on it. */
    pdfRenderId: uuid('pdf_render_id'),
    pdfRenderStartedAt: timestamp('pdf_render_started_at', { withTimezone: true }),
    pdfRenderError: text('pdf_render_error'),
    pdfS3Key: text('pdf_s3_key'),
    pdfFingerprint: text('pdf_fingerprint'),

    generatedByUserId: uuid('generated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    editedByUserId: uuid('edited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_tailored_resumes_opportunity_senior').on(t.jobOpportunityId, t.seniorUserId),
    check(
      'ck_tailored_resumes_run_status',
      sql`${t.runStatus} IS NULL OR ${t.runStatus} IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')`,
    ),
    check(
      'ck_tailored_resumes_pdf_status',
      sql`${t.pdfStatus} IN ('IDLE', 'QUEUED', 'RUNNING', 'READY', 'FAILED')`,
    ),
    // An active run is always owned: the run id is what every run write compare-and-sets on.
    check(
      'ck_tailored_resumes_active_run_id',
      sql`${t.runStatus} IS NULL OR ${t.runStatus} NOT IN ('QUEUED', 'RUNNING') OR ${t.runId} IS NOT NULL`,
    ),
    // A published variant is the resume and its cover letter together, never one of them.
    check(
      'ck_tailored_resumes_content_cover_letter',
      sql`(${t.content} IS NULL) = (${t.coverLetter} IS NULL)`,
    ),
    // The sweep and the slot gate read only active runs.
    index('idx_tailored_resumes_active_run')
      .on(t.runStatus)
      .where(sql`${t.runStatus} IN ('QUEUED', 'RUNNING')`),
  ],
)

export type TailoredResumeRow = typeof tailoredResumes.$inferSelect
