/**
 * Senior roles PR 2 — the AI role-classification cache `job_role_classifications`, plus the CHECK
 * helper every `technical_roles` column uses.
 *
 * One row per (normalised title = `job_opportunities.title_key`, description hash, classifier
 * version). Ingest reads it when the deterministic classifier cannot name a role
 * (`job-sourcing/store/opportunity-roles.ts`); the AI pass (PR 3) writes it. Roles are `text[]` +
 * CHECK, never a pg enum, so the forward DDL stays a re-runnable `CREATE TABLE IF NOT EXISTS`.
 * Production gets the table ONLY through `drizzle/manual/2026-11-17_technical_roles.sql`.
 */
import { SENIOR_SELECTABLE_ROLES, TECHNICAL_ROLES } from '@crm/shared'
import { sql, type SQL } from 'drizzle-orm'
import {
  check,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

/** `col <@ ARRAY['A','B',...]::text[]` — every element is a known id. The ids are code literals. */
function rolesWithin(col: AnyPgColumn, ids: readonly string[]): SQL {
  return sql`${col} <@ ARRAY[${sql.raw(ids.map((id) => `'${id}'`).join(', '))}]::text[]`
}

/** All 34 roles: a vacancy (and a cache row) may carry the vacancy-only `SOFTWARE_ENGINEER`. */
export const allTechnicalRolesCheck = (col: AnyPgColumn): SQL => rolesWithin(col, TECHNICAL_ROLES)

/** The 33 senior-selectable roles: a senior never holds `SOFTWARE_ENGINEER`. */
export const seniorTechnicalRolesCheck = (col: AnyPgColumn): SQL =>
  rolesWithin(col, SENIOR_SELECTABLE_ROLES)

export const JOB_ROLE_CLASSIFICATION_OUTCOMES = ['AI', 'UNCLEAR', 'FAILED'] as const

export const jobRoleClassifications = pgTable(
  'job_role_classifications',
  {
    titleKey: text('title_key').notNull(),
    descriptionSha256: text('description_sha256').notNull(),
    classifierVersion: text('classifier_version').notNull(),
    outcome: text('outcome').$type<(typeof JOB_ROLE_CLASSIFICATION_OUTCOMES)[number]>().notNull(),
    technicalRoles: text('technical_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    model: text('model'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'job_role_classifications_pkey',
      columns: [t.titleKey, t.descriptionSha256, t.classifierVersion],
    }),
    check('ck_job_role_classifications_outcome', sql`${t.outcome} IN ('AI', 'UNCLEAR', 'FAILED')`),
    check(
      'ck_job_role_classifications_technical_roles_known',
      allTechnicalRolesCheck(t.technicalRoles),
    ),
  ],
)
