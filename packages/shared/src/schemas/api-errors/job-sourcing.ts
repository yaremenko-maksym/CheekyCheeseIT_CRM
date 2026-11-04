import type { MessageDescriptor } from '@lingui/core'

/**
 * r5 Phase 1 (vacancy-sourcing store) error contract for the `job_opportunities`
 * domain. Codes only for what the core store delivers (opportunities, source
 * records, the record -> opportunity link, ADMIN team triage). Codes for
 * metering, why-matched, score components, assignment versions and scoped
 * dismissals depend on tables delivered by follow-up PRs and are added there.
 * All codes are static (no `{token}` params).
 *
 * r5 Phase 6 T0 adds the `/job-queue` codes (`JOB_QUEUE_*`). A visibility miss
 * has NO code of its own: an opportunity outside the viewer's scope answers
 * with the same `JOB_OPPORTUNITY_NOT_FOUND` 404 as one that does not exist, so
 * the two cannot be told apart (the open-opportunity precedent). None of the
 * queue codes names, counts or hints at another team's activity.
 */
export const JOB_SOURCING_ERROR_CODES = [
  'JOB_OPPORTUNITY_NOT_FOUND',
  'JOB_SOURCE_RECORD_NOT_FOUND',
  'JOB_SOURCE_RECORD_ALREADY_LINKED',
  'JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED',
  'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
  'JOB_QUEUE_REFRESH_REQUIRED',
  'JOB_QUEUE_CURSOR_MALFORMED',
  'JOB_QUEUE_VERSION_CONFLICT',
  'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
  'JOB_QUEUE_POLICY_UNAVAILABLE',
] as const
export type JobSourcingErrorCode = (typeof JOB_SOURCING_ERROR_CODES)[number]

export const JOB_SOURCING_ERROR_PARAMS = {
  JOB_OPPORTUNITY_NOT_FOUND: [],
  JOB_SOURCE_RECORD_NOT_FOUND: [],
  JOB_SOURCE_RECORD_ALREADY_LINKED: [],
  JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED: [],
  JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED: [],
  JOB_QUEUE_REFRESH_REQUIRED: [],
  JOB_QUEUE_CURSOR_MALFORMED: [],
  JOB_QUEUE_VERSION_CONFLICT: [],
  JOB_QUEUE_IDEMPOTENCY_CONFLICT: [],
  JOB_QUEUE_POLICY_UNAVAILABLE: [],
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
  JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED: /* i18n */ {
    id: 'api-error.JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
    message: 'Цього сеньйора вже подано на схожу вакансію. Перевірте й підтвердьте подачу.',
  },
  JOB_QUEUE_REFRESH_REQUIRED: /* i18n */ {
    id: 'api-error.JOB_QUEUE_REFRESH_REQUIRED',
    message: 'Список застарів. Оновіть його.',
  },
  JOB_QUEUE_CURSOR_MALFORMED: /* i18n */ {
    id: 'api-error.JOB_QUEUE_CURSOR_MALFORMED',
    message: 'Не вдалося відкрити цю сторінку списку. Оновіть список.',
  },
  JOB_QUEUE_VERSION_CONFLICT: /* i18n */ {
    id: 'api-error.JOB_QUEUE_VERSION_CONFLICT',
    message: 'Дані змінилися. Оновіть картку й повторіть.',
  },
  JOB_QUEUE_IDEMPOTENCY_CONFLICT: /* i18n */ {
    id: 'api-error.JOB_QUEUE_IDEMPOTENCY_CONFLICT',
    message: 'Цей запит уже виконано з іншими даними. Оновіть картку й повторіть.',
  },
  JOB_QUEUE_POLICY_UNAVAILABLE: /* i18n */ {
    id: 'api-error.JOB_QUEUE_POLICY_UNAVAILABLE',
    message: 'Не вдалося перевірити доступ. Спробуйте пізніше.',
  },
}

export const JOB_SOURCING_ERROR_FALLBACK_EN: Record<JobSourcingErrorCode, string> = {
  JOB_OPPORTUNITY_NOT_FOUND: 'External job not found',
  JOB_SOURCE_RECORD_NOT_FOUND: 'Source record not found',
  JOB_SOURCE_RECORD_ALREADY_LINKED: 'This source record is already linked to a job',
  JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED: 'This job cannot be assigned to the team for triage',
  JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED:
    'This senior is already submitted to a similar job. Review it and confirm the submission.',
  JOB_QUEUE_REFRESH_REQUIRED: 'The list is out of date. Refresh it.',
  JOB_QUEUE_CURSOR_MALFORMED: 'This page of the list could not be opened. Refresh the list.',
  JOB_QUEUE_VERSION_CONFLICT: 'The data has changed. Refresh the card and try again.',
  JOB_QUEUE_IDEMPOTENCY_CONFLICT:
    'This request was already made with different data. Refresh the card and try again.',
  JOB_QUEUE_POLICY_UNAVAILABLE: 'Access could not be checked. Try again later.',
}
