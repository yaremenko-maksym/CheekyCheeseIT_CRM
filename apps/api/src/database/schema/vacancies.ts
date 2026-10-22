/**
 * Public vacancies and applications.
 */
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { type VacancyTranslations } from '@crm/shared'
import {
  currencyEnum,
  vacancyApplicationStatusEnum,
  vacancyDomainEnum,
  vacancyEmploymentTypeEnum,
  vacancySalaryPeriodEnum,
  vacancySeniorityEnum,
  vacancyStatusEnum,
} from './enums'
import { users } from './users'

// ---------------------------------------------------------------------------
// Vacancies (task-vacancies-api)
// ---------------------------------------------------------------------------
//
// Public hiring channel for new SENIORs — completely separate from the
// interviews Kanban (that board tracks a candidate a SENIOR is already
// placing on a project; vacancies are visible on the landing before the
// applicant is a user at all). No salary fields — never add them here.

export const vacancies = pgTable(
  'vacancies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    descriptionMd: text('description_md').notNull(),
    domain: vacancyDomainEnum('domain').notNull(),
    seniority: vacancySeniorityEnum('seniority').notNull(),
    employmentType: vacancyEmploymentTypeEnum('employment_type').notNull(),
    location: text('location').notNull(),
    status: vacancyStatusEnum('status').notNull().default('DRAFT'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    // task-vacancy-i18n-jobposting — nullable; shape imported from
    // packages/shared (VacancyTranslations, the SSOT) instead of duplicated
    // here — owner scope-change 2026-07-25 made the locale set data-driven
    // (VACANCY_TRANSLATION_LOCALES), so this column's type follows it
    // automatically instead of needing a matching edit on every language add.
    // `en` is the row's own title/descriptionMd above; every other locale is
    // an optional, independently-present override.
    translations: jsonb('translations').$type<VacancyTranslations>(),
    // JobPosting (Google for Jobs) enrichment — all optional/admin-entered,
    // never invented (see packages/shared vacancySeoFieldsSchema doc).
    skills: text('skills').array(),
    experienceMonths: integer('experience_months'),
    qualifications: text('qualifications'),
    responsibilities: text('responsibilities'),
    jobBenefits: text('job_benefits'),
    workHours: text('work_hours'),
    // task-vacancy-salary-range (owner decision 2026-07-31) — public salary
    // range, MANDATORY going forward (enforced in packages/shared
    // createVacancySchema + VacanciesService.assertSalaryFilled), but
    // nullable HERE: 3 vacancies were already PUBLISHED on prod before this
    // change and a NOT NULL constraint can't be retrofitted onto existing
    // rows without inventing values — see the manual DDL's header comment.
    // `salaryCurrency` reuses the EXISTING `currency` pg enum (already shared
    // by users.salaryCurrency/transactions.currency) — a real DB-level type,
    // unlike packages/shared's OWN independently-declared
    // `vacancySalaryCurrencySchema` (deliberately not imported from
    // payment-requisites.ts — see that file's doc comment for why).
    salaryMin: numeric('salary_min', { precision: 12, scale: 2 }),
    salaryMax: numeric('salary_max', { precision: 12, scale: 2 }),
    salaryCurrency: currencyEnum('salary_currency'),
    salaryPeriod: vacancySalaryPeriodEnum('salary_period'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_vacancies_status').on(t.status)],
)

export const vacancyApplications = pgTable(
  'vacancy_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vacancyId: uuid('vacancy_id')
      .notNull()
      .references(() => vacancies.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    telegram: text('telegram'),
    linkedinUrl: text('linkedin_url'),
    githubUrl: text('github_url'),
    coverLetter: text('cover_letter'),
    // Immutable R2/S3 object key —
    // `vacancy-applications/<vacancyId>/<applicationId>.pdf`.
    // task-file-storage-hardening §2 (owner decision 2026-08-01, 6-month
    // resume retention): NULLABLE — `VacanciesRetentionCronService` clears
    // both this and `resumeSizeBytes` once an application turns 180 days old
    // (any status, including the evergreen NEW/VIEWED ones that used to keep
    // their file forever alongside the vacancy). The application ROW stays
    // (hiring-history value), only the file+size are scrubbed.
    resumeS3Key: text('resume_s3_key'),
    resumeSizeBytes: integer('resume_size_bytes'),
    status: vacancyApplicationStatusEnum('status').notNull().default('NEW'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Admin application list per vacancy, most recent first.
    index('idx_vacancy_applications_vacancy_created').on(t.vacancyId, t.createdAt.desc()),
    // Duplicate-submission check: same email + vacancy within 24h.
    index('idx_vacancy_applications_email_vacancy').on(t.email, t.vacancyId),
  ],
)
