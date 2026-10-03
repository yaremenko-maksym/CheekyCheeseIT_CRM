import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-6b-wave2-vacancies (i18n stage-6B Wave 2). Error codes for vacancies
 * throw-sites that carried literal Russian messages. Codes → apiError() calls.
 * 8 codes: 7 VACANCY_* plus ADMIN_HR_ONLY. ADMIN_HR_ONLY is a SHARED code that
 * is declared HERE for the first time (it is not defined anywhere else) and is
 * reused by Wave 3 (applications). VACANCY_SLUG_EXISTS carries a `slug` param,
 * VACANCY_INVALID_STATUS_TRANSITION carries `from` and `to` (enum-like status
 * values, not PII); the others are static.
 */
export const VACANCIES_ERROR_CODES = [
  'ADMIN_HR_ONLY',
  'VACANCY_CLOSE_BEFORE_DELETE',
  'VACANCY_CLOSED',
  'VACANCY_HAS_APPLICATIONS',
  'VACANCY_INVALID_STATUS_TRANSITION',
  'VACANCY_NOT_FOUND',
  'VACANCY_SALARY_RANGE_REQUIRED',
  'VACANCY_SLUG_EXISTS',
] as const
export type VacanciesErrorCode = (typeof VACANCIES_ERROR_CODES)[number]

export const VACANCIES_ERROR_PARAMS = {
  ADMIN_HR_ONLY: [],
  VACANCY_CLOSE_BEFORE_DELETE: [],
  VACANCY_CLOSED: [],
  VACANCY_HAS_APPLICATIONS: [],
  VACANCY_INVALID_STATUS_TRANSITION: ['from', 'to'],
  VACANCY_NOT_FOUND: [],
  VACANCY_SALARY_RANGE_REQUIRED: [],
  VACANCY_SLUG_EXISTS: ['slug'],
} as const satisfies Record<VacanciesErrorCode, readonly string[]>

export const VACANCIES_ERROR_MESSAGES: Record<VacanciesErrorCode, MessageDescriptor> = {
  ADMIN_HR_ONLY: /* i18n */ {
    id: 'api-error.ADMIN_HR_ONLY',
    message: 'Доступно лише для ADMIN і HR',
  },
  VACANCY_CLOSE_BEFORE_DELETE: /* i18n */ {
    id: 'api-error.VACANCY_CLOSE_BEFORE_DELETE',
    message: 'Спочатку закрийте опубліковану вакансію',
  },
  VACANCY_CLOSED: /* i18n */ {
    id: 'api-error.VACANCY_CLOSED',
    message: 'Вакансію закрито',
  },
  VACANCY_HAS_APPLICATIONS: /* i18n */ {
    id: 'api-error.VACANCY_HAS_APPLICATIONS',
    message: 'Не можна видалити вакансію з відгуками',
  },
  VACANCY_INVALID_STATUS_TRANSITION: /* i18n */ {
    id: 'api-error.VACANCY_INVALID_STATUS_TRANSITION',
    message: 'Неприпустимий перехід статусу вакансії: {from} → {to}',
  },
  VACANCY_NOT_FOUND: /* i18n */ {
    id: 'api-error.VACANCY_NOT_FOUND',
    message: 'Вакансію не знайдено',
  },
  VACANCY_SALARY_RANGE_REQUIRED: /* i18n */ {
    id: 'api-error.VACANCY_SALARY_RANGE_REQUIRED',
    message: 'Вкажіть вилку зарплати: мінімум, максимум, валюту та період',
  },
  VACANCY_SLUG_EXISTS: /* i18n */ {
    id: 'api-error.VACANCY_SLUG_EXISTS',
    message: 'Вакансія зі slug {slug} вже існує',
  },
}

export const VACANCIES_ERROR_FALLBACK_EN: Record<VacanciesErrorCode, string> = {
  ADMIN_HR_ONLY: 'Only ADMIN and HR can do this',
  VACANCY_CLOSE_BEFORE_DELETE: 'Close the published vacancy first',
  VACANCY_CLOSED: 'This vacancy is closed',
  VACANCY_HAS_APPLICATIONS: "Can't delete a vacancy that has applications",
  VACANCY_INVALID_STATUS_TRANSITION: 'Invalid vacancy status transition: {from} → {to}',
  VACANCY_NOT_FOUND: 'Vacancy not found',
  VACANCY_SALARY_RANGE_REQUIRED: 'Set the salary range: min, max, currency and period',
  VACANCY_SLUG_EXISTS: 'A vacancy with slug {slug} already exists',
}
