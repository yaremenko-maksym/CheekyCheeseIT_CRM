import type { MessageDescriptor } from '@lingui/core'
import { createI18n, INVOICE_PDF_MESSAGES, renderMessage } from '@crm/shared'
import { users, type Transaction } from '../database/schema'
import type { InvoiceCounterpartyInfo } from './invoice-pdf.service'

/**
 * Counterparty id derivation:
 *   SENIOR_INCOME — the senior is the counterparty (receiver of the income).
 *   SALARY        — the employee is the counterparty (receiver of the
 *                   salary).
 *   PAYOUT        — task-aggregate-invoice-per-payout. The aggregated
 *                   invoice anchors on the PAYOUT row. The PAYOUT row's
 *                   `senderId` is the senior / drop that initiated the
 *                   payout — they are the counterparty (the entity signing
 *                   on behalf of «ИСПОЛНИТЕЛЬ» in the act).
 * Returning null defensively when the column is unexpectedly NULL (the DB
 * FK ON DELETE SET NULL means a deleted user breaks the link).
 */
export function getCounterpartyId(tx: Transaction): string | null {
  if (tx.type === 'SENIOR_INCOME' || tx.type === 'SALARY') {
    return tx.receiverId
  }
  if (tx.type === 'PAYOUT') {
    return tx.senderId
  }
  return null
}

/**
 * Build the counterparty info struct for the PDF service. Pulls payment
 * requisites off the user row — branches by `paymentMethod` because USDT
 * and Bank UAH ФОП have completely different field layouts.
 */
export function buildCounterpartyInfo(user: typeof users.$inferSelect): InvoiceCounterpartyInfo {
  // i18n stage 5: the requisites labels are words, so they follow the
  // RECIPIENT's locale (the counterparty's own `users.locale`) exactly like
  // every other label on the PDF; the values (wallet, IBAN, names) are data.
  const i18n = createI18n(user.locale)
  const label = (descriptor: MessageDescriptor, value: string): string =>
    renderMessage(i18n, descriptor, { value })
  const details: string[] = []
  if (user.paymentMethod === 'USDT_ERC20') {
    if (user.walletUsdtErc20) details.push(`USDT (ERC-20): ${user.walletUsdtErc20}`)
    if (user.walletUsdtLabel) details.push(user.walletUsdtLabel)
  } else if (user.paymentMethod === 'BANK_UAH_FOP') {
    if (user.bankUahRecipient)
      details.push(label(INVOICE_PDF_MESSAGES.bankRecipient, user.bankUahRecipient))
    if (user.bankUahIban) details.push(`IBAN: ${user.bankUahIban}`)
    if (user.bankUahRnokpp) details.push(label(INVOICE_PDF_MESSAGES.bankRnokpp, user.bankUahRnokpp))
    if (user.bankUahBankName)
      details.push(label(INVOICE_PDF_MESSAGES.bankName, user.bankUahBankName))
  }
  return {
    displayName: user.displayName,
    locale: user.locale,
    paymentMethod: user.paymentMethod ?? null,
    paymentDetails: details,
  }
}
