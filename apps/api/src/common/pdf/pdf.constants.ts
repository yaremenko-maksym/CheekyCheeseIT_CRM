/**
 * Shared PDF rendering constants — colors, layout dimensions, brand strings.
 *
 * Used by InvoicePdfService and future ContractPdfService (Phase 2).
 * Source of truth so both features render with identical visual language
 * without duplicating magic numbers.
 *
 * Colors use pdf-lib's 0–1 float range (not 0–255).
 */

/** PDF color palette. All values are 0–1 float (pdf-lib convention). */
export const PDF_COLORS = {
  /** Primary text — near-black graphite. */
  text: { r: 0.1, g: 0.1, b: 0.12 },
  /** Secondary / muted text — mid-gray. */
  muted: { r: 0.45, g: 0.45, b: 0.5 },
  /** Brand accent — warm yellow (matches CSS var --accent in dark mode). */
  accent: { r: 0.85, g: 0.66, b: 0.0 },
  /** Brand mark fill — graphite for outline on white background. */
  brand: { r: 0.12, g: 0.12, b: 0.12 },
  /** Thin horizontal rule between sections. */
  separator: { r: 0.85, g: 0.85, b: 0.88 },
  /** Warning state — orange-amber (used for missing payment details). */
  warning: { r: 0.85, g: 0.55, b: 0.1 },
  /** Footer text — light gray. */
  footer: { r: 0.5, g: 0.5, b: 0.55 },
} as const

/** Page and spacing constants for A4 portrait (595.28 × 841.89 pt). */
export const PDF_LAYOUT = {
  /** Left/right/top margin in points. */
  pageMargin: 50,
  /** A4 width in pt. */
  pageWidth: 595.28,
  /** A4 height in pt. */
  pageHeight: 841.89,
  /** Content width = pageWidth - 2 * pageMargin. */
  contentWidth: 495.28,
  /** Default line height for body text at 11pt. */
  lineHeight: 14,
  /** Vertical gap inserted between major sections. */
  sectionGap: 18,
  /** Brand mark size in pt. */
  brandMarkSize: 32,
  /** QR code rendered size in pt. */
  qrSize: 80,
  /** QR code source resolution in px (medium error correction). */
  qrSourcePx: 220,
} as const

/** Brand-level strings. Single source so rename is a one-liner. */
export const PDF_BRAND = {
  /** Display name for the company — appears in signatures, footer, PDF metadata. */
  companyName: 'CheekyCheeseIT',
  /** Base URL for the public verify endpoint. Callers append `/<invoiceId>`. */
  verifyUrlBase: 'https://crm.cheekycheeseit.com',
  /** pdf-lib document Producer/Creator string. */
  producerString: 'CheekyCheeseIT CRM',
} as const

/**
 * Legal entity data for the Company side of MSA contracts.
 *
 * These are the registered legal details of the contracting entity and appear
 * in the «Сторони / Компанія» section of every signed contract PDF.
 * Kept as a single constant (not env-based) because changing the legal entity
 * requires a new contract template version + ADMIN approval — not a deployment
 * toggle.
 */
export const CONTRACT_COMPANY = {
  /** Registered legal name of the company. */
  legalName: 'VolkerWessels Nederland IE B.V.',
  /** Registered office address. */
  address: 'Reggesingel 4, NL-7461 BA Rijssen',
  /** Country of incorporation. */
  country: 'Netherlands',
} as const
