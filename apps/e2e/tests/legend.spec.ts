/**
 * legend.spec.ts
 *
 * Tests for SENIOR Legend feature — RBAC reversal 2026-06-09.
 *
 * NEW RULES (subject excluded, view==edit):
 *   /profile/:id  — ADMIN / linked-HR / linked-JUNIOR:
 *                       see legend section + can EDIT it (canEdit=true for all)
 *   /profile      — SENIOR/DROP self: legend section NOT shown
 *   ACCOUNTANT        — no legend section (fields.legend absent → not rendered)
 *
 * Pattern: mock-based (no live server needed). Uses typed fixtures (asAdmin,
 * asSenior, asHr, asJunior, asDrop) — mockAuthAs is pre-applied before use().
 * Per-test API overrides are registered via page.route() inside the test body
 * before page.goto() so they take precedence over generic fixture routes.
 */

import {
  test,
  expect,
  USERS,
  buildAdminViewingUser,
  buildHrViewingSenior,
  buildJuniorViewingSenior,
  API_RE,
} from './fixtures'

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
// Helpers
// ---------------------------------------------------------------------------

type PageLike = Parameters<typeof buildAdminViewingUser>[0] extends never
  ? never
  : {
      route: (
        url: string | RegExp,
        handler: (r: import('@playwright/test').Route) => unknown,
      ) => Promise<void>
    }

async function mockLegendGet(
  page: import('@playwright/test').Page,
  userId: string,
  response: 'found' | 'not-found' | 'forbidden',
) {
  const pattern = new RegExp(`${API_RE}/users/${userId}/legend$`)
  if (response === 'found') {
    await page.route(pattern, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_LEGEND),
      })
    })
  } else if (response === 'not-found') {
    await page.route(pattern, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Легенда не найдена' }),
      })
    })
  } else {
    await page.route(pattern, (r) =>
      r.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Forbidden' }),
      }),
    )
  }
}

