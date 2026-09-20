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
  'COMPANY_ACCOUNT_USDT_ONLY',
  'REASON_REQUIRED_DELETE',
  'REASON_REQUIRED_RESTORE',
  'REASON_REQUIRED_RELEASE',
  'TX_HASH_MIN_LENGTH',
  'TX_HASH_FORMAT',
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
    message: 'Не більше 6 знаків після коми — інакше суму округлять',
  },
  SALARY_AMOUNT_TOO_SMALL: /* i18n */ {
    id: 'zod-error.SALARY_AMOUNT_TOO_SMALL',
    message: 'Сума занадто мала — мінімум 0.01',
  },
  SALARY_AMOUNT_TOO_MANY_DECIMALS: /* i18n */ {
    id: 'zod-error.SALARY_AMOUNT_TOO_MANY_DECIMALS',
    message: 'Не більше 2 знаків після коми — інакше суму округлять',
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
  TX_HASH_MIN_LENGTH: /* i18n */ {
    id: 'zod-error.TX_HASH_MIN_LENGTH',
    message: 'txHash має містити щонайменше 10 символів',
  },
  TX_HASH_FORMAT: /* i18n */ {
    id: 'zod-error.TX_HASH_FORMAT',
    message: 'Вкажіть коректний хеш транзакції (0x + 64 hex) або посилання на Etherscan',
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
    message: 'Реквізити не повинні перевищувати 10 000 символів',
  },
  USDT_ADDRESS_FORMAT: /* i18n */ {
    id: 'zod-error.USDT_ADDRESS_FORMAT',
    message: 'Адреса USDT ERC-20 має починатися з 0x і містити 42 символи',
  },
  TELEGRAM_FORMAT: /* i18n */ {
    id: 'zod-error.TELEGRAM_FORMAT',
    message: 'Telegram: 5–32 символи, латиниця/цифри/_',
  },
  RECIPIENT_NAME_MIN: /* i18n */ {
    id: 'zod-error.RECIPIENT_NAME_MIN',
    message: 'ПІБ отримувача — мінімум 3 символи',
  },
  RECIPIENT_NAME_REQUIRED: /* i18n */ {
    id: 'zod-error.RECIPIENT_NAME_REQUIRED',
    message: "ПІБ обов'язкове",
  },
  IBAN_FORMAT: /* i18n */ {
    id: 'zod-error.IBAN_FORMAT',
    message: 'IBAN має бути у форматі UA + 27 цифр (29 символів)',
  },
  IBAN_REQUIRED: /* i18n */ {
    id: 'zod-error.IBAN_REQUIRED',
    message: "IBAN обов'язковий",
  },
  RNOKPP_FORMAT: /* i18n */ {
    id: 'zod-error.RNOKPP_FORMAT',
    message: 'РНОКПП має містити 10 цифр',
  },
  RNOKPP_REQUIRED: /* i18n */ {
    id: 'zod-error.RNOKPP_REQUIRED',
    message: "РНОКПП обов'язковий",
  },
  USDT_ONLY_FOR_SENIOR_ADMIN: /* i18n */ {
    id: 'zod-error.USDT_ONLY_FOR_SENIOR_ADMIN',
    message: 'Senior/Admin можуть використовувати лише USDT ERC-20',
  },
  USDT_WALLET_REQUIRED: /* i18n */ {
    id: 'zod-error.USDT_WALLET_REQUIRED',
    message: "Гаманець USDT обов'язковий",
  },
  EMAIL_INVALID: /* i18n */ {
    id: 'zod-error.EMAIL_INVALID',
    message: 'Некоректний email',
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
    message: "ПІБ обов'язкове для контракту",
  },
  PERSONAL_EMAIL_MUST_DIFFER: /* i18n */ {
    id: 'zod-error.PERSONAL_EMAIL_MUST_DIFFER',
    message: 'Особистий email має відрізнятися від робочого',
  },
  JOIN_DROP_TEAM_SENIOR_ONLY: /* i18n */ {
    id: 'zod-error.JOIN_DROP_TEAM_SENIOR_ONLY',
    message: 'teamMode=JOIN_DROP_TEAM доступний лише під час створення SENIOR',
  },
  DROP_TEAM_ID_REQUIRED: /* i18n */ {
    id: 'zod-error.DROP_TEAM_ID_REQUIRED',
    message: "dropTeamId обов'язковий при teamMode=JOIN_DROP_TEAM",
  },
  HR_REQUIRED_MIN: /* i18n */ {
    id: 'zod-error.HR_REQUIRED_MIN',
    message: "HR обов'язковий (мінімум 1)",
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
  TRANSACTION_AMOUNT_TOO_MANY_DECIMALS:
    'No more than 6 digits after the decimal point — otherwise the amount will be rounded',
  SALARY_AMOUNT_TOO_SMALL: 'Amount is too small — minimum 0.01',
  SALARY_AMOUNT_TOO_MANY_DECIMALS:
    'No more than 2 digits after the decimal point — otherwise the amount will be rounded',
  AMOUNT_NOT_A_NUMBER: 'Enter the amount as a number — e.g. 1000.50',
  AMOUNT_MUST_BE_POSITIVE: 'Amount must be greater than zero',
  TRANSACTION_AMOUNT_EXCEEDS_MAX: 'Amount cannot exceed 500,000',
  RECEIPT_REQUIRED: 'A receipt is required — attach a file or a link',
  COMPANY_ACCOUNT_USDT_ONLY: 'A company account operation can only be made in USDT',
  REASON_REQUIRED_DELETE: 'State a reason for the deletion — it goes into the audit log',
  REASON_REQUIRED_RESTORE: 'State a reason for the restoration — it goes into the audit log',
  REASON_REQUIRED_RELEASE: 'Describe the reason — it goes into the audit log',
  TX_HASH_MIN_LENGTH: 'txHash must be at least 10 characters',
  TX_HASH_FORMAT: 'Enter a valid transaction hash (0x + 64 hex) or an Etherscan link',
  DATE_FORMAT_YYYYMMDD: 'The date must be in YYYY-MM-DD format',
  DATE_NOT_IN_FUTURE: 'The transaction date cannot be in the future',
  REQUISITES_TOO_LONG: 'Requisites must not exceed 10,000 characters',
  USDT_ADDRESS_FORMAT: 'The USDT ERC-20 address must start with 0x and be 42 characters long',
  TELEGRAM_FORMAT: 'Telegram: 5–32 characters, Latin letters/digits/_',
  RECIPIENT_NAME_MIN: 'Recipient full name — at least 3 characters',
  RECIPIENT_NAME_REQUIRED: 'Full name is required',
  IBAN_FORMAT: 'IBAN must be in UA + 27 digits format (29 characters)',
  IBAN_REQUIRED: 'IBAN is required',
  RNOKPP_FORMAT: 'The tax ID must contain 10 digits',
  RNOKPP_REQUIRED: 'The tax ID is required',
  USDT_ONLY_FOR_SENIOR_ADMIN: 'Senior/Admin can only use USDT ERC-20',
  USDT_WALLET_REQUIRED: 'A USDT wallet is required',
  EMAIL_INVALID: 'Invalid email',
  EMAIL_TOO_LONG: 'Email must not exceed 255 characters',
  LEGAL_FULL_NAME_MIN: 'Full name — at least 5 characters',
  LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT: 'Full name is required for the contract',
  PERSONAL_EMAIL_MUST_DIFFER: 'The personal email must differ from the work email',
  JOIN_DROP_TEAM_SENIOR_ONLY: 'teamMode=JOIN_DROP_TEAM is only available when creating a SENIOR',
  DROP_TEAM_ID_REQUIRED: 'dropTeamId is required when teamMode=JOIN_DROP_TEAM',
  HR_REQUIRED_MIN: 'An HR is required (at least 1)',
}
