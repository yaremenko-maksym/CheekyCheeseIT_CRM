import type { MessageDescriptor } from '@lingui/core'

/**
 * i18n stage 5. Every label the signable-invoice PDF
 * (`apps/api/src/invoices/invoice-pdf.service.ts`) draws, as `/* i18n *\/`-marked
 * explicit-id descriptors. The PDF is rendered in the RECIPIENT's locale
 * (`users.locale` of the counterparty, default `uk`) through `createI18n(locale)`
 * and the shared `renderMessage` — the same one renderer as notifications and
 * pending titles, not a second one.
 *
 * Shape: one `Record` per concern, because `lingui extract` only sees a
 * `/* i18n *\/` literal as an object PROPERTY value (see
 * `PENDING_TITLE_MESSAGES`). Source text is `uk`; `en` is a second original in
 * the `.po`, not a calque.
 *
 * What is deliberately NOT here: amounts, dates, the № short id, hash, verify
 * URL, brand name, currency codes, wallet/IBAN values. They are data (code
 * identifiers, locale-neutral numerics), not words. Every sentence is a whole
 * message with named placeholders — nothing is assembled from fragments on the
 * server, and every substituted param is nominative or a code (no case
 * agreement).
 */
export const INVOICE_PDF_MESSAGES = {
  titleAct: /* i18n */ {
    id: 'invoicePdf.title.act',
    message: 'АКТ ВИКОНАНИХ РОБІТ',
  },
  titleSalary: /* i18n */ {
    id: 'invoicePdf.title.salary',
    message: 'ВИПЛАТА ЗАРПЛАТИ',
  },
  number: /* i18n */ {
    id: 'invoicePdf.number',
    message: '№ {number}',
  },
  date: /* i18n */ {
    id: 'invoicePdf.date',
    message: 'Дата: {date}',
  },
  sectionContractor: /* i18n */ {
    id: 'invoicePdf.section.contractor',
    message: 'ВИКОНАВЕЦЬ',
  },
  sectionClient: /* i18n */ {
    id: 'invoicePdf.section.client',
    message: 'ЗАМОВНИК',
  },
  sectionDescription: /* i18n */ {
    id: 'invoicePdf.section.description',
    message: 'ОПИС ПОСЛУГИ',
  },
  sectionAmount: /* i18n */ {
    id: 'invoicePdf.section.amount',
    message: 'СУМА ДО СПЛАТИ',
  },
  sectionSignatures: /* i18n */ {
    id: 'invoicePdf.section.signatures',
    message: 'ПІДПИСИ',
  },
  requisitesMissing: /* i18n */ {
    id: 'invoicePdf.requisites.missing',
    message: 'Реквізити: не вказано, зверніться до адміністратора',
  },
  methodLine: /* i18n */ {
    id: 'invoicePdf.method.line',
    message: 'Метод: {method}',
  },
  methodCash: /* i18n */ {
    id: 'invoicePdf.method.cash',
    message: 'готівка ({currency})',
  },
  methodBankUahFop: /* i18n */ {
    id: 'invoicePdf.method.bankUahFop',
    message: 'банк UAH (ФОП)',
  },
  bankRecipient: /* i18n */ {
    id: 'invoicePdf.bank.recipient',
    message: 'Отримувач: {value}',
  },
  bankRnokpp: /* i18n */ {
    id: 'invoicePdf.bank.rnokpp',
    message: 'РНОКПП: {value}',
  },
  bankName: /* i18n */ {
    id: 'invoicePdf.bank.name',
    message: 'Банк: {value}',
  },
  descriptionContract: /* i18n */ {
    id: 'invoicePdf.description.contract',
    message: 'Послуги виконавця згідно з контрактом № {contractNumber}',
  },
  descriptionProject: /* i18n */ {
    id: 'invoicePdf.description.project',
    message: 'Частка за проєктом «{projectName}»',
  },
  descriptionPeriod: /* i18n */ {
    id: 'invoicePdf.description.period',
    message: 'Період: {period}',
  },
  descriptionSalaryForPeriod: /* i18n */ {
    id: 'invoicePdf.description.salaryForPeriod',
    message: 'Заробітна плата працівника за {period}',
  },
  descriptionSalary: /* i18n */ {
    id: 'invoicePdf.description.salary',
    message: 'Заробітна плата працівника',
  },
  period: /* i18n */ {
    id: 'invoicePdf.period',
    message: '{month} {year}',
  },
  uahEquivalent: /* i18n */ {
    id: 'invoicePdf.uahEquivalent',
    message: '≈ {amount} UAH (курс НБУ {rateDate})',
  },
  signatureContractor: /* i18n */ {
    id: 'invoicePdf.signature.contractor',
    message: '1. Від ВИКОНАВЦЯ',
  },
  signatureClient: /* i18n */ {
    id: 'invoicePdf.signature.client',
    message: '2. Від ЗАМОВНИКА',
  },
  signaturePendingAuto: /* i18n */ {
    id: 'invoicePdf.signature.pendingAuto',
    message: 'Очікує автопідпису',
  },
  signaturePending: /* i18n */ {
    id: 'invoicePdf.signature.pending',
    message: 'Очікує підпису',
  },
  signatureMethodAuto: /* i18n */ {
    id: 'invoicePdf.signature.methodAuto',
    message: 'Автоматичний електронний',
  },
  signatureMethodClick: /* i18n */ {
    id: 'invoicePdf.signature.methodClick',
    message: 'Електронний click-підпис',
  },
  verify: /* i18n */ {
    id: 'invoicePdf.verify',
    message: 'Перевірити документ',
  },
} satisfies Record<string, MessageDescriptor>

/**
 * Month names for the «Період» / salary lines, nominative (the sentences are
 * written so the month stays nominative: «за {period}» with «травень 2026» in
 * `uk` is the accepted business-document form, no genitive needed).
 * Keyed by the two-digit month number as it appears in `salaryMonth` (YYYY-MM).
 * A catalog entry per month — not `Intl` — so the bytes of a signed PDF never
 * depend on the ICU build of the machine that rendered them.
 */
export const INVOICE_PDF_MONTH_MESSAGES = {
  '01': /* i18n */ { id: 'invoicePdf.month.01', message: 'січень' },
  '02': /* i18n */ { id: 'invoicePdf.month.02', message: 'лютий' },
  '03': /* i18n */ { id: 'invoicePdf.month.03', message: 'березень' },
  '04': /* i18n */ { id: 'invoicePdf.month.04', message: 'квітень' },
  '05': /* i18n */ { id: 'invoicePdf.month.05', message: 'травень' },
  '06': /* i18n */ { id: 'invoicePdf.month.06', message: 'червень' },
  '07': /* i18n */ { id: 'invoicePdf.month.07', message: 'липень' },
  '08': /* i18n */ { id: 'invoicePdf.month.08', message: 'серпень' },
  '09': /* i18n */ { id: 'invoicePdf.month.09', message: 'вересень' },
  '10': /* i18n */ { id: 'invoicePdf.month.10', message: 'жовтень' },
  '11': /* i18n */ { id: 'invoicePdf.month.11', message: 'листопад' },
  '12': /* i18n */ { id: 'invoicePdf.month.12', message: 'грудень' },
} satisfies Record<string, MessageDescriptor>
