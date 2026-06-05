/**
 * contract-editor.spec.ts — A3-2 E2E happy-path + RBAC
 *
 * Coverage:
 * - AC1: 'contract' tab visible for ADMIN viewing non-ADMIN employee; hidden for non-ADMIN viewer
 * - AC2: DRAFT contract loads in editor, Save button enables on dirty
 * - AC3: Mark Ready transitions status badge → "Готов к подписанию"
 * - AC4: Editor frozen (readOnly) in READY_TO_SIGN state
 * - AC7: No-template 404 shows empty state with link to templates
 *
 * All tests use Playwright route mocks — no real backend required.
 */

import { test, expect } from '@playwright/test'
import { USERS, mockAuthAs, buildAdminViewingUser, buildSelfView } from './fixtures'

const API = 'http://localhost:3001/api'

// ─── Contract fixtures ────────────────────────────────────────────────────────

const TARGET_ID = USERS.senior.id

const DRAFT_CONTRACT = {
  id: 'ec000001-0000-4000-8000-000000000001',
  userId: TARGET_ID,
  sourceTemplateId: 'ec000001-0000-4000-8000-000000000002', // valid UUID — Zod schema requires uuid()
  bodyMarkdown: '# Contract\n\nThis is the **draft** contract body.',
  status: 'DRAFT',
  signedContractId: null,
  createdByUserId: USERS.admin.id,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}

const READY_CONTRACT = {
  ...DRAFT_CONTRACT,
  status: 'READY_TO_SIGN',
  updatedAt: '2026-06-02T00:00:00.000Z',
}

// Minimal 1-byte placeholder — just needs to not crash the blob URL creation.
const PDF_BYTES = Buffer.from('%PDF-1.4 placeholder')

// ─── Helper: mount standard ADMIN-as-admin mocks + contract endpoint ──────────

