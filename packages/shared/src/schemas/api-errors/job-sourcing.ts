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
  // r5 Phase 6 manual card (`POST /job-queue/manual`), both 422.
  'JOB_QUEUE_SENIOR_INELIGIBLE',
  'JOB_QUEUE_RESUME_UNUSABLE',
  // r5 Phase 6 manual card, 409: an opportunity with this application link already exists. Generic:
  // it names no team and no card.
  'JOB_QUEUE_MANUAL_DUPLICATE',
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
  JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED: [],
  JOB_QUEUE_REFRESH_REQUIRED: [],
  JOB_QUEUE_CURSOR_MALFORMED: [],
  JOB_QUEUE_VERSION_CONFLICT: [],
  JOB_QUEUE_IDEMPOTENCY_CONFLICT: [],
  JOB_QUEUE_POLICY_UNAVAILABLE: [],
  JOB_QUEUE_SENIOR_INELIGIBLE: [],
  JOB_QUEUE_RESUME_UNUSABLE: [],
  JOB_QUEUE_MANUAL_DUPLICATE: [],
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
  JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED: /* i18n */ {
    id: 'api-error.JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
    message:
      'Цього сеньйора вже подано на схожу вакансію. Перевірте її й підтвердьте запис подачі.',
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
  JOB_QUEUE_SENIOR_INELIGIBLE: /* i18n */ {
    id: 'api-error.JOB_QUEUE_SENIOR_INELIGIBLE',
    message:
      'Цього сеньйора не можна подати на цю вакансію від цієї команди. Оберіть іншого сеньйора або іншу команду.',
  },
  JOB_QUEUE_RESUME_UNUSABLE: /* i18n */ {
    id: 'api-error.JOB_QUEUE_RESUME_UNUSABLE',
    message: 'Це резюме не можна використати для цього сеньйора. Оберіть інше.',
  },
  JOB_QUEUE_MANUAL_DUPLICATE: /* i18n */ {
    id: 'api-error.JOB_QUEUE_MANUAL_DUPLICATE',
    message: 'Вакансія з цим посиланням уже є в системі. Нову картку не створено.',
  },
  JOB_SOURCE_NOT_FOUND: /* i18n */ {
    id: 'api-error.JOB_SOURCE_NOT_FOUND',
    message: 'Джерело вакансій не знайдено',
  },
  JOB_SOURCE_NOT_READY: /* i18n */ {
    id: 'api-error.JOB_SOURCE_NOT_READY',
    message:
      'Джерело ще не готове: завершіть налаштування (перевірка готовності, підключення, лічильник квоти), потім увімкніть його',
  },
  JOB_SOURCE_AUTH_PAUSED: /* i18n */ {
    id: 'api-error.JOB_SOURCE_AUTH_PAUSED',
    message:
      'Джерело призупинено, бо провайдер відмовив у доступі: спершу зніміть паузу, потім увімкніть його',
  },
}

export const JOB_SOURCING_ERROR_FALLBACK_EN: Record<JobSourcingErrorCode, string> = {
  JOB_OPPORTUNITY_NOT_FOUND: 'External job not found',
  JOB_SOURCE_RECORD_NOT_FOUND: 'Source record not found',
  JOB_SOURCE_RECORD_ALREADY_LINKED: 'This source record is already linked to a job',
  JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED: 'This job cannot be assigned to the team for triage',
  JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED:
    'This senior has already been submitted to a similar job. Review it and confirm to log the submission.',
  JOB_QUEUE_REFRESH_REQUIRED: 'The list is out of date. Refresh it.',
  JOB_QUEUE_CURSOR_MALFORMED: 'This page of the list could not be opened. Refresh the list.',
  JOB_QUEUE_VERSION_CONFLICT: 'The data has changed. Refresh the card and try again.',
  JOB_QUEUE_IDEMPOTENCY_CONFLICT:
    'This request was already made with different data. Refresh the card and try again.',
  JOB_QUEUE_POLICY_UNAVAILABLE: 'Access could not be checked. Try again later.',
  JOB_QUEUE_SENIOR_INELIGIBLE:
    'This senior cannot be submitted to this job from this team. Choose another senior or another team.',
  JOB_QUEUE_RESUME_UNUSABLE: 'This resume cannot be used for this senior. Choose another one.',
  JOB_QUEUE_MANUAL_DUPLICATE: 'A job with this link already exists. No new card was created.',
  JOB_SOURCE_NOT_FOUND: 'The source was not found',
  JOB_SOURCE_NOT_READY:
    'The source is not ready yet: finish its setup (readiness check, connection, quota meter), then switch it on',
  JOB_SOURCE_AUTH_PAUSED:
    'The source is paused because the provider refused access: clear the pause first, then switch it on',
}
