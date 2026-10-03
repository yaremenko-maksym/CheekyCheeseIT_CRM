import { COMPANY_ACCOUNT_LABEL, type TransactionDto } from '@crm/shared'

/**
 * server-text PR3 — the server stores the company account as the CODE
 * `COMPANY_ACCOUNT_LABEL` in `senderLabel` / `receiverLabel` (it used to store
 * Russian prose). Every place that prints a counterparty label routes it through
 * here so the code becomes the viewer-locale text, never the raw token.
 *
 * `companyLabel` is passed in (not read from a module-level constant) because
 * the localized text comes from `useLingui()`, which only a component may call.
 * Any other label (an admin's displayName, the masked `CheekyCheeseIT` brand, a
 * client company name) passes through unchanged; null stays null so callers keep
 * their own fallback.
 */
export function displayCounterpartyLabel(
  label: string | null | undefined,
  companyLabel: string,
): string | null {
  if (label === COMPANY_ACCOUNT_LABEL) return companyLabel
  return label ?? null
}

/**
 * Returns the DTO with both counterparty labels localized.
 *
 * An EXPENSE row's `receiverLabel` is the user-typed CATEGORY (free text), not a
 * counterparty — it is left untouched even if it happens to equal the code.
 */
export function withLocalizedCompanyLabels(
  tx: TransactionDto,
  companyLabel: string,
): TransactionDto {
  return {
    ...tx,
    senderLabel: displayCounterpartyLabel(tx.senderLabel, companyLabel),
    receiverLabel:
      tx.type === 'EXPENSE'
        ? tx.receiverLabel
        : displayCounterpartyLabel(tx.receiverLabel, companyLabel),
  }
}
