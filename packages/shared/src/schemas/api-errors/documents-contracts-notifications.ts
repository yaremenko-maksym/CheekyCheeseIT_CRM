import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage4-task3 (Track A). Error codes for `documents`/`contracts`/
 * `teams`/`legends`/`approvals`/`interviews`/`notifications` throw-sites
 * that used to carry a literal Russian or English message — `apiError()`
 * call sites now route through these codes instead. Source locale is
 * Ukrainian (spec decision: Russian leaves the product; see `CONTEXT.md`).
 *
 * Two codes keep their PRE-EXISTING literal names
 * (`ADMIN_DOES_NOT_SIGN_CONTRACTS`, `LEGAL_NAME_REQUIRED`) rather than a
 * fresh `<MODULE>_...` name: `apps/web/app/components/onboarding/
 * SignContractStep.tsx` already matched the raw exception message against
 * these exact strings via `.includes()` (task plan Step 1, "сообщение =
 * идентификатор" — COPY-H-api-3) — this PR switches that call site to
 * `getApiErrorCode(err) === '<name>'`, so keeping the name avoids a
 * pointless rename on both sides of the same PR.
 *
 * A number of codes here are reused ACROSS this file's own modules, and a
 * few reuse codes Task 1 already registered in `auth-users-projects.ts`
 * (`USER_NOT_FOUND`, `PROJECT_NOT_FOUND`, `SENIOR_NOT_FOUND`,
 * `DROP_NOT_FOUND`, `HR_REQUIRED_MINIMUM_ONE`,
 * `JUNIOR_ALREADY_ON_ANOTHER_PROJECT`) — dedupe is deliberate (audit §696
 * п.5 / lesson #7, task-i18n-stage4-lessons-701): the underlying refusal is
 * the same across call sites, and no distinguishing context is lost by
 * sharing one code. Reused codes are declared in `auth-users-projects.ts`
 * and are NOT redeclared here (would fail this file's own
 * "no code declared twice" invariant test).
 *
 * `role`/`category`/`expectedRole`/`actualRole`/`status` params are ICU
 * `select` enum values, never PII (lesson #4 — no raw enum leaks into text,
 * `CONTEXT.md` glossary labels only). `mimeType`/`declaredMime`/
 * `detectedMime`/`maxMb`/`keys` are technical values with no personal data.
 */
export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES = [
  // documents
  'DOCUMENT_MIME_NOT_ALLOWED',
  'DOCUMENT_CONTENT_UNRECOGNIZED',
  'DOCUMENT_CONTENT_TYPE_MISMATCH',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_PROJECT_ID_REQUIRED',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_DELETE_OWNER_OR_ADMIN_ONLY',
  'DOCUMENT_RESTORE_ADMIN_ONLY',
  'DOCUMENT_HARD_DELETE_ADMIN_ONLY',
  'DOCUMENT_HARD_DELETE_REQUIRES_SOFT_DELETE',
  'DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN',
  'DOCUMENT_UPLOAD_SELF_ONLY',
  'DOCUMENT_UPLOAD_CONTRACT_RESTRICTED',
  'DOCUMENT_UPLOAD_AVATAR_SELF_ONLY',
  'DOCUMENT_UPLOAD_INVOICE_FORBIDDEN',
  'DOCUMENT_MULTIPART_REQUIRED',
  'DOCUMENT_FILE_FIELD_MISSING',
  // contracts
  'CONTRACT_TEMPLATE_INVALID_ROLE',
  'CONTRACT_TEMPLATE_NOT_FOUND',
  'CONTRACT_TEMPLATE_ADMIN_NONE',
  'CONTRACT_TEMPLATE_ADMIN_PUBLISH_FORBIDDEN',
  'CONTRACT_TEMPLATE_DUPLICATE_ACTIVE',
  'CONTRACT_VIEW_SELF_ONLY',
  'SIGNED_CONTRACT_NOT_FOUND',
  'CONTRACT_ADMIN_NOT_ALLOWED',
  'CONTRACT_NOT_EDITABLE',
  'CONTRACT_NOT_DRAFT',
  'CONTRACT_ALREADY_STATUS_CANNOT_REVERT',
  'CONTRACT_NOT_READY',
  'CONTRACT_UNKNOWN_CUSTOM_VARIABLE_KEYS',
  'EMPLOYEE_CONTRACT_NOT_FOUND',
  'ADMIN_DOES_NOT_SIGN_CONTRACTS',
  'LEGAL_NAME_REQUIRED',
  // teams
  'TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM',
  'TEAM_NOT_FOUND',
  'TEAM_SENIOR_SHARE_OVERRIDE_TEAM_LEVEL_FORBIDDEN',
  'TEAM_ALREADY_ARCHIVED',
  'TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE',
  'TEAM_NOT_ARCHIVED',
  'TEAM_ADMIN_CANNOT_BE_MEMBER',
  'TEAM_ADD_SENIOR_ADMIN_ONLY',
  'TEAM_ALREADY_HAS_SENIOR',
  'TEAM_USER_ALREADY_MEMBER',
  'TEAM_MEMBER_NOT_FOUND',
  'TEAM_CANNOT_REMOVE_SENIOR',
  'TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE',
  'TEAM_USER_NOT_FOUND_OR_WRONG_ROLE',
  'TEAM_UNEXPECTED_USER_ROLE',
  'TEAM_DROP_TEAMS_ONLY',
  // legends
  'LEGEND_ACCESS_DENIED',
  'LEGEND_EDIT_ACCESS_DENIED',
  'LEGEND_UPSERT_FAILED',
  'LEGEND_NOT_FOUND',
  // approvals
  'APPROVAL_NOT_FOUND_OR_CLOSED',
  'APPROVAL_ALREADY_DECIDED',
  // interviews
  'INTERVIEW_NO_ACTIVE_TEAM',
  'INTERVIEW_SENIOR_ID_REQUIRED',
  'INTERVIEW_SENIOR_NOT_IN_YOUR_TEAMS',
  'INTERVIEW_JUNIOR_FORBIDDEN',
  'INTERVIEW_NOT_FOUND',
  'INTERVIEW_HR_SUMMARY_FORBIDDEN',
  'INTERVIEW_DROP_FORBIDDEN',
  'INTERVIEW_SENIOR_ID_INVALID',
  // notifications
  'NOTIFICATION_NOT_FOUND',
] as const
export type DocumentsContractsNotificationsErrorCode =
  (typeof DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES)[number]

export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_PARAMS = {
  DOCUMENT_MIME_NOT_ALLOWED: ['mimeType'],
  DOCUMENT_CONTENT_UNRECOGNIZED: [],
  DOCUMENT_CONTENT_TYPE_MISMATCH: ['declaredMime', 'detectedMime'],
  DOCUMENT_TOO_LARGE: ['maxMb'],
  DOCUMENT_PROJECT_ID_REQUIRED: [],
  DOCUMENT_NOT_FOUND: [],
  DOCUMENT_DELETE_OWNER_OR_ADMIN_ONLY: [],
  DOCUMENT_RESTORE_ADMIN_ONLY: [],
  DOCUMENT_HARD_DELETE_ADMIN_ONLY: [],
  DOCUMENT_HARD_DELETE_REQUIRES_SOFT_DELETE: [],
  DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN: ['role', 'category'],
  DOCUMENT_UPLOAD_SELF_ONLY: ['role'],
  DOCUMENT_UPLOAD_CONTRACT_RESTRICTED: [],
  DOCUMENT_UPLOAD_AVATAR_SELF_ONLY: [],
  DOCUMENT_UPLOAD_INVOICE_FORBIDDEN: [],
  DOCUMENT_MULTIPART_REQUIRED: [],
  DOCUMENT_FILE_FIELD_MISSING: [],
  CONTRACT_TEMPLATE_INVALID_ROLE: [],
  CONTRACT_TEMPLATE_NOT_FOUND: [],
  CONTRACT_TEMPLATE_ADMIN_NONE: [],
  CONTRACT_TEMPLATE_ADMIN_PUBLISH_FORBIDDEN: [],
  CONTRACT_TEMPLATE_DUPLICATE_ACTIVE: [],
  CONTRACT_VIEW_SELF_ONLY: [],
  SIGNED_CONTRACT_NOT_FOUND: [],
  CONTRACT_ADMIN_NOT_ALLOWED: [],
  CONTRACT_NOT_EDITABLE: [],
  CONTRACT_NOT_DRAFT: [],
  CONTRACT_ALREADY_STATUS_CANNOT_REVERT: ['status'],
  CONTRACT_NOT_READY: [],
  CONTRACT_UNKNOWN_CUSTOM_VARIABLE_KEYS: ['keys'],
  EMPLOYEE_CONTRACT_NOT_FOUND: [],
  ADMIN_DOES_NOT_SIGN_CONTRACTS: [],
  LEGAL_NAME_REQUIRED: [],
  TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM: [],
  TEAM_NOT_FOUND: [],
  TEAM_SENIOR_SHARE_OVERRIDE_TEAM_LEVEL_FORBIDDEN: [],
  TEAM_ALREADY_ARCHIVED: [],
  TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE: [],
  TEAM_NOT_ARCHIVED: [],
  TEAM_ADMIN_CANNOT_BE_MEMBER: [],
  TEAM_ADD_SENIOR_ADMIN_ONLY: [],
  TEAM_ALREADY_HAS_SENIOR: [],
  TEAM_USER_ALREADY_MEMBER: [],
  TEAM_MEMBER_NOT_FOUND: [],
  TEAM_CANNOT_REMOVE_SENIOR: [],
  TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE: [],
  TEAM_USER_NOT_FOUND_OR_WRONG_ROLE: [],
  TEAM_UNEXPECTED_USER_ROLE: ['expectedRole', 'actualRole'],
  TEAM_DROP_TEAMS_ONLY: [],
  LEGEND_ACCESS_DENIED: [],
  LEGEND_EDIT_ACCESS_DENIED: [],
  LEGEND_UPSERT_FAILED: [],
  LEGEND_NOT_FOUND: [],
  APPROVAL_NOT_FOUND_OR_CLOSED: [],
  APPROVAL_ALREADY_DECIDED: [],
  INTERVIEW_NO_ACTIVE_TEAM: [],
  INTERVIEW_SENIOR_ID_REQUIRED: [],
  INTERVIEW_SENIOR_NOT_IN_YOUR_TEAMS: [],
  INTERVIEW_JUNIOR_FORBIDDEN: [],
  INTERVIEW_NOT_FOUND: [],
  INTERVIEW_HR_SUMMARY_FORBIDDEN: [],
  INTERVIEW_DROP_FORBIDDEN: [],
  INTERVIEW_SENIOR_ID_INVALID: [],
  NOTIFICATION_NOT_FOUND: [],
} as const satisfies Record<DocumentsContractsNotificationsErrorCode, readonly string[]>

export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_MESSAGES: Record<
  DocumentsContractsNotificationsErrorCode,
  MessageDescriptor
> = {
  DOCUMENT_MIME_NOT_ALLOWED: /* i18n */ {
    id: 'api-error.DOCUMENT_MIME_NOT_ALLOWED',
    message:
      'Тип файлу «{mimeType}» не підтримується. Дозволені формати: PDF, JPEG, PNG, WEBP, HEIC',
  },
  DOCUMENT_CONTENT_UNRECOGNIZED: /* i18n */ {
    id: 'api-error.DOCUMENT_CONTENT_UNRECOGNIZED',
    message: 'Вміст файлу не відповідає жодному з дозволених форматів',
  },
  DOCUMENT_CONTENT_TYPE_MISMATCH: /* i18n */ {
    id: 'api-error.DOCUMENT_CONTENT_TYPE_MISMATCH',
    message:
      'Вміст файлу не відповідає заявленому типу: заявлено «{declaredMime}», виявлено «{detectedMime}»',
  },
  DOCUMENT_TOO_LARGE: /* i18n */ {
    id: 'api-error.DOCUMENT_TOO_LARGE',
    message: 'Файл більший за {maxMb} МБ',
  },
  DOCUMENT_PROJECT_ID_REQUIRED: /* i18n */ {
    id: 'api-error.DOCUMENT_PROJECT_ID_REQUIRED',
    message: 'Для документів категорії «Договір» потрібен проєкт',
  },
  DOCUMENT_NOT_FOUND: /* i18n */ {
    id: 'api-error.DOCUMENT_NOT_FOUND',
    message: 'Документ не знайдено',
  },
  DOCUMENT_DELETE_OWNER_OR_ADMIN_ONLY: /* i18n */ {
    id: 'api-error.DOCUMENT_DELETE_OWNER_OR_ADMIN_ONLY',
    message: 'Видалити документ може лише власник або адміністратор',
  },
  DOCUMENT_RESTORE_ADMIN_ONLY: /* i18n */ {
    id: 'api-error.DOCUMENT_RESTORE_ADMIN_ONLY',
    message: 'Відновити документ може лише адміністратор',
  },
  DOCUMENT_HARD_DELETE_ADMIN_ONLY: /* i18n */ {
    id: 'api-error.DOCUMENT_HARD_DELETE_ADMIN_ONLY',
    message: 'Видалити документ остаточно може лише адміністратор',
  },
  DOCUMENT_HARD_DELETE_REQUIRES_SOFT_DELETE: /* i18n */ {
    id: 'api-error.DOCUMENT_HARD_DELETE_REQUIRES_SOFT_DELETE',
    message: 'Спершу перемістіть документ у кошик, а тоді видаляйте остаточно',
  },
  DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN: /* i18n */ {
    id: 'api-error.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN',
    message:
      '{role, select, JUNIOR {Джуніор} HR {HR} ACCOUNTANT {Бухгалтер} SENIOR {Сеньйор} DROP {Дроп} other {Співробітник}} ' +
      'не може завантажувати {category, select, CONTRACT {договори} RECEIPT {чеки} LOGO {логотипи} other {документи}}',
  },
  DOCUMENT_UPLOAD_SELF_ONLY: /* i18n */ {
    id: 'api-error.DOCUMENT_UPLOAD_SELF_ONLY',
    message:
      '{role, select, JUNIOR {Джуніор} DROP {Дроп} other {Співробітник}} може завантажувати лише власні документи',
  },
  DOCUMENT_UPLOAD_CONTRACT_RESTRICTED: /* i18n */ {
    id: 'api-error.DOCUMENT_UPLOAD_CONTRACT_RESTRICTED',
    message: 'Завантажити договір може лише адміністратор, сеньйор або дроп — за себе',
  },
  DOCUMENT_UPLOAD_AVATAR_SELF_ONLY: /* i18n */ {
    id: 'api-error.DOCUMENT_UPLOAD_AVATAR_SELF_ONLY',
    message: 'Аватар можна завантажити лише для власного профілю',
  },
  DOCUMENT_UPLOAD_INVOICE_FORBIDDEN: /* i18n */ {
    id: 'api-error.DOCUMENT_UPLOAD_INVOICE_FORBIDDEN',
    message:
      'Документи категорії «Рахунок» створює лише система — завантажити їх через цей запит не можна',
  },
  DOCUMENT_MULTIPART_REQUIRED: /* i18n */ {
    id: 'api-error.DOCUMENT_MULTIPART_REQUIRED',
    message: 'Тип вмісту запиту має бути multipart/form-data',
  },
  DOCUMENT_FILE_FIELD_MISSING: /* i18n */ {
    id: 'api-error.DOCUMENT_FILE_FIELD_MISSING',
    message: 'У тілі запиту відсутнє поле «file»',
  },
  CONTRACT_TEMPLATE_INVALID_ROLE: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_INVALID_ROLE',
    message: 'Некоректна роль шаблону контракту',
  },
  CONTRACT_TEMPLATE_NOT_FOUND: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_NOT_FOUND',
    message: 'Шаблон контракту не знайдено',
  },
  CONTRACT_TEMPLATE_ADMIN_NONE: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_ADMIN_NONE',
    message: 'Для адміністратора немає шаблону контракту',
  },
  CONTRACT_TEMPLATE_ADMIN_PUBLISH_FORBIDDEN: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_ADMIN_PUBLISH_FORBIDDEN',
    message: 'Опублікувати шаблон контракту адміністратора не можна',
  },
  CONTRACT_TEMPLATE_DUPLICATE_ACTIVE: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_DUPLICATE_ACTIVE',
    message: 'Активний шаблон контракту для цієї ролі вже існує',
  },
  CONTRACT_VIEW_SELF_ONLY: /* i18n */ {
    id: 'api-error.CONTRACT_VIEW_SELF_ONLY',
    message: 'Переглянути можна лише власний контракт',
  },
  SIGNED_CONTRACT_NOT_FOUND: /* i18n */ {
    id: 'api-error.SIGNED_CONTRACT_NOT_FOUND',
    message: 'Підписаний контракт не знайдено',
  },
  CONTRACT_ADMIN_NOT_ALLOWED: /* i18n */ {
    id: 'api-error.CONTRACT_ADMIN_NOT_ALLOWED',
    message: 'Адміністратори не можуть мати трудовий контракт',
  },
  CONTRACT_NOT_EDITABLE: /* i18n */ {
    id: 'api-error.CONTRACT_NOT_EDITABLE',
    message: 'Контракт більше не можна редагувати',
  },
  CONTRACT_NOT_DRAFT: /* i18n */ {
    id: 'api-error.CONTRACT_NOT_DRAFT',
    message: 'Контракт більше не в статусі чернетки — оновіть сторінку',
  },
  CONTRACT_ALREADY_STATUS_CANNOT_REVERT: /* i18n */ {
    id: 'api-error.CONTRACT_ALREADY_STATUS_CANNOT_REVERT',
    message:
      'Повернути в чернетку не можна: контракт уже {status, select, READY_TO_SIGN {очікує підпису} SIGNED {підписано} CANCELLED {скасовано} other {в іншому статусі}}',
  },
  CONTRACT_NOT_READY: /* i18n */ {
    id: 'api-error.CONTRACT_NOT_READY',
    message: 'Контракт не готовий до підпису',
  },
  CONTRACT_UNKNOWN_CUSTOM_VARIABLE_KEYS: /* i18n */ {
    id: 'api-error.CONTRACT_UNKNOWN_CUSTOM_VARIABLE_KEYS',
    message: 'Невідомі ключі кастомних змінних: {keys}',
  },
  EMPLOYEE_CONTRACT_NOT_FOUND: /* i18n */ {
    id: 'api-error.EMPLOYEE_CONTRACT_NOT_FOUND',
    message: 'Активний трудовий контракт для користувача не знайдено',
  },
  ADMIN_DOES_NOT_SIGN_CONTRACTS: /* i18n */ {
    id: 'api-error.ADMIN_DOES_NOT_SIGN_CONTRACTS',
    message: 'Адміністратор не підписує контракт',
  },
  LEGAL_NAME_REQUIRED: /* i18n */ {
    id: 'api-error.LEGAL_NAME_REQUIRED',
    message: 'Юридичне ПІБ не заповнено. Зверніться до адміністратора',
  },
  TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM: /* i18n */ {
    id: 'api-error.TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM',
    message: 'Сеньйор уже перебуває в іншій активній команді',
  },
  TEAM_NOT_FOUND: /* i18n */ {
    id: 'api-error.TEAM_NOT_FOUND',
    message: 'Команду не знайдено',
  },
  TEAM_SENIOR_SHARE_OVERRIDE_TEAM_LEVEL_FORBIDDEN: /* i18n */ {
    id: 'api-error.TEAM_SENIOR_SHARE_OVERRIDE_TEAM_LEVEL_FORBIDDEN',
    message: 'Змінити частку сеньйора на рівні команди можуть лише адміністратор і бухгалтер',
  },
  TEAM_ALREADY_ARCHIVED: /* i18n */ {
    id: 'api-error.TEAM_ALREADY_ARCHIVED',
    message: 'Команду вже заархівовано',
  },
  TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE: /* i18n */ {
    id: 'api-error.TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE',
    message: 'У команді немає активного сеньйора — архівування через парний перехід неможливе',
  },
  TEAM_NOT_ARCHIVED: /* i18n */ {
    id: 'api-error.TEAM_NOT_ARCHIVED',
    message: 'Команду не заархівовано',
  },
  TEAM_ADMIN_CANNOT_BE_MEMBER: /* i18n */ {
    id: 'api-error.TEAM_ADMIN_CANNOT_BE_MEMBER',
    message: 'Адміністратор не може бути учасником команди',
  },
  TEAM_ADD_SENIOR_ADMIN_ONLY: /* i18n */ {
    id: 'api-error.TEAM_ADD_SENIOR_ADMIN_ONLY',
    message: 'Додати сеньйора до команди може лише адміністратор',
  },
  TEAM_ALREADY_HAS_SENIOR: /* i18n */ {
    id: 'api-error.TEAM_ALREADY_HAS_SENIOR',
    message: 'У команді вже є сеньйор',
  },
  TEAM_USER_ALREADY_MEMBER: /* i18n */ {
    id: 'api-error.TEAM_USER_ALREADY_MEMBER',
    message: 'Користувач уже є учасником команди',
  },
  TEAM_MEMBER_NOT_FOUND: /* i18n */ {
    id: 'api-error.TEAM_MEMBER_NOT_FOUND',
    message: 'Учасника команди не знайдено',
  },
  TEAM_CANNOT_REMOVE_SENIOR: /* i18n */ {
    id: 'api-error.TEAM_CANNOT_REMOVE_SENIOR',
    message: 'Прибрати сеньйора з команди не можна — видаліть команду замість цього',
  },
  TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE: /* i18n */ {
    id: 'api-error.TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE',
    message: 'Потрібен щонайменше один бухгалтер у команді',
  },
  TEAM_USER_NOT_FOUND_OR_WRONG_ROLE: /* i18n */ {
    id: 'api-error.TEAM_USER_NOT_FOUND_OR_WRONG_ROLE',
    message: 'Вказаного користувача не знайдено або він має невідповідну роль',
  },
  TEAM_UNEXPECTED_USER_ROLE: /* i18n */ {
    id: 'api-error.TEAM_UNEXPECTED_USER_ROLE',
    message:
      'Очікувалася роль {expectedRole, select, ADMIN {адміністратор} SENIOR {сеньйор} JUNIOR {джуніор} HR {HR} ACCOUNTANT {бухгалтер} DROP {дроп} other {співробітник}}, ' +
      'а отримано {actualRole, select, ADMIN {адміністратор} SENIOR {сеньйор} JUNIOR {джуніор} HR {HR} ACCOUNTANT {бухгалтер} DROP {дроп} other {співробітник}}',
  },
  TEAM_DROP_TEAMS_ONLY: /* i18n */ {
    id: 'api-error.TEAM_DROP_TEAMS_ONLY',
    message: 'Ця операція доступна лише для команд-дропів',
  },
  LEGEND_ACCESS_DENIED: /* i18n */ {
    id: 'api-error.LEGEND_ACCESS_DENIED',
    message: 'Немає доступу до легенди проєкту',
  },
  LEGEND_EDIT_ACCESS_DENIED: /* i18n */ {
    id: 'api-error.LEGEND_EDIT_ACCESS_DENIED',
    message: 'Немає доступу до редагування легенди проєкту',
  },
  LEGEND_UPSERT_FAILED: /* i18n */ {
    id: 'api-error.LEGEND_UPSERT_FAILED',
    message: 'Не вдалося зберегти легенду — рядок не повернуто',
  },
  LEGEND_NOT_FOUND: /* i18n */ {
    id: 'api-error.LEGEND_NOT_FOUND',
    message: 'Легенду проєкту не знайдено — спочатку створіть легенду',
  },
  APPROVAL_NOT_FOUND_OR_CLOSED: /* i18n */ {
    id: 'api-error.APPROVAL_NOT_FOUND_OR_CLOSED',
    message: 'Підтвердження не знайдено або вже закрито',
  },
  APPROVAL_ALREADY_DECIDED: /* i18n */ {
    id: 'api-error.APPROVAL_ALREADY_DECIDED',
    message: 'Підтвердження вже отримало відповідь',
  },
  INTERVIEW_NO_ACTIVE_TEAM: /* i18n */ {
    id: 'api-error.INTERVIEW_NO_ACTIVE_TEAM',
    message: 'У вас немає активної команди',
  },
  INTERVIEW_SENIOR_ID_REQUIRED: /* i18n */ {
    id: 'api-error.INTERVIEW_SENIOR_ID_REQUIRED',
    message: 'Потрібен ідентифікатор сеньйора',
  },
  INTERVIEW_SENIOR_NOT_IN_YOUR_TEAMS: /* i18n */ {
    id: 'api-error.INTERVIEW_SENIOR_NOT_IN_YOUR_TEAMS',
    message: 'Цей сеньйор не входить до ваших команд',
  },
  INTERVIEW_JUNIOR_FORBIDDEN: /* i18n */ {
    id: 'api-error.INTERVIEW_JUNIOR_FORBIDDEN',
    message: 'Джуніорам недоступні співбесіди',
  },
  INTERVIEW_NOT_FOUND: /* i18n */ {
    id: 'api-error.INTERVIEW_NOT_FOUND',
    message: 'Співбесіду не знайдено',
  },
  INTERVIEW_HR_SUMMARY_FORBIDDEN: /* i18n */ {
    id: 'api-error.INTERVIEW_HR_SUMMARY_FORBIDDEN',
    message: 'Зведення для HR доступне лише HR або адміністратору',
  },
  INTERVIEW_DROP_FORBIDDEN: /* i18n */ {
    id: 'api-error.INTERVIEW_DROP_FORBIDDEN',
    message: 'Дроп не має доступу до співбесід',
  },
  INTERVIEW_SENIOR_ID_INVALID: /* i18n */ {
    id: 'api-error.INTERVIEW_SENIOR_ID_INVALID',
    message: 'Ідентифікатор сеньйора має бути коректним UUID',
  },
  NOTIFICATION_NOT_FOUND: /* i18n */ {
    id: 'api-error.NOTIFICATION_NOT_FOUND',
    message: 'Сповіщення не знайдено',
  },
}

