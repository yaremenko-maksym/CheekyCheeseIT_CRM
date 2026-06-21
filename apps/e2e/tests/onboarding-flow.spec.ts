/**
 * onboarding-flow.spec.ts — Phase 6B E2E tests
 *
 * Coverage (AC #8):
 * - 5 non-ADMIN roles (HR, SENIOR, JUNIOR, DROP, ACCOUNTANT): unboarded user
 *   → lands on /onboarding → signs contract → accepts ToS → reaches /crm
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
    // A3-4: contractReady=true means the personal contract is READY_TO_SIGN
    // so the UI shows SignContractStep (not ContractWaitScreen).
    contractReady: true,
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

  // GET /onboarding/contract/pdf — A3-4: personal contract PDF blob.
  // Return a minimal PDF so the iframe loads without error and the
  // isLoadingPdf state clears (enabling the sign button once checkbox checked).
  await page.route(`${API}/onboarding/contract/pdf`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 mock'),
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

  // A3-4: SignContractStep shows PDF iframe (personal contract).
  // Wait for the form to appear — PDF fetch may take a moment in mocked env.
  await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 6000 })

  // Check confirm checkbox (no typed-name-input in A3-4 — legalFullName comes from server)
  await page.getByTestId('confirm-checkbox').check()

  // Sign button should now be enabled (blobUrl from PDF mock + checkbox checked)
  const signBtn = page.getByTestId('sign-button')
  await expect(signBtn).toBeEnabled({ timeout: 6000 })
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

    await page.goto('/')

    // Gate redirects to onboarding
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })

    // Complete wizard
    await completeOnboarding(page)

    // After accept → dashboard
    await expect(page).toHaveURL(/\/?$/, { timeout: 8000 })
  })

  test('HR: unboarded user → onboarding wizard → dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.hr)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('HR') })

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    await expect(page).toHaveURL(/\/?$/, { timeout: 8000 })
  })

  test('JUNIOR: unboarded user → onboarding wizard → dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('JUNIOR') })

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    await expect(page).toHaveURL(/\/?$/, { timeout: 8000 })
  })

  test('DROP: unboarded user → onboarding wizard → profile (DROP has no dashboard)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.drop)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('DROP') })

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    // DROP role has no dashboard — dashboard.tsx redirects DROP to /profile
    await expect(page).toHaveURL(/\/profile/, { timeout: 8000 })
  })

  test('ACCOUNTANT: unboarded user → onboarding wizard → dashboard', async ({
    asAccountant: page,
  }) => {
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('ACCOUNTANT') })

    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 8000 })
    await completeOnboarding(page)
    await expect(page).toHaveURL(/\/?$/, { timeout: 8000 })
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

    await page.goto('/')

    // Should NOT redirect to onboarding
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })
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

    await page.goto('/')

    // Should stay on dashboard
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 3000 })
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })
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

    await page.goto('/')
    await expect(page).toHaveURL(/\/?$/, { timeout: 5000 })

    // Banner should be visible
    await expect(page.getByTestId('tos-update-banner')).toBeVisible({ timeout: 5000 })

    // Banner link points to /onboarding with step=tos
    const bannerLink = page.getByTestId('tos-update-banner-link')
    await expect(bannerLink).toBeVisible()
    const href = await bannerLink.getAttribute('href')
    expect(href).toContain('/onboarding')
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

    await page.goto('/onboarding?step=tos')

    // Should show ToS step, not contract step
    await expect(page.getByTestId('onboarding-step-tos')).toBeVisible({ timeout: 6000 })
    await expect(page.getByTestId('onboarding-step-contract')).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // A3-4 wait-path: contractReady=false → ContractWaitScreen shown
  // -------------------------------------------------------------------------

  test('A3-4 wait-path: contractReady=false shows ContractWaitScreen', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)

    const waitStatus = {
      requiresContract: true,
      requiresTos: true,
      contractReady: false, // contract still in DRAFT — user must wait
      contractTemplate: null,
      tosVersion: TOS_VERSION,
      tosUpdateAvailable: false,
      latestTosVersion: TOS_VERSION,
    }

    await mockOnboardingApi(page, { initialStatus: waitStatus })

    await page.goto('/onboarding')
    await expect(page.getByTestId('onboarding-step-contract')).toBeVisible({ timeout: 8000 })

    // ContractWaitScreen should be shown, NOT SignContractStep form
    await expect(page.getByTestId('contract-wait-screen')).toBeVisible({ timeout: 6000 })
    await expect(page.getByTestId('sign-contract-form')).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Wizard: sign button disabled until checkbox checked (A3-4 model)
  // A3-4: typed-name-input removed — legalFullName comes from server.
  // Sign button is enabled once: blobUrl loaded (PDF mock) + checkbox checked.
  // -------------------------------------------------------------------------

  test('Sign button disabled until confirm checkbox checked', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockOnboardingApi(page, { initialStatus: statusUnboarded('SENIOR') })

    await page.goto('/onboarding')
    await expect(page.getByTestId('sign-contract-form')).toBeVisible({ timeout: 6000 })

    const signBtn = page.getByTestId('sign-button')

    // Initially disabled (checkbox unchecked)
    await expect(signBtn).toBeDisabled()

    // After checking confirm checkbox → enabled (PDF blob mock resolves immediately)
    await page.getByTestId('confirm-checkbox').check()
    await expect(signBtn).toBeEnabled({ timeout: 6000 })

    // Uncheck → disabled again
    await page.getByTestId('confirm-checkbox').uncheck()
    await expect(signBtn).toBeDisabled()
  })
})
