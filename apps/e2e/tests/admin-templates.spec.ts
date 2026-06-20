/**
 * admin-templates.spec.ts — Phase 6C E2E tests
 *
 * Coverage (AC 6C-8):
 * 1. ADMIN opens /crm/admin/contracts → sees 5 role cards,
 *    clicks SENIOR editor, edits markdown, publishes new version → toast shown
 * 2. ADMIN publishes new ToS version → onboarding-status invalidated
 *    (soft-notify banner visible for an onboarded user)
 * 3. non-ADMIN (SENIOR) navigates to /crm/admin →
 *    redirected to /crm + error toast shown
 *
 * All tests use Playwright route mocks (no real backend required).
 * Route moved: /crm/admin/templates/* → /crm/admin/* (PR #256).
 */

import { test as base, expect, type Page, type Route } from '@playwright/test'
import { USERS, mockAuthAs } from './fixtures'

// Origin-agnostic prefix — matches any host/port (dev proxy on :3000,
// direct :3001, preview :3010). Mirrors the API_GLOB pattern from fixtures.ts.
const API_GLOB = '**/api'
const API_RE = '\\/api'

function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const CONTRACT_TEMPLATE_SENIOR = {
  id: 'tpl-senior-1',
  targetRole: 'SENIOR',
  version: 3,
  bodyMarkdown: '# MSA Senior\n\nTerms for **{{employeeName}}**.',
  isActive: true,
  createdByUserId: USERS.admin.id,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const ALL_CONTRACT_TEMPLATES = [
  CONTRACT_TEMPLATE_SENIOR,
  { ...CONTRACT_TEMPLATE_SENIOR, id: 'tpl-hr-1', targetRole: 'HR', version: 1 },
  { ...CONTRACT_TEMPLATE_SENIOR, id: 'tpl-junior-1', targetRole: 'JUNIOR', version: 1 },
  { ...CONTRACT_TEMPLATE_SENIOR, id: 'tpl-drop-1', targetRole: 'DROP', version: 1 },
  {
    ...CONTRACT_TEMPLATE_SENIOR,
    id: 'tpl-accountant-1',
    targetRole: 'ACCOUNTANT',
    version: 1,
  },
]

const TOS_VERSION = {
  id: 'tos-v1',
  version: 1,
  bodyMarkdown: '# Terms of Service\n\nBy accepting you agree.',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mockTemplateApis(page: Page) {
  // GET /contracts/templates — returns all active templates list
  await page.route(`${API_GLOB}/contracts/templates`, (r) => {
    if (r.request().method() === 'GET') return jsonOk(r, ALL_CONTRACT_TEMPLATES)
    // POST — publish new version
    return jsonOk(
      r,
      { ...CONTRACT_TEMPLATE_SENIOR, version: CONTRACT_TEMPLATE_SENIOR.version + 1 },
      201,
    )
  })

  // GET /contracts/templates/current/:role
  await page.route(new RegExp(`${API_RE}/contracts/templates/current/([^/?]+)$`), (r) => {
    const role = r.request().url().split('/').at(-1)?.toUpperCase()
    const tpl = ALL_CONTRACT_TEMPLATES.find((t) => t.targetRole === role)
    return jsonOk(r, tpl ?? null)
  })

  // GET /tos/versions
  await page.route(`${API_GLOB}/tos/versions`, (r) => jsonOk(r, [TOS_VERSION]))

  // GET /tos/current
  await page.route(`${API_GLOB}/tos/current`, (r) => jsonOk(r, TOS_VERSION))

  // POST /tos — publish new ToS version
  await page.route(`${API_GLOB}/tos`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { ...TOS_VERSION, id: 'tos-v2', version: 2, isActive: true }, 201)
  })
}

// ---------------------------------------------------------------------------
// Custom test fixture
// ---------------------------------------------------------------------------

type LocalFixtures = { asAdmin: Page; asSenior: Page }

const test = base.extend<LocalFixtures>({
  asAdmin: async ({ page }, use) => {
    await mockAuthAs(page, USERS.admin)
    await mockTemplateApis(page)
    await use(page)
  },
  asSenior: async ({ page }, use) => {
    await mockAuthAs(page, USERS.senior)
    await mockTemplateApis(page)
    await use(page)
  },
})

// ---------------------------------------------------------------------------
// AC 6C-8 — Scenario 1: ADMIN edits SENIOR contract + publishes
// ---------------------------------------------------------------------------

test('ADMIN sees 5 role cards, edits SENIOR contract, publishes new version', async ({
  asAdmin: page,
}) => {
  await page.goto('/crm/admin/contracts')

  // All 5 role cards should render
  for (const role of ['hr', 'senior', 'junior', 'drop', 'accountant']) {
    await expect(page.getByTestId(`contract-template-card-${role}`)).toBeVisible()
  }

  // Click to open SENIOR editor
  await page.getByTestId('contract-template-edit-senior').click()
  await expect(page).toHaveURL(/\/crm\/admin\/contracts\/senior/)

  // Variables tab should be visible by default (new UI: Tabs instead of hint toggle)
  await expect(page.getByTestId('tab-variables')).toBeVisible()
  await expect(page.getByTestId('variables-tab-content')).toBeVisible()

  // Switch to preview tab → preview panel becomes visible
  await page.getByTestId('tab-preview').click()
  await expect(page.getByTestId('contract-editor-preview')).toBeVisible()

  // Click publish → confirmation dialog appears
  await page.getByTestId('publish-template-button').click()
  await expect(page.getByTestId('publish-confirm-dialog')).toBeVisible()

  // Cancel → dialog closes
  await page.getByTestId('cancel-button').click()
  await expect(page.getByTestId('publish-confirm-dialog')).not.toBeVisible()

  // Confirm publish
  await page.getByTestId('publish-template-button').click()
  await expect(page.getByTestId('publish-confirm-dialog')).toBeVisible()

  // NEW: assert diff panel visible inside confirm dialog
  await expect(page.locator('[data-testid^="markdown-diff"]')).toBeVisible()

  await page.getByTestId('confirm-publish-button').click()

  // Toast success
  await expect(page.getByText(/опубликован/i)).toBeVisible()
})