export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_FALLBACK_EN: Record<
  DocumentsContractsNotificationsErrorCode,
  string
> = {
  DOCUMENT_MIME_NOT_ALLOWED:
    "File type '{mimeType}' isn't supported. Allowed formats: PDF, JPEG, PNG, WEBP, HEIC",
  DOCUMENT_CONTENT_UNRECOGNIZED: "The file's content doesn't match any of the allowed formats",
  DOCUMENT_CONTENT_TYPE_MISMATCH:
    "The file's content doesn't match its declared type: declared '{declaredMime}', detected '{detectedMime}'",
  DOCUMENT_TOO_LARGE: 'The file is larger than {maxMb} MB',
  DOCUMENT_PROJECT_ID_REQUIRED: 'A project is required for contract documents',
  DOCUMENT_NOT_FOUND: 'Document not found',
  DOCUMENT_DELETE_OWNER_OR_ADMIN_ONLY: 'Only the owner or an administrator can delete a document',
  DOCUMENT_RESTORE_ADMIN_ONLY: 'Only an administrator can restore a document',
  DOCUMENT_HARD_DELETE_ADMIN_ONLY: 'Only an administrator can permanently delete a document',
  DOCUMENT_HARD_DELETE_REQUIRES_SOFT_DELETE:
    'Move the document to trash first, then delete it permanently',
  DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN:
    "{role, select, JUNIOR {A junior} HR {HR} ACCOUNTANT {An accountant} SENIOR {A senior} DROP {A drop} other {An employee}} can't upload " +
    '{category, select, CONTRACT {contracts} RECEIPT {receipts} LOGO {logos} other {documents}}',
  DOCUMENT_UPLOAD_SELF_ONLY:
    '{role, select, JUNIOR {A junior} DROP {A drop} other {An employee}} can only upload their own documents',
  DOCUMENT_UPLOAD_CONTRACT_RESTRICTED:
    'Only an administrator, a senior, or a drop (for themselves) can upload a contract',
  DOCUMENT_UPLOAD_AVATAR_SELF_ONLY: 'An avatar can only be uploaded for your own profile',
  DOCUMENT_UPLOAD_INVOICE_FORBIDDEN:
    'Invoice documents are generated by the system and cannot be uploaded through this endpoint',
  DOCUMENT_MULTIPART_REQUIRED: 'Content-Type must be multipart/form-data',
  DOCUMENT_FILE_FIELD_MISSING: "Missing 'file' field in the request body",
  CONTRACT_TEMPLATE_INVALID_ROLE: 'Invalid contract template role',
  CONTRACT_TEMPLATE_NOT_FOUND: 'Contract template not found',
  CONTRACT_TEMPLATE_ADMIN_NONE: 'There is no contract template for an administrator',
  CONTRACT_TEMPLATE_ADMIN_PUBLISH_FORBIDDEN:
    "An administrator's contract template can't be published",
  CONTRACT_TEMPLATE_DUPLICATE_ACTIVE: 'An active contract template for this role already exists',
  CONTRACT_VIEW_SELF_ONLY: 'You can only view your own contract',
  SIGNED_CONTRACT_NOT_FOUND: 'Signed contract not found',
  CONTRACT_ADMIN_NOT_ALLOWED: "Administrators can't have an employee contract",
  CONTRACT_NOT_EDITABLE: 'This contract can no longer be edited',
  CONTRACT_NOT_DRAFT: 'This contract is no longer a draft — refresh the page',
  CONTRACT_ALREADY_STATUS_CANNOT_REVERT:
    "Can't revert to draft: the contract is already {status, select, READY_TO_SIGN {awaiting signature} SIGNED {signed} CANCELLED {cancelled} other {in another status}}",
  CONTRACT_NOT_READY: "The contract isn't ready to sign",
  CONTRACT_UNKNOWN_CUSTOM_VARIABLE_KEYS: 'Unknown custom variable keys: {keys}',
  EMPLOYEE_CONTRACT_NOT_FOUND: 'No active employee contract found for this user',
  ADMIN_DOES_NOT_SIGN_CONTRACTS: "An administrator doesn't sign a contract",
  LEGAL_NAME_REQUIRED: "Legal full name isn't filled in. Contact an administrator",
  TEAM_SENIOR_ALREADY_ON_ANOTHER_TEAM: 'The senior is already on another active team',
  TEAM_NOT_FOUND: 'Team not found',
  TEAM_SENIOR_SHARE_OVERRIDE_TEAM_LEVEL_FORBIDDEN:
    "Only an administrator or an accountant can change the senior's share at the team level",
  TEAM_ALREADY_ARCHIVED: 'The team is already archived',
  TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE:
    "The team has no active senior — archiving through the pair flow isn't possible",
  TEAM_NOT_ARCHIVED: "The team isn't archived",
  TEAM_ADMIN_CANNOT_BE_MEMBER: "An administrator can't be a team member",
  TEAM_ADD_SENIOR_ADMIN_ONLY: 'Only an administrator can add a senior to a team',
  TEAM_ALREADY_HAS_SENIOR: 'The team already has a senior',
  TEAM_USER_ALREADY_MEMBER: 'The user is already a team member',
  TEAM_MEMBER_NOT_FOUND: 'Team member not found',
  TEAM_CANNOT_REMOVE_SENIOR: "The senior can't be removed from a team — delete the team instead",
  TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE: 'The team needs at least one accountant',
  TEAM_USER_NOT_FOUND_OR_WRONG_ROLE: "The specified user wasn't found or has the wrong role",
  TEAM_UNEXPECTED_USER_ROLE:
    'Expected the role {expectedRole, select, ADMIN {administrator} SENIOR {senior} JUNIOR {junior} HR {HR} ACCOUNTANT {accountant} DROP {drop} other {employee}}, ' +
    'got {actualRole, select, ADMIN {administrator} SENIOR {senior} JUNIOR {junior} HR {HR} ACCOUNTANT {accountant} DROP {drop} other {employee}}',
  TEAM_DROP_TEAMS_ONLY: 'This operation is only available for drop teams',
  LEGEND_ACCESS_DENIED: "No access to the project's legend",
  LEGEND_EDIT_ACCESS_DENIED: "No access to editing the project's legend",
  LEGEND_UPSERT_FAILED: 'Failed to save the legend — no row was returned',
  LEGEND_NOT_FOUND: "The project's legend wasn't found — create a legend first",
  APPROVAL_NOT_FOUND_OR_CLOSED: 'Approval not found or already closed',
  APPROVAL_ALREADY_DECIDED: 'The approval already received a decision',
  INTERVIEW_NO_ACTIVE_TEAM: "You don't have an active team",
  INTERVIEW_SENIOR_ID_REQUIRED: 'A senior ID is required',
  INTERVIEW_SENIOR_NOT_IN_YOUR_TEAMS: "This senior isn't in your teams",
  INTERVIEW_JUNIOR_FORBIDDEN: "Juniors can't access interviews",
  INTERVIEW_NOT_FOUND: 'Interview not found',
  INTERVIEW_HR_SUMMARY_FORBIDDEN: 'The HR summary is only available to HR or an administrator',
  INTERVIEW_DROP_FORBIDDEN: "A drop doesn't have access to interviews",
  INTERVIEW_SENIOR_ID_INVALID: 'The senior ID must be a valid UUID',
  NOTIFICATION_NOT_FOUND: 'Notification not found',
}
