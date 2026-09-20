import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage4-task4. Zod v4 only carries a single `message: string` on
 * an issue — there is no separate "code" field a validator can attach (see
 * the spike note in the plan for why `z.setErrorMap` was rejected: it maps
 * by `issue.code`/`issue.path`, not by business meaning, and would add a
 * SECOND parallel mechanism next to this one). The chosen shape: a schema's
 * `message` becomes a stable key of the form `'zod.<CODE>'` — Zod treats it
 * as an ordinary string, so nothing in the validator itself changes — and
 * the key is resolved to real text in exactly two places, both consuming
 * THIS registry: `ZodExceptionFilter` (server, 400 response envelope) and
 * `translateZodError` (`apps/web/app/lib/axios-utils.ts`, client render).
 *
 * Every code registered here is a COMPILE-TIME-CONSTANT message — no code in
 * this wave (B1: `money.ts`/`finance.ts`/`users.ts`/`payment-requisites.ts`)
 * needs a value only known at request time (a user-typed number, an
 * `issue.path`), so there is no params-interpolation mechanism here yet.
 * `AMOUNT_DECIMAL_PLACES`/`MIN_TRANSACTION_AMOUNT`-shaped numbers ARE baked
 * into the message text below as literal digits, not template
 * interpolation — `zod-errors.spec.ts`'s invariant tests pin the literal
 * against the live constant from `./money`/`./finance` so a future change to
 * either drifts loudly (a failing test), not silently (a stale number in a
 * translated string nobody notices).
 */
export const ZOD_ERROR_CODES = [
  // money.ts — shared floor+precision helpers (scale-6 transaction columns,
  // scale-2 salary columns). Registered together with finance.ts's own
  // `transactionAmountError` codes below — the same task-of-record dedups
  // `transactionAmountError` to DELEGATE to `moneyFloorAndPrecisionError`
  // for the floor+precision branches instead of repeating the literal.
  'TRANSACTION_AMOUNT_TOO_SMALL',
  'TRANSACTION_AMOUNT_TOO_MANY_DECIMALS',
  'SALARY_AMOUNT_TOO_SMALL',
  'SALARY_AMOUNT_TOO_MANY_DECIMALS',
  // finance.ts — transactionAmountError's own branches (not shared with money.ts)
  'AMOUNT_NOT_A_NUMBER',
  'AMOUNT_MUST_BE_POSITIVE',
  'TRANSACTION_AMOUNT_EXCEEDS_MAX',
  // finance.ts — other static messages
  'RECEIPT_REQUIRED',
  // finance.ts — receiptMandatoryError's other three branches (fix-round 1,
  // COPY-H-2: the function used to return raw English literals — a dual-use
  // escape hatch for direct apps/api throw-sites outside this task's Zod
  // boundary; the orchestrator's fix-round decision reverses that call —
  // those throw-sites now translate `ZOD_ERROR_FALLBACK_EN[code]` instead).
  'RECEIPT_BOTH_NOT_ALLOWED',
  'RECEIPT_USDT_LINK_ONLY',
  'RECEIPT_USDT_LINK_REQUIRED',
  'COMPANY_ACCOUNT_USDT_ONLY',
  'REASON_REQUIRED_DELETE',
  'REASON_REQUIRED_RESTORE',
  'REASON_REQUIRED_RELEASE',
  // finance.ts — selfPayError's default message (fix-round 1, COPY-H-2)
  'SENDER_RECEIVER_SAME',
  'TX_HASH_MIN_LENGTH',
  'TX_HASH_FORMAT',
  'TX_HASH_FORMAT_OR_EMPTY',
  'DATE_FORMAT_YYYYMMDD',
  'DATE_NOT_IN_FUTURE',
  'REQUISITES_TOO_LONG',
  // shared across finance.ts / users.ts / payment-requisites.ts
  'USDT_ADDRESS_FORMAT',
  // users.ts / payment-requisites.ts — payment requisites
  'TELEGRAM_FORMAT',
  'RECIPIENT_NAME_MIN',
  'RECIPIENT_NAME_REQUIRED',
  'IBAN_FORMAT',
  'IBAN_REQUIRED',
  'RNOKPP_FORMAT',
  'RNOKPP_REQUIRED',
  'USDT_ONLY_FOR_SENIOR_ADMIN',
  'USDT_WALLET_REQUIRED',
  // users.ts — profile / user-creation
  'EMAIL_INVALID',
  'EMAIL_TOO_LONG',
  'LEGAL_FULL_NAME_MIN',
  'LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT',
  'PERSONAL_EMAIL_MUST_DIFFER',
  'JOIN_DROP_TEAM_SENIOR_ONLY',
  'DROP_TEAM_ID_REQUIRED',
  'HR_REQUIRED_MIN',
  // UserDialog.tsx / RejoinTeamDialog.tsx — local literal dupes migrated into
  // the registry (fix-round 1, COPY-M-8 / SR-M-1 / SR-M-3)
  'VALIDATION_FAILED_FORM',
  'EMAIL_REQUIRED',
  'DISPLAY_NAME_MIN',
  'PHONE_INVALID',
] as const
export type ZodErrorCode = (typeof ZOD_ERROR_CODES)[number]

