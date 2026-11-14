import type { MessageDescriptor } from '@lingui/core'

/**
 * Verified base resume — error codes for the facts / verification / confirm
 * flow. 6 codes; only RESUME_STAGED_TEXT_INVALID takes a param (`reason`).
 */
export const RESUME_ERROR_CODES = [
  'RESUME_ALREADY_VERIFIED',
  'RESUME_CONFIRM_STALE',
  'RESUME_CUSTOM_TEMPLATE',
  'RESUME_INCOMPLETE',
  'RESUME_STAGED_TEXT_INVALID',
  'RESUME_VERIFICATION_BUSY',
] as const
export type ResumeErrorCode = (typeof RESUME_ERROR_CODES)[number]

export const RESUME_ERROR_PARAMS = {
  RESUME_ALREADY_VERIFIED: [],
  RESUME_CONFIRM_STALE: [],
  RESUME_CUSTOM_TEMPLATE: [],
  RESUME_INCOMPLETE: [],
  // `reason` is NON_LATIN or CONTACT_IN_TEXT; the matched text is never echoed (ruling P7).
  RESUME_STAGED_TEXT_INVALID: ['reason'],
  RESUME_VERIFICATION_BUSY: [],
} as const satisfies Record<ResumeErrorCode, readonly string[]>

export const RESUME_ERROR_MESSAGES: Record<ResumeErrorCode, MessageDescriptor> = {
  RESUME_ALREADY_VERIFIED: /* i18n */ {
    id: 'api-error.RESUME_ALREADY_VERIFIED',
    message: 'Резюме вже підтверджено. Змініть факти, щоб надіслати його знову.',
  },
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
  RESUME_STAGED_TEXT_INVALID: /* i18n */ {
    id: 'api-error.RESUME_STAGED_TEXT_INVALID',
    message:
      'Текст не збережено: {reason, select, NON_LATIN {пишіть лише латиницею} CONTACT_IN_TEXT {приберіть ім’я, email або телефон} other {перевірте текст}}.',
  },
  RESUME_VERIFICATION_BUSY: /* i18n */ {
    id: 'api-error.RESUME_VERIFICATION_BUSY',
    message: 'Резюме зараз перевіряється. Зачекайте, доки перевірка завершиться.',
  },
}

export const RESUME_ERROR_FALLBACK_EN: Record<ResumeErrorCode, string> = {
  RESUME_ALREADY_VERIFIED: 'The resume is already verified. Change the facts to submit it again.',
  RESUME_CONFIRM_STALE: 'The resume changed after the check. Refresh the page and check it again.',
  RESUME_CUSTOM_TEMPLATE:
    'This resume template cannot be checked. Choose a template from the catalog.',
  RESUME_INCOMPLETE: 'Fill in all required resume fields before the check.',
  RESUME_STAGED_TEXT_INVALID:
    'The text was not saved: {reason, select, NON_LATIN {use Latin letters only} CONTACT_IN_TEXT {remove the name, email or phone number} other {check the text}}.',
  RESUME_VERIFICATION_BUSY: 'The resume is being checked right now. Wait until the check finishes.',
}
