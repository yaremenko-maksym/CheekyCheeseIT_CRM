import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage4-task2 (Track A). Error codes for `finance`/`invoices`
 * throw-sites that used to carry a literal Russian or English message —
 * `apiError()` call sites now route through these codes instead. Source
 * locale is Ukrainian (spec decision: Russian leaves the product; see
 * `CONTEXT.md`).
 *
 * Reused codes declared in `auth-users-projects.ts` (Task 1) — NOT
 * redeclared here (would fail this file's own "no code declared twice"
 * invariant test): `USER_NOT_FOUND`, `PROJECT_NOT_FOUND`, `SENIOR_NOT_FOUND`,
 * `DROP_NOT_FOUND`.
 *
 * Dedup discipline (lesson #7, task-i18n-stage4-lessons-701): identical
 * literal messages across call sites share ONE code (e.g.
 * `FINANCE_TRANSACTION_NOT_FOUND` covers 11 call sites). Near-duplicates
 * with a materially different action/remedy stay separate codes (e.g.
 * `FINANCE_SALARY_RECEIVER_ARCHIVED` vs `FINANCE_TRANSFER_RECEIVER_ARCHIVED`
 * vs `FINANCE_DIVIDEND_RECEIVER_ARCHIVED` — same underlying fact, different
 * action being refused).
 *
 * Money discipline (task file "Уточнения оркестратора" §4): no formatted
 * amounts, wallet addresses, or other-entity identifiers in `params`.
 * `maxAmount`/`maxMb`-shaped params are a configured SYSTEM LIMIT, not a
 * computed sum — same precedent as `DOCUMENT_TOO_LARGE.maxMb` (Task 3).
 * `currency`/`obligationCurrency`/`sourceSettledCurrency` are short enum-like
 * codes (USD/USDT/UAH/EUR), not PII — same precedent as `status`/`category`
 * (Task 3). `rowId` (derivative cascade row) identifies WHICH of possibly
 * several rows failed in a bulk cascade operation the user themselves is
 * looking at (not a "foreign" entity id) — kept for that reason.
 *
 * Transaction TYPE names (`SENIOR_INCOME`, `DROP_INCOME`, `PAYOUT`, `SALARY`,
 * …) are kept as literal identifiers in text, not humanized via ICU
 * `select` — unlike ROLE enums (lesson #4's ban is specifically about role
 * enums appearing raw in RBAC text), there is no glossary-level human label
 * for transaction types yet (`apps/web/app/routes/_authenticated/finance/
 * constants.ts`'s `TRANSACTION_TYPE_LABELS` is still Russian, out of this
 * task's scope — Track A Task 2 covers `apps/api`/`packages/shared` codes
 * only, plus dispatch-by-code in the finance/invoices web components).
 */
export const FINANCE_INVOICES_ERROR_CODES = [
  // transaction lifecycle
  'FINANCE_TRANSACTION_NOT_FOUND',
  'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
  'FINANCE_TRANSACTION_ALREADY_DELETED',
  'FINANCE_TRANSACTION_NOT_DELETED',
  'FINANCE_TRANSACTION_NOT_PENDING',
  'FINANCE_TRANSACTION_DELETE_REASON_REQUIRED',
  'FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED',
  'FINANCE_REJECTION_REASON_REQUIRED',
  'FINANCE_ROW_AMOUNT_MISMATCH',
  'FINANCE_ROW_STATE_CHANGED_WHILE_EDITING',
  'FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW',
  'FINANCE_CASCADE_PREVIEW_STALE',
  'FINANCE_SHARE_LEFT_PENDING_DURING_SAVE',
  // tx hash / on-chain
  'FINANCE_TX_HASH_INVALID',
  'FINANCE_TX_HASH_ALREADY_CONSUMED',
  'FINANCE_TX_HASH_RELEASE_REASON_REQUIRED',
  'FINANCE_TX_HASH_NOT_CONSUMED',
  'FINANCE_TX_HASH_REQUIRED',
  'FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT',
  'FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET',
  'FINANCE_TX_NOT_CONFIRMED_ONCHAIN',
  'FINANCE_ONCHAIN_AMOUNT_MISMATCH',
  'FINANCE_CRYPTO_TX_HASH_TOO_SHORT',
  'FINANCE_SIMULATION_TX_NOT_CONFIRMED',
  'FINANCE_TX_HASH_PARAM_REQUIRED',
  // income declaration
  'FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED',
  'FINANCE_SHARES_SUM_EXCEEDS_100',
  'FINANCE_INCOME_OWN_PROJECTS_ONLY',
  'FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED',
  'FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT',
  'FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN',
  'FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE',
  'FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH',
  'FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY',
  'FINANCE_INCOME_RECEIVER_ARCHIVED',
  'FINANCE_NOT_YOUR_DROP_PROJECT',
  'FINANCE_EDIT_SENIOR_INCOME_ONLY',
  'FINANCE_EDIT_REJECTED_ONLY',
  'FINANCE_EDIT_DROP_INCOME_ONLY',
  'FINANCE_VALIDATE_WRONG_TYPE',
  'FINANCE_ADMIN_NO_SALARY',
  // receipts
  'FINANCE_RECEIPT_ATTACH_FORBIDDEN',
  'FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN',
  'FINANCE_RECEIPT_DOCUMENT_NOT_FOUND',
  'FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY',
  'FINANCE_RECEIPT_DOCUMENT_NOT_OWNED',
  // edit/delete restrictions
  'FINANCE_EDIT_PAYOUT_FORBIDDEN',
  'FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN',
  'FINANCE_DELETE_PAYOUT_FORBIDDEN',
  'FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN',
  'FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN',
  'FINANCE_PAY_SALARY_ONLY',
  // derivative cascade rows
  'FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT',
  'FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH',
  'FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN',
  'FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE',
  'FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN',
  // salary
  'FINANCE_SALARY_ROLE_NOT_ELIGIBLE',
  'FINANCE_SALARY_RECEIVER_ARCHIVED',
  'FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH',
  'FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED',
  'FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN',
  // transfer
  'FINANCE_TRANSFER_SENDER_ID_REQUIRED',
  'FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN',
  'FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN',
  'FINANCE_TRANSFER_RECEIVER_ARCHIVED',
  // payout requests
  'FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE',
  'FINANCE_PAYOUT_SINGLE_PROJECT_ONLY',
  'FINANCE_COMPANY_WALLET_NOT_CONFIGURED',
  'FINANCE_NBU_RATE_UNAVAILABLE',
  'FINANCE_PAYOUT_REQUEST_NOT_FOUND',
  'FINANCE_PAYOUT_REQUEST_ALREADY_PAID',
  'FINANCE_RECIPIENT_ADMIN_NOT_FOUND',
  'FINANCE_RECIPIENT_MUST_BE_ADMIN',
  'FINANCE_RECIPIENT_ADMIN_ARCHIVED',
  'FINANCE_PAYOUT_NOT_PENDING_PAYMENT',
  'FINANCE_CONFIRM_PAYOUT_ONLY',
  'FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
  'FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT',
  'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS',
  // drop
  'FINANCE_DROP_SUMMARY_FORBIDDEN',
  'FINANCE_DROP_INCOMES_FORBIDDEN',
  'FINANCE_DROP_PAYMENTS_FORBIDDEN',
  // summaries / RBAC
  'FINANCE_SUMMARY_FORBIDDEN',
  'FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN',
  'FINANCE_SENIOR_SUMMARY_FORBIDDEN',
  'FINANCE_INCOME_COMPLIANCE_FORBIDDEN',
  'FINANCE_SALARY_MONTH_GAP_FORBIDDEN',
  'FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN',
  // balance
  'FINANCE_ADMIN_BALANCE_FORBIDDEN',
  'FINANCE_SENIOR_BALANCE_FORBIDDEN',
  'FINANCE_TOTAL_EARNED_FORBIDDEN',
  'FINANCE_PENDING_OBLIGATIONS_FORBIDDEN',
  // company account
  'FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN',
  'FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY',
  'FINANCE_WALLET_ADDRESS_INVALID',
  'FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY',
  'FINANCE_COMPANY_REQUISITES_TOO_LONG',
  'FINANCE_COMPANY_DEPOSIT_FORBIDDEN',
  'FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN',
  'FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY',
  'FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE',
  'FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN',
  'FINANCE_DIVIDEND_RECEIVER_ARCHIVED',
  // pending settlement / obligations
  'FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED',
  'FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN',
  'FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN',
  'FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN',
  'FINANCE_OBLIGATION_NOT_COMPANY_TYPE',
  'FINANCE_OBLIGATION_ALREADY_CLOSED',
  'FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT',
  'FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY',
  'FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY',
  'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION',
  'FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO',
  'FINANCE_OBLIGATION_OVERPAID',
  'FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY',
  'FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH',
  'FINANCE_OBLIGATION_AMOUNT_CHANGED',
  'FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING',
  'FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION',
  'FINANCE_OBLIGATION_NOT_FOUND',
  'FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
  'FINANCE_SETTLED_AMOUNT_NEGATIVE',
  'FINANCE_SETTLED_AMOUNT_OVER_LIMIT',
  // invoices
  'INVOICE_NOT_APPLICABLE_FOR_TX_TYPE',
  'INVOICE_NOT_GENERATED_YET',
  'INVOICE_NOT_GENERATED_RETRY',
  'INVOICE_NOT_COUNTERPARTY',
  'INVOICE_ALREADY_SIGNED',
  'INVOICE_COMPANY_SIGNATURE_MISSING',
  'INVOICE_DOCUMENT_NOT_FOUND',
  'INVOICE_PDF_MODIFIED_AFTER_SIGNATURE',
  'INVOICE_USER_DATA_FETCH_FAILED',
  'INVOICE_AMOUNT_VERIFICATION_FAILED',
  'INVOICE_VOIDED',
  'INVOICE_NOT_FOUND',
  'INVOICE_ACCESS_DENIED',
  // misc controller-level
  'FINANCE_DATE_FORMAT_INVALID',
] as const
export type FinanceInvoicesErrorCode = (typeof FINANCE_INVOICES_ERROR_CODES)[number]

export const FINANCE_INVOICES_ERROR_PARAMS = {
  FINANCE_TRANSACTION_NOT_FOUND: [],
  FINANCE_TRANSACTION_DELETED_RESTORE_FIRST: [],
  FINANCE_TRANSACTION_ALREADY_DELETED: [],
  FINANCE_TRANSACTION_NOT_DELETED: [],
  FINANCE_TRANSACTION_NOT_PENDING: [],
  FINANCE_TRANSACTION_DELETE_REASON_REQUIRED: [],
  FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED: [],
  FINANCE_REJECTION_REASON_REQUIRED: [],
  FINANCE_ROW_AMOUNT_MISMATCH: [],
  FINANCE_ROW_STATE_CHANGED_WHILE_EDITING: [],
  FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW: [],
  FINANCE_CASCADE_PREVIEW_STALE: [],
  FINANCE_SHARE_LEFT_PENDING_DURING_SAVE: [],
  FINANCE_TX_HASH_INVALID: [],
  FINANCE_TX_HASH_ALREADY_CONSUMED: [],
  FINANCE_TX_HASH_RELEASE_REASON_REQUIRED: [],
  FINANCE_TX_HASH_NOT_CONSUMED: [],
  FINANCE_TX_HASH_REQUIRED: [],
  FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT: [],
  FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET: [],
  FINANCE_TX_NOT_CONFIRMED_ONCHAIN: [],
  FINANCE_ONCHAIN_AMOUNT_MISMATCH: [],
  FINANCE_CRYPTO_TX_HASH_TOO_SHORT: [],
  FINANCE_SIMULATION_TX_NOT_CONFIRMED: [],
  FINANCE_TX_HASH_PARAM_REQUIRED: [],
  FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED: ['currency'],
  FINANCE_SHARES_SUM_EXCEEDS_100: [],
  FINANCE_INCOME_OWN_PROJECTS_ONLY: [],
  FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED: [],
  FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT: [],
  FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN: [],
  FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE: [],
  FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH: [],
  FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY: [],
  FINANCE_INCOME_RECEIVER_ARCHIVED: [],
  FINANCE_NOT_YOUR_DROP_PROJECT: [],
  FINANCE_EDIT_SENIOR_INCOME_ONLY: [],
  FINANCE_EDIT_REJECTED_ONLY: [],
  FINANCE_EDIT_DROP_INCOME_ONLY: [],
  FINANCE_VALIDATE_WRONG_TYPE: [],
  FINANCE_ADMIN_NO_SALARY: [],
  FINANCE_RECEIPT_ATTACH_FORBIDDEN: [],
  FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN: [],
  FINANCE_RECEIPT_DOCUMENT_NOT_FOUND: [],
  FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY: [],
  FINANCE_RECEIPT_DOCUMENT_NOT_OWNED: [],
  FINANCE_EDIT_PAYOUT_FORBIDDEN: [],
  FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN: [],
  FINANCE_DELETE_PAYOUT_FORBIDDEN: [],
  FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN: [],
  FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN: [],
  FINANCE_PAY_SALARY_ONLY: [],
  FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT: [],
  FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH: [],
  FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN: [],
  FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE: ['settledCurrency', 'currency'],
  FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN: [],
  FINANCE_SALARY_ROLE_NOT_ELIGIBLE: [],
  FINANCE_SALARY_RECEIVER_ARCHIVED: [],
  FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH: [],
  FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED: [],
  FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN: [],
  FINANCE_TRANSFER_SENDER_ID_REQUIRED: [],
  FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN: [],
  FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN: [],
  FINANCE_TRANSFER_RECEIVER_ARCHIVED: [],
  FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE: [],
  FINANCE_PAYOUT_SINGLE_PROJECT_ONLY: [],
  FINANCE_COMPANY_WALLET_NOT_CONFIGURED: [],
  FINANCE_NBU_RATE_UNAVAILABLE: [],
  FINANCE_PAYOUT_REQUEST_NOT_FOUND: [],
  FINANCE_PAYOUT_REQUEST_ALREADY_PAID: [],
  FINANCE_RECIPIENT_ADMIN_NOT_FOUND: [],
  FINANCE_RECIPIENT_MUST_BE_ADMIN: [],
  FINANCE_RECIPIENT_ADMIN_ARCHIVED: [],
  FINANCE_PAYOUT_NOT_PENDING_PAYMENT: [],
  FINANCE_CONFIRM_PAYOUT_ONLY: [],
  FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST: [],
  FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT: [],
  FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS: [],
  FINANCE_DROP_SUMMARY_FORBIDDEN: [],
  FINANCE_DROP_INCOMES_FORBIDDEN: [],
  FINANCE_DROP_PAYMENTS_FORBIDDEN: [],
  FINANCE_SUMMARY_FORBIDDEN: [],
  FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN: [],
  FINANCE_SENIOR_SUMMARY_FORBIDDEN: [],
  FINANCE_INCOME_COMPLIANCE_FORBIDDEN: [],
  FINANCE_SALARY_MONTH_GAP_FORBIDDEN: [],
  FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN: [],
  FINANCE_ADMIN_BALANCE_FORBIDDEN: [],
  FINANCE_SENIOR_BALANCE_FORBIDDEN: [],
  FINANCE_TOTAL_EARNED_FORBIDDEN: [],
  FINANCE_PENDING_OBLIGATIONS_FORBIDDEN: [],
  FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN: [],
  FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY: [],
  FINANCE_WALLET_ADDRESS_INVALID: [],
  FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY: [],
  FINANCE_COMPANY_REQUISITES_TOO_LONG: ['maxChars'],
  FINANCE_COMPANY_DEPOSIT_FORBIDDEN: [],
  FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN: [],
  FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY: [],
  FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE: [],
  FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN: [],
  FINANCE_DIVIDEND_RECEIVER_ARCHIVED: [],
  FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED: ['currency'],
  FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN: [],
  FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN: [],
  FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN: [],
  FINANCE_OBLIGATION_NOT_COMPANY_TYPE: [],
  FINANCE_OBLIGATION_ALREADY_CLOSED: [],
  FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT: [],
  FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY: [],
  FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY: ['obligationCurrency'],
  FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION: [],
  FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO: [],
  FINANCE_OBLIGATION_OVERPAID: [],
  FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY: ['sourceSettledCurrency', 'currency'],
  FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH: [],
  FINANCE_OBLIGATION_AMOUNT_CHANGED: [],
  FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING: [],
  FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION: [],
  FINANCE_OBLIGATION_NOT_FOUND: [],
  FINANCE_SETTLED_AMOUNT_NOT_NUMBER: [],
  FINANCE_SETTLED_AMOUNT_NEGATIVE: [],
  FINANCE_SETTLED_AMOUNT_OVER_LIMIT: ['maxAmount'],
  INVOICE_NOT_APPLICABLE_FOR_TX_TYPE: [],
  INVOICE_NOT_GENERATED_YET: [],
  INVOICE_NOT_GENERATED_RETRY: [],
  INVOICE_NOT_COUNTERPARTY: [],
  INVOICE_ALREADY_SIGNED: [],
  INVOICE_COMPANY_SIGNATURE_MISSING: [],
  INVOICE_DOCUMENT_NOT_FOUND: [],
  INVOICE_PDF_MODIFIED_AFTER_SIGNATURE: [],
  INVOICE_USER_DATA_FETCH_FAILED: [],
  INVOICE_AMOUNT_VERIFICATION_FAILED: [],
  INVOICE_VOIDED: [],
  INVOICE_NOT_FOUND: [],
  INVOICE_ACCESS_DENIED: [],
  FINANCE_DATE_FORMAT_INVALID: [],
} as const satisfies Record<FinanceInvoicesErrorCode, readonly string[]>

export const FINANCE_INVOICES_ERROR_MESSAGES: Record<FinanceInvoicesErrorCode, MessageDescriptor> =
  {
    FINANCE_TRANSACTION_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_NOT_FOUND',
      message: 'Транзакцію не знайдено',
    },
    FINANCE_TRANSACTION_DELETED_RESTORE_FIRST: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
      message: 'Транзакцію видалено — відновіть її перед цією дією',
    },
    FINANCE_TRANSACTION_ALREADY_DELETED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_ALREADY_DELETED',
      message: 'Транзакцію вже видалено',
    },
    FINANCE_TRANSACTION_NOT_DELETED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_NOT_DELETED',
      message: 'Транзакцію не видалено',
    },
    FINANCE_TRANSACTION_NOT_PENDING: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_NOT_PENDING',
      message: 'Транзакція не в статусі очікування',
    },
    FINANCE_TRANSACTION_DELETE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_DELETE_REASON_REQUIRED',
      message: 'Вкажіть причину видалення транзакції — вона потрапить до журналу',
    },
    FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED',
      message: 'Вкажіть причину відновлення транзакції — вона потрапить до журналу',
    },
    FINANCE_REJECTION_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_REJECTION_REASON_REQUIRED',
      message: 'Вкажіть причину відхилення',
    },
    FINANCE_ROW_AMOUNT_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_ROW_AMOUNT_MISMATCH',
      message:
        'Сума однієї з часток не збігається з уже виплаченим — правку заблоковано до ручної звірки',
    },
    FINANCE_ROW_STATE_CHANGED_WHILE_EDITING: /* i18n */ {
      id: 'api-error.FINANCE_ROW_STATE_CHANGED_WHILE_EDITING',
      message:
        'Стан рядка змінився, поки ви його редагували (його оплатили або видалили) — оновіть сторінку і повторіть',
    },
    FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW: /* i18n */ {
      id: 'api-error.FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW',
      message:
        'Правку не збережено — сума оплаченої транзакції тягне за собою частки і зобов’язання: відкрийте передперегляд і повторіть',
    },
    FINANCE_CASCADE_PREVIEW_STALE: /* i18n */ {
      id: 'api-error.FINANCE_CASCADE_PREVIEW_STALE',
      message:
        'Дані змінилися з моменту передперегляду — попередній розрахунок більше не діє, оновіть передперегляд і повторіть збереження',
    },
    FINANCE_SHARE_LEFT_PENDING_DURING_SAVE: /* i18n */ {
      id: 'api-error.FINANCE_SHARE_LEFT_PENDING_DURING_SAVE',
      message:
        'Одна з часток вийшла з очікування виплати, поки тривало збереження — правку скасовано повністю, нічого не змінилося',
    },
    FINANCE_TX_HASH_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_INVALID',
      message: 'Некоректний хеш транзакції — очікується 0x + 64 hex або посилання на Etherscan',
    },
    FINANCE_TX_HASH_ALREADY_CONSUMED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_ALREADY_CONSUMED',
      message: 'Цей хеш транзакції вже використано (виплата або поповнення рахунку компанії)',
    },
    FINANCE_TX_HASH_RELEASE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_RELEASE_REASON_REQUIRED',
      message: 'Вкажіть причину звільнення хешу — вона потрапить до журналу',
    },
    FINANCE_TX_HASH_NOT_CONSUMED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_NOT_CONSUMED',
      message: 'Цей хеш не позначений як використаний',
    },
    FINANCE_TX_HASH_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_REQUIRED',
      message: 'Хеш транзакції обов’язковий',
    },
    FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT',
      message: 'Цей хеш транзакції вже використано для іншої виплати',
    },
    FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET: /* i18n */ {
      id: 'api-error.FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET',
      message: 'Отримувач транзакції не збігається з гаманцем компанії',
    },
    FINANCE_TX_NOT_CONFIRMED_ONCHAIN: /* i18n */ {
      id: 'api-error.FINANCE_TX_NOT_CONFIRMED_ONCHAIN',
      message: 'Транзакцію ще не підтверджено в мережі',
    },
    FINANCE_ONCHAIN_AMOUNT_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_ONCHAIN_AMOUNT_MISMATCH',
      message: 'Сума on-chain транзакції має точно збігатися із сумою виплати',
    },
    FINANCE_CRYPTO_TX_HASH_TOO_SHORT: /* i18n */ {
      id: 'api-error.FINANCE_CRYPTO_TX_HASH_TOO_SHORT',
      message: 'Для crypto-методу потрібен хеш транзакції мінімум 10 символів',
    },
    FINANCE_SIMULATION_TX_NOT_CONFIRMED: /* i18n */ {
      id: 'api-error.FINANCE_SIMULATION_TX_NOT_CONFIRMED',
      message: 'Симуляція: транзакцію не підтверджено',
    },
    FINANCE_TX_HASH_PARAM_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_PARAM_REQUIRED',
      message: 'Вкажіть рівно один параметр txHash — 0x + 64 hex або посилання на Etherscan',
    },
    FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED: /* i18n */ {
      id: 'api-error.FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED',
      message: 'Непідтримувана валюта для конверсії в USDT: {currency}',
    },
    FINANCE_SHARES_SUM_EXCEEDS_100: /* i18n */ {
      id: 'api-error.FINANCE_SHARES_SUM_EXCEEDS_100',
      message: 'Сума часток сеньйора і дропа перевищує 100%',
    },
    FINANCE_INCOME_OWN_PROJECTS_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_OWN_PROJECTS_ONLY',
      message: 'Заявити дохід можна лише за власним проєктом',
    },
    FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED',
      message: 'Дохід адміністратора можна заявити лише за проєктом адміністратора',
    },
    FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT',
      message: 'Бухгалтер не обирає, хто отримує дохід адміністратора',
    },
    FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN',
      message: 'Отримувач має бути активним адміністратором',
    },
    FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE: /* i18n */ {
      id: 'api-error.FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE',
      message:
        'Дохід USDT-проєкту заявляється як USDT-дохід — тоді одразу враховуються частки сеньйора й дропа',
    },
    FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH',
      message: 'USDT-дохід можна заявити лише за USDT-проєктом',
    },
    FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY',
      message: 'Дохід USDT-проєкту заявляє лише адміністратор',
    },
    FINANCE_INCOME_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_RECEIVER_ARCHIVED',
      message: 'Користувача заархівовано — дохід не оголошується',
    },
    FINANCE_NOT_YOUR_DROP_PROJECT: /* i18n */ {
      id: 'api-error.FINANCE_NOT_YOUR_DROP_PROJECT',
      message: 'Це не ваш drop-проєкт',
    },
    FINANCE_EDIT_SENIOR_INCOME_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_SENIOR_INCOME_ONLY',
      message: 'Редагувати можна лише дохід сеньйора',
    },
    FINANCE_EDIT_REJECTED_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_REJECTED_ONLY',
      message: 'Редагувати можна лише відхилені транзакції',
    },
    FINANCE_EDIT_DROP_INCOME_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_DROP_INCOME_ONLY',
      message: 'Редагувати можна лише дохід дропа',
    },
    FINANCE_VALIDATE_WRONG_TYPE: /* i18n */ {
      id: 'api-error.FINANCE_VALIDATE_WRONG_TYPE',
      message: 'Валідувати можна лише дохід сеньйора або дропа',
    },
    FINANCE_ADMIN_NO_SALARY: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_NO_SALARY',
      message: 'Адміністратор не отримує зарплату — його дохід іде через частки',
    },
    FINANCE_RECEIPT_ATTACH_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_ATTACH_FORBIDDEN',
      message: 'Немає прав прикріпити чек до цієї транзакції',
    },
    FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN',
      message: 'Замінити чек після оплати можуть лише адміністратор або бухгалтер',
    },
    FINANCE_RECEIPT_DOCUMENT_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_DOCUMENT_NOT_FOUND',
      message: 'Документ чека не знайдено',
    },
    FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY',
      message: 'Прикріпити до транзакції можна лише документ категорії «Чек»',
    },
    FINANCE_RECEIPT_DOCUMENT_NOT_OWNED: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_DOCUMENT_NOT_OWNED',
      message: 'Немає прав прикріпити цей документ чека',
    },
    FINANCE_EDIT_PAYOUT_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_PAYOUT_FORBIDDEN',
      message: 'Виплату редагувати не можна',
    },
    FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN',
      message: 'Редагувати транзакцію, пов’язану із заявкою на виплату, не можна',
    },
    FINANCE_DELETE_PAYOUT_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DELETE_PAYOUT_FORBIDDEN',
      message: 'Виплату видалити не можна',
    },
    FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN',
      message: 'Видаляти транзакцію, пов’язану із заявкою на виплату, не можна',
    },
    FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN',
      message: 'Видаляти транзакцію, яка є джерелом зобов’язання компанії, не можна',
    },
    FINANCE_PAY_SALARY_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_PAY_SALARY_ONLY',
      message: 'Оплатити можна лише зарплату',
    },
    FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT',
      message: 'В однієї з часток не збережено відсоток — перерахувати її можна лише вручну',
    },
    FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH',
      message:
        'Зобов’язання за однією з часток записане в іншій валюті — перерахувати його не можна',
    },
    FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN',
      message: 'Не записано, скільки вже виплачено за однією з часток — потрібна ручна звірка',
    },
    FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE',
      message:
        'За однією з часток уже виплачено в {settledCurrency}, а нова сума в {currency} — потрібна ручна звірка',
    },
    FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN',
      message:
        'Одну з часток закрила транзакція нетипового виду — повернути її до очікування виплати не можна',
    },
    FINANCE_SALARY_ROLE_NOT_ELIGIBLE: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_ROLE_NOT_ELIGIBLE',
      message: 'Зарплату можна створити лише для джуніора, HR, бухгалтера, сеньйора або дропа',
    },
    FINANCE_SALARY_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — зарплата не нараховується',
    },
    FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH',
      message: 'Зарплату для цього співробітника за вибраний місяць уже створено',
    },
    FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED',
      message: 'Отримувача зарплати заархівовано — виплата неможлива',
    },
    FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN',
      message: 'Особистий рахунок-платник має належати адміністратору',
    },
    FINANCE_TRANSFER_SENDER_ID_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_SENDER_ID_REQUIRED',
      message: 'Вкажіть відправника — переказ можливий лише між двома адміністраторами',
    },
    FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN',
      message: 'Відправник має бути адміністратором',
    },
    FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN',
      message: 'Переказати можна лише іншому адміністратору',
    },
    FINANCE_TRANSFER_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — переказ неможливий',
    },
    FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE',
      message: 'Частина транзакцій уже включена до виплати або недоступна',
    },
    FINANCE_PAYOUT_SINGLE_PROJECT_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_SINGLE_PROJECT_ONLY',
      message: 'Виплата має охоплювати лише один проєкт',
    },
    FINANCE_COMPANY_WALLET_NOT_CONFIGURED: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_WALLET_NOT_CONFIGURED',
      message: 'Гаманець компанії не налаштовано',
    },
    FINANCE_NBU_RATE_UNAVAILABLE: /* i18n */ {
      id: 'api-error.FINANCE_NBU_RATE_UNAVAILABLE',
      message: 'Курс НБУ недоступний — спробуйте пізніше',
    },
    FINANCE_PAYOUT_REQUEST_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_REQUEST_NOT_FOUND',
      message: 'Заявку на виплату не знайдено',
    },
    FINANCE_PAYOUT_REQUEST_ALREADY_PAID: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_REQUEST_ALREADY_PAID',
      message: 'Заявку на виплату вже оплачено',
    },
    FINANCE_RECIPIENT_ADMIN_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_RECIPIENT_ADMIN_NOT_FOUND',
      message: 'Адміністратора-отримувача не знайдено',
    },
    FINANCE_RECIPIENT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_RECIPIENT_MUST_BE_ADMIN',
      message: 'Отримувач має бути адміністратором',
    },
    FINANCE_RECIPIENT_ADMIN_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_RECIPIENT_ADMIN_ARCHIVED',
      message: 'Адміністратора-отримувача заархівовано',
    },
    FINANCE_PAYOUT_NOT_PENDING_PAYMENT: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_NOT_PENDING_PAYMENT',
      message: 'Виплата не очікує оплати — можливо, її вже підтверджено',
    },
    FINANCE_CONFIRM_PAYOUT_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_CONFIRM_PAYOUT_ONLY',
      message: 'Підтвердити можна лише виплату',
    },
    FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
      message: 'Транзакцію виплати за цією заявкою не знайдено',
    },
    FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT: /* i18n */ {
      id: 'api-error.FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT',
      message: 'Сеньйора на drop-проєкті не знайдено',
    },
    FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS',
      message: 'Недостатньо коштів на рахунку компанії',
    },
    FINANCE_DROP_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DROP_SUMMARY_FORBIDDEN',
      message: 'Зведення дропа доступне лише дропу',
    },
    FINANCE_DROP_INCOMES_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DROP_INCOMES_FORBIDDEN',
      message: 'Доходи дропа доступні лише дропу',
    },
    FINANCE_DROP_PAYMENTS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DROP_PAYMENTS_FORBIDDEN',
      message: 'Виплати дропа доступні лише дропу',
    },
    FINANCE_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SUMMARY_FORBIDDEN',
      message: 'Фінансове зведення доступне лише адміністратору і бухгалтеру',
    },
    FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN',
      message: 'Зведення бухгалтера доступне лише бухгалтеру і адміністратору',
    },
    FINANCE_SENIOR_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SENIOR_SUMMARY_FORBIDDEN',
      message: 'Зведення сеньйора доступне лише сеньйору і адміністратору',
    },
    FINANCE_INCOME_COMPLIANCE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_COMPLIANCE_FORBIDDEN',
      message: 'Огляд відповідності доходів доступний лише адміністратору і бухгалтеру',
    },
    FINANCE_SALARY_MONTH_GAP_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_MONTH_GAP_FORBIDDEN',
      message: 'Звіт про прогалини місяців зарплати доступний лише адміністратору і бухгалтеру',
    },
    FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN',
      message: 'Заповнення прогалин місяців зарплати доступне лише адміністратору',
    },
    FINANCE_ADMIN_BALANCE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_BALANCE_FORBIDDEN',
      message: 'Баланс адміністратора бачить лише він сам або бухгалтер',
    },
    FINANCE_SENIOR_BALANCE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SENIOR_BALANCE_FORBIDDEN',
      message: 'Баланс сеньйора бачать адміністратор, бухгалтер або сам сеньйор',
    },
    FINANCE_TOTAL_EARNED_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_TOTAL_EARNED_FORBIDDEN',
      message: 'Показник «всього зароблено» бачать лише адміністратор і бухгалтер',
    },
    FINANCE_PENDING_OBLIGATIONS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_PENDING_OBLIGATIONS_FORBIDDEN',
      message: 'Зобов’язання, що очікують виплати, бачать лише адміністратор, бухгалтер і сеньйор',
    },
    FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN',
      message: 'Рахунок компанії бачать лише адміністратор і бухгалтер',
    },
    FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY',
      message: 'Змінити гаманець компанії може лише адміністратор',
    },
    FINANCE_WALLET_ADDRESS_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_WALLET_ADDRESS_INVALID',
      message: 'Некоректна адреса гаманця — очікується 0x + 40 hex',
    },
    FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY',
      message: 'Змінити реквізити компанії може лише адміністратор',
    },
    FINANCE_COMPANY_REQUISITES_TOO_LONG: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_REQUISITES_TOO_LONG',
      message: 'Реквізити не повинні перевищувати {maxChars} символів',
    },
    FINANCE_COMPANY_DEPOSIT_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_DEPOSIT_FORBIDDEN',
      message: 'Поповнювати рахунок компанії можуть лише сеньйор або дроп',
    },
    FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN',
      message: 'Статус депозиту бачать власник, адміністратор або бухгалтер',
    },
    FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY',
      message: 'Виводити дивіденди може лише адміністратор',
    },
    FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE',
      message: 'Сума дивідендів має бути додатною',
    },
    FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN',
      message: 'Дивіденди можна вивести лише на рахунок адміністратора',
    },
    FINANCE_DIVIDEND_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — дивіденди не виплачуються',
    },
    FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED: /* i18n */ {
      id: 'api-error.FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED',
      message:
        'Закриття USDT-зобов’язання в {currency} без конверсії суми не підтримується. Використайте USD або USDT',
    },
    FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN',
      message: 'Зобов’язання, що очікують виплати, бачать лише адміністратор, бухгалтер і сеньйор',
    },
    FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN',
      message:
        'Список зобов’язань компанії перед сеньйорами доступний лише адміністраторам і бухгалтерам',
    },
    FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN',
      message: 'Закривати зобов’язання компанії можуть лише адміністратор або бухгалтер',
    },
    FINANCE_OBLIGATION_NOT_COMPANY_TYPE: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_NOT_COMPANY_TYPE',
      message: 'Це зобов’язання закриває не компанія',
    },
    FINANCE_OBLIGATION_ALREADY_CLOSED: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_ALREADY_CLOSED',
      message: 'Зобов’язання вже закрито або скасовано',
    },
    FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT: /* i18n */ {
      id: 'api-error.FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT',
      message:
        'Частка дропа з цієї виплати не проходила через рахунок компанії — виберіть особистий рахунок адміністратора',
    },
    FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY: /* i18n */ {
      id: 'api-error.FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY',
      message: 'Зобов’язання дропа пошкоджено: валюта зобов’язання не USDT — конверсія неможлива',
    },
    FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY',
      message:
        'Доплата за цим рядком можлива лише в {obligationCurrency} — курс зафіксовано попередньою виплатою, залишок закривається окремою ручною звіркою',
    },
    FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION',
      message: 'Дата виплати не може бути раніше дати виникнення зобов’язання',
    },
    FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO: /* i18n */ {
      id: 'api-error.FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO',
      message:
        'Після округлення сума виплати стала нульовою, хоча зобов’язання не нульове — виберіть іншу валюту виплати',
    },
    FINANCE_OBLIGATION_OVERPAID: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_OVERPAID',
      message:
        'За цим зобов’язанням уже виплачено більше, ніж воно коштує — потрібне ручне рішення щодо переплати',
    },
    FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY: /* i18n */ {
      id: 'api-error.FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY',
      message:
        'Накопичена сума виплат за цим рядком уже записана в {sourceSettledCurrency} — повторна виплата в {currency} неможлива без звірки валют',
    },
    FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH: /* i18n */ {
      id: 'api-error.FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH',
      message:
        'Доплата за цим рядком має йти з того самого джерела, що й попередня виплата — зверніться до бухгалтера для звірки',
    },
    FINANCE_OBLIGATION_AMOUNT_CHANGED: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_AMOUNT_CHANGED',
      message:
        'Сума зобов’язання змінилася після завантаження — оновіть сторінку і повторіть закриття',
    },
    FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING',
      message:
        'Не вдалося закрити зобов’язання: вихідна транзакція зобов’язання не в статусі очікування виплати',
    },
    FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION: /* i18n */ {
      id: 'api-error.FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION',
      message: 'Відкрите зобов’язання для цієї транзакції не знайдено',
    },
    FINANCE_OBLIGATION_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_NOT_FOUND',
      message: 'Зобов’язання не знайдено',
    },
    FINANCE_SETTLED_AMOUNT_NOT_NUMBER: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
      message: 'Сума виплати має бути числом',
    },
    FINANCE_SETTLED_AMOUNT_NEGATIVE: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_NEGATIVE',
      message: 'Сума виплати не може бути від’ємною',
    },
    FINANCE_SETTLED_AMOUNT_OVER_LIMIT: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_OVER_LIMIT',
      message: 'Сума не може перевищувати {maxAmount}',
    },
    INVOICE_NOT_APPLICABLE_FOR_TX_TYPE: /* i18n */ {
      id: 'api-error.INVOICE_NOT_APPLICABLE_FOR_TX_TYPE',
      message: 'Рахунок не передбачений для цього типу транзакції',
    },
    INVOICE_NOT_GENERATED_YET: /* i18n */ {
      id: 'api-error.INVOICE_NOT_GENERATED_YET',
      message: 'Рахунок ще не згенеровано',
    },
    INVOICE_NOT_GENERATED_RETRY: /* i18n */ {
      id: 'api-error.INVOICE_NOT_GENERATED_RETRY',
      message: 'Рахунок ще не згенеровано — повторіть спробу пізніше',
    },
    INVOICE_NOT_COUNTERPARTY: /* i18n */ {
      id: 'api-error.INVOICE_NOT_COUNTERPARTY',
      message: 'Ви не контрагент цієї транзакції',
    },
    INVOICE_ALREADY_SIGNED: /* i18n */ {
      id: 'api-error.INVOICE_ALREADY_SIGNED',
      message: 'Рахунок вже підписано',
    },
    INVOICE_COMPANY_SIGNATURE_MISSING: /* i18n */ {
      id: 'api-error.INVOICE_COMPANY_SIGNATURE_MISSING',
      message: 'Відсутній підпис компанії',
    },
    INVOICE_DOCUMENT_NOT_FOUND: /* i18n */ {
      id: 'api-error.INVOICE_DOCUMENT_NOT_FOUND',
      message: 'Документ рахунку не знайдено',
    },
    INVOICE_PDF_MODIFIED_AFTER_SIGNATURE: /* i18n */ {
      id: 'api-error.INVOICE_PDF_MODIFIED_AFTER_SIGNATURE',
      message: 'PDF змінено після першого підпису — зверніться до адміністратора',
    },
    INVOICE_USER_DATA_FETCH_FAILED: /* i18n */ {
      id: 'api-error.INVOICE_USER_DATA_FETCH_FAILED',
      message: 'Не вдалося отримати дані користувачів',
    },
    INVOICE_AMOUNT_VERIFICATION_FAILED: /* i18n */ {
      id: 'api-error.INVOICE_AMOUNT_VERIFICATION_FAILED',
      message: 'Не вдалося підтвердити суму цього рахунку — зверніться до адміністратора',
    },
    INVOICE_VOIDED: /* i18n */ {
      id: 'api-error.INVOICE_VOIDED',
      message: 'Рахунок анульовано — оновіть сторінку',
    },
    INVOICE_NOT_FOUND: /* i18n */ {
      id: 'api-error.INVOICE_NOT_FOUND',
      message: 'Рахунок не знайдено',
    },
    INVOICE_ACCESS_DENIED: /* i18n */ {
      id: 'api-error.INVOICE_ACCESS_DENIED',
      message: 'Немає доступу до цього рахунку',
    },
    FINANCE_DATE_FORMAT_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_DATE_FORMAT_INVALID',
      message: 'Дата має бути у форматі YYYYMMDD',
    },
  }