/**
 * Украинский исходный текст (source locale). Явные id (`zod-error.<CODE>`) —
 * извлечение стабильно без макроса `t`/`msg` (см. `api-errors.ts` — тот же
 * приём, уже проверенный `pnpm i18n:extract`).
 *
 * Черновик кодера (task-i18n-stage4-task4) — `copy-reviewer` проверяет оба
 * языка (en — в `en/messages.po` после `pnpm i18n:extract`).
 */
export const ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor> = {
  TRANSACTION_AMOUNT_TOO_SMALL: /* i18n */ {
    id: 'zod-error.TRANSACTION_AMOUNT_TOO_SMALL',
    message: 'Сума занадто мала — мінімум 0.000001',
  },
  TRANSACTION_AMOUNT_TOO_MANY_DECIMALS: /* i18n */ {
    id: 'zod-error.TRANSACTION_AMOUNT_TOO_MANY_DECIMALS',
    message: 'Не більше 6 знаків після крапки — суму округлять',
  },
  SALARY_AMOUNT_TOO_SMALL: /* i18n */ {
    id: 'zod-error.SALARY_AMOUNT_TOO_SMALL',
    message: 'Сума занадто мала — мінімум 0.01',
  },
  SALARY_AMOUNT_TOO_MANY_DECIMALS: /* i18n */ {
    id: 'zod-error.SALARY_AMOUNT_TOO_MANY_DECIMALS',
    message: 'Не більше 2 знаків після крапки — суму округлять',
  },
  AMOUNT_NOT_A_NUMBER: /* i18n */ {
    id: 'zod-error.AMOUNT_NOT_A_NUMBER',
    message: 'Введіть суму числом — наприклад 1000.50',
  },
  AMOUNT_MUST_BE_POSITIVE: /* i18n */ {
    id: 'zod-error.AMOUNT_MUST_BE_POSITIVE',
    message: 'Сума має бути більшою за нуль',
  },
  TRANSACTION_AMOUNT_EXCEEDS_MAX: /* i18n */ {
    id: 'zod-error.TRANSACTION_AMOUNT_EXCEEDS_MAX',
    message: 'Сума не може перевищувати 500 000',
  },
  RECEIPT_REQUIRED: /* i18n */ {
    id: 'zod-error.RECEIPT_REQUIRED',
    message: 'Квитанція обов’язкова — додайте файл або посилання',
  },
  RECEIPT_BOTH_NOT_ALLOWED: /* i18n */ {
    id: 'zod-error.RECEIPT_BOTH_NOT_ALLOWED',
    message: 'Квитанція — це файл або посилання, не обидва одночасно',
  },
  RECEIPT_USDT_LINK_ONLY: /* i18n */ {
    id: 'zod-error.RECEIPT_USDT_LINK_ONLY',
    message: 'Для USDT квитанція приймається лише як посилання на блокчейн-експлорер, без файлу',
  },
  RECEIPT_USDT_LINK_REQUIRED: /* i18n */ {
    id: 'zod-error.RECEIPT_USDT_LINK_REQUIRED',
    message:
      'Для USDT потрібне посилання на транзакцію в блокчейн-експлорері (etherscan.io, tronscan.org тощо)',
  },
  COMPANY_ACCOUNT_USDT_ONLY: /* i18n */ {
    id: 'zod-error.COMPANY_ACCOUNT_USDT_ONLY',
    message: 'Операція з рахунку компанії проводиться лише в USDT',
  },
  REASON_REQUIRED_DELETE: /* i18n */ {
    id: 'zod-error.REASON_REQUIRED_DELETE',
    message: 'Вкажіть причину видалення — вона потрапить до журналу',
  },
  REASON_REQUIRED_RESTORE: /* i18n */ {
    id: 'zod-error.REASON_REQUIRED_RESTORE',
    message: 'Вкажіть причину відновлення — вона потрапить до журналу',
  },
  REASON_REQUIRED_RELEASE: /* i18n */ {
    id: 'zod-error.REASON_REQUIRED_RELEASE',
    message: 'Опишіть причину — вона потрапить до журналу',
  },
  SENDER_RECEIVER_SAME: /* i18n */ {
    id: 'zod-error.SENDER_RECEIVER_SAME',
    message: 'Відправник і отримувач не можуть збігатися',
  },
  TX_HASH_MIN_LENGTH: /* i18n */ {
    id: 'zod-error.TX_HASH_MIN_LENGTH',
    message: 'Хеш транзакції або посилання — щонайменше 10 символів',
  },
  TX_HASH_FORMAT: /* i18n */ {
    id: 'zod-error.TX_HASH_FORMAT',
    message: 'Хеш транзакції: 0x + 64 hex — або посилання на Etherscan',
  },
  TX_HASH_FORMAT_OR_EMPTY: /* i18n */ {
    id: 'zod-error.TX_HASH_FORMAT_OR_EMPTY',
    message: 'Хеш транзакції: 0x + 64 hex — або посилання на Etherscan',
  },
  DATE_FORMAT_YYYYMMDD: /* i18n */ {
    id: 'zod-error.DATE_FORMAT_YYYYMMDD',
    message: 'Дата має бути у форматі YYYY-MM-DD',
  },
  DATE_NOT_IN_FUTURE: /* i18n */ {
    id: 'zod-error.DATE_NOT_IN_FUTURE',
    message: 'Дата транзакції не може бути в майбутньому',
  },
  REQUISITES_TOO_LONG: /* i18n */ {
    id: 'zod-error.REQUISITES_TOO_LONG',
    message: 'Реквізити не довші за 10 000 символів',
  },
  USDT_ADDRESS_FORMAT: /* i18n */ {
    id: 'zod-error.USDT_ADDRESS_FORMAT',
    message: 'Адреса USDT ERC-20 має починатися з 0x і містити 42 символи',
  },
  TELEGRAM_FORMAT: /* i18n */ {
    id: 'zod-error.TELEGRAM_FORMAT',
    message: 'Нік у Telegram: 5–32 символи — латиниця, цифри або _',
  },
  RECIPIENT_NAME_MIN: /* i18n */ {
    id: 'zod-error.RECIPIENT_NAME_MIN',
    message: 'ПІБ отримувача — мінімум 3 символи',
  },
  RECIPIENT_NAME_REQUIRED: /* i18n */ {
    id: 'zod-error.RECIPIENT_NAME_REQUIRED',
    message: 'ПІБ отримувача обов’язкове',
  },
  IBAN_FORMAT: /* i18n */ {
    id: 'zod-error.IBAN_FORMAT',
    message: 'IBAN має бути у форматі UA + 27 цифр (29 символів)',
  },
  IBAN_REQUIRED: /* i18n */ {
    id: 'zod-error.IBAN_REQUIRED',
    message: 'IBAN обов’язковий',
  },
  RNOKPP_FORMAT: /* i18n */ {
    id: 'zod-error.RNOKPP_FORMAT',
    message: 'Введіть 10 цифр РНОКПП',
  },
  RNOKPP_REQUIRED: /* i18n */ {
    id: 'zod-error.RNOKPP_REQUIRED',
    message: 'РНОКПП обов’язковий',
  },
  USDT_ONLY_FOR_SENIOR_ADMIN: /* i18n */ {
    id: 'zod-error.USDT_ONLY_FOR_SENIOR_ADMIN',
    message: 'Сеньйор і адмін отримують лише на USDT ERC-20',
  },
  USDT_WALLET_REQUIRED: /* i18n */ {
    id: 'zod-error.USDT_WALLET_REQUIRED',
    message: 'Вкажіть адресу USDT ERC-20',
  },
  EMAIL_INVALID: /* i18n */ {
    id: 'zod-error.EMAIL_INVALID',
    message: 'Введіть email у форматі name@domain',
  },
  EMAIL_TOO_LONG: /* i18n */ {
    id: 'zod-error.EMAIL_TOO_LONG',
    message: 'Email не довше 255 символів',
  },
  LEGAL_FULL_NAME_MIN: /* i18n */ {
    id: 'zod-error.LEGAL_FULL_NAME_MIN',
    message: 'ПІБ — мінімум 5 символів',
  },
  LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT: /* i18n */ {
    id: 'zod-error.LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT',
    message: 'ПІБ обов’язкове для контракту',
  },
  PERSONAL_EMAIL_MUST_DIFFER: /* i18n */ {
    id: 'zod-error.PERSONAL_EMAIL_MUST_DIFFER',
    message: 'Особистий email має відрізнятися від робочого',
  },
  JOIN_DROP_TEAM_SENIOR_ONLY: /* i18n */ {
    id: 'zod-error.JOIN_DROP_TEAM_SENIOR_ONLY',
    message: 'Долучити до команди дропа можна лише сеньйора',
  },
  DROP_TEAM_ID_REQUIRED: /* i18n */ {
    id: 'zod-error.DROP_TEAM_ID_REQUIRED',
    message: 'Виберіть команду дропа',
  },
  HR_REQUIRED_MIN: /* i18n */ {
    id: 'zod-error.HR_REQUIRED_MIN',
    message: 'Виберіть щонайменше одного HR',
  },
  VALIDATION_FAILED_FORM: /* i18n */ {
    id: 'zod-error.VALIDATION_FAILED_FORM',
    message: 'Перевірте заповнені поля',
  },
  EMAIL_REQUIRED: /* i18n */ {
    id: 'zod-error.EMAIL_REQUIRED',
    message: 'Введіть email',
  },
  DISPLAY_NAME_MIN: /* i18n */ {
    id: 'zod-error.DISPLAY_NAME_MIN',
    message: 'Ім’я — мінімум 2 символи',
  },
  PHONE_INVALID: /* i18n */ {
    id: 'zod-error.PHONE_INVALID',
    message: 'Введіть номер у міжнародному форматі, напр. +380671234567',
  },
}

