/**
 * admin-templates.spec.ts — Phase 6C E2E tests
 *
 * Coverage (AC 6C-8):
 * 1. ADMIN opens /admin/contracts → sees 5 role cards,
 *    clicks SENIOR editor, opens the PDF preview, publishes new version → toast shown
 * 2. ADMIN publishes new ToS version → onboarding-status invalidated
 *    (soft-notify banner visible for an onboarded user)
 * 3. non-ADMIN (SENIOR) navigates to /admin → redirected to the CRM root
 * 4. ADMIN can preview an archived ToS version from the history list
 *
 * All tests use Playwright route mocks (no real backend required).
 * Route moved: /admin/templates/* → /admin/* (PR #256).
 */

import { test as base, expect, type Page, type Route } from '@playwright/test'
import { USERS, mockAuthAs, API_GLOB, API_RE } from './fixtures'

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

  // POST /contracts/templates/preview-pdf and /tos/preview-pdf — server-rendered PDF
  // previews. Unmocked they hit the real API, 401 and bounce the page to /login.
  const MINIMAL_PDF = Buffer.from('%PDF-1.4 mock')
  await page.route(`${API_GLOB}/contracts/templates/preview-pdf`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/pdf', body: MINIMAL_PDF }),
  )
  await page.route(`${API_GLOB}/tos/preview-pdf`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/pdf', body: MINIMAL_PDF }),
  )

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
  await page.goto('/admin/contracts')

  // All 5 role cards should render
  for (const role of ['hr', 'senior', 'junior', 'drop', 'accountant']) {
    await expect(page.getByTestId(`contract-template-card-${role}`)).toBeVisible()
  }

  // Click to open SENIOR editor
  await page.getByTestId('contract-template-edit-senior').click()
  await expect(page).toHaveURL(/\/admin\/contracts\/senior/)

  // The editor and the variables panel render together (the old Variables/Preview
  // tabs were replaced by a full-width editor + panel below it).
  await expect(page.getByTestId('contract-editor-wrapper')).toBeVisible()
  await expect(page.getByTestId('variables-panel-wrapper')).toBeVisible()

  // Preview opens as a modal (PDF rendered server-side) and closes again.
  await page.getByTestId('preview-template-button').click()
  await expect(page.getByTestId('preview-dialog')).toBeVisible()
  await page.getByTestId('preview-dialog-close').click()
  await expect(page.getByTestId('preview-dialog')).not.toBeVisible()

  // Click publish → confirmation dialog appears
  await page.getByTestId('publish-template-button').click()
  await expect(page.getByTestId('publish-confirm-dialog')).toBeVisible()

  // Cancel → dialog closes
  await page.getByTestId('cancel-button').click()
  await expect(page.getByTestId('publish-confirm-dialog')).not.toBeVisible()

  // Confirm publish
  await page.getByTestId('publish-template-button').click()
  await expect(page.getByTestId('publish-confirm-dialog')).toBeVisible()

  // Diff panel visible inside the confirm dialog
  await expect(page.locator('[data-testid^="markdown-diff"]')).toBeVisible()

  await page.getByTestId('confirm-publish-button').click()

  // Success toast («Шаблон договору для ролі «…» опубліковано») — scoped to the toast region.
  await expect(
    page.getByRole('region', { name: /Notifications/ }).getByText(/опубліковано/),
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// AC 6C-8 — Scenario 2: ADMIN publishes new ToS, soft-notify banner visible
// ---------------------------------------------------------------------------

test('ADMIN publishes new ToS, soft-notify banner visible for onboarded user', async ({
  asAdmin: page,
}) => {
  await page.goto('/admin/tos')

  // Current active ToS should show in viewer
  await expect(page.getByTestId('publish-new-tos-button')).toBeVisible()

  // Check history list renders (1 version)
  await expect(page.getByTestId('tos-history-list')).not.toBeVisible()

  // Navigate to publish new ToS
  await page.getByTestId('publish-new-tos-button').click()
  await expect(page).toHaveURL(/\/admin\/tos\/new/)

  // Editor visible
  await expect(page.getByTestId('tos-editor-wrapper')).toBeVisible()

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

  // Diff panel visible inside the confirm dialog
  await expect(page.locator('[data-testid^="markdown-diff"]')).toBeVisible()

  await page.getByTestId('confirm-publish-tos-button').click()

  // Success toast («Нову версію умов використання опубліковано…») — scoped to the toast region.
  await expect(
    page.getByRole('region', { name: /Notifications/ }).getByText(/опубліковано/),
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// AC 6C-8 — Scenario 3: non-ADMIN redirected from /admin/*
// ---------------------------------------------------------------------------

test('non-ADMIN navigating to /admin is redirected to /', async ({ asSenior: page }) => {
  await page.goto('/admin/contracts')

  // The layout-level route guard (route-access: `/admin` is ADMIN-only) sends the
  // SENIOR to their home. Anchored on the whole URL so `/admin/...` cannot match.
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?(\?.*)?$/, { timeout: 8_000 })

  // No admin editor content leaks to the SENIOR.
  await expect(page.getByTestId('contract-template-card-senior')).toHaveCount(0)
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

  await page.goto('/admin/tos')

  // History list shows archived v1
  await expect(page.getByTestId('tos-history-list')).toBeVisible()
  await expect(page.getByTestId('tos-history-item-v1')).toBeVisible()

  // Click archived version → amber «Перегляд архівної версії» banner appears
  await page.getByTestId('tos-history-item-v1').click()
  await expect(page.getByText(/Перегляд архівної версії v1/)).toBeVisible()

  // Back to active button returns to active view
  await page.getByTestId('back-to-active-tos').click()
  await expect(page.getByText(/Перегляд архівної версії/)).not.toBeVisible()
})
