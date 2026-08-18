/**
 * documents-search-sort.spec.ts — AC7 E2E coverage for search + sort toolbar.
 *
 * Coverage:
 * - AC1a: Search narrows the list by name substring
 * - AC1b: Clearing the search (× button) restores the full list
 * - AC2a: Sort by name А→Я (name_asc) changes DOM order
 * - AC2b: Sort by size largest first (size_desc) changes DOM order
 * - AC5:  grid/list buttons have aria-label + aria-pressed
 *
 * All tests use Playwright route mocks — no real backend required.
 * Auth mocking pattern copied from documents-status-badges.spec.ts.
 *
 * Task: task-documents-search-sort (AC7)
 */

import { test, expect } from '@playwright/test'
import { USERS, mockAuthAs, API_RE } from '../fixtures'

// ---------------------------------------------------------------------------
// Document fixtures
// ---------------------------------------------------------------------------

function makeDoc(overrides: Record<string, unknown>) {
  return {
    id: `doc-${String(overrides['id'] ?? Math.random())}`,
    ownerId: USERS.admin.id,
    projectId: null,
    category: 'RESUME',
    name: 'file.pdf',
    originalName: 'file.pdf',
    s3Key: 'documents/RESUME/x/file.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: USERS.admin.id,
    uploadedByDisplayName: 'Admin User',
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    statusBadge: null,
    invoiceTransactionId: null,
    invoicePendingSignature: false,
    source: null,
    ...overrides,
  }
}

// Three docs: two share "Резюме" in originalName, one "Скан"
const DOC_RESUME_A = makeDoc({
  id: 'resume-a',
  name: 'resume-alpha.pdf',
  originalName: 'Резюме Alpha.pdf',
  sizeBytes: 5000,
  createdAt: '2026-03-01T00:00:00.000Z',
})

const DOC_RESUME_B = makeDoc({
  id: 'resume-b',
  name: 'resume-beta.pdf',
  originalName: 'Резюме Beta.pdf',
  sizeBytes: 1000,
  createdAt: '2026-01-01T00:00:00.000Z',
})

const DOC_SCAN = makeDoc({
  id: 'scan-x',
  category: 'SCAN',
  name: 'scan-passport.jpg',
  originalName: 'Скан паспорта.jpg',
  sizeBytes: 2500,
  createdAt: '2026-06-01T00:00:00.000Z',
})

const ALL_DOCS = [DOC_RESUME_A, DOC_RESUME_B, DOC_SCAN]

// ---------------------------------------------------------------------------
// Helper: override the /documents mock
// ---------------------------------------------------------------------------

async function mockDocumentsList(
  page: import('@playwright/test').Page,
  docs: ReturnType<typeof makeDoc>[],
) {
  // Override ONLY the generic list route — specific sub-routes (download, hard,
  // restore) registered by mockAuthAs remain intact (LIFO stack in Playwright).
  await page.route(new RegExp(`${API_RE}/documents(\\?.*)?$`), (r) => {
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
// AC1 — search narrows the list
// ---------------------------------------------------------------------------

test.describe('AC1: search field filters document list', () => {
  test('AC1a: typing "резюме" shows only 2 matching documents', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, ALL_DOCS)

    await page.goto('/documents')

    // Default view is list mode — switch to it explicitly for stable row counting
    await page.getByTestId('documents-view-list').click()

    // Counter element must be visible (list loaded)
    await expect(page.getByTestId('documents-counter-ALL')).toBeVisible()

    // Initially 3 docs rendered
    const listContainer = page.getByTestId('documents-list-view')
    await expect(listContainer.getByTestId('document-row')).toHaveCount(3)

    // Type in the search input
    const searchInput = page.getByTestId('documents-search')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('резюме')

    // After debounce settles — 2 rows remain
    await expect(listContainer.getByTestId('document-row')).toHaveCount(2)

    // Counter also updated
    await expect(page.getByTestId('documents-counter-ALL')).toContainText('2')
  })

  test('AC1b: × button clears search and restores full list', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, ALL_DOCS)

    await page.goto('/documents')
    await page.getByTestId('documents-view-list').click()
    await expect(page.getByTestId('documents-counter-ALL')).toBeVisible()

    const searchInput = page.getByTestId('documents-search')
    await searchInput.fill('резюме')

    const listContainer = page.getByTestId('documents-list-view')
    await expect(listContainer.getByTestId('document-row')).toHaveCount(2)

    // Clear via the × button (aria-label="Очистить поиск")
    const clearBtn = page.getByRole('button', { name: 'Очистить поиск' })
    await expect(clearBtn).toBeVisible()
    await clearBtn.click()

    // All 3 documents restored
    await expect(listContainer.getByTestId('document-row')).toHaveCount(3)
    await expect(searchInput).toHaveValue('')
  })
})