/**
 * Английский fallback, который едет в САМОМ HTTP-теле (`ZodExceptionFilter`,
 * `apps/api/src/zod-exception.filter.ts`) для мигрированных полей — для
 * логов и клиентов без каталога. Тот же приём и то же обязательство, что
 * `API_ERROR_FALLBACK_EN` (`api-errors.ts`): равно `en`-строке каталога
 * дословно (`zod-errors.spec.ts` закрепляет это инвариантным тестом).
 */
export const ZOD_ERROR_FALLBACK_EN: Record<ZodErrorCode, string> = {
  TRANSACTION_AMOUNT_TOO_SMALL: 'Amount is too small — minimum 0.000001',
  TRANSACTION_AMOUNT_TOO_MANY_DECIMALS: 'No more than 6 decimals — otherwise the amount is rounded',
  SALARY_AMOUNT_TOO_SMALL: 'Amount is too small — minimum 0.01',
  SALARY_AMOUNT_TOO_MANY_DECIMALS: 'No more than 2 decimals — otherwise the amount is rounded',
  AMOUNT_NOT_A_NUMBER: 'Enter the amount as a number — e.g. 1000.50',
  AMOUNT_MUST_BE_POSITIVE: 'Amount must be greater than zero',
  TRANSACTION_AMOUNT_EXCEEDS_MAX: 'Amount cannot exceed 500,000',
  RECEIPT_REQUIRED: 'A receipt is required — attach a file or a link',
  RECEIPT_BOTH_NOT_ALLOWED: 'The receipt is either an uploaded file or a link, not both',
  RECEIPT_USDT_LINK_ONLY:
    'For USDT, the receipt is accepted only as a blockchain-explorer link, not a file',
  RECEIPT_USDT_LINK_REQUIRED:
    'For USDT, a transaction link on a blockchain-explorer is required (etherscan.io, tronscan.org, etc.)',
  COMPANY_ACCOUNT_USDT_ONLY: 'Company account operations are in USDT only',
  REASON_REQUIRED_DELETE: 'State a reason for the deletion — it goes into the audit log',
  REASON_REQUIRED_RESTORE: 'State a reason for the restoration — it goes into the audit log',
  REASON_REQUIRED_RELEASE: 'Describe the reason — it goes into the audit log',
  SENDER_RECEIVER_SAME: 'Sender and receiver cannot be the same',
  TX_HASH_MIN_LENGTH: 'Transaction hash or link — at least 10 characters',
  TX_HASH_FORMAT: 'Transaction hash: 0x + 64 hex — or an Etherscan link',
  TX_HASH_FORMAT_OR_EMPTY: 'Transaction hash: 0x + 64 hex — or an Etherscan link',
  DATE_FORMAT_YYYYMMDD: 'The date must be in YYYY-MM-DD format',
  DATE_NOT_IN_FUTURE: 'The transaction date cannot be in the future',
  REQUISITES_TOO_LONG: 'Company details must not exceed 10,000 characters',
  USDT_ADDRESS_FORMAT: 'The USDT ERC-20 address must start with 0x and be 42 characters long',
  TELEGRAM_FORMAT: 'Telegram handle: 5–32 characters — Latin letters, digits or _',
  RECIPIENT_NAME_MIN: 'Recipient full name — at least 3 characters',
  RECIPIENT_NAME_REQUIRED: 'Recipient full name is required',
  IBAN_FORMAT: 'Enter the IBAN: UA + 27 digits (29 characters)',
  IBAN_REQUIRED: 'IBAN is required',
  RNOKPP_FORMAT: 'Enter the 10 digits of the RNOKPP (tax ID)',
  RNOKPP_REQUIRED: 'The tax ID is required',
  USDT_ONLY_FOR_SENIOR_ADMIN: 'Seniors and admins are paid in USDT ERC-20 only',
  USDT_WALLET_REQUIRED: 'Enter the USDT ERC-20 address',
  EMAIL_INVALID: 'Enter an email like name@domain',
  EMAIL_TOO_LONG: 'Email must not exceed 255 characters',
  LEGAL_FULL_NAME_MIN: 'Full name — at least 5 characters',
  LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT: 'Full name is required for the contract',
  PERSONAL_EMAIL_MUST_DIFFER: 'The personal email must differ from the work email',
  JOIN_DROP_TEAM_SENIOR_ONLY: 'Only a senior can be added to a drop team',
  DROP_TEAM_ID_REQUIRED: 'Select a drop team',
  HR_REQUIRED_MIN: 'Select at least one HR',
  VALIDATION_FAILED_FORM: 'Check the fields you filled in',
  EMAIL_REQUIRED: 'Enter an email',
  DISPLAY_NAME_MIN: 'Name — at least 2 characters',
  PHONE_INVALID: 'Enter the number in international format, e.g. +380671234567',
}

/**
 * Resolves a `receiptMandatoryError`/`selfPayError`/`transactionAmountError`-
 * style return value — either a `'zod.<CODE>'` key or an ordinary (non-coded)
 * message — to English. For the handful of server-side callers that `throw`
 * BEFORE ever reaching the Zod boundary (a direct pure-function call from a
 * service method, not a schema `.parse()`), so `ZodExceptionFilter` never
 * gets a chance to translate the issue itself — the raw key would otherwise
 * leak into the exception body verbatim (fix-round 1, COPY-H-2/SPEC-L-1; same
 * pattern `transactions.service.ts`'s `paySalary` already applies to
 * `transactionAmountError`). A non-coded message passes through unchanged.
 */
export function zodErrorFallbackText(message: string): string {
  if (!message.startsWith('zod.')) return message
  const code = message.slice('zod.'.length) as ZodErrorCode
  return ZOD_ERROR_FALLBACK_EN[code] ?? message
}
