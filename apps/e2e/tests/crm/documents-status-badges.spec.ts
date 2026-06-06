/**
 * documents-status-badges.spec.ts — PR-2 E2E: unified document list + status badges
 *
 * Coverage:
 * - AC1: INVOICE row with statusBadge invoice/ready → "Ожидает подписи" badge
 * - AC2: INVOICE row with statusBadge invoice/signed → "Подписано" badge
 * - AC3: RECEIPT row with statusBadge receipt/pending → "Требует подтверждения" badge
 * - AC4: RECEIPT row with statusBadge receipt/validated → "Подтверждено" badge
 * - AC5: employee_contract virtual entry (source='employee_contract') shows contract badge
 * - AC6: RESUME row has no status badge
 * - AC7: List view renders badges same as grid view (view toggle)
 * - AC8: Category filter narrows list (CONTRACT shows contract rows only)
 *
 * All tests use Playwright route mocks — no real backend required.
 */

import { test, expect } from '@playwright/test'
import { USERS, mockAuthAs } from '../fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Document fixtures (PR-2 shape with statusBadge)
// ---------------------------------------------------------------------------

const ADMIN_ID = USERS.admin.id
const SENIOR_ID = USERS.senior.id

function makeDoc(overrides: Record<string, unknown>) {
  return {
    id: 'doc-base-0001',
    ownerId: ADMIN_ID,
    projectId: null,
    category: 'RESUME',
    name: 'file.pdf',
    originalName: 'file.pdf',
    s3Key: 'documents/RESUME/x/file.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: ADMIN_ID,
    uploadedByDisplayName: 'Admin User',
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    statusBadge: null,
    invoicePendingSignature: false,
    source: null,
    ...overrides,
  }
}

const DOC_INVOICE_READY = makeDoc({
  id: 'doc-inv-ready',
  category: 'INVOICE',
  name: 'invoice-abc12345.pdf',
  originalName: 'invoice-abc12345.pdf',
  statusBadge: { kind: 'invoice', state: 'ready' },
})

const DOC_INVOICE_SIGNED = makeDoc({
  id: 'doc-inv-signed',
  category: 'INVOICE',
  name: 'invoice-xyz99999.pdf',
  originalName: 'invoice-xyz99999.pdf',
  statusBadge: { kind: 'invoice', state: 'signed' },
})

const DOC_RECEIPT_PENDING = makeDoc({
  id: 'doc-rcpt-pending',
  category: 'RECEIPT',
  name: 'receipt-abc12345.pdf',
  originalName: 'receipt-abc12345.pdf',
  statusBadge: { kind: 'receipt', state: 'pending' },
})

const DOC_RECEIPT_VALIDATED = makeDoc({
  id: 'doc-rcpt-validated',
  category: 'RECEIPT',
  name: 'receipt-xyz99999.pdf',
  originalName: 'receipt-xyz99999.pdf',
  statusBadge: { kind: 'receipt', state: 'validated' },
})

const DOC_CONTRACT_DRAFT = makeDoc({
  id: 'doc-contract-draft',
  ownerId: SENIOR_ID,
  uploadedBy: SENIOR_ID,
  uploadedByDisplayName: 'Senior Dev',
  category: 'CONTRACT',
  name: 'employee-contract-draft',
  originalName: 'employee-contract-draft',
  source: 'employee_contract',
  statusBadge: { kind: 'contract', state: 'draft' },
})

const DOC_CONTRACT_READY = makeDoc({
  id: 'doc-contract-ready',
  ownerId: SENIOR_ID,
  uploadedBy: SENIOR_ID,
  uploadedByDisplayName: 'Senior Dev',
  category: 'CONTRACT',
  name: 'employee-contract-ready',
  originalName: 'employee-contract-ready',
  source: 'employee_contract',
  statusBadge: { kind: 'contract', state: 'ready' },
})

const DOC_RESUME = makeDoc({
  id: 'doc-resume-0001',
  category: 'RESUME',
  name: 'cv.pdf',
  originalName: 'CV.pdf',
  statusBadge: null,
  source: null,
})

