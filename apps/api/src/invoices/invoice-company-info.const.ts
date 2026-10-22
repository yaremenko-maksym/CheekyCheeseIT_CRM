import type { InvoiceCompanyInfo } from './invoice-pdf.service'

// ---------------------------------------------------------------------------
// Company info constants (TBD — currently hardcoded; future migration into
// `/admin/settings` epic will move these into the DB)
// ---------------------------------------------------------------------------

// task-drop-company-debt-and-invoices: brand name is centralised in
// invoice-pdf.service.ts (COMPANY_BRAND_NAME). The `name` field is no
// longer rendered on the PDF (the header uses the brand const directly),
// but the InvoiceCompanyInfo struct still requires it for backward compat.
export const COMPANY_INFO: InvoiceCompanyInfo = {
  name: 'CheekyCheeseIT',
  address: 'Україна, м. Київ',
}