// ---------------------------------------------------------------------------
// AC2 — sort changes document order
// ---------------------------------------------------------------------------

test.describe('AC2: sort select changes document order', () => {
  test('AC2a: sort by name А→Я puts "Alpha" before "Beta" before "Скан"', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, ALL_DOCS)

    await page.goto('/documents')
    await page.getByTestId('documents-view-list').click()
    await expect(page.getByTestId('documents-counter-ALL')).toBeVisible()

    // Open sort select and pick name_asc
    const sortSelect = page.getByTestId('documents-sort')
    await expect(sortSelect).toBeVisible()
    await sortSelect.click()
    await page.getByRole('option', { name: 'Имя: А-Я' }).click()

    const listContainer = page.getByTestId('documents-list-view')
    const rows = listContainer.getByTestId('document-row')
    await expect(rows).toHaveCount(3)

    // Row order: Alpha < Beta < Скан (ru locale)
    await expect(rows.nth(0)).toHaveAttribute('data-doc-id', 'resume-a')
    await expect(rows.nth(1)).toHaveAttribute('data-doc-id', 'resume-b')
    await expect(rows.nth(2)).toHaveAttribute('data-doc-id', 'scan-x')
  })

  test('AC2b: sort by size largest first puts resume-a (5000B) first', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    // API returns: resume-a(5000) resume-b(1000) scan-x(2500) — unordered by size
    await mockDocumentsList(page, [DOC_RESUME_B, DOC_SCAN, DOC_RESUME_A])

    await page.goto('/documents')
    await page.getByTestId('documents-view-list').click()
    await expect(page.getByTestId('documents-counter-ALL')).toBeVisible()

    const sortSelect = page.getByTestId('documents-sort')
    await sortSelect.click()
    await page.getByRole('option', { name: 'Размер: больше' }).click()

    const listContainer = page.getByTestId('documents-list-view')
    const rows = listContainer.getByTestId('document-row')
    await expect(rows).toHaveCount(3)

    // resume-a (5000) must come first
    await expect(rows.nth(0)).toHaveAttribute('data-doc-id', 'resume-a')
    // scan-x (2500) second
    await expect(rows.nth(1)).toHaveAttribute('data-doc-id', 'scan-x')
    // resume-b (1000) last
    await expect(rows.nth(2)).toHaveAttribute('data-doc-id', 'resume-b')
  })
})

// ---------------------------------------------------------------------------
// AC5 — grid/list toggle aria attributes
// ---------------------------------------------------------------------------

test.describe('AC5: grid/list toggle aria-label + aria-pressed', () => {
  test('default state: list active (aria-pressed=true), grid inactive', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [])

    await page.goto('/documents')

    const listBtn = page.getByTestId('documents-view-list')
    const gridBtn = page.getByTestId('documents-view-grid')

    await expect(listBtn).toHaveAttribute('aria-label', 'Список')
    await expect(listBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(gridBtn).toHaveAttribute('aria-label', 'Сетка')
    await expect(gridBtn).toHaveAttribute('aria-pressed', 'false')
  })

  test('after clicking grid: grid aria-pressed=true, list aria-pressed=false', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await mockDocumentsList(page, [])

    await page.goto('/documents')

    await page.getByTestId('documents-view-grid').click()

    await expect(page.getByTestId('documents-view-grid')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('documents-view-list')).toHaveAttribute('aria-pressed', 'false')
  })
})
