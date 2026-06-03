/**
 * onboarding-flow.spec.ts — Phase 6B E2E tests
 *
 * Coverage (AC #8):
 * - 5 non-ADMIN roles (HR, SENIOR, JUNIOR, DROP, ACCOUNTANT): unboarded user
 *   → lands on /crm/onboarding → signs contract → accepts ToS → reaches /crm/dashboard
 * - ADMIN: logs in → NOT redirected to onboarding (gate bypass)
 * - Onboarded user: logs in → NOT redirected to onboarding (idempotent)
 * - Soft-notify banner: shows when tosUpdateAvailable=true AND requiresTos=false
 *
 * All tests use Playwright route mocks (no real backend required).
 * Onboarding API responses are controlled per-test to simulate unboarded / boarded state.
 */

import { test as base, expect, type Page } from '@playwright/test'
import { USERS, mockAuthAs } from './fixtures'

// ---------------------------------------------------------------------------
// API base (mirrors fixtures.ts)
// ---------------------------------------------------------------------------
const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Onboarding mock payloads
// ---------------------------------------------------------------------------

const CONTRACT_TEMPLATE = {
  id: 'tpl-senior-1',
  targetRole: 'SENIOR',
  version: 1,
  bodyMarkdown: '# Master Service Agreement\n\nThis is the **MSA** for your role.',
  isActive: true,
  createdByUserId: 'admin-id',
  createdAt: '2026-01-01T00:00:00.000Z',
}

const TOS_VERSION = {
  id: 'tos-v1',
  version: 1,
  bodyMarkdown: '# Terms of Service\n\nBy accepting you agree to the following terms.',
  isActive: true,
  createdByUserId: 'admin-id',
  createdAt: '2026-01-01T00:00:00.000Z',
}

const SIGNED_CONTRACT = {
  id: 'signed-1',
  userId: USERS.senior.id,
  templateId: 'tpl-senior-1',
  bodyMarkdownSnapshot: CONTRACT_TEMPLATE.bodyMarkdown,
  variablesFilled: { employeeName: 'Senior Dev' },
  signedTypedName: 'Senior Dev',
  signedIp: '127.0.0.1',
  signedUserAgent: 'Mozilla/5.0',
  signedAt: '2026-01-02T00:00:00.000Z',
  contractNumber: 'CHK-1-2026',
}

/** Status for a user who needs BOTH contract + ToS */
function statusUnboarded(role: string) {
  return {
    requiresContract: true,
    requiresTos: true,
    contractTemplate: { ...CONTRACT_TEMPLATE, targetRole: role },
    tosVersion: TOS_VERSION,
    tosUpdateAvailable: false,
    latestTosVersion: TOS_VERSION,
  }
}

/** Status for a fully onboarded user */
const STATUS_ONBOARDED = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: TOS_VERSION,
}

/** Status for ADMIN — always bypass */
const STATUS_ADMIN = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

/** Status where ToS updated but user already onboarded (soft-notify) */
const STATUS_TOS_UPDATE_AVAILABLE = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: true,
  latestTosVersion: { ...TOS_VERSION, version: 2, id: 'tos-v2' },
}