export const FINANCE_INVOICES_ERROR_FALLBACK_EN: Record<FinanceInvoicesErrorCode, string> = {
  FINANCE_TRANSACTION_NOT_FOUND: 'Transaction not found',
  FINANCE_TRANSACTION_DELETED_RESTORE_FIRST:
    'The transaction is deleted — restore it before this action',
  FINANCE_TRANSACTION_ALREADY_DELETED: 'The transaction is already deleted',
  FINANCE_TRANSACTION_NOT_DELETED: "The transaction isn't deleted",
  FINANCE_TRANSACTION_NOT_PENDING: "The transaction isn't pending",
  FINANCE_TRANSACTION_DELETE_REASON_REQUIRED:
    'Give a reason for deleting the transaction — it goes into the audit log',
  FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED:
    'Give a reason for restoring the transaction — it goes into the audit log',
  FINANCE_REJECTION_REASON_REQUIRED: 'Give a reason for the rejection',
  FINANCE_ROW_AMOUNT_MISMATCH:
    "One of the shares doesn't match what was already paid — the edit is blocked until a manual reconciliation",
  FINANCE_ROW_STATE_CHANGED_WHILE_EDITING:
    'The row changed while you were editing it (it was paid or deleted) — refresh the page and try again',
  FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW:
    "The edit wasn't saved — a paid transaction's amount cascades into shares and obligations: open the preview and try again",
  FINANCE_CASCADE_PREVIEW_STALE:
    'The data changed since the preview — the earlier calculation no longer applies, refresh the preview and save again',
  FINANCE_SHARE_LEFT_PENDING_DURING_SAVE:
    'One of the shares left pending payout while saving was in progress — the edit was cancelled entirely, nothing changed',
  FINANCE_TX_HASH_INVALID: 'Invalid transaction hash — expected 0x + 64 hex or an Etherscan link',
  FINANCE_TX_HASH_ALREADY_CONSUMED:
    'This transaction hash has already been used (a payout or a company account deposit)',
  FINANCE_TX_HASH_RELEASE_REASON_REQUIRED:
    'Give a reason for releasing the hash — it goes into the audit log',
  FINANCE_TX_HASH_NOT_CONSUMED: "This hash isn't marked as consumed",
  FINANCE_TX_HASH_REQUIRED: 'A transaction hash is required',
  FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT:
    'This transaction hash has already been used for another payout',
  FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET:
    "The transaction recipient doesn't match the company wallet",
  FINANCE_TX_NOT_CONFIRMED_ONCHAIN: "The transaction isn't confirmed on-chain yet",
  FINANCE_ONCHAIN_AMOUNT_MISMATCH:
    'The on-chain transaction amount must exactly match the payout amount',
  FINANCE_CRYPTO_TX_HASH_TOO_SHORT:
    'A crypto method needs a transaction hash of at least 10 characters',
  FINANCE_SIMULATION_TX_NOT_CONFIRMED: "Simulation: the transaction isn't confirmed",
  FINANCE_TX_HASH_PARAM_REQUIRED:
    'Provide exactly one txHash parameter — 0x + 64 hex or an Etherscan link',
  FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED:
    'Unsupported currency for USDT conversion: {currency}',
  FINANCE_SHARES_SUM_EXCEEDS_100: "The senior and drop shares' sum exceeds 100%",
  FINANCE_INCOME_OWN_PROJECTS_ONLY: 'You can only declare income for your own project',
  FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED:
    "Admin income can only be declared for an admin's project",
  FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT:
    "An accountant can't choose who receives admin income",
  FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN: 'The recipient must be an active admin',
  FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE:
    "Declare income on a USDT project as USDT income so the senior's and drop's shares are booked with it",
  FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH: 'USDT income can only be declared for a USDT project',
  FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY: 'Only an admin declares income on a USDT project',
  FINANCE_INCOME_RECEIVER_ARCHIVED: "The user is archived — income can't be declared",
  FINANCE_NOT_YOUR_DROP_PROJECT: "This isn't your drop project",
  FINANCE_EDIT_SENIOR_INCOME_ONLY: 'Only senior income can be edited',
  FINANCE_EDIT_REJECTED_ONLY: 'Only rejected transactions can be edited',
  FINANCE_EDIT_DROP_INCOME_ONLY: 'Only drop income can be edited',
  FINANCE_VALIDATE_WRONG_TYPE: 'Only senior or drop income can be validated',
  FINANCE_ADMIN_NO_SALARY: "An admin doesn't get a salary — admin income comes through shares",
  FINANCE_RECEIPT_ATTACH_FORBIDDEN:
    "You don't have permission to attach a receipt to this transaction",
  FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN:
    'Only an admin or an accountant can replace a receipt after payment',
  FINANCE_RECEIPT_DOCUMENT_NOT_FOUND: 'Receipt document not found',
  FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY:
    'Only a document in the Receipt category can be attached to a transaction',
  FINANCE_RECEIPT_DOCUMENT_NOT_OWNED: "You don't have permission to attach this receipt document",
  FINANCE_EDIT_PAYOUT_FORBIDDEN: "A payout can't be edited",
  FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN:
    "A transaction linked to a payout request can't be edited",
  FINANCE_DELETE_PAYOUT_FORBIDDEN: "A payout can't be deleted",
  FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN:
    "A transaction linked to a payout request can't be deleted",
  FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN:
    "A transaction that is the source of a company obligation can't be deleted",
  FINANCE_PAY_SALARY_ONLY: 'Only a salary can be paid',
  FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT:
    'One of the shares has no saved percentage — it can only be recalculated manually',
  FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH:
    "The obligation for one of the shares is in another currency — it can't be recalculated",
  FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN:
    "How much was already paid on one of the shares isn't recorded — a manual reconciliation is needed",
  FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE:
    'One of the shares was already paid in {settledCurrency} and its new amount is in {currency} — a manual reconciliation is needed',
  FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN:
    "One of the shares was closed by an unusual transaction type — it can't return to pending payout",
  FINANCE_SALARY_ROLE_NOT_ELIGIBLE:
    'Salary can only be created for a junior, HR, an accountant, a senior, or a drop',
  FINANCE_SALARY_RECEIVER_ARCHIVED: "The recipient is archived — salary isn't accrued",
  FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH:
    "This employee's salary for the selected month already exists",
  FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED:
    "The salary recipient is archived — payout isn't possible",
  FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN: 'The personal payer account must belong to an administrator',
  FINANCE_TRANSFER_SENDER_ID_REQUIRED:
    'Specify a sender — a transfer is only possible between two admins',
  FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN: 'The sender must be an admin',
  FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN: 'You can only transfer to another admin',
  FINANCE_TRANSFER_RECEIVER_ARCHIVED: "The recipient is archived — the transfer isn't possible",
  FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE:
    'Some of the transactions are already included in a payout or unavailable',
  FINANCE_PAYOUT_SINGLE_PROJECT_ONLY: 'A payout must cover only one project',
  FINANCE_COMPANY_WALLET_NOT_CONFIGURED: "The company wallet isn't configured",
  FINANCE_NBU_RATE_UNAVAILABLE: 'The NBU exchange rate is unavailable — try again later',
  FINANCE_PAYOUT_REQUEST_NOT_FOUND: 'Payout request not found',
  FINANCE_PAYOUT_REQUEST_ALREADY_PAID: 'The payout request is already paid',
  FINANCE_RECIPIENT_ADMIN_NOT_FOUND: 'Recipient admin not found',
  FINANCE_RECIPIENT_MUST_BE_ADMIN: 'The recipient must be an admin',
  FINANCE_RECIPIENT_ADMIN_ARCHIVED: 'The recipient administrator is archived',
  FINANCE_PAYOUT_NOT_PENDING_PAYMENT:
    "The payout isn't pending payment — it may already be confirmed",
  FINANCE_CONFIRM_PAYOUT_ONLY: 'Only a payout can be confirmed',
  FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST: 'No payout transaction found for this request',
  FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT: 'Senior not found on the drop project',
  FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS: 'Insufficient funds in the company account',
  FINANCE_DROP_SUMMARY_FORBIDDEN: 'The drop summary is available to a drop only',
  FINANCE_DROP_INCOMES_FORBIDDEN: 'Drop incomes are available to a drop only',
  FINANCE_DROP_PAYMENTS_FORBIDDEN: 'Drop payments are available to a drop only',
  FINANCE_SUMMARY_FORBIDDEN:
    'The finance summary is available to an administrator and an accountant only',
  FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN:
    'The accountant summary is available to an accountant and an administrator only',
  FINANCE_SENIOR_SUMMARY_FORBIDDEN:
    'The senior summary is available to a senior and an administrator only',
  FINANCE_INCOME_COMPLIANCE_FORBIDDEN:
    'The income compliance overview is available to an administrator and an accountant only',
  FINANCE_SALARY_MONTH_GAP_FORBIDDEN:
    'The salary month gap report is available to an administrator and an accountant only',
  FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN:
    'Backfilling salary month gaps is available to an administrator only',
  FINANCE_ADMIN_BALANCE_FORBIDDEN:
    'Only the administrator themself or an accountant can see this admin balance',
  FINANCE_SENIOR_BALANCE_FORBIDDEN:
    "An administrator, an accountant, or the senior themself can see the senior's balance",
  FINANCE_TOTAL_EARNED_FORBIDDEN:
    'Only an administrator and an accountant can see the “total earned” figure',
  FINANCE_PENDING_OBLIGATIONS_FORBIDDEN:
    'Only an admin, an accountant, or a senior can see pending obligations',
  FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN:
    'Only an administrator and an accountant can see the company account',
  FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY: 'Only an admin can change the company wallet',
  FINANCE_WALLET_ADDRESS_INVALID: 'Invalid wallet address — expected 0x + 40 hex',
  FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY:
    'Only an administrator can change the company requisites',
  FINANCE_COMPANY_REQUISITES_TOO_LONG: "Requisites can't exceed {maxChars} characters",
  FINANCE_COMPANY_DEPOSIT_FORBIDDEN: 'Only a senior or a drop can top up the company account',
  FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN:
    'The deposit status is visible to its owner, an administrator, or an accountant',
  FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY: 'Only an admin can withdraw dividends',
  FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE: 'The dividend amount must be positive',
  FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN: "Dividends can only be withdrawn to an admin's account",
  FINANCE_DIVIDEND_RECEIVER_ARCHIVED: "The recipient is archived — dividends aren't paid out",
  FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED:
    'Closing a USDT obligation in {currency} without converting the amount is not supported. Use USD or USDT',
  FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN:
    'Only an admin, an accountant, or a senior can see pending obligations',
  FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN:
    "The company's obligations list toward seniors is available to administrators and accountants only",
  FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN:
    'Only an admin or an accountant can close a company obligation',
  FINANCE_OBLIGATION_NOT_COMPANY_TYPE: "This obligation isn't closed by the company",
  FINANCE_OBLIGATION_ALREADY_CLOSED: 'The obligation is already closed or cancelled',
  FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT:
    "The drop's share from this payout didn't go through the company account — choose an admin's personal account",
  FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY:
    "The drop obligation is corrupted: its currency isn't USDT — conversion isn't possible",
  FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY:
    'A top-up on this row is only possible in {obligationCurrency} — the rate was fixed by the earlier payout, the remainder is closed by a separate manual reconciliation',
  FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION:
    "The payout date can't be earlier than the obligation's creation date",
  FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO:
    "After rounding, the payout amount became zero even though the obligation isn't zero — choose a different payout currency",
  FINANCE_OBLIGATION_OVERPAID:
    'This obligation has already been paid more than it is worth — a manual decision on the overpayment is required',
  FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY:
    "The accumulated payout amount on this row is already recorded in {sourceSettledCurrency} — a repeat payout in {currency} isn't possible without reconciling currencies",
  FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH:
    'A top-up on this row must come from the same source as the earlier payout — contact an accountant for reconciliation',
  FINANCE_OBLIGATION_AMOUNT_CHANGED:
    'The obligation amount changed after loading — refresh the page and try closing it again',
  FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING:
    "Couldn't close the obligation: the obligation's source transaction isn't in pending-payout status",
  FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION:
    'No open obligation found for this transaction',
  FINANCE_OBLIGATION_NOT_FOUND: 'Obligation not found',
  FINANCE_SETTLED_AMOUNT_NOT_NUMBER: 'The payout amount must be a number',
  FINANCE_SETTLED_AMOUNT_NEGATIVE: "The payout amount can't be negative",
  FINANCE_SETTLED_AMOUNT_OVER_LIMIT: "The amount can't exceed {maxAmount}",
  INVOICE_NOT_APPLICABLE_FOR_TX_TYPE: "An invoice isn't issued for this transaction type",
  INVOICE_NOT_GENERATED_YET: "The invoice hasn't been generated yet",
  INVOICE_NOT_GENERATED_RETRY: "The invoice hasn't been generated yet — try again later",
  INVOICE_NOT_COUNTERPARTY: "You aren't the counterparty of this transaction",
  INVOICE_ALREADY_SIGNED: 'The invoice is already signed',
  INVOICE_COMPANY_SIGNATURE_MISSING: "The company's signature is missing",
  INVOICE_DOCUMENT_NOT_FOUND: 'The invoice document was not found',
  INVOICE_PDF_MODIFIED_AFTER_SIGNATURE:
    'The PDF was modified after the first signature — contact an admin',
  INVOICE_USER_DATA_FETCH_FAILED: "Couldn't fetch user data",
  INVOICE_AMOUNT_VERIFICATION_FAILED: "Couldn't verify this invoice's amount — contact an admin",
  INVOICE_VOIDED: 'The invoice was voided — refresh the page',
  INVOICE_NOT_FOUND: 'Invoice not found',
  INVOICE_ACCESS_DENIED: "You don't have access to this invoice",
  FINANCE_DATE_FORMAT_INVALID: 'The date must be in YYYYMMDD format',
}
