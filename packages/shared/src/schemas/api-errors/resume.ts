import type { MessageDescriptor } from '@lingui/core'

/**
 * Resume area error codes. The first six serve the facts / verification /
 * confirm flow. The rest (backlog 443) replace the Russian literals the resumes
 * API used to throw or store: HTTP refusals go out through `apiError()`, and the
 * extraction `error_message` / `pdf_render_error` columns hold one of these codes
 * encoded by `encodeResumeMessage` (`./resume-stored-message.ts`).
 */
export const RESUME_ERROR_CODES = [
  'RESUME_ALREADY_VERIFIED',
  'RESUME_CONFIRM_STALE',
  'RESUME_CUSTOM_TEMPLATE',
  'RESUME_INCOMPLETE',
  'RESUME_STAGED_TEXT_INVALID',
  'RESUME_VERIFICATION_BUSY',
  'RESUME_UPLOAD_NOT_MULTIPART',
  'RESUME_UPLOAD_UNREADABLE',
  'RESUME_UPLOAD_NO_FILE',
  'RESUME_UPLOAD_TOO_MANY_PARTS',
  'RESUME_NO_ACCESS',
  'RESUME_NOT_CREATED',
  'RESUME_NOT_FOUND',
  'RESUME_SENIOR_ONLY',
  'RESUME_SOURCE_MISSING',
  'RESUME_FILE_EMPTY',
  'RESUME_FILE_TOO_LARGE',
  'RESUME_FILE_UNSUPPORTED',
  'RESUME_DELETE_BUSY',
  'RESUME_CREATE_FAILED',
  'RESUME_PDF_PREPARING',
  'RESUME_AI_NOT_CONFIGURED',
  'RESUME_AI_INVALID_ANSWER',
  'RESUME_AI_UNAVAILABLE',
  'RESUME_AI_QUOTA_EXCEEDED',
  'RESUME_AI_ERROR',
  'RESUME_NO_TEXT',
  'RESUME_EXTRACTION_STALLED_FILE',
  'RESUME_EXTRACTION_STALLED_TEXT',
  'RESUME_SOURCE_LOAD_FAILED',
  'RESUME_SOURCE_CORRUPT',
  'RESUME_FILE_TOO_COMPLEX',
  'RESUME_FILE_UNREADABLE',
  'RESUME_PDF_UNREADABLE',
  'RESUME_PDF_TOO_MANY_PAGES',
  'RESUME_PDF_TOO_LARGE',
  'RESUME_DOCX_UNREADABLE',
  'RESUME_DOCX_CORRUPT',
  'RESUME_DOCX_UNSUPPORTED',
  'RESUME_DOCX_TOO_MANY_FILES',
  'RESUME_DOCX_TOO_LARGE',
  'RESUME_RENDER_TIMEOUT',
  'RESUME_RENDER_TEMPLATE_FAILED',
  'RESUME_RENDER_FAILED',
  'RESUME_RENDER_BLANK_PAGE',
  'RESUME_RENDER_MISSING_GLYPHS',
  'RESUME_RENDER_STORAGE_FAILED',
  'RESUME_DOCX_CONTENT_TOO_LARGE',
  'RESUME_PDF_TOO_BUSY',
  'RESUME_AI_VALUES_OUT_OF_RANGE',
  'RESUME_ERROR_DETAILS_UNAVAILABLE',
  // Tailored resume (spec §9): a run or an edit render is in flight, or a published variant exists
  // and the POST did not confirm the overwrite (409); the team's daily generation cap is used up
  // (429); the senior's row is not eligible (422). Out of scope stays JOB_OPPORTUNITY_NOT_FOUND.
  'TAILORED_RESUME_CONFLICT',
  'TAILORED_RESUME_DAILY_CAP',
  'TAILORED_RESUME_NOT_ELIGIBLE',
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
  RESUME_UPLOAD_NOT_MULTIPART: [],
  RESUME_UPLOAD_UNREADABLE: [],
  RESUME_UPLOAD_NO_FILE: [],
  RESUME_UPLOAD_TOO_MANY_PARTS: [],
  RESUME_NO_ACCESS: [],
  RESUME_NOT_CREATED: [],
  RESUME_NOT_FOUND: [],
  RESUME_SENIOR_ONLY: [],
  RESUME_SOURCE_MISSING: [],
  RESUME_FILE_EMPTY: [],
  RESUME_FILE_TOO_LARGE: ['mb'],
  RESUME_FILE_UNSUPPORTED: [],
  RESUME_DELETE_BUSY: [],
  RESUME_CREATE_FAILED: [],
  RESUME_PDF_PREPARING: [],
  RESUME_AI_NOT_CONFIGURED: [],
  RESUME_AI_INVALID_ANSWER: [],
  RESUME_AI_UNAVAILABLE: [],
  RESUME_AI_QUOTA_EXCEEDED: [],
  RESUME_AI_ERROR: [],
  RESUME_NO_TEXT: [],
  RESUME_EXTRACTION_STALLED_FILE: [],
  RESUME_EXTRACTION_STALLED_TEXT: [],
  RESUME_SOURCE_LOAD_FAILED: [],
  RESUME_SOURCE_CORRUPT: [],
  RESUME_FILE_TOO_COMPLEX: [],
  RESUME_FILE_UNREADABLE: [],
  RESUME_PDF_UNREADABLE: [],
  RESUME_PDF_TOO_MANY_PAGES: ['max'],
  RESUME_PDF_TOO_LARGE: ['mb'],
  RESUME_DOCX_UNREADABLE: [],
  RESUME_DOCX_CORRUPT: [],
  RESUME_DOCX_UNSUPPORTED: [],
  RESUME_DOCX_TOO_MANY_FILES: ['max'],
  RESUME_DOCX_TOO_LARGE: ['mb'],
  RESUME_RENDER_TIMEOUT: ['seconds'],
  RESUME_RENDER_TEMPLATE_FAILED: [],
  RESUME_RENDER_FAILED: [],
  RESUME_RENDER_BLANK_PAGE: [],
  RESUME_RENDER_MISSING_GLYPHS: ['glyphs'],
  RESUME_RENDER_STORAGE_FAILED: [],
  RESUME_DOCX_CONTENT_TOO_LARGE: ['mb'],
  RESUME_PDF_TOO_BUSY: ['max'],
  RESUME_AI_VALUES_OUT_OF_RANGE: [],
  // The generic fallback line for a stored message this build cannot render (unknown code, missing param).
  RESUME_ERROR_DETAILS_UNAVAILABLE: [],
  TAILORED_RESUME_CONFLICT: [],
  TAILORED_RESUME_DAILY_CAP: [],
  // `eligibility` is a `tailoredEligibilitySchema` value; the envelope carries it as a param.
  TAILORED_RESUME_NOT_ELIGIBLE: ['eligibility'],
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
  RESUME_UPLOAD_NOT_MULTIPART: /* i18n */ {
    id: 'api-error.RESUME_UPLOAD_NOT_MULTIPART',
    message: 'Не вдалося завантажити файл. Спробуйте ще раз.',
  },
  RESUME_UPLOAD_UNREADABLE: /* i18n */ {
    id: 'api-error.RESUME_UPLOAD_UNREADABLE',
    message: 'Не вдалося прочитати надісланий файл. Завантажте його ще раз.',
  },
  RESUME_UPLOAD_NO_FILE: /* i18n */ {
    id: 'api-error.RESUME_UPLOAD_NO_FILE',
    message: 'Файл резюме не додано. Додайте його й спробуйте ще раз.',
  },
  RESUME_UPLOAD_TOO_MANY_PARTS: /* i18n */ {
    id: 'api-error.RESUME_UPLOAD_TOO_MANY_PARTS',
    message: 'Забагато файлів. Додайте лише один файл резюме й спробуйте ще раз.',
  },
  RESUME_NO_ACCESS: /* i18n */ {
    id: 'api-error.RESUME_NO_ACCESS',
    message: 'Немає доступу до резюме цього користувача.',
  },
  RESUME_NOT_CREATED: /* i18n */ {
    id: 'api-error.RESUME_NOT_CREATED',
    message: 'Резюме ще не створено.',
  },
  RESUME_NOT_FOUND: /* i18n */ {
    id: 'api-error.RESUME_NOT_FOUND',
    message: 'Резюме не знайдено. Оновіть сторінку.',
  },
  RESUME_SENIOR_ONLY: /* i18n */ {
    id: 'api-error.RESUME_SENIOR_ONLY',
    message: 'Резюме ведеться лише для сеньйорів.',
  },
  RESUME_SOURCE_MISSING: /* i18n */ {
    id: 'api-error.RESUME_SOURCE_MISSING',
    message: 'Оригінал файлу резюме не завантажено.',
  },
  RESUME_FILE_EMPTY: /* i18n */ {
    id: 'api-error.RESUME_FILE_EMPTY',
    message: 'Файл порожній. Оберіть інший файл.',
  },
  RESUME_FILE_TOO_LARGE: /* i18n */ {
    id: 'api-error.RESUME_FILE_TOO_LARGE',
    message: 'Файл більший за {mb} МБ. Завантажте менший файл або вставте текст.',
  },
  RESUME_FILE_UNSUPPORTED: /* i18n */ {
    id: 'api-error.RESUME_FILE_UNSUPPORTED',
    message: 'Підтримуються лише PDF і DOCX. Вміст файлу не відповідає жодному з цих форматів.',
  },
  RESUME_DELETE_BUSY: /* i18n */ {
    id: 'api-error.RESUME_DELETE_BUSY',
    message: 'Резюме саме зараз змінюється. Повторіть видалення за кілька секунд.',
  },
  RESUME_CREATE_FAILED: /* i18n */ {
    id: 'api-error.RESUME_CREATE_FAILED',
    message: 'Не вдалося створити резюме. Спробуйте ще раз.',
  },
  RESUME_PDF_PREPARING: /* i18n */ {
    id: 'api-error.RESUME_PDF_PREPARING',
    message: 'Готуємо PDF за шаблоном резюме. Оновіть сторінку за кілька секунд.',
  },
  RESUME_AI_NOT_CONFIGURED: /* i18n */ {
    id: 'api-error.RESUME_AI_NOT_CONFIGURED',
    message:
      'Автоматичне розпізнавання недоступне: сервіс ШІ не налаштовано. Заповніть резюме вручну.',
  },
  RESUME_AI_INVALID_ANSWER: /* i18n */ {
    id: 'api-error.RESUME_AI_INVALID_ANSWER',
    message: 'Не вдалося правильно розпізнати резюме. Перевірте поля й заповніть їх вручну.',
  },
  RESUME_AI_UNAVAILABLE: /* i18n */ {
    id: 'api-error.RESUME_AI_UNAVAILABLE',
    message: 'Сервіс розпізнавання недоступний. Спробуйте пізніше або заповніть резюме вручну.',
  },
  RESUME_AI_QUOTA_EXCEEDED: /* i18n */ {
    id: 'api-error.RESUME_AI_QUOTA_EXCEEDED',
    message: 'Вичерпано добовий ліміт безкоштовних запитів до ШІ.',
  },
  RESUME_AI_ERROR: /* i18n */ {
    id: 'api-error.RESUME_AI_ERROR',
    message: 'Сервіс розпізнавання повернув помилку. Заповніть резюме вручну.',
  },
  RESUME_NO_TEXT: /* i18n */ {
    id: 'api-error.RESUME_NO_TEXT',
    message:
      'З файлу не вдалося витягти текст (імовірно, це скан або картинка). Вставте текст резюме вручну.',
  },
  RESUME_EXTRACTION_STALLED_FILE: /* i18n */ {
    id: 'api-error.RESUME_EXTRACTION_STALLED_FILE',
    message:
      'Розпізнавання перервалося (сервіс перезапустився). Завантажте файл ще раз або заповніть резюме вручну.',
  },
  RESUME_EXTRACTION_STALLED_TEXT: /* i18n */ {
    id: 'api-error.RESUME_EXTRACTION_STALLED_TEXT',
    message:
      'Розпізнавання перервалося (сервіс перезапустився). Вставте текст резюме ще раз або заповніть форму вручну.',
  },
  RESUME_SOURCE_LOAD_FAILED: /* i18n */ {
    id: 'api-error.RESUME_SOURCE_LOAD_FAILED',
    message:
      'Не вдалося прочитати оригінал файлу резюме. Завантажте його ще раз або вставте текст.',
  },
  RESUME_SOURCE_CORRUPT: /* i18n */ {
    id: 'api-error.RESUME_SOURCE_CORRUPT',
    message: 'Оригінал файлу пошкоджено. Завантажте файл ще раз або вставте текст.',
  },
  RESUME_FILE_TOO_COMPLEX: /* i18n */ {
    id: 'api-error.RESUME_FILE_TOO_COMPLEX',
    message: 'Документ надто складний для автоматичної обробки. Вставте текст резюме вручну.',
  },
  RESUME_FILE_UNREADABLE: /* i18n */ {
    id: 'api-error.RESUME_FILE_UNREADABLE',
    message: 'Не вдалося прочитати файл резюме. Завантажте інший файл або вставте текст.',
  },
  RESUME_PDF_UNREADABLE: /* i18n */ {
    id: 'api-error.RESUME_PDF_UNREADABLE',
    message: 'Не вдалося прочитати PDF-файл. Завантажте інший файл або вставте текст.',
  },
  RESUME_PDF_TOO_MANY_PAGES: /* i18n */ {
    id: 'api-error.RESUME_PDF_TOO_MANY_PAGES',
    message: 'У PDF понад {max} сторінок — це не схоже на резюме.',
  },
  RESUME_PDF_TOO_LARGE: /* i18n */ {
    id: 'api-error.RESUME_PDF_TOO_LARGE',
    message: 'Вміст PDF після розпакування більший за {mb} МБ — це не схоже на резюме.',
  },
  RESUME_DOCX_UNREADABLE: /* i18n */ {
    id: 'api-error.RESUME_DOCX_UNREADABLE',
    message: 'Не вдалося прочитати DOCX-файл. Завантажте інший файл або вставте текст.',
  },
  RESUME_DOCX_CORRUPT: /* i18n */ {
    id: 'api-error.RESUME_DOCX_CORRUPT',
    message: 'DOCX-файл пошкоджено. Збережіть його ще раз або вставте текст.',
  },
  RESUME_DOCX_UNSUPPORTED: /* i18n */ {
    id: 'api-error.RESUME_DOCX_UNSUPPORTED',
    message:
      'Цей файл DOCX збережено у непідтримуваному форматі. Збережіть його ще раз у Word або вставте текст.',
  },
  RESUME_DOCX_TOO_MANY_FILES: /* i18n */ {
    id: 'api-error.RESUME_DOCX_TOO_MANY_FILES',
    message: 'У DOCX забагато вкладених файлів (понад {max}) — це не схоже на резюме.',
  },
  RESUME_DOCX_TOO_LARGE: /* i18n */ {
    id: 'api-error.RESUME_DOCX_TOO_LARGE',
    message: 'Розпакований DOCX більший за {mb} МБ — це не схоже на резюме.',
  },
  RESUME_RENDER_TIMEOUT: /* i18n */ {
    id: 'api-error.RESUME_RENDER_TIMEOUT',
    message: 'Не вдалося зібрати PDF: верстка не вклалася в {seconds} с.',
  },
  RESUME_RENDER_TEMPLATE_FAILED: /* i18n */ {
    id: 'api-error.RESUME_RENDER_TEMPLATE_FAILED',
    message:
      'Не вдалося зібрати PDF за шаблоном резюме. Перевірте оформлення або зверніться до адміністратора.',
  },
  RESUME_RENDER_FAILED: /* i18n */ {
    id: 'api-error.RESUME_RENDER_FAILED',
    message: 'Не вдалося зібрати PDF резюме. Спробуйте пізніше.',
  },
  RESUME_RENDER_BLANK_PAGE: /* i18n */ {
    id: 'api-error.RESUME_RENDER_BLANK_PAGE',
    message:
      'Шаблон резюме зібрався в порожню сторінку — імовірно, у ньому є символ, який не відображається доступними шрифтами. Перевірте оформлення або зверніться до адміністратора.',
  },
  RESUME_RENDER_MISSING_GLYPHS: /* i18n */ {
    id: 'api-error.RESUME_RENDER_MISSING_GLYPHS',
    message:
      'У шаблоні резюме є символи, які не відображаються доступними шрифтами: {glyphs}. Замініть їх або додайте шрифт із цими гліфами.',
  },
  RESUME_RENDER_STORAGE_FAILED: /* i18n */ {
    id: 'api-error.RESUME_RENDER_STORAGE_FAILED',
    message: 'PDF зібрано, але не збережено у сховищі. Спробуйте пізніше.',
  },
  RESUME_DOCX_CONTENT_TOO_LARGE: /* i18n */ {
    id: 'api-error.RESUME_DOCX_CONTENT_TOO_LARGE',
    message: 'Текст усередині DOCX більший за {mb} МБ — це не схоже на резюме.',
  },
  RESUME_PDF_TOO_BUSY: /* i18n */ {
    id: 'api-error.RESUME_PDF_TOO_BUSY',
    message: 'У PDF забагато текстових операцій (межа {max}) — це не схоже на резюме.',
  },
  RESUME_AI_VALUES_OUT_OF_RANGE: /* i18n */ {
    id: 'api-error.RESUME_AI_VALUES_OUT_OF_RANGE',
    message: 'Частину даних резюме розпізнано неправильно. Перевірте поля й заповніть їх вручну.',
  },
  RESUME_ERROR_DETAILS_UNAVAILABLE: /* i18n */ {
    id: 'api-error.RESUME_ERROR_DETAILS_UNAVAILABLE',
    message: 'Подробиці цієї помилки недоступні.',
  },
  TAILORED_RESUME_CONFLICT: /* i18n */ {
    id: 'api-error.TAILORED_RESUME_CONFLICT',
    message:
      'Резюме під цю вакансію вже готується або змінюється. Оновіть сторінку й спробуйте ще раз.',
  },
  TAILORED_RESUME_DAILY_CAP: /* i18n */ {
    id: 'api-error.TAILORED_RESUME_DAILY_CAP',
    message: 'Команда вичерпала денний ліміт генерацій резюме. Спробуйте завтра.',
  },
  TAILORED_RESUME_NOT_ELIGIBLE: /* i18n */ {
    id: 'api-error.TAILORED_RESUME_NOT_ELIGIBLE',
    message:
      'Резюме під вакансію не можна згенерувати: {eligibility, select, NO_VERIFIED_RESUME {у сеньйора немає підтвердженого резюме} NON_ENGLISH {резюме має бути англійською} NON_LATIN_NAME {імʼя має бути латиницею} POSTING_PENDING {текст вакансії ще завантажується} other {умови не виконано}}.',
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
  RESUME_UPLOAD_NOT_MULTIPART: 'Could not upload the file. Try again.',
  RESUME_UPLOAD_UNREADABLE: 'The uploaded file could not be read. Upload it again.',
  RESUME_UPLOAD_NO_FILE: 'No resume file was attached. Attach one and try again.',
  RESUME_UPLOAD_TOO_MANY_PARTS:
    'Too many files in one upload. Attach one resume file and try again.',
  RESUME_NO_ACCESS: 'You have no access to this user’s resume.',
  RESUME_NOT_CREATED: 'The resume has not been created yet.',
  RESUME_NOT_FOUND: 'The resume was not found. Refresh the page.',
  RESUME_SENIOR_ONLY: 'Resumes are kept for seniors only.',
  RESUME_SOURCE_MISSING: 'The original resume file has not been uploaded.',
  RESUME_FILE_EMPTY: 'The file is empty. Choose another file.',
  RESUME_FILE_TOO_LARGE:
    'The file is larger than {mb} MB. Upload a smaller file or paste the text.',
  RESUME_FILE_UNSUPPORTED:
    'Only PDF and DOCX are supported. The file content matches neither format.',
  RESUME_DELETE_BUSY:
    'The resume is being changed right now. Try deleting it again in a few seconds.',
  RESUME_CREATE_FAILED: 'The resume could not be created. Try again.',
  RESUME_PDF_PREPARING:
    'The PDF is being built from the resume template. Refresh the page in a few seconds.',
  RESUME_AI_NOT_CONFIGURED:
    'Automatic recognition is unavailable: the AI service is not set up. Fill in the resume by hand.',
  RESUME_AI_INVALID_ANSWER:
    'The resume could not be recognized correctly. Check the fields and fill them in by hand.',
  RESUME_AI_UNAVAILABLE:
    'The recognition service is unavailable. Try later or fill in the resume by hand.',
  RESUME_AI_QUOTA_EXCEEDED: 'The daily limit of free AI requests is used up.',
  RESUME_AI_ERROR: 'The recognition service returned an error. Fill in the resume by hand.',
  RESUME_NO_TEXT:
    'No text could be taken from the file (it is probably a scan or an image). Paste the resume text by hand.',
  RESUME_EXTRACTION_STALLED_FILE:
    'Recognition stopped (the service restarted). Upload the file again or fill in the resume by hand.',
  RESUME_EXTRACTION_STALLED_TEXT:
    'Recognition stopped (the service restarted). Paste the resume text again or fill in the form by hand.',
  RESUME_SOURCE_LOAD_FAILED:
    'The original resume file could not be read. Upload it again or paste the text.',
  RESUME_SOURCE_CORRUPT: 'The original file is damaged. Upload the file again or paste the text.',
  RESUME_FILE_TOO_COMPLEX:
    'The document is too complex to process automatically. Paste the resume text by hand.',
  RESUME_FILE_UNREADABLE:
    'The resume file could not be read. Upload another file or paste the text.',
  RESUME_PDF_UNREADABLE: 'The PDF file could not be read. Upload another file or paste the text.',
  RESUME_PDF_TOO_MANY_PAGES:
    'The PDF has more than {max} pages, which does not look like a resume.',
  RESUME_PDF_TOO_LARGE:
    'The PDF content is larger than {mb} MB once unpacked, which does not look like a resume.',
  RESUME_DOCX_UNREADABLE: 'The DOCX file could not be read. Upload another file or paste the text.',
  RESUME_DOCX_CORRUPT: 'The DOCX file is damaged. Save it again or paste the text.',
  RESUME_DOCX_UNSUPPORTED:
    'This DOCX file is saved in an unsupported format. Save it again in Word or paste the text.',
  RESUME_DOCX_TOO_MANY_FILES:
    'The DOCX holds too many inner files (over {max}), which does not look like a resume.',
  RESUME_DOCX_TOO_LARGE:
    'The unpacked DOCX is larger than {mb} MB, which does not look like a resume.',
  RESUME_RENDER_TIMEOUT:
    'The PDF could not be built: the layout did not finish within {seconds} s.',
  RESUME_RENDER_TEMPLATE_FAILED:
    'The PDF could not be built from the resume template. Check the layout or contact an administrator.',
  RESUME_RENDER_FAILED: 'The resume PDF could not be built. Try later.',
  RESUME_RENDER_BLANK_PAGE:
    'The resume template built a blank page. It probably holds a character the available fonts cannot draw. Check the layout or contact an administrator.',
  RESUME_RENDER_MISSING_GLYPHS:
    'The resume template holds characters the available fonts cannot draw: {glyphs}. Replace them or add a font with these glyphs.',
  RESUME_RENDER_STORAGE_FAILED: 'The PDF was built but not saved to storage. Try later.',
  RESUME_DOCX_CONTENT_TOO_LARGE:
    'The text inside the DOCX is larger than {mb} MB, which does not look like a resume.',
  RESUME_PDF_TOO_BUSY:
    'The PDF has too many text operations (the limit is {max}), which does not look like a resume.',
  RESUME_AI_VALUES_OUT_OF_RANGE:
    'Some resume data was recognized incorrectly. Check the fields and fill them in by hand.',
  RESUME_ERROR_DETAILS_UNAVAILABLE: 'No details are available for this error.',
  TAILORED_RESUME_CONFLICT:
    'A resume for this job is already being prepared or changed. Refresh the page and try again.',
  TAILORED_RESUME_DAILY_CAP:
    'The team has used up its daily limit of resume generations. Try again tomorrow.',
  TAILORED_RESUME_NOT_ELIGIBLE:
    'A resume for this job cannot be generated: {eligibility, select, NO_VERIFIED_RESUME {the senior has no verified resume} NON_ENGLISH {the resume must be in English} NON_LATIN_NAME {the name must be in Latin letters} POSTING_PENDING {the job text is still loading} other {the conditions are not met}}.',
}
