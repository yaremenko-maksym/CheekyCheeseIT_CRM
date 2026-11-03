import type { MessageDescriptor } from '@lingui/core'

/**
 * r5 Phase 1 (vacancy-sourcing store) error contract for the `job_opportunities`
 * domain. Codes only for what the core store delivers (opportunities, source
 * records, the record -> opportunity link, ADMIN team triage). Codes for
 * metering, why-matched, score components, assignment versions and scoped
 * dismissals depend on tables delivered by follow-up PRs and are added there.
 * All codes are static (no `{token}` params).
 */
export const JOB_SOURCING_ERROR_CODES = [
  'JOB_OPPORTUNITY_NOT_FOUND',
  'JOB_SOURCE_RECORD_NOT_FOUND',
  'JOB_SOURCE_RECORD_ALREADY_LINKED',
  'JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED',
  // r5 Task 6.5: the ADMIN source switch (`PATCH /job-sourcing/sources/:id`).
  'JOB_SOURCE_NOT_FOUND',
  'JOB_SOURCE_NOT_READY',
  'JOB_SOURCE_AUTH_PAUSED',
] as const
export type JobSourcingErrorCode = (typeof JOB_SOURCING_ERROR_CODES)[number]

export const JOB_SOURCING_ERROR_PARAMS = {
  JOB_OPPORTUNITY_NOT_FOUND: [],
  JOB_SOURCE_RECORD_NOT_FOUND: [],
  JOB_SOURCE_RECORD_ALREADY_LINKED: [],
  JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED: [],
  JOB_SOURCE_NOT_FOUND: [],
  JOB_SOURCE_NOT_READY: [],
  JOB_SOURCE_AUTH_PAUSED: [],
} as const satisfies Record<JobSourcingErrorCode, readonly string[]>

export const JOB_SOURCING_ERROR_MESSAGES: Record<JobSourcingErrorCode, MessageDescriptor> = {
  JOB_OPPORTUNITY_NOT_FOUND: /* i18n */ {
    id: 'api-error.JOB_OPPORTUNITY_NOT_FOUND',
    message: 'Зовнішню вакансію не знайдено',
  },
  JOB_SOURCE_RECORD_NOT_FOUND: /* i18n */ {
    id: 'api-error.JOB_SOURCE_RECORD_NOT_FOUND',
    message: 'Запис джерела не знайдено',
  },
  JOB_SOURCE_RECORD_ALREADY_LINKED: /* i18n */ {
    id: 'api-error.JOB_SOURCE_RECORD_ALREADY_LINKED',
    message: 'Запис джерела вже прив’язано до вакансії',
  },
  JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED: /* i18n */ {
    id: 'api-error.JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED',
    message: 'Не можна призначити цю вакансію на розгляд команді',
  },
  JOB_SOURCE_NOT_FOUND: /* i18n */ {
    id: 'api-error.JOB_SOURCE_NOT_FOUND',
    message: 'Джерело вакансій не знайдено',
  },
  JOB_SOURCE_NOT_READY: /* i18n */ {
    id: 'api-error.JOB_SOURCE_NOT_READY',
    message: 'Джерело ще не готове до роботи, тому його не можна ввімкнути',
  },
  JOB_SOURCE_AUTH_PAUSED: /* i18n */ {
    id: 'api-error.JOB_SOURCE_AUTH_PAUSED',
    message: 'Джерело призупинено через відмову в доступі: спершу скиньте помилки',
  },
}

export const JOB_SOURCING_ERROR_FALLBACK_EN: Record<JobSourcingErrorCode, string> = {
  JOB_OPPORTUNITY_NOT_FOUND: 'External job not found',
  JOB_SOURCE_RECORD_NOT_FOUND: 'Source record not found',
  JOB_SOURCE_RECORD_ALREADY_LINKED: 'This source record is already linked to a job',
  JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED: 'This job cannot be assigned to the team for triage',
  JOB_SOURCE_NOT_FOUND: 'Job source not found',
  JOB_SOURCE_NOT_READY: 'The source is not ready yet, so it cannot be switched on',
  JOB_SOURCE_AUTH_PAUSED: 'The source is paused after an access refusal: reset its failures first',
}