async function mockUserGet(page: import('@playwright/test').Page, userId: string, body: object) {
  await page.route(new RegExp(`${API_RE}/users/${userId}$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

// ---------------------------------------------------------------------------
// SENIOR self-profile — legend section MUST NOT appear (subject excluded)
// ---------------------------------------------------------------------------

test.describe('SENIOR self-profile — legend section hidden (subject excluded)', () => {
  test('SENIOR does NOT see legend section on own /profile', async ({ asSenior: page }) => {
    // Even if the GET would succeed, mode='self' prevents LegendSection mounting
    await mockLegendGet(page, USERS.senior.id, 'found')
    await page.goto('/profile')

    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    // Self-view: mode='self' → OverviewTab condition `mode === 'view'` false → no legend-section
    await expect(page.getByTestId('legend-section')).not.toBeVisible({ timeout: 2000 })
  })

  test('DROP does NOT see legend section on own /profile', async ({ asDrop: page }) => {
    await mockLegendGet(page, USERS.drop.id, 'found')
    await page.goto('/profile')

    await expect(page.getByRole('heading', { name: 'Drop User' })).toBeVisible()
    await expect(page.getByTestId('legend-section')).not.toBeVisible({ timeout: 2000 })
  })
})

// ---------------------------------------------------------------------------
// ADMIN viewing senior profile — editable legend
// ---------------------------------------------------------------------------

test.describe('ADMIN viewing senior profile — editable legend', () => {
  test('ADMIN sees editable legend on senior profile with existing legend', async ({
    asAdmin: page,
  }) => {
    await mockLegendGet(page, USERS.senior.id, 'found')
    await mockUserGet(page, USERS.senior.id, buildAdminViewingUser(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await expect(page.getByTestId('legend-section')).toBeVisible()
    await expect(page.getByTestId('legend-fullname')).toHaveText('Іванов Іван Іванович')
    // ADMIN has canEdit=true (view==edit)
    await expect(page.getByTestId('legend-edit-button')).toBeVisible()
  })

  test('ADMIN sees "Легенда не заполнена" + Создать button when legend absent', async ({
    asAdmin: page,
  }) => {
    await mockLegendGet(page, USERS.senior.id, 'not-found')
    await mockUserGet(page, USERS.senior.id, buildAdminViewingUser(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await expect(page.getByTestId('legend-section')).toBeVisible()
    await expect(page.getByText('Легенда не заполнена')).toBeVisible()
    await expect(page.getByTestId('legend-edit-button')).toHaveText(/Создать/)
  })

  test('ADMIN can open edit form, fill and save legend', async ({ asAdmin: page }) => {
    const updatedLegend = { ...MOCK_LEGEND, fullName: 'Петренко Петро Петрович' }

    // GET initially 404, PUT returns updated, GET after invalidation returns updated
    await page.route(new RegExp(`${API_RE}/users/${USERS.senior.id}/legend$`), (r) => {
      if (r.request().method() === 'PUT') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(updatedLegend),
        })
      }
      // GET — first call 404, subsequent returns updated (simplification: always 404 for initial)
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Легенда не найдена' }),
      })
    })
    await mockUserGet(page, USERS.senior.id, buildAdminViewingUser(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    // Open edit form
    await page.getByTestId('legend-edit-button').click()
    await expect(page.getByTestId('legend-form')).toBeVisible()

    // Fill required ФИО field
    await page.getByTestId('legend-input-fullname').fill('Петренко Петро Петрович')

    await page.getByTestId('legend-save-button').click()
    await expect(page.getByText('Легенда сохранена')).toBeVisible()
  })

  test('ADMIN can cancel editing without saving', async ({ asAdmin: page }) => {
    await mockLegendGet(page, USERS.senior.id, 'found')
    await mockUserGet(page, USERS.senior.id, buildAdminViewingUser(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await page.getByTestId('legend-edit-button').click()
    await expect(page.getByTestId('legend-form')).toBeVisible()

    await page.getByTestId('legend-cancel-button').click()
    await expect(page.getByTestId('legend-form')).not.toBeVisible()
    await expect(page.getByTestId('legend-fullname')).toBeVisible()
  })

  test('ADMIN does NOT see legend section on non-SENIOR target (JUNIOR)', async ({
    asAdmin: page,
  }) => {
    await mockUserGet(page, USERS.junior.id, buildAdminViewingUser(USERS.junior))

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // user.role === 'JUNIOR' → legend condition false → section absent
    await expect(page.getByTestId('legend-section')).not.toBeVisible({ timeout: 2000 })
  })
})

// ---------------------------------------------------------------------------
// HR viewing senior profile — editable legend (view==edit)
// ---------------------------------------------------------------------------

test.describe('HR viewing senior profile — editable legend (view==edit)', () => {
  test('HR sees legend section with edit button on senior profile', async ({ asHr: page }) => {
    await mockLegendGet(page, USERS.senior.id, 'found')
    await mockUserGet(page, USERS.senior.id, buildHrViewingSenior(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await expect(page.getByTestId('legend-section')).toBeVisible()
    await expect(page.getByTestId('legend-fullname')).toHaveText('Іванов Іван Іванович')
    // HR now has canEdit=true (view==edit — was read-only in old spec)
    await expect(page.getByTestId('legend-edit-button')).toBeVisible()
  })

  test('HR can cancel editing without saving', async ({ asHr: page }) => {
    await mockLegendGet(page, USERS.senior.id, 'found')
    await mockUserGet(page, USERS.senior.id, buildHrViewingSenior(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await page.getByTestId('legend-edit-button').click()
    await expect(page.getByTestId('legend-form')).toBeVisible()

    await page.getByTestId('legend-cancel-button').click()
    await expect(page.getByTestId('legend-form')).not.toBeVisible()
    await expect(page.getByTestId('legend-fullname')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// JUNIOR viewing senior profile — editable legend (view==edit)
// ---------------------------------------------------------------------------

test.describe('JUNIOR viewing senior profile — editable legend (view==edit)', () => {
  test('JUNIOR sees legend section with edit button on senior profile', async ({
    asJunior: page,
  }) => {
    await mockLegendGet(page, USERS.senior.id, 'found')
    await mockUserGet(page, USERS.senior.id, buildJuniorViewingSenior(USERS.senior))

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await expect(page.getByTestId('legend-section')).toBeVisible()
    await expect(page.getByTestId('legend-fullname')).toHaveText('Іванов Іван Іванович')
    // JUNIOR has canEdit=true (view==edit — was forbidden in old spec)
    await expect(page.getByTestId('legend-edit-button')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// ACCOUNTANT — legend section hidden (fields.legend absent)
// ---------------------------------------------------------------------------

test.describe('ACCOUNTANT — legend section not shown', () => {
  test('ACCOUNTANT does NOT see legend section on senior profile', async ({
    asAdmin: page, // use asAdmin then override /users/:id with accountant-perspective response
  }) => {
    // Reuse asAdmin fixture but respond as if ACCOUNTANT is viewing
    // (fields.legend absent → OverviewTab condition false → no mount → no GET)
    await mockUserGet(page, USERS.senior.id, {
      user: { ...USERS.senior },
      permissions: {
        tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
        actions: [],
        // fields.legend intentionally absent — mirrors ACCOUNTANT server response
        fields: { techStack: true, registrationDate: true, salary: true, share: true },
      },
      data: {},
    })

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    // fields.legend not true → OverviewTab never mounts LegendSection
    await expect(page.getByTestId('legend-section')).not.toBeVisible({ timeout: 2000 })
  })
})

// ---------------------------------------------------------------------------
// Non-SENIOR/DROP target — legend section never shown
// ---------------------------------------------------------------------------

test.describe('Non-SENIOR/DROP target — no legend section', () => {
  test('ADMIN viewing JUNIOR profile does NOT see legend section', async ({ asAdmin: page }) => {
    await mockUserGet(page, USERS.junior.id, buildAdminViewingUser(USERS.junior))

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // user.role === 'JUNIOR' → condition `user.role === 'SENIOR' || user.role === 'DROP'` false
    await expect(page.getByTestId('legend-section')).not.toBeVisible({ timeout: 2000 })
  })

  test('HR viewing JUNIOR profile does NOT see legend section', async ({ asHr: page }) => {
    await mockUserGet(page, USERS.junior.id, {
      user: { ...USERS.junior },
      permissions: {
        tabs: ['overview'],
        actions: [],
        fields: { techStack: true, registrationDate: true },
      },
      data: {},
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await expect(page.getByTestId('legend-section')).not.toBeVisible({ timeout: 2000 })
  })
})
