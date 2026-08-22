import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Who signed: the company side (auto, ADMIN) or the counterparty side
 * (manual click by SENIOR / JUNIOR / HR depending on transaction type).
 */
export const invoiceSignerRoleSchema = z.enum(['COMPANY', 'COUNTERPARTY'])
export type InvoiceSignerRole = z.infer<typeof invoiceSignerRoleSchema>

/**
 * How the signature was applied:
 *   - `AUTO_COMPANY` — system auto-sign of the company side when the PDF is
 *     generated; recorded against the active ADMIN.
 *   - `MANUAL_CLICK` — counterparty actively confirmed via /sign.
 */
export const invoiceSignatureMethodSchema = z.enum(['AUTO_COMPANY', 'MANUAL_CLICK'])
export type InvoiceSignatureMethod = z.infer<typeof invoiceSignatureMethodSchema>

/**
 * Two-state lifecycle visible in the UI:
 *   - `PENDING` — auto-sign COMPANY done, awaiting counterparty click.
 *   - `SIGNED` — both signatures in place; PDF immutable.
 *
 * Cancellation / amendments are out of scope for v1 (handled manually by
 * ADMIN intervention in the DB if ever needed).
 */
export const invoiceStatusSchema = z.enum(['PENDING', 'SIGNED'])
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>

/**
 * Narrow subset of `transaction_type` — only these two flows generate an
 * invoice. Other transaction types (PAYOUT, EXPENSE, ADMIN_TRANSFER, …) are
 * never paired with an invoice.
 */
export const invoiceTypeSchema = z.enum(['SENIOR_INCOME', 'SALARY'])
export type InvoiceType = z.infer<typeof invoiceTypeSchema>

/**
 * Invoice currency mirrors the transaction currency. UAH appears for SALARY
 * paid via Bank UAH ФОП; USDT is the most common for SENIOR_INCOME.
 */
export const invoiceCurrencySchema = z.enum(['USDT', 'USD', 'EUR', 'UAH'])
export type InvoiceCurrency = z.infer<typeof invoiceCurrencySchema>

// ---------------------------------------------------------------------------
// Signature DTO (returned by the authenticated detail endpoint)
// ---------------------------------------------------------------------------

/**
 * Signature row as projected to the authenticated UI. Joins the signer's
 * `displayName` from `users` so the front-end never needs a second lookup.
 * Private fields (`ip_address`, `user_agent`, full `pdf_hash`) are NEVER
 * included — only the first 8 hex chars of the hash are exposed so the UI
 * can stamp them next to the signer's name for a quick visual check.
 */
export const invoiceSignatureSchema = z.object({
  id: z.string().uuid(),
  transactionId: z.string().uuid(),
  signerRole: invoiceSignerRoleSchema,
  signerId: z.string().uuid(),
  /** Joined from `users.displayName` server-side. */
  signerName: z.string(),
  signedAt: z.string().datetime(),
  /** First 8 hex chars of SHA-256 (full hash never leaves the server). */
  pdfHashShort: z.string().length(8),
  method: invoiceSignatureMethodSchema,
})
export type InvoiceSignatureDto = z.infer<typeof invoiceSignatureSchema>

// ---------------------------------------------------------------------------
// Invoice DTO (full)
// ---------------------------------------------------------------------------

/**
 * Full invoice payload returned by `GET /api/invoices/:transactionId`.
 * `documentId` is nullable for safety — the moment between transaction state
 * change and successful PDF upload is racey, and an UI that polls during
 * that window should still receive a coherent row (it falls back to
 * "Готовится…" while document_id is null).
 */
export const invoiceSchema = z.object({
  transactionId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  status: invoiceStatusSchema,
  type: invoiceTypeSchema,
  /** Numeric serialized as string (preserves precision, matches DB output). */
  amount: z.string(),
  currency: invoiceCurrencySchema,
  counterpartyId: z.string().uuid(),
  counterpartyName: z.string(),
  /** Project name (null for SALARY since salaries are not project-linked). */
  projectName: z.string().nullable(),
  /** YYYY-MM string snapshot at invoice creation (for SALARY mostly). */
  salaryMonth: z.string().nullable(),
  signatures: z.array(invoiceSignatureSchema),
  createdAt: z.string().datetime(),
})
export type InvoiceDto = z.infer<typeof invoiceSchema>

// ---------------------------------------------------------------------------
// List item DTO (slimmed down for the tabs / cards listing)
// ---------------------------------------------------------------------------

/**
 * Lighter DTO returned by `GET /api/invoices`. Pick of the full schema —
 * keeps the listing response small (no signatures array per item).
 */
export const invoiceListItemSchema = invoiceSchema.pick({
  transactionId: true,
  status: true,
  type: true,
  amount: true,
  currency: true,
  counterpartyName: true,
  createdAt: true,
})
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>

export const invoiceListResponseSchema = z.object({
  items: z.array(invoiceListItemSchema),
})
export type InvoiceListResponse = z.infer<typeof invoiceListResponseSchema>

// ---------------------------------------------------------------------------
// Public verify response (no auth)
// ---------------------------------------------------------------------------

/**
 * Public DTO returned by `GET /api/invoices/:transactionId/verify` —
 * reachable without authentication so the QR code in the printed PDF
 * resolves cleanly. CRITICAL: no private fields (no IP / user-agent / full
 * pdf hash / internal IDs beyond what's already on the PDF). Only the bare
 * minimum required to convince a third party that the document is genuine.
 */
export const invoiceVerifyResponseSchema = z.object({
  transactionId: z.string().uuid(),
  status: invoiceStatusSchema,
  amount: z.string(),
  currency: invoiceCurrencySchema,
  // security-review round 5 (PR #600, HIGH-4): raised from
  // `resolvePayoutAggregateAmount` on the legacy no-snapshot PAYOUT
  // recompute path — true when the linked incomes behind this amount span
  // more than one currency (a supported configuration; the aggregate is a
  // blind sum across currencies, not converted). `false` for every other
  // path, including the common signed-snapshot case, which does not
  // persist this flag per-signature. Not rendered on the public verify
  // page yet — surfacing it in the UI is a product/legal decision, tracked
  // separately (backlog item 83).
  mixedCurrency: z.boolean(),
  type: invoiceTypeSchema,
  signatures: z.array(
    z.object({
      role: invoiceSignerRoleSchema,
      signerName: z.string(),
      signedAt: z.string().datetime(),
      pdfHashShort: z.string().length(8),
    }),
  ),
})
export type InvoiceVerifyResponse = z.infer<typeof invoiceVerifyResponseSchema>

// ---------------------------------------------------------------------------
// Sign request body
// ---------------------------------------------------------------------------

/**
 * Body for `POST /api/invoices/:transactionId/sign`. Empty for v1 (the
 * server reads `ip` + `user-agent` from the request). Reserved for future
 * fields like an explicit acknowledgement checkbox flag.
 */
export const signInvoiceRequestSchema = z.object({}).passthrough()
export type SignInvoiceRequest = z.infer<typeof signInvoiceRequestSchema>

// ---------------------------------------------------------------------------
// List filters (query string)
// ---------------------------------------------------------------------------

export const invoiceListFiltersSchema = z.object({
  status: invoiceStatusSchema.optional(),
  type: invoiceTypeSchema.optional(),
})
export type InvoiceListFilters = z.infer<typeof invoiceListFiltersSchema>
