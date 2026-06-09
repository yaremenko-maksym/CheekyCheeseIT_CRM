/**
 * legend.spec.ts
 *
 * Tests for SENIOR Legend feature — /crm/profile and /crm/profile/:userId
 *
 * Pattern: mock-based (no live server needed).
 * - SENIOR sees editable legend section on own profile
 * - HR sees read-only legend on their senior's profile
 * - ACCOUNTANT does NOT see legend section (GET /legend returns 403 → hidden)
 * - JUNIOR sees read-only legend if active in senior's project
 */

import { test, expect, USERS, mockAuthAs, buildSelfView, buildHrViewingSenior } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Legend fixture data
// ---------------------------------------------------------------------------

const MOCK_LEGEND = {
  id: 'legend-uuid-0001',
  userId: USERS.senior.id,
  fullName: 'Іванов Іван Іванович',
  dateOfBirth: '1990-01-15',
  address: 'Київ, Хрещатик 1',
  hobbies: 'Читання, плавання',
  notes: 'Досвідчений TypeScript розробник',
  createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
  updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
}

// ---------------------------------------------------------------------------
// Helper: mock legend endpoint
// ---------------------------------------------------------------------------

async function mockLegendGet(
  page: Parameters<typeof mockAuthAs>[0],
  userId: string,
  response: 'found' | 'not-found' | 'forbidden',
) {
  const pattern = new RegExp(`${API}/users/${userId}/legend$`)
  if (response === 'found') {
    await page.route(pattern, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_LEGEND) }),
    )
  } else if (response === 'not-found') {
    await page.route(pattern, (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not found' }) }),
    )
  } else {
    await page.route(pattern, (r) =>
      r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden' }) }),
    )
  }
}

async function mockLegendPut(
  page: Parameters<typeof mockAuthAs>[0],
  userId: string,
  responseData: object,
) {
  const pattern = new RegExp(`${API}/users/${userId}/legend$`)
  await page.route(pattern, (r) => {
    if (r.request().method() === 'PUT') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(responseData),
      })
    }
    return r.fallback()
  })
}

// ---------------------------------------------------------------------------
// SENIOR: own profile — editable legend
// ---------------------------------------------------------------------------

test.describe('SENIOR self-profile — legend section', () => {
  test('SENIOR sees legend section with existing legend', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockLegendGet(page, USERS.senior.id, 'found')
    await page.goto('/crm/profile')

    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    // Legend section renders
    await expect(page.getByTestId('legend-section')).toBeVisible()
    // Full name is shown
    await expect(page.getByTestId('legend-fullname')).toHaveText('Іванов Іван Іванович')
    // Edit button is present (SENIOR can edit own legend)
    await expect(page.getByTestId('legend-edit-button')).toBeVisible()
  })

  test('SENIOR sees "Легенда не заполнена" when no legend exists', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockLegendGet(page, USERS.senior.id, 'not-found')
    await page.goto('/crm/profile')

    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByTestId('legend-section')).toBeVisible()
    await expect(page.getByText('Легенда не заполнена')).toBeVisible()
    // "Создать" button for empty state
    await expect(page.getByTestId('legend-edit-button')).toHaveText(/Создать/)
  })

  test('SENIOR can open edit form and save legend', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    // Start with 404 (no legend yet)
    await mockLegendGet(page, USERS.senior.id, 'not-found')

    // Mock PUT to return the new legend
    const newLegend = { ...MOCK_LEGEND, fullName: 'Петренко Петро Петрович' }
    await page.route(new RegExp(`${API}/users/${USERS.senior.id}/legend$`), (r) => {
      if (r.request().method() === 'PUT') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(newLegend),
        })
      }
      // GET after save — return updated legend
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(newLegend),
      })
    })

    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    // Open edit form
    await page.getByTestId('legend-edit-button').click()
    await expect(page.getByTestId('legend-form')).toBeVisible()

    // Fill ФИО (required field)
    await page.getByTestId('legend-input-fullname').fill('Петренко Петро Петрович')

    // Submit
    await page.getByTestId('legend-save-button').click()

    // Toast success
    await expect(page.getByText('Легенда сохранена')).toBeVisible()
  })

  test('SENIOR can cancel editing without saving', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await mockLegendGet(page, USERS.senior.id, 'found')
    await page.goto('/crm/profile')

    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await page.getByTestId('legend-edit-button').click()
    await expect(page.getByTestId('legend-form')).toBeVisible()

    // Cancel — form disappears
    await page.getByTestId('legend-cancel-button').click()
    await expect(page.getByTestId('legend-form')).not.toBeVisible()
    // Read-only view shown again
    await expect(page.getByTestId('legend-fullname')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// HR viewing senior profile — read-only legend
// ---------------------------------------------------------------------------

test.describe('HR viewing senior profile — read-only legend', () => {
  test('HR sees read-only legend on senior profile (no edit button)', async ({ page }) => {
    await mockAuthAs(page, USERS.hr)
    // Mock /users/:id for senior's profile
    await page.route(new RegExp(`${API}/users/${USERS.senior.id}$`), (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildHrViewingSenior(USERS.senior)),
        })
      }
      return r.fallback()
    })
    await mockLegendGet(page, USERS.senior.id, 'found')

    await page.goto(`/crm/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    // Legend section is visible
    await expect(page.getByTestId('legend-section')).toBeVisible()
    await expect(page.getByTestId('legend-fullname')).toHaveText('Іванов Іван Іванович')
    // No edit button for HR
    await expect(page.getByTestId('legend-edit-button')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// ACCOUNTANT — legend section hidden (403)
// ---------------------------------------------------------------------------

test.describe('ACCOUNTANT — legend section not shown', () => {
  test('ACCOUNTANT does NOT see legend section on senior profile', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)

    // Mock /users/:id — ACCOUNTANT can view senior profile overview
    await page.route(new RegExp(`${API}/users/${USERS.senior.id}$`), (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { ...USERS.senior },
            permissions: {
              tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
              actions: [],
              fields: { techStack: true, registrationDate: true, salary: true, share: true },
            },
            data: {},
          }),
        })
      }
      return r.fallback()
    })
    // GET legend returns 403 — section hides itself
    await mockLegendGet(page, USERS.senior.id, 'forbidden')

    await page.goto(`/crm/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    // Wait for overview tab to load then check no legend section
    await page.waitForTimeout(300)
    await expect(page.getByTestId('legend-section')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Non-SENIOR target — legend section not shown
// ---------------------------------------------------------------------------

test.describe('JUNIOR target — no legend section', () => {
  test('ADMIN viewing JUNIOR profile does NOT see legend section', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.route(new RegExp(`${API}/users/${USERS.junior.id}$`), (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { ...USERS.junior },
            permissions: {
              tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents', 'contract'],
              actions: ['edit-profile', 'change-role', 'change-salary', 'change-requisites', 'set-note', 'archive'],
              fields: { salary: true, share: false, paymentMethodKpi: true, techStack: true, registrationDate: true },
            },
            data: {},
          }),
        })
      }
      return r.fallback()
    })

    await page.goto(`/crm/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // Legend section should not be present (user.role !== 'SENIOR')
    await expect(page.getByTestId('legend-section')).not.toBeVisible()
  })
})