// ---------------------------------------------------------------------------
// Helper: mock onboarding API routes
// ---------------------------------------------------------------------------
async function mockOnboardingApi(
  page: Page,
  opts: {
    initialStatus: object
    /** Status returned after sign — defaults to status needing only ToS */
    statusAfterSign?: object
    /** Status returned after ToS accept — defaults to fully onboarded */
    statusAfterAccept?: object
  },
) {
  let signDone = false
  let tosAcceptDone = false

  // Clear any previously registered handler for this URL (e.g. the default
  // "fully onboarded" mock registered by mockAuthAs) so our stateful handler
  // takes effect unconditionally.
  await page.unroute(`${API}/onboarding/status`)

  // GET /onboarding/status — dynamic based on state
  await page.route(`${API}/onboarding/status`, (r) => {
    if (tosAcceptDone)
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_ONBOARDED),
      })
    if (signDone)
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          opts.statusAfterSign ?? { ...opts.initialStatus, requiresContract: false },
        ),
      })
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.initialStatus),
    })
  })

  // GET /contracts/templates/current/:role
  await page.route(new RegExp(`${API}/contracts/templates/current/[A-Z]+$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONTRACT_TEMPLATE),
    }),
  )

  // POST /contracts/sign
  await page.route(`${API}/contracts/sign`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    signDone = true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(SIGNED_CONTRACT),
    })
  })

  // GET /tos/current
  await page.route(`${API}/tos/current`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TOS_VERSION) }),
  )

  // POST /tos/accept
  await page.route(`${API}/tos/accept`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    tosAcceptDone = true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'acceptance-1',
        userId: USERS.senior.id,
        tosVersionId: TOS_VERSION.id,
        acceptedAt: new Date().toISOString(),
        acceptedIp: '127.0.0.1',
        acceptedUserAgent: 'Mozilla/5.0',
      }),
    })
  })
}

// ---------------------------------------------------------------------------
// Custom fixture: asAccountant (not in shared fixtures)
// ---------------------------------------------------------------------------
type OnboardingFixtures = {
  asAccountant: Page
}

const test = base.extend<OnboardingFixtures>({
  asAccountant: async ({ page }, use) => {
    await mockAuthAs(page, USERS.accountant)
    await use(page)
  },
})

// ---------------------------------------------------------------------------
// Helper: complete the full onboarding wizard
// ---------------------------------------------------------------------------
async function completeOnboarding(page: Page) {
  // Wait for wizard to load
  await expect(page.getByTestId('onboarding-title')).toBeVisible({ timeout: 8000 })

  // --- Step 1: Sign Contract ---
  await expect(page.getByTestId('onboarding-step-contract')).toBeVisible()

  // Wait for markdown to render (contract template loaded)
  await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 6000 })

  // Type name
  await page.getByTestId('typed-name-input').fill('Test User Signature')

  // Check confirm checkbox
  await page.getByTestId('confirm-checkbox').check()

  // Sign button should now be enabled
  const signBtn = page.getByTestId('sign-button')
  await expect(signBtn).toBeEnabled()
  await signBtn.click()

  // --- Step 2: Accept ToS ---
  await expect(page.getByTestId('onboarding-step-tos')).toBeVisible({ timeout: 6000 })

  // Check ToS checkbox
  await page.getByTestId('accept-tos-checkbox').check()

  // Accept button should be enabled
  const acceptBtn = page.getByTestId('accept-tos-button')
  await expect(acceptBtn).toBeEnabled()
  await acceptBtn.click()
}

// ===========================================================================
// Tests
// ===========================================================================

test.describe('Onboarding flow', () => {
  // -------------------------------------------------------------------------
  // Role-parametrized tests: SENIOR (canonical), HR, JUNIOR, DROP, ACCOUNTANT
  // -------------------------------------------------------------------------

  test('SENIOR: unboarded user → onboarding wizard → dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('SENIOR') })

    await page.goto('/crm/dashboard')

    // Gate redirects to onboarding
    await expect(page).toHaveURL(/\/crm\/onboarding/, { timeout: 8000 })

    // Complete wizard
    await completeOnboarding(page)

    // After accept → dashboard
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8000 })
  })

  test('HR: unboarded user → onboarding wizard → dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.hr)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('HR') })

    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8000 })
  })

  test('JUNIOR: unboarded user → onboarding wizard → dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('JUNIOR') })

    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8000 })
  })

  test('DROP: unboarded user → onboarding wizard → profile (DROP has no dashboard)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.drop)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('DROP') })

    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    // DROP role has no dashboard — dashboard.tsx redirects DROP to /crm/profile
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8000 })
  })

  test('ACCOUNTANT: unboarded user → onboarding wizard → dashboard', async ({
    asAccountant: page,
  }) => {
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('ACCOUNTANT') })

    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8000 })
  })

  // -------------------------------------------------------------------------
  // ADMIN bypass
  // -------------------------------------------------------------------------

  test('ADMIN: logs in → NOT redirected to onboarding', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)

    // Mock onboarding status as admin bypass
    await page.route(`${API}/onboarding/status`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_ADMIN),
      }),
    )

    await page.goto('/crm/dashboard')

    // Should NOT redirect to onboarding
    await expect(page).not.toHaveURL(/\/crm\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 5000 })
  })

  // -------------------------------------------------------------------------
  // Idempotent: already onboarded user
  // -------------------------------------------------------------------------

  test('Onboarded user: re-login → NOT redirected to onboarding', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)

    // Status = fully onboarded
    await page.route(`${API}/onboarding/status`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_ONBOARDED),
      }),
    )

    await page.goto('/crm/dashboard')

    // Should stay on dashboard
    await expect(page).not.toHaveURL(/\/crm\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 5000 })
  })

  // -------------------------------------------------------------------------
  // Soft-notify banner
  // -------------------------------------------------------------------------

  test('Soft-notify banner shows when new ToS version available', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)

    // Status: onboarded but ToS update available — override the default mock.
    await page.unroute(`${API}/onboarding/status`)
    await page.route(`${API}/onboarding/status`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_TOS_UPDATE_AVAILABLE),
      }),
    )

    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 5000 })

    // Banner should be visible
    await expect(page.getByTestId('tos-update-banner')).toBeVisible({ timeout: 5000 })

    // Banner link points to /crm/onboarding with step=tos
    const bannerLink = page.getByTestId('tos-update-banner-link')
    await expect(bannerLink).toBeVisible()
    const href = await bannerLink.getAttribute('href')
    expect(href).toContain('/crm/onboarding')
  })

  // -------------------------------------------------------------------------
  // Wizard step navigation: ?step=tos skips to ToS directly
  // -------------------------------------------------------------------------

  test('?step=tos param skips to ToS step directly', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockOnboardingApi(page, {
      initialStatus: {
        ...STATUS_ONBOARDED,
        requiresTos: true,
        tosVersion: TOS_VERSION,
        tosUpdateAvailable: false,
        latestTosVersion: TOS_VERSION,
      },
    })

    await page.goto('/crm/onboarding?step=tos')

    // Should show ToS step, not contract step
    await expect(page.getByTestId('onboarding-step-tos')).toBeVisible({ timeout: 6000 })
    await expect(page.getByTestId('onboarding-step-contract')).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Wizard: sign button disabled until both name + checkbox filled
  // -------------------------------------------------------------------------

  test('Sign button disabled until typed name AND checkbox both filled', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('SENIOR') })

    await page.goto('/crm/onboarding')
    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 6000 })

    const signBtn = page.getByTestId('sign-button')

    // Initially disabled
    await expect(signBtn).toBeDisabled()

    // Name filled but no checkbox → still disabled
    await page.getByTestId('typed-name-input').fill('Test Name')
    await expect(signBtn).toBeDisabled()

    // Checkbox only (clear name) → disabled
    await page.getByTestId('typed-name-input').fill('')
    await page.getByTestId('confirm-checkbox').check()
    await expect(signBtn).toBeDisabled()

    // Both filled → enabled
    await page.getByTestId('typed-name-input').fill('Test Name')
    await expect(signBtn).toBeEnabled()
  })
})
