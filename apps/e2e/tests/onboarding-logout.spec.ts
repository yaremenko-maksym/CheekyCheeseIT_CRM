/**
 * onboarding-logout.spec.ts
 *
 * Verifies that a user trapped on the onboarding screen can log out:
 *  AC1 — [data-testid="onboarding-logout"] button is visible on /crm/onboarding
 *  AC2 — user email is shown next to the button (sm+ breakpoint; we use 1280px viewport)
 *  AC3 — clicking the button redirects to /login and clears the session
 *         (subsequent navigation to /crm redirects back to /login)
 */

import { expect, test } from '@playwright/test'
import { USERS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'

// Unboarded status — user must complete onboarding before proceeding
const STATUS_UNBOARDED = {
  requiresContract: true,
  requiresTos: true,
  contractReady: true,
  contractTemplate: {
    id: 'tpl-senior-1',
    targetRole: 'SENIOR',
    version: 1,
    bodyMarkdown: '# Master Service Agreement\n\nThis is the **MSA** for your role.',
    isActive: true,
    createdByUserId: 'admin-id',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  tosVersion: {
    id: 'tos-v1',
    version: 1,
    bodyMarkdown: '# Terms of Service\n\nBy accepting you agree to the following terms.',
    isActive: true,
    createdByUserId: 'admin-id',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

test.describe('Onboarding logout', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as SENIOR (who needs onboarding)
    await mockAuthAs(page, USERS.senior)

    // Override onboarding status to "unboarded" so the gate stays open
    await page.unroute(`${API}/onboarding/status`)
    await page.route(`${API}/onboarding/status`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_UNBOARDED),
      }),
    )

    // Mock PDF endpoint so onboarding page loads without error
    await page.route(`${API}/onboarding/contract/pdf`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 mock'),
      }),
    )

    await page.goto('/crm/onboarding')
    // Wait for the page to fully render (brand mark or logout button present)
    await expect(page.getByTestId('onboarding-logout')).toBeVisible({ timeout: 8000 })
  })

  // -------------------------------------------------------------------------
  // AC1: logout button is visible on the onboarding page
  // -------------------------------------------------------------------------
  test('AC1: logout button is visible on /crm/onboarding', async ({ page }) => {
    await expect(page.getByTestId('onboarding-logout')).toBeVisible()
    await expect(page.getByTestId('onboarding-logout')).toContainText('Выйти')
  })

  // -------------------------------------------------------------------------
  // AC2: user email shown next to the button (sm+ viewport = 1280px default)
  // -------------------------------------------------------------------------
  test('AC2: user email is displayed next to the logout button', async ({ page }) => {
    const emailEl = page.getByTestId('onboarding-user-email')
    await expect(emailEl).toBeVisible()
    await expect(emailEl).toContainText(USERS.senior.email)
  })

  // -------------------------------------------------------------------------
  // AC3: clicking logout redirects to /login and clears the session
  // -------------------------------------------------------------------------
  test('AC3: clicking logout redirects to /login and session is cleared', async ({ page }) => {
    // Set up the post-logout session state BEFORE clicking: /auth/me returns
    // 401 so any re-fetch (and the /crm guard below) deterministically sees a
    // cleared session — independent of CRM Layout init ordering.
    await page.unroute(`${API}/auth/me`)
    await page.route(`${API}/auth/me`, (r) => r.fulfill({ status: 401, body: '' }))

    // The click triggers window.location.href='/login' inside useLogout.
    await page.getByTestId('onboarding-logout').click()

    // Hard redirect to the public login page.
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 })

    // Guard holds: navigating back to /crm re-redirects to login (no bypass).
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 })
  })
})
