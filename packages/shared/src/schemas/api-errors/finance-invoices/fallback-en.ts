import type { FinanceInvoicesErrorCode } from './codes'

export const FINANCE_INVOICES_ERROR_FALLBACK_EN: Record<FinanceInvoicesErrorCode, string> = {
  FINANCE_TRANSACTION_NOT_FOUND: 'Transaction not found',
  FINANCE_TRANSACTION_DELETED_RESTORE_FIRST: 'The transaction is deleted — restore it first',
  FINANCE_TRANSACTION_ALREADY_DELETED: 'The transaction is already deleted',
  FINANCE_TRANSACTION_NOT_DELETED: "The transaction isn't deleted — there's nothing to restore",
  FINANCE_TRANSACTION_NOT_PENDING: "The transaction isn't pending",
  FINANCE_TRANSACTION_DELETE_REASON_REQUIRED:
    'Give a reason for deleting the transaction — it goes into the audit log',
  FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED:
    'Give a reason for restoring the transaction — it goes into the audit log',
  FINANCE_REJECTION_REASON_REQUIRED: 'Give a reason for the rejection',
  FINANCE_ROW_AMOUNT_MISMATCH:
    "One of the shares doesn't match what was already paid — the edit is blocked until a manual reconciliation",
  FINANCE_ROW_STATE_CHANGED_WHILE_EDITING:
    'The record changed while you were working with it — reload the page and try again',
  FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW:
    "Changing a paid transaction's amount recalculates shares and obligations — open the preview first",
  FINANCE_PAYMENT_FACT_AMOUNT_LOCKED:
    "This payment's amount is recorded together with the transfer rate — it can't be changed here, correct it with a reversing transaction",
  FINANCE_SALARY_OBLIGATION_OUT_OF_RANGE:
    'At the recorded transfer rate this amount gives a salary obligation outside the allowed range — check the amount',
  FINANCE_PAID_ROW_CURRENCY_LOCKED:
    "The currency of a paid row can't be changed — the payment already went through in this currency, correct it with a reversing transaction",
  FINANCE_PAID_ROW_SALARY_MONTH_LOCKED:
    "The salary month of a paid row can't be changed — monthly totals are already calculated for it, correct it with a reversing transaction",
  FINANCE_SETTLED_AMOUNT_LOCKED:
    'Payouts have already been made on this row — its amount is backed by what was actually transferred, correct it with a reversing transaction',
  FINANCE_CLOSING_ROW_AMOUNT_LOCKED:
    'This row closed an obligation — its amount is fixed in the settlement, correct it with a reversing transaction',
  FINANCE_ONCHAIN_DEPOSIT_AMOUNT_LOCKED:
    "The deposit amount has been matched against the blockchain — it can't be changed, record any discrepancy as a separate transaction",
  FINANCE_CASCADE_PREVIEW_STALE: 'The data changed after the preview — refresh it and save again',
  FINANCE_SHARE_LEFT_PENDING_DURING_SAVE:
    'One of the shares changed status while saving — nothing was saved, refresh the page and try again',
  FINANCE_TX_HASH_INVALID:
    'Invalid transaction hash — paste an Etherscan link or 0x followed by 64 hex characters',
  FINANCE_TX_HASH_ALREADY_CONSUMED:
    'This transaction hash has already been used for a payout or a company account deposit',
  FINANCE_TX_HASH_RELEASE_REASON_REQUIRED:
    'Give a reason for releasing the hash — it goes into the audit log',
  FINANCE_TX_HASH_NOT_CONSUMED: "This hash isn't marked as used",
  FINANCE_TX_HASH_REQUIRED: 'Enter the transaction hash',
  FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT:
    'This transaction hash has already been used for another payout',
  FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET:
    "The transaction recipient doesn't match the company wallet",
  FINANCE_TX_NOT_CONFIRMED_ONCHAIN:
    "The transaction isn't confirmed on-chain yet — try again later",
  FINANCE_ONCHAIN_AMOUNT_MISMATCH:
    'The on-chain transaction amount must exactly match the payout amount',
  FINANCE_CRYPTO_TX_HASH_TOO_SHORT:
    'For a crypto payout, enter a transaction hash of at least 10 characters',
  FINANCE_SIMULATION_TX_NOT_CONFIRMED: "Simulation: the transaction isn't confirmed",
  FINANCE_TX_HASH_PARAM_REQUIRED: 'Provide one Etherscan link or one transaction hash',
  FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED: "{currency} can't be converted to USDT",
  FINANCE_SHARES_SUM_EXCEEDS_100: "The senior's and drop's shares add up to more than 100%",
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
  FINANCE_INCOME_RECEIVER_ARCHIVED: "The recipient is archived — income can't be declared",
  FINANCE_NOT_YOUR_DROP_PROJECT: "You aren't the drop on this project",
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
  FINANCE_SALARY_RECEIVER_ARCHIVED: "The recipient is archived — a salary can't be created",
  FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH:
    "This employee's salary for the selected month already exists",
  FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED: "The recipient is archived — the salary can't be paid",
  FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN:
    'The personal account the payment comes from must belong to an admin',
  FINANCE_TRANSFER_SENDER_ID_REQUIRED:
    'Specify a sender — a transfer is only possible between two admins',
  FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN: 'The sender must be an admin',
  FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN: 'You can only transfer to another admin',
  FINANCE_TRANSFER_RECEIVER_ARCHIVED: "The recipient is archived — the transfer can't be made",
  FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE:
    'Some transactions are already in a payout or unavailable — refresh the list',
  FINANCE_PAYOUT_DATE_BEFORE_INCOME:
    "The payout date can't be earlier than the selected income date",
  FINANCE_TX_DATE_INVALID: "The transaction date isn't a valid date",
  FINANCE_TX_DATE_IN_FUTURE: "A completed operation can't have a future date",
  FINANCE_TX_DATE_TOO_OLD: 'This date is too far in the past — ask an admin to record it',
  FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED:
    "This date is too far back and needs a documented reason — it can't be recorded from this screen",
  FINANCE_TX_DATE_LOCKED_ROW:
    "This transaction's date can't be changed: its payment is confirmed on-chain, comes from the company account, or already has settlements",
  FINANCE_TX_DATE_EDIT_REASON_REQUIRED:
    'This date is too far back — enter a reason in the “Reason for changing the date” field',
  FINANCE_PAYOUT_SINGLE_PROJECT_ONLY: 'A payout must cover only one project',
  FINANCE_COMPANY_WALLET_NOT_CONFIGURED: "The company wallet isn't configured",
  FINANCE_NBU_RATE_UNAVAILABLE: 'The NBU exchange rate is unavailable — try again later',
  FINANCE_PAYOUT_REQUEST_NOT_FOUND: 'Payout request not found',
  FINANCE_PAYOUT_REQUEST_ALREADY_PAID: 'The payout request is already paid',
  FINANCE_RECIPIENT_ADMIN_NOT_FOUND: 'Recipient admin not found',
  FINANCE_RECIPIENT_MUST_BE_ADMIN: 'The recipient must be an admin',
  FINANCE_RECIPIENT_ADMIN_ARCHIVED: 'The recipient admin is archived — choose another one',
  FINANCE_PAYOUT_NOT_PENDING_PAYMENT:
    "The payout isn't pending payment — it may already be confirmed",
  FINANCE_CONFIRM_PAYOUT_ONLY: 'Only a payout can be confirmed',
  FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST: 'No payout transaction found for this request',
  FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT: 'No senior found on this project',
  FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS: 'Insufficient funds in the company account',
  FINANCE_DROP_SUMMARY_FORBIDDEN: 'Only a drop can see the drop summary',
  FINANCE_DROP_INCOMES_FORBIDDEN: 'Only a drop can see drop income',
  FINANCE_DROP_PAYMENTS_FORBIDDEN: 'Only a drop can see drop payouts',
  FINANCE_SUMMARY_FORBIDDEN: 'Only an admin or an accountant can see the finance summary',
  FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN:
    'Only an admin or an accountant can see the accountant summary',
  FINANCE_SENIOR_SUMMARY_FORBIDDEN: 'Only an admin or a senior can see the senior summary',
  FINANCE_INCOME_COMPLIANCE_FORBIDDEN:
    'Only an admin or an accountant can see the income compliance overview',
  FINANCE_SALARY_MONTH_GAP_FORBIDDEN:
    'Only an admin or an accountant can see the missed salary months report',
  FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN: 'Only an admin can fill in missed salary months',
  FINANCE_ADMIN_BALANCE_FORBIDDEN: "Only that admin or an accountant can see an admin's balance",
  FINANCE_SENIOR_BALANCE_FORBIDDEN:
    "Only an admin, an accountant, or the senior can see a senior's balance",
  FINANCE_TOTAL_EARNED_FORBIDDEN:
    'Only an admin or an accountant can see the “total earned” figure',
  FINANCE_PENDING_OBLIGATIONS_FORBIDDEN:
    'Only an admin, an accountant, or a senior can see pending obligations',
  FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN:
    'Only an admin or an accountant can see the company account',
  FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY: 'Only an admin can change the company wallet',
  FINANCE_WALLET_ADDRESS_INVALID:
    'Invalid wallet address — it should be 0x followed by 40 hex characters',
  FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY: 'Only an admin can change the company details',
  FINANCE_COMPANY_REQUISITES_TOO_LONG:
    'Company details must not exceed {maxChars, number} characters',
  FINANCE_COMPANY_DEPOSIT_FORBIDDEN: 'Only a senior or a drop can deposit to the company account',
  FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN:
    'Only the person who made the deposit, an admin, or an accountant can see its status',
  FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY: 'Only an admin can withdraw dividends',
  FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE: 'The dividend amount must be greater than zero',
  FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN: "Dividends can only be withdrawn to an admin's account",
  FINANCE_DIVIDEND_RECEIVER_ARCHIVED: "The recipient is archived — dividends can't be paid",
  FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED:
    "A USDT obligation can't be closed in {currency} — choose USD or USDT",
  FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN:
    'Only an admin, an accountant, or a senior can see pending obligations',
  FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN:
    "Only an admin or an accountant can see the company's obligations",
  FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN:
    'Only an admin or an accountant can close a company obligation',
  FINANCE_OBLIGATION_NOT_COMPANY_TYPE: "This isn't a company obligation",
  FINANCE_OBLIGATION_ALREADY_CLOSED: 'The obligation is already closed or cancelled',
  FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT:
    "The drop's share from this payout didn't go through the company account — choose an admin's personal account",
  FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY:
    "The drop's obligation isn't recorded in USDT — it can't be closed with conversion and needs a manual reconciliation",
  FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY:
    'The rest of this obligation can only be paid in {obligationCurrency} — the earlier payout fixed the rate',
  FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION:
    "The payout date can't be earlier than the obligation's creation date",
  FINANCE_SALARY_IDEMPOTENCY_CONFLICT:
    'This salary was not saved: a record with different details already exists for this employee and month. The existing record is unchanged.',
  FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO:
    "After rounding, the payout amount became zero even though the obligation isn't zero — choose a different payout currency",
  FINANCE_OBLIGATION_OVERPAID:
    'More has been paid on this obligation than was owed — the overpayment needs a manual review',
  FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY:
    'The rest of this obligation can only be paid in {sourceSettledCurrency}, the currency of the earlier payout',
  FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH:
    'Pay the rest from the same source as the earlier payout on this obligation',
  FINANCE_OBLIGATION_AMOUNT_CHANGED:
    'The obligation amount changed after loading — refresh the page and try closing it again',
  FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING:
    'The transaction behind this obligation is no longer awaiting payout — refresh the page',
  FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION:
    'No open obligation found for this transaction',
  FINANCE_OBLIGATION_NOT_FOUND: 'Obligation not found',
  FINANCE_SETTLED_AMOUNT_NOT_NUMBER: 'The payout amount must be a number',
  FINANCE_SETTLED_AMOUNT_NEGATIVE: "The payout amount can't be negative",
  FINANCE_SETTLED_AMOUNT_OVER_LIMIT: "The amount can't exceed {maxAmount, number}",
  INVOICE_NOT_APPLICABLE_FOR_TX_TYPE: "An invoice isn't issued for this transaction type",
  INVOICE_NOT_GENERATED_YET: "The invoice hasn't been generated yet — try again later",
  INVOICE_NOT_COUNTERPARTY: "You aren't the counterparty of this transaction",
  INVOICE_ALREADY_SIGNED: 'The invoice is already signed',
  INVOICE_COMPANY_SIGNATURE_MISSING: "The company hasn't signed the invoice yet — contact an admin",
  INVOICE_DOCUMENT_NOT_FOUND: 'Invoice document not found',
  INVOICE_PDF_MODIFIED_AFTER_SIGNATURE:
    'The PDF was modified after the first signature — contact an admin',
  INVOICE_USER_DATA_FETCH_FAILED: "Couldn't fetch user data — try again",
  INVOICE_AMOUNT_VERIFICATION_FAILED: "Couldn't verify this invoice's amount — contact an admin",
  INVOICE_VOIDED: 'The invoice was voided — refresh the page',
  INVOICE_NOT_FOUND: 'Invoice not found',
  INVOICE_ACCESS_DENIED: "You don't have access to this invoice",
  FINANCE_DATE_FORMAT_INVALID: 'The date must be in YYYYMMDD format',
}
