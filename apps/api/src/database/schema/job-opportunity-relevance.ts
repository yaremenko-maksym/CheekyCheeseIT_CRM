/**
 * Queue relevance PR1 — `job_opportunity_relevance`: Jev's raw fit grade of one (vacancy, senior)
 * pair, written by the relevance pass (`job-sourcing/relevance/`). One row per pair; a key change
 * overwrites it (no history). The key is (grader version, title key, description hash, the
 * vacancy's roles, the senior's profile version): a fit counts only while it matches the live row.
 * Status is `text` + CHECK, never a pg enum, so the forward DDL stays a re-runnable
 * `CREATE TABLE IF NOT EXISTS`. Production gets the table ONLY through
 * `drizzle/manual/2026-11-24_job_opportunity_relevance.sql`.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { allTechnicalRolesCheck } from './job-role-classifications'
import { jobOpportunities } from './job-opportunities'
import { users } from './users'

export const JOB_OPPORTUNITY_RELEVANCE_STATUSES = ['GRADED', 'FAILED'] as const

export const jobOpportunityRelevance = pgTable(
  'job_opportunity_relevance',
  {
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => jobOpportunities.id, { onDelete: 'cascade' }),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    graderVersion: text('grader_version').notNull(),
    titleKey: text('title_key').notNull(),
    // Nullable, like job_opportunities.description_sha256 (a vacancy with no description).
    descriptionSha256: text('description_sha256'),
    opportunityRoles: text('opportunity_roles').array().notNull(),
    seniorProfileVersion: text('senior_profile_version').notNull(),
    status: text('status').$type<(typeof JOB_OPPORTUNITY_RELEVANCE_STATUSES)[number]>().notNull(),
    fit: real('fit'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'job_opportunity_relevance_pkey',
      columns: [t.opportunityId, t.seniorId],
    }),
    // The FK cascade from users scans by senior.
    index('idx_job_opportunity_relevance_senior').on(t.seniorId),
    check('ck_job_opportunity_relevance_status', sql`${t.status} IN ('GRADED', 'FAILED')`),
    check(
      'ck_job_opportunity_relevance_fit',
      sql`(${t.status} = 'GRADED') = (${t.fit} IS NOT NULL) AND (${t.fit} IS NULL OR ${t.fit} BETWEEN 0 AND 1)`,
    ),
    check('ck_job_opportunity_relevance_roles', allTechnicalRolesCheck(t.opportunityRoles)),
  ],
)
