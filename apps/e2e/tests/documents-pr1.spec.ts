/**
 * documents-pr1.spec.ts
 *
 * E2E tests for Documents PR-1:
 *   1. Sidebar does not contain "Аудит-журнал" link after removal.
 *   2. Direct navigation to /audit-log is redirected (route gone).
 *   3. User profile does not have an "audit" tab (tab removed).
 *   4. ToS acceptance marker is visible for ADMIN viewing any user profile.
 *   5. /documents renders in list view by default (data-testid).
 *   6. View toggle switches to grid and back to list.
 */

import { test, expect, USERS, mockAuthAs, API_RE } from './fixtures'

// ---------------------------------------------------------------------------
// 1. Sidebar — no "Аудит-журнал"
// ---------------------------------------------------------------------------

test.describe('Sidebar — audit-log link removed', () => {
  test('ADMIN sidebar has no "Аудит-журнал" link', async ({ asAdmin: page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Any link whose text is «Аудит-журнал» must not be in the DOM.
    await expect(page.getByRole('link', { name: /аудит-журнал/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /аудит журнал/i })).toHaveCount(0)
  })

  test('ACCOUNTANT sidebar has no "Аудит-журнал" link', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('link', { name: /аудит-журнал/i })).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 2. /audit-log route is gone — redirected away
// ---------------------------------------------------------------------------

test.describe('/audit-log route removed', () => {
  test('ADMIN navigating to /audit-log lands outside the audit-log route', async ({
    asAdmin: page,
  }) => {
    await page.goto('/audit-log')
    await page.waitForLoadState('networkidle')
    // The route no longer exists — TanStack Router renders a 404 / redirect.
    // Either the URL changes OR the page renders without the former
    // audit-log-page testid. Both conditions prove the route is gone.
    const hasAuditPage = await page.getByTestId('audit-log-page').count()
    const urlIsAuditLog = page.url().includes('/audit-log')
    // If URL didn't change AND old testid is present — route still exists → fail.
    expect(hasAuditPage === 0 || !urlIsAuditLog).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Profile does not have "audit" tab
// ---------------------------------------------------------------------------

test.describe('User profile — no audit tab', () => {
  test('ADMIN viewing junior profile has no "История" (audit) tab button', async ({
    asAdmin: page,
  }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    // AnimatedTabs renders tab buttons by label text, not by testid.
    // The audit tab was labelled "История" — it must not appear after removal.
    await expect(page.getByRole('button', { name: 'История' })).toHaveCount(0)
    // Profile still renders the Overview tab correctly.
    await expect(page.getByRole('button', { name: 'Обзор' })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 4. ToS acceptance marker visible for ADMIN
// ---------------------------------------------------------------------------

test.describe('ToS acceptance marker on profile overview', () => {
  test('ADMIN sees ToS acceptance card on junior profile overview', async ({ asAdmin: page }) => {
    // Override the /users/:id response to include tosAcceptedAt in data.overview.
    await page.route(new RegExp(`${API_RE}/users/${USERS.junior.id}$`), (r) => {
      if (r.request().method() !== 'GET') return r.continue()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            ...USERS.junior,
            telegram: null,
            phone: null,
            techStack: null,
            paymentMethod: null,
            walletUsdtErc20: null,
            walletUsdtLabel: null,
            bankUahRecipient: null,
            bankUahIban: null,
            bankUahRnokpp: null,
            bankUahBankName: null,
            archivedAt: null,
            adminNote: null,
            seniorSharePercent: 0,
            dropSharePercent: null,
            legalFullName: null,
            monthlySalary: null,
            salaryCurrency: 'USD',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          permissions: {
            tabs: [
              'overview',
              'finance',
              'projects',
              'team',
              'requisites',
              'documents',
              'contract',
            ],
            actions: [
              'edit-profile',
              'change-role',
              'change-salary',
              'change-requisites',
              'set-note',
              'archive',
            ],
            fields: { salary: true, share: false, techStack: true, registrationDate: true },
          },
          data: {
            overview: {
              techStack: null,
              adminNote: null,
              tosAcceptedAt: '2026-01-10T08:00:00.000Z',
              tosVersion: 1,
            },
          },
        }),
      })
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // ToS card must be visible on the Overview tab (default).
    await expect(page.getByTestId('tos-acceptance-card')).toBeVisible()
    // Accepted date and version present in the card text.
    await expect(page.getByTestId('tos-accepted-text')).toBeVisible()
    const text = await page.getByTestId('tos-accepted-text').textContent()
    expect(text).toContain('v1')
  })

  test('ADMIN sees "Не принято" when tosAcceptedAt is null', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API_RE}/users/${USERS.junior.id}$`), (r) => {
      if (r.request().method() !== 'GET') return r.continue()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            ...USERS.junior,
            telegram: null,
            phone: null,
            techStack: null,
            paymentMethod: null,
            walletUsdtErc20: null,
            walletUsdtLabel: null,
            bankUahRecipient: null,
            bankUahIban: null,
            bankUahRnokpp: null,
            bankUahBankName: null,
            archivedAt: null,
            adminNote: null,
            seniorSharePercent: 0,
            dropSharePercent: null,
            legalFullName: null,
            monthlySalary: null,
            salaryCurrency: 'USD',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          permissions: {
            tabs: [
              'overview',
              'finance',
              'projects',
              'team',
              'requisites',
              'documents',
              'contract',
            ],
            actions: [
              'edit-profile',
              'change-role',
              'change-salary',
              'change-requisites',
              'set-note',
              'archive',
            ],
            fields: { salary: true, share: false, techStack: true, registrationDate: true },
          },
          data: {
            overview: {
              techStack: null,
              adminNote: null,
              tosAcceptedAt: null,
              tosVersion: null,
            },
          },
        }),
      })
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await expect(page.getByTestId('tos-acceptance-card')).toBeVisible()
    await expect(page.getByTestId('tos-not-accepted-text')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 5 & 6. /documents — view toggle list/grid
// ---------------------------------------------------------------------------

test.describe('/documents — view toggle', () => {
  test('default view is list (data-testid documents-view-list is aria-pressed)', async ({
    asAdmin: page,
  }) => {
    // Clear localStorage before navigating so we test the true default.
    await page.addInitScript(() => {
      localStorage.removeItem('crm.documents.view')
    })
    await page.goto('/documents')
    await page.waitForLoadState('networkidle')

    // View toggle is present.
    await expect(page.getByTestId('documents-view-toggle')).toBeVisible()

    // List button is pressed by default.
    const listBtn = page.getByTestId('documents-view-list')
    await expect(listBtn).toBeVisible()
    await expect(listBtn).toHaveAttribute('aria-pressed', 'true')

    // Grid button is not pressed.
    const gridBtn = page.getByTestId('documents-view-grid')
    await expect(gridBtn).toHaveAttribute('aria-pressed', 'false')
  })

  test('clicking grid button switches to grid view', async ({ asAdmin: page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('crm.documents.view')
    })
    await page.goto('/documents')
    await page.waitForLoadState('networkidle')

    await page.getByTestId('documents-view-grid').click()

    // Grid button now pressed.
    await expect(page.getByTestId('documents-view-grid')).toHaveAttribute('aria-pressed', 'true')
    // List button no longer pressed.
    await expect(page.getByTestId('documents-view-list')).toHaveAttribute('aria-pressed', 'false')

    // URL reflects the view param.
    await expect(page).toHaveURL(/[?&]view=grid/)
  })

  test('?view=list in URL sets list mode', async ({ asAdmin: page }) => {
    await page.goto('/documents?view=list')
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('documents-view-list')).toHaveAttribute('aria-pressed', 'true')
  })

  test('?view=grid in URL sets grid mode', async ({ asAdmin: page }) => {
    await page.goto('/documents?view=grid')
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('documents-view-grid')).toHaveAttribute('aria-pressed', 'true')
  })
})
