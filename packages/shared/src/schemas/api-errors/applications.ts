import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-6b-wave3-applications (i18n stage-6B Wave 3). Error codes for the
 * vacancy-applications throw-sites that carried literal Russian messages.
 * 6 codes. ADMIN_HR_ONLY is reused from `./vacancies` (declared there, NOT here).
 * APPLICATION_RESUME_TOO_LARGE carries `maxMb` — a config limit
 * (RESUME_MAX_BYTES), not a computed value (precedent: DOCUMENT_TOO_LARGE).
 * APPLICATION_RESUME_PDF_ONLY covers both the MIME check and the magic-byte
 * check: for the candidate the meaning is the same (a valid PDF is needed).
 * The public landing form derives its error copy from the HTTP status, so the
 * statuses of the public throw-sites must not change.
 */
export const APPLICATIONS_ERROR_CODES = [
  'APPLICATION_NOT_FOUND',
  'APPLICATION_RESUME_EXPIRED',
  'APPLICATION_RESUME_PDF_ONLY',
  'APPLICATION_RESUME_REQUIRED',
  'APPLICATION_RESUME_TOO_LARGE',
  'APPLICATION_TURNSTILE_FAILED',
] as const
export type ApplicationsErrorCode = (typeof APPLICATIONS_ERROR_CODES)[number]

export const APPLICATIONS_ERROR_PARAMS = {
  APPLICATION_NOT_FOUND: [],
  APPLICATION_RESUME_EXPIRED: [],
  APPLICATION_RESUME_PDF_ONLY: [],
  APPLICATION_RESUME_REQUIRED: [],
  APPLICATION_RESUME_TOO_LARGE: ['maxMb'],
  APPLICATION_TURNSTILE_FAILED: [],
} as const satisfies Record<ApplicationsErrorCode, readonly string[]>

export const APPLICATIONS_ERROR_MESSAGES: Record<ApplicationsErrorCode, MessageDescriptor> = {
  APPLICATION_NOT_FOUND: /* i18n */ {
    id: 'api-error.APPLICATION_NOT_FOUND',
    message: 'Відгук не знайдено',
  },
  APPLICATION_RESUME_EXPIRED: /* i18n */ {
    id: 'api-error.APPLICATION_RESUME_EXPIRED',
    message: 'Резюме видалено після завершення терміну зберігання',
  },
  APPLICATION_RESUME_PDF_ONLY: /* i18n */ {
    id: 'api-error.APPLICATION_RESUME_PDF_ONLY',
    message: 'Резюме має бути у форматі PDF',
  },
  APPLICATION_RESUME_REQUIRED: /* i18n */ {
    id: 'api-error.APPLICATION_RESUME_REQUIRED',
    message: 'Додайте файл резюме',
  },
  APPLICATION_RESUME_TOO_LARGE: /* i18n */ {
    id: 'api-error.APPLICATION_RESUME_TOO_LARGE',
    message: 'Файл резюме завеликий: максимум {maxMb} МБ',
  },
  APPLICATION_TURNSTILE_FAILED: /* i18n */ {
    id: 'api-error.APPLICATION_TURNSTILE_FAILED',
    message: 'Перевірку Turnstile не пройдено',
  },
}

export const APPLICATIONS_ERROR_FALLBACK_EN: Record<ApplicationsErrorCode, string> = {
  APPLICATION_NOT_FOUND: 'Application not found',
  APPLICATION_RESUME_EXPIRED: 'The resume was deleted after its retention period ended',
  APPLICATION_RESUME_PDF_ONLY: 'The resume must be a PDF',
  APPLICATION_RESUME_REQUIRED: 'Attach a resume file',
  APPLICATION_RESUME_TOO_LARGE: 'The resume file is too large: {maxMb} MB maximum',
  APPLICATION_TURNSTILE_FAILED: 'Turnstile check failed',
}
