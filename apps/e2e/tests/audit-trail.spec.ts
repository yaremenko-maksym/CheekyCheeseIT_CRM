import { test, expect, USERS, mockAuthAs } from './fixtures'

/**
 * E2E: Phase 6 polish PR3 — compliance audit trail
 *
 * AC coverage:
 *   AC1 — GET /api/me/audit-trail returns signed_contracts + tos_acceptances
 *   AC2 — GET /api/audit/all RBAC (ACCOUNTANT/ADMIN only)
 *   AC4 — Route /crm/profile/audit for self-service users
 *   AC5 — Route /crm/audit-log for ACCOUNTANT/ADMIN + sidebar nav item
 *   AC6 — Russian UI everywhere
 *   AC8 — E2E: RBAC + download
 */

// ---------------------------------------------------------------------------
// /crm/profile/audit — self-service page (any authenticated user)
// ---------------------------------------------------------------------------

test.describe('/crm/profile/audit — self-service', () => {
  test('ADMIN: /crm/profile/audit renders with signed contract and ToS cards', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell resolves auth guard → component mounted
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByText('Моя аудит-история')).toBeVisible()
    // getByRole scopes to heading element — avoids strict-mode conflict with subtitle paragraph
    // that contains both strings as a combined substring.
    await expect(page.getByRole('heading', { name: 'Подписанные контракты' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Принятые Terms of Service' })).toBeVisible()
  })

  test('ADMIN: shows contract number and signed date', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell + data loaded (contract card rendered after useQuery resolves)
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByTestId('audit-contract-card')).toBeVisible()
    await expect(page.getByText('CHK-1-2026')).toBeVisible()
  })

  test('ADMIN: shows ToS card with version', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell + data loaded (ToS card rendered after useQuery resolves)
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByTestId('audit-contract-card')).toBeVisible()
    await expect(page.getByTestId('audit-tos-card')).toBeVisible()
    await expect(page.getByText(/Terms of Service · версия/)).toBeVisible()
  })

  test('SENIOR: /crm/profile/audit renders (self-service available for all roles)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell visible (auth resolved, component mounted)
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByText('Моя аудит-история')).toBeVisible()
  })

  test('ACCOUNTANT: /crm/profile/audit renders', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell visible
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
  })

  test('Download markdown button is present for contract', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell + data loaded — download button only renders after useQuery resolves
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByTestId('audit-contract-card')).toBeVisible()

    const downloadBtn = page.getByTestId('audit-contract-download').first()
    await expect(downloadBtn).toBeVisible()
    await expect(downloadBtn).toContainText('Markdown')
  })

  test('Clicking download triggers file download', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell + data loaded — must wait for button before click
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByTestId('audit-contract-card')).toBeVisible()

    // Set up download promise before clicking
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('audit-contract-download').first().click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/CHK-1-2026\.md$/)
  })
})

// ---------------------------------------------------------------------------
// /crm/audit-log — ACCOUNTANT + ADMIN only
// ---------------------------------------------------------------------------

test.describe('/crm/audit-log — ACCOUNTANT + ADMIN only', () => {
  test('ADMIN: /crm/audit-log renders audit log page', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/audit-log')

    // Anchor: page shell visible
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
    // Scope heading to main to avoid strict-mode conflict with sidebar nav link
    await expect(page.locator('main').getByText('Аудит-журнал')).toBeVisible()
  })

  test('ADMIN: shows event rows from mock data', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/audit-log')

    // Anchor: page shell + event rows loaded (useQuery resolved, skeleton gone)
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
    await expect(page.getByTestId('audit-event-row').first()).toBeVisible()
    await expect(page.getByText('CHK-1-2026')).toBeVisible()
  })

  test('ACCOUNTANT: /crm/audit-log is accessible', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await page.goto('/crm/audit-log')

    // Anchor: page shell visible
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
  })

  test('ADMIN: sidebar shows «Аудит-журнал» nav item', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/dashboard')

    // getByRole auto-retries until sidebar mounts — no explicit anchor needed
    await expect(page.getByRole('link', { name: 'Аудит-журнал' })).toBeVisible()
  })

  test('ACCOUNTANT: sidebar shows «Аудит-журнал» nav item', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await page.goto('/crm/dashboard')

    await expect(page.getByRole('link', { name: 'Аудит-журнал' })).toBeVisible()
  })

  test('ADMIN: filter inputs are present', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/audit-log')

    // Anchor: page shell before asserting filter inputs
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
    await expect(page.getByTestId('audit-filter-user')).toBeVisible()
    await expect(page.getByTestId('audit-filter-from')).toBeVisible()
    await expect(page.getByTestId('audit-filter-to')).toBeVisible()
    await expect(page.getByTestId('audit-filter-type')).toBeVisible()
  })

  test('ADMIN: CSV download button is visible and enabled when events exist', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/audit-log')

    // Anchor: page shell + event rows loaded — CSV button enabled only after items arrive
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
    await expect(page.getByTestId('audit-event-row').first()).toBeVisible()

    const csvBtn = page.getByTestId('audit-csv-download')
    await expect(csvBtn).toBeVisible()
    await expect(csvBtn).toBeEnabled()
    await expect(csvBtn).toContainText('Скачать CSV')
  })

  test('ADMIN: clicking CSV download triggers file download', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/audit-log')

    // Anchor: page shell + event rows — CSV button is disabled until items load
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
    await expect(page.getByTestId('audit-event-row').first()).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('audit-csv-download').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/audit-log-.*\.csv$/)
  })
})