const ALL_DOCS = [
  DOC_INVOICE_READY,
  DOC_INVOICE_SIGNED,
  DOC_RECEIPT_PENDING,
  DOC_RECEIPT_VALIDATED,
  DOC_CONTRACT_DRAFT,
  DOC_CONTRACT_READY,
  DOC_RESUME,
]

// ---------------------------------------------------------------------------
// Helper: override the generic /documents mock from fixtures.ts
// ---------------------------------------------------------------------------
async function mockDocumentsList(page: import('@playwright/test').Page, docs: typeof ALL_DOCS) {
  // Override the generic mock set by mockAuthAs (which returns []).
  // Specific sub-routes (download, hard, restore) registered first by
  // mockAuthAs remain intact; this only overrides the list endpoint.
  await page.route(new RegExp(`${API}/documents(\\?.*)?$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(docs),
      })
    }
    return r.fallback()
  })
}

// ---------------------------------------------------------------------------
// AC1 & AC2 — INVOICE badges
// ---------------------------------------------------------------------------

test.describe('PR-2: INVOICE status badges', () => {
  test('AC1: INVOICE/ready → "Ожидает подписи" badge visible in grid view', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_INVOICE_READY])

    await page.goto('/crm/documents')

    // Wait for the list to render (not loading skeleton)
    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'invoice')
    await expect(badge).toHaveAttribute('data-badge-state', 'ready')
    await expect(badge).toHaveText('Ожидает подписи')
  })

  test('AC2: INVOICE/signed → "Подписано" badge visible in grid view', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_INVOICE_SIGNED])

    await page.goto('/crm/documents')

    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'invoice')
    await expect(badge).toHaveAttribute('data-badge-state', 'signed')
    await expect(badge).toHaveText('Подписано')
  })
})

// ---------------------------------------------------------------------------
// AC3 & AC4 — RECEIPT badges
// ---------------------------------------------------------------------------

test.describe('PR-2: RECEIPT status badges', () => {
  test('AC3: RECEIPT/pending → "Требует подтверждения" badge visible in grid view', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_RECEIPT_PENDING])

    await page.goto('/crm/documents')

    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'receipt')
    await expect(badge).toHaveAttribute('data-badge-state', 'pending')
    await expect(badge).toHaveText('Требует подтверждения')
  })

  test('AC4: RECEIPT/validated → "Подтверждено" badge visible in grid view', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_RECEIPT_VALIDATED])

    await page.goto('/crm/documents')

    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'receipt')
    await expect(badge).toHaveAttribute('data-badge-state', 'validated')
    await expect(badge).toHaveText('Подтверждено')
  })
})

// ---------------------------------------------------------------------------
// AC5 — employee_contract virtual entries
// ---------------------------------------------------------------------------

test.describe('PR-2: employee_contract virtual entries', () => {
  test('AC5a: CONTRACT/draft virtual entry → "Драфт" badge visible', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_CONTRACT_DRAFT])

    await page.goto('/crm/documents')

    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'contract')
    await expect(badge).toHaveAttribute('data-badge-state', 'draft')
    await expect(badge).toHaveText('Драфт')
  })

  test('AC5b: CONTRACT/ready virtual entry → "Готово к подписи" badge visible', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_CONTRACT_READY])

    await page.goto('/crm/documents')

    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'contract')
    await expect(badge).toHaveAttribute('data-badge-state', 'ready')
    await expect(badge).toHaveText('Готово к подписи')
  })
})

// ---------------------------------------------------------------------------
// AC6 — RESUME has no badge
// ---------------------------------------------------------------------------

test.describe('PR-2: RESUME has no status badge', () => {
  test('AC6: RESUME row renders without any status badge', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_RESUME])

    await page.goto('/crm/documents')

    // Default view is list — wait for document-row to appear
    await expect(page.getByTestId('document-row').first()).toBeVisible()
    // No status badge present
    await expect(page.getByTestId('document-status-badge')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC7 — list view renders badges same as grid view
// ---------------------------------------------------------------------------

test.describe('PR-2: list view badges', () => {
  test('AC7: switch to list view — INVOICE/ready badge still visible as DocumentRow', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_INVOICE_READY])

    await page.goto('/crm/documents')

    // Switch to list view
    await page.getByTestId('documents-view-list').click()

    // document-row should be visible
    await expect(page.getByTestId('document-row').first()).toBeVisible()

    // Status badge within the row
    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-kind', 'invoice')
    await expect(badge).toHaveAttribute('data-badge-state', 'ready')
    await expect(badge).toHaveText('Ожидает подписи')
  })

  test('AC7b: list view — RESUME row has no status badge', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [DOC_RESUME])

    await page.goto('/crm/documents')

    // Switch to list view
    await page.getByTestId('documents-view-list').click()

    await expect(page.getByTestId('document-row').first()).toBeVisible()
    await expect(page.getByTestId('document-status-badge')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC5c — DRAFT contract visibility (role-based)
//   AC5a already verified ADMIN sees DRAFT badge → that remains intact.
//   AC5c: non-ADMIN (SENIOR) does NOT see DRAFT contract in the list.
// ---------------------------------------------------------------------------

test.describe('PR-2: DRAFT contract hidden from non-ADMIN', () => {
  test('AC5c: SENIOR does not see DRAFT contract in document list', async ({ page }) => {
    // Mock as SENIOR user (non-ADMIN)
    await mockAuthAs(page, USERS.senior)

    // API returns only READY_TO_SIGN contract for SENIOR (DRAFT is filtered server-side).
    // This test verifies the frontend correctly renders what the server returns — no DRAFT badge.
    await mockDocumentsList(page, [DOC_CONTRACT_READY])

    await page.goto('/crm/documents')

    // READY_TO_SIGN contract should be visible
    const badge = page.getByTestId('document-status-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-badge-state', 'ready')

    // No DRAFT badge should be visible anywhere in the list
    const draftBadges = page.locator('[data-badge-state="draft"]')
    await expect(draftBadges).not.toBeVisible()
  })

  test('AC5d: SENIOR with no contract visible (server returns empty for DRAFT-only user)', async ({
    page,
  }) => {
    // Mock as SENIOR user — simulate API returning no contracts (all are DRAFT, hidden server-side)
    await mockAuthAs(page, USERS.senior)

    // Server returns empty list (all contracts are DRAFT, filtered by backend)
    await mockDocumentsList(page, [])

    await page.goto('/crm/documents')

    // With no documents, the empty-state should appear (no status badges)
    await expect(page.getByTestId('document-status-badge')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC8 — category filter narrows the list
// ---------------------------------------------------------------------------

test.describe('PR-2: category filter', () => {
  test('AC8: selecting CONTRACT filter shows only CONTRACT rows', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)

    // Mock that respects the ?category= query param — filters server-side like the real API
    await page.route(new RegExp(`${API}/documents(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      const url = new URL(r.request().url())
      const category = url.searchParams.get('category')
      const docs = category ? ALL_DOCS.filter((d) => d.category === category) : ALL_DOCS
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(docs),
      })
    })

    await page.goto('/crm/documents')

    // Default view is list — wait for document-row to appear (7 docs total)
    await expect(page.getByTestId('document-row').first()).toBeVisible()

    // Open category filter
    const filterTrigger = page.getByTestId('documents-category-filter')
    await filterTrigger.click()

    // Pick CONTRACT option from the dropdown
    // shadcn Select renders options in a listbox role; CONTRACT category label is "Договоры"
    await page.getByRole('option', { name: 'Договоры' }).click()

    // After filtering: only CONTRACT badges visible
    const badges = page.getByTestId('document-status-badge')
    await expect(badges.first()).toBeVisible()

    // All visible badges should be contract kind
    const count = await badges.count()
    for (let i = 0; i < count; i++) {
      await expect(badges.nth(i)).toHaveAttribute('data-badge-kind', 'contract')
    }

    // INVOICE / RECEIPT badges must not be visible
    const allBadgeKinds = await badges.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-badge-kind')),
    )
    expect(allBadgeKinds.every((k) => k === 'contract')).toBe(true)
  })
})