async function setupAdminViewingSenior(
  page: import('@playwright/test').Page,
  contractResponse: object | { status: number; message: string },
  opts: { contractStatus?: number } = {},
) {
  await mockAuthAs(page, USERS.admin)

  const contractStatus = opts.contractStatus ?? 200

  // GET /api/users/:id/contract
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract/pdf$`), async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: PDF_BYTES,
    })
  })
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract/ready$`), async (r) => {
    if (r.request().method() === 'POST') {
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(READY_CONTRACT),
      })
    } else {
      await r.fallback()
    }
  })
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract/revert$`), async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DRAFT_CONTRACT),
    })
  })
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract/reset$`), async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DRAFT_CONTRACT),
    })
  })
  await page.route(new RegExp(`${API}/users/([^/?]+)/contract$`), async (r) => {
    if (r.request().method() === 'PATCH') {
      // Merge body into contract
      const body = JSON.parse(r.request().postData() ?? '{}') as { bodyMarkdown?: string }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...DRAFT_CONTRACT, bodyMarkdown: body.bodyMarkdown ?? DRAFT_CONTRACT.bodyMarkdown }),
      })
    } else if (r.request().method() === 'GET') {
      if (contractStatus !== 200) {
        await r.fulfill({
          status: contractStatus,
          contentType: 'application/json',
          body: JSON.stringify(contractResponse),
        })
      } else {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(contractResponse),
        })
      }
    } else {
      await r.fallback()
    }
  })

  // Override /users/:id to include 'contract' tab (buildAdminViewingUser already does this)
  await page.route(new RegExp(`${API}/users/${TARGET_ID}$`), async (r) => {
    if (r.request().method() === 'GET') {
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildAdminViewingUser(USERS.senior)),
      })
    } else {
      await r.fallback()
    }
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('A3-2: Contract editor tab', () => {
  test('AC1: ADMIN sees "Контракт" tab on employee profile', async ({ page }) => {
    await setupAdminViewingSenior(page, DRAFT_CONTRACT)
    await page.goto(`/crm/profile/${TARGET_ID}?tab=contract`)

    // Tab label
    await expect(page.getByRole('button', { name: 'Контракт' })).toBeVisible()
    // Contract tab content renders (status badge present)
    await expect(page.getByTestId('contract-tab')).toBeVisible()
    await expect(page.getByTestId('contract-status-badge')).toHaveText('Черновик')
  })

  test('AC1: SENIOR (non-ADMIN) does NOT see "Контракт" tab on another profile', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)

    // Senior viewing junior — no contract tab in permissions
    await page.route(new RegExp(`${API}/users/${USERS.junior.id}$`), async (r) => {
      if (r.request().method() === 'GET') {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          // HR viewing junior — limited tabs, no contract
          body: JSON.stringify({
            user: { ...USERS.junior },
            permissions: { tabs: ['overview', 'projects', 'team'], actions: [], fields: {} },
            data: {},
          }),
        })
      } else {
        await r.fallback()
      }
    })

    await page.goto(`/crm/profile/${USERS.junior.id}`)
    // Wait for profile to load
    await expect(page.getByRole('button', { name: 'Обзор' })).toBeVisible()
    // No contract tab
    await expect(page.getByRole('button', { name: 'Контракт' })).not.toBeVisible()
  })

  test('AC2: DRAFT contract loads; Save button disabled when clean, enabled when dirty', async ({ page }) => {
    await setupAdminViewingSenior(page, DRAFT_CONTRACT)
    await page.goto(`/crm/profile/${TARGET_ID}?tab=contract`)

    await expect(page.getByTestId('contract-tab')).toBeVisible()
    await expect(page.getByTestId('contract-status-badge')).toHaveText('Черновик')

    // Save button starts disabled (no unsaved changes)
    await expect(page.getByTestId('contract-save-btn')).toBeDisabled()

    // Type in the CodeMirror editor to make it dirty
    const editorArea = page.locator('.cm-content').first()
    await editorArea.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edited')

    // Save button becomes enabled
    await expect(page.getByTestId('contract-save-btn')).toBeEnabled()
    // Dirty indicator appears
    await expect(page.getByText('Есть несохранённые изменения')).toBeVisible()
  })

  test('AC3: Mark Ready transitions status badge to "Готов к подписанию"', async ({ page }) => {
    await setupAdminViewingSenior(page, DRAFT_CONTRACT)
    await page.goto(`/crm/profile/${TARGET_ID}?tab=contract`)

    await expect(page.getByTestId('contract-tab')).toBeVisible()
    await expect(page.getByTestId('contract-mark-ready-btn')).toBeVisible()

    // Mock the query invalidation refetch to return READY_TO_SIGN contract
    await page.route(new RegExp(`${API}/users/([^/?]+)/contract$`), async (r) => {
      if (r.request().method() === 'GET') {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(READY_CONTRACT),
        })
      } else {
        await r.fallback()
      }
    })

    await page.getByTestId('contract-mark-ready-btn').click()

    // After mutation + refetch: badge shows READY_TO_SIGN
    await expect(page.getByTestId('contract-status-badge')).toHaveText('Готов к подписанию', {
      timeout: 5000,
    })
  })

  test('AC4: READY_TO_SIGN editor is frozen (frozen banner visible)', async ({ page }) => {
    await setupAdminViewingSenior(page, READY_CONTRACT)
    await page.goto(`/crm/profile/${TARGET_ID}?tab=contract`)

    await expect(page.getByTestId('contract-tab')).toBeVisible()
    await expect(page.getByTestId('contract-status-badge')).toHaveText('Готов к подписанию')
    // Frozen banner appears
    await expect(page.getByTestId('contract-editor-frozen-banner')).toBeVisible()
    // No Save / MarkReady / Reset buttons in READY_TO_SIGN
    await expect(page.getByTestId('contract-save-btn')).not.toBeVisible()
    await expect(page.getByTestId('contract-mark-ready-btn')).not.toBeVisible()
    // Only Revert available
    await expect(page.getByTestId('contract-revert-btn')).toBeVisible()
  })

  test('AC7: no-template 404 shows empty state with link to templates', async ({ page }) => {
    await setupAdminViewingSenior(
      page,
      { message: 'No active contract template for role SENIOR' },
      { contractStatus: 404 },
    )
    await page.goto(`/crm/profile/${TARGET_ID}?tab=contract`)

    await expect(page.getByTestId('contract-tab-no-template')).toBeVisible()
    await expect(page.getByTestId('contract-tab-template-link')).toBeVisible()
    await expect(page.getByText('Нет шаблона контракта для роли SENIOR')).toBeVisible()
  })

  test('AC6: PDF preview refresh button disabled while editor is dirty', async ({ page }) => {
    await setupAdminViewingSenior(page, DRAFT_CONTRACT)
    await page.goto(`/crm/profile/${TARGET_ID}?tab=contract`)

    await expect(page.getByTestId('contract-tab')).toBeVisible()

    // Initially refresh is enabled (clean state)
    await expect(page.getByTestId('contract-pdf-refresh-btn')).toBeEnabled()

    // Make editor dirty
    const editorArea = page.locator('.cm-content').first()
    await editorArea.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' dirty')

    // Refresh button becomes disabled
    await expect(page.getByTestId('contract-pdf-refresh-btn')).toBeDisabled()
  })
})