// ---------------------------------------------------------------------------
// AC 6C-8 — Scenario 2: ADMIN publishes new ToS, soft-notify banner visible
// ---------------------------------------------------------------------------

test('ADMIN publishes new ToS, soft-notify banner visible for onboarded user', async ({
  asAdmin: page,
}) => {
  await page.goto('/crm/admin/tos')

  // Current active ToS should show in viewer
  await expect(page.getByTestId('publish-new-tos-button')).toBeVisible()

  // Check history list renders (1 version)
  await expect(page.getByTestId('tos-history-list')).not.toBeVisible()

  // Navigate to publish new ToS
  await page.getByTestId('publish-new-tos-button').click()
  await expect(page).toHaveURL(/\/crm\/admin\/tos\/new/)

  // Editor and preview visible
  await expect(page.getByTestId('tos-editor-preview')).toBeVisible()

  // Click publish → confirmation dialog
  await page.getByTestId('publish-tos-button').click()
  await expect(page.getByTestId('publish-tos-confirm-dialog')).toBeVisible()

  // Cancel
  await page.getByTestId('cancel-button').click()
  await expect(page.getByTestId('publish-tos-confirm-dialog')).not.toBeVisible()

  // Override onboarding/status to return tosUpdateAvailable=true AFTER publish
  // so a fresh page load for an onboarded user shows the soft-notify banner.
  await page.route(`${API_GLOB}/onboarding/status`, (r) =>
    jsonOk(r, {
      requiresContract: false,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: true,
      latestTosVersion: { ...TOS_VERSION, id: 'tos-v2', version: 2 },
    }),
  )

  // Confirm publish
  await page.getByTestId('publish-tos-button').click()
  await expect(page.getByTestId('publish-tos-confirm-dialog')).toBeVisible()

  // NEW: assert diff panel visible inside confirm dialog
  await expect(page.locator('[data-testid^="markdown-diff"]')).toBeVisible()

  await page.getByTestId('confirm-publish-tos-button').click()

  // Toast success — .first() guards against strict-mode violation: Sonner portal
  // plus the sidebar/status badge can both match /опубликована/i simultaneously.
  await expect(page.getByText(/опубликована/i).first()).toBeVisible()
})

// ---------------------------------------------------------------------------
// AC 6C-8 — Scenario 3: non-ADMIN redirected from /crm/admin/templates
// ---------------------------------------------------------------------------

test('non-ADMIN navigating to /crm/admin is redirected to /crm', async ({ asSenior: page }) => {
  await page.goto('/crm/admin/contracts')

  // Should land on the dashboard root /crm (redirect triggered by RBAC guard in
  // route layout). Anchored so it doesn't match /crm/admin/... sub-paths.
  await expect(page).toHaveURL(/\/crm\/?$/)

  // Error toast should be shown — use .first() to handle potential strict-mode
  // duplicate (toast can render inside the Sonner portal which may produce two
  // matching nodes when a sidebar label also contains the text; .first() is
  // safe here because we only assert the toast is visible, not its exact count).
  await expect(page.getByText(/только для ADMIN/i).first()).toBeVisible()
})

// ---------------------------------------------------------------------------
// Bonus: ToS history list with multiple versions + archive preview
// ---------------------------------------------------------------------------

test('ADMIN can preview archived ToS version in history list', async ({ asAdmin: page }) => {
  const TOS_V2 = {
    ...TOS_VERSION,
    id: 'tos-v2',
    version: 2,
    bodyMarkdown: '# ToS v2\n\nUpdated terms.',
    isActive: true,
  }
  const TOS_V1_ARCHIVED = { ...TOS_VERSION, isActive: false }

  // Override with 2 versions
  await page.route(`${API_GLOB}/tos/versions`, (r) => jsonOk(r, [TOS_V2, TOS_V1_ARCHIVED]))

  await page.goto('/crm/admin/tos')

  // History list shows archived v1
  await expect(page.getByTestId('tos-history-list')).toBeVisible()
  await expect(page.getByTestId('tos-history-item-v1')).toBeVisible()

  // Click archived version → amber "Просмотр архивной версии" banner appears
  await page.getByTestId('tos-history-item-v1').click()
  await expect(page.getByText(/Просмотр архивной версии v1/)).toBeVisible()

  // Back to active button returns to active view
  await page.getByTestId('back-to-active-tos').click()
  await expect(page.getByText(/Просмотр архивной версии/)).not.toBeVisible()
})
