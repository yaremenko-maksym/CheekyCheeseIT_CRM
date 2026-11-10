import type { MessageDescriptor } from '@lingui/core'

/**
 * Verified base resume — error codes for the facts / verification / confirm
 * flow. 4 codes, none takes params.
 */
export const RESUME_ERROR_CODES = [
  'RESUME_CONFIRM_STALE',
  'RESUME_CUSTOM_TEMPLATE',
  'RESUME_INCOMPLETE',
  'RESUME_VERIFICATION_BUSY',
] as const
export type ResumeErrorCode = (typeof RESUME_ERROR_CODES)[number]

export const RESUME_ERROR_PARAMS = {
  RESUME_CONFIRM_STALE: [],
  RESUME_CUSTOM_TEMPLATE: [],
  RESUME_INCOMPLETE: [],
  RESUME_VERIFICATION_BUSY: [],
} as const satisfies Record<ResumeErrorCode, readonly string[]>

export const RESUME_ERROR_MESSAGES: Record<ResumeErrorCode, MessageDescriptor> = {
  RESUME_CONFIRM_STALE: /* i18n */ {
    id: 'api-error.RESUME_CONFIRM_STALE',
    message: 'Резюме змінилося після перевірки. Оновіть сторінку й перевірте його ще раз.',
  },
  RESUME_CUSTOM_TEMPLATE: /* i18n */ {
    id: 'api-error.RESUME_CUSTOM_TEMPLATE',
    message: 'Цей шаблон резюме не підтримує перевірку. Оберіть шаблон із каталогу.',
  },
  RESUME_INCOMPLETE: /* i18n */ {
    id: 'api-error.RESUME_INCOMPLETE',
    message: 'Заповніть усі потрібні поля резюме перед перевіркою.',
  },
  RESUME_VERIFICATION_BUSY: /* i18n */ {
    id: 'api-error.RESUME_VERIFICATION_BUSY',
    message: 'Резюме зараз перевіряється. Зачекайте, доки перевірка завершиться.',
  },
}

export const RESUME_ERROR_FALLBACK_EN: Record<ResumeErrorCode, string> = {
  RESUME_CONFIRM_STALE: 'The resume changed after the check. Refresh the page and check it again.',
  RESUME_CUSTOM_TEMPLATE:
    'This resume template does not support verification. Choose a template from the catalog.',
  RESUME_INCOMPLETE: 'Fill in all required resume fields before the check.',
  RESUME_VERIFICATION_BUSY: 'The resume is being checked right now. Wait until the check finishes.',
}