// ---------------------------------------------------------------------------
// RBAC — SENIOR / JUNIOR / HR redirected from /crm/audit-log
// ---------------------------------------------------------------------------

test.describe('RBAC — /crm/audit-log unauthorized roles', () => {
  test('SENIOR: /crm/audit-log redirects to /crm/dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/audit-log')

    // waitForURL: deterministic — waits up to actionTimeout for URL predicate
    await page.waitForURL((url) => !url.pathname.startsWith('/crm/audit-log'))
    expect(page.url()).toContain('/crm/dashboard')
  })

  test('JUNIOR: /crm/audit-log redirects to /crm/dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/audit-log')

    await page.waitForURL((url) => !url.pathname.startsWith('/crm/audit-log'))
    expect(page.url()).toContain('/crm/dashboard')
  })

  test('HR: /crm/audit-log redirects to /crm/dashboard', async ({ page }) => {
    await mockAuthAs(page, USERS.hr)
    await page.goto('/crm/audit-log')

    await page.waitForURL((url) => !url.pathname.startsWith('/crm/audit-log'))
    expect(page.url()).toContain('/crm/dashboard')
  })

  test('SENIOR: sidebar does NOT show «Аудит-журнал» nav item', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/dashboard')

    // Anchor: wait for a sidebar link that IS visible for SENIOR to confirm sidebar
    // has mounted before asserting absence — prevents false-negative before mount.
    await expect(page.getByRole('link', { name: 'Команда' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Аудит-журнал' })).not.toBeVisible()
  })

  test('HR: sidebar does NOT show «Аудит-журнал» nav item', async ({ page }) => {
    await mockAuthAs(page, USERS.hr)
    await page.goto('/crm/dashboard')

    // Anchor: wait for a sidebar link that IS visible for HR to confirm mount
    await expect(page.getByRole('link', { name: 'Команда' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Аудит-журнал' })).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Russian UI strings
// ---------------------------------------------------------------------------

test.describe('Russian UI strings', () => {
  test('/crm/profile/audit has all required Russian labels', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile/audit')

    // Anchor: page shell + data loaded so all labels including «Скачать» are rendered
    await expect(page.getByTestId('profile-audit-page')).toBeVisible()
    await expect(page.getByTestId('audit-contract-card')).toBeVisible()

    await expect(page.getByText('Моя аудит-история')).toBeVisible()
    // getByRole scopes to heading — avoids strict-mode conflict with subtitle paragraph
    await expect(page.getByRole('heading', { name: 'Подписанные контракты' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Принятые Terms of Service' })).toBeVisible()
    // Scope to audit-contract-download testid — avoids strict-mode conflict
    // (button label changed from «Скачать» to «Markdown» in current UI).
    await expect(page.getByTestId('audit-contract-download').first()).toBeVisible()
  })

  test('/crm/audit-log has all required Russian labels', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/audit-log')

    // Anchor: page shell + event rows so «Скачать CSV» button is enabled
    await expect(page.getByTestId('audit-log-page')).toBeVisible()
    await expect(page.getByTestId('audit-event-row').first()).toBeVisible()

    // Scope heading to main to avoid strict-mode conflict with sidebar nav link
    await expect(page.locator('main').getByText('Аудит-журнал')).toBeVisible()
    await expect(page.getByText('Фильтры')).toBeVisible()
    await expect(page.getByText('Скачать CSV')).toBeVisible()
  })
})
