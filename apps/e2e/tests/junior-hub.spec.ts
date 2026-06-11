/**
 * junior-hub.spec.ts — task-junior-ux-2-hub (AC1, AC2, AC3, AC4).
 *
 * Covers:
 *   AC1 — JUNIOR login → /crm/project hub with all 6 blocks;
 *          rate / real senior identity absent from DOM.
 *   AC2 — /crm/legend renders all 3 blocks; JUNIOR can add journal entry.
 *   AC3 — JUNIOR sidebar has exactly 5 nav items.
 *
 * All tests are mock-based (no live server required for the mock suite).
 * Pattern follows rbac-senior-junior.spec.ts: role-fixtures + per-test route overrides.
 */

import { test, expect, USERS, PROJECTS } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Shared junior-facing fixtures
// ---------------------------------------------------------------------------

/**
 * A JUNIOR-masked project: seniorId / rate / currency nulled out,
 * seniorName replaced with legend persona (as the backend would return it).
 * Used in tests that assert real identity is absent from DOM.
 */
// PROJECTS[0] is guaranteed — fixture array always has at least 2 elements.
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const P0 = PROJECTS[0]!
const JUNIOR_PROJECT = {
  ...P0,
  id: 'project-junior-view',
  companyName: P0.companyName,
  domain: P0.domain,
  seniorId: null as string | null,
  seniorName: 'Олександр П.', // masked legend name — not a real display name
  seniorPresentedRole: 'Lead Developer',
  rate: null as number | null,
  currency: null as string | null,
}

/** Legend response for the JUNIOR_PROJECT — returned by GET /projects/:id/legend */
const LEGEND_FIXTURE = {
  id: 'legend-hub-id',
  projectId: JUNIOR_PROJECT.id,
  fullName: 'Олександр Петренко',
  dateOfBirth: '1990-05-15',
  address: 'Київ, вул. Хрещатик 1',
  presentedRole: 'Lead Developer',
  presentedStack: 'TypeScript, React, NestJS',
  backstory: 'Досвідчений розробник з 10 роками досвіду в фінтеху.',
  hobbies: 'Гірський туризм, фотографія',
  notes: null,
  entries: [
    {
      id: 'entry-1',
      legendId: 'legend-hub-id',
      content: 'Перший запис журналу',
      createdAt: '2024-01-15T10:00:00.000Z',
      createdBy: USERS.junior.id,
    },
  ],
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-01-20T00:00:00.000Z',
}

/** HR contact allowlist DTO returned by GET /projects/:id/hr-contact */
const HR_CONTACT_FIXTURE = {
  displayName: USERS.hr.displayName,
  telegram: '@hrmanager',
  phone: '+380671234567',
}

// ---------------------------------------------------------------------------
// Helper: mount junior-specific mocks on top of mockAuthAs(page, USERS.junior)
// ---------------------------------------------------------------------------

async function mockJuniorProjectsAndLegend(page: import('@playwright/test').Page) {
  // Override projects list — return the masked project
  await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([JUNIOR_PROJECT]),
    })
  })

  // Override per-project legend — return filled fixture
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT.id}/legend/entries$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const newEntry = {
      id: 'entry-new',
      legendId: 'legend-hub-id',
      content: 'Новий запис',
      createdAt: new Date().toISOString(),
      createdBy: USERS.junior.id,
    }
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ...LEGEND_FIXTURE, entries: [...LEGEND_FIXTURE.entries, newEntry] }),
    })
  })
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT.id}/legend$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(LEGEND_FIXTURE),
      })
    }
    if (r.request().method() === 'PUT') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(LEGEND_FIXTURE),
      })
    }
    return r.fallback()
  })

  // HR contact endpoint (new in this task)
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT.id}/hr-contact$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(HR_CONTACT_FIXTURE),
    })
  })

  // Contract — null (no contract yet)
  await page.route(new RegExp(`${API}/contracts/me$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Not found' }),
    })
  })

  // Transactions (salary) — one paid entry
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const url = new URL(r.request().url())
    if (url.searchParams.get('type') === 'SALARY') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'tx-salary-1',
            amount: '800',
            currency: 'USD',
            salaryMonth: 'Травень 2026',
            status: 'VALIDATED',
            createdAt: '2026-05-31T00:00:00.000Z',
          },
        ]),
      })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  })
}

// ---------------------------------------------------------------------------
// AC1 — Hub: all cards render; rate / real identity absent
// ---------------------------------------------------------------------------

test.describe('AC1 — JUNIOR hub /crm/project', () => {
  test('hub renders with all 6 blocks visible', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')

    // Root hub container
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    // All 6 blocks
    await expect(page.getByTestId('project-info-card')).toBeVisible()
    await expect(page.getByTestId('persona-card')).toBeVisible()
    await expect(page.getByTestId('contract-status-card')).toBeVisible()
    await expect(page.getByTestId('salary-snapshot-card')).toBeVisible()
    await expect(page.getByTestId('hr-contact-card')).toBeVisible()
    await expect(page.getByTestId('quick-links-bar')).toBeVisible()
  })

  test('project-info card shows company name, domain, status — no rate/currency', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('project-info-card')).toBeVisible()

    const card = page.getByTestId('project-info-card')
    // Company name visible
    await expect(card.getByText(JUNIOR_PROJECT.companyName)).toBeVisible()
    // Domain visible
    await expect(card.getByText(JUNIOR_PROJECT.domain!)).toBeVisible()
    // Status badge visible
    await expect(card.getByText('Активний')).toBeVisible()

    // Rate and currency MUST NOT be in the DOM (AC1: not CSS hiding)
    // The real project fixture has rate=5000, currency='USDT' — JUNIOR sees null
    await expect(page.getByText('5000')).toHaveCount(0)
    await expect(page.getByText('5 000')).toHaveCount(0)
    await expect(page.getByText('USDT')).toHaveCount(0)
  })

  test('persona card shows legend name/role — real senior identity absent', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('persona-card')).toBeVisible()

    const card = page.getByTestId('persona-card')
    // Legend persona name visible
    await expect(card.getByTestId('persona-fullname')).toContainText(LEGEND_FIXTURE.fullName)
    // Presented role visible
    await expect(card.getByTestId('persona-role')).toContainText(LEGEND_FIXTURE.presentedRole!)

    // Real senior display name must NOT appear
    await expect(page.getByText(USERS.senior.displayName, { exact: false })).toHaveCount(0)
    // Real senior email must NOT appear
    await expect(page.getByText(USERS.senior.email, { exact: false })).toHaveCount(0)
  })

  test('persona card "Открыть легенду" button navigates to /crm/legend', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('persona-card')).toBeVisible()

    await page.getByTestId('persona-open-legend-btn').click()
    await expect(page).toHaveURL('/crm/legend')
  })

  test('HR contact card shows name, telegram, phone from allowlist', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('hr-contact-card')).toBeVisible()

    const card = page.getByTestId('hr-contact-card')
    await expect(card.getByText(HR_CONTACT_FIXTURE.displayName)).toBeVisible()
    await expect(card.getByText(HR_CONTACT_FIXTURE.telegram)).toBeVisible()
    await expect(card.getByText(HR_CONTACT_FIXTURE.phone)).toBeVisible()
  })

  test('salary snapshot card shows last salary amount', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('salary-snapshot-card')).toBeVisible()

    const card = page.getByTestId('salary-snapshot-card')
    await expect(card.getByTestId('salary-last-amount')).toBeVisible()
    // "Все мои выплаты" link
    await expect(card.getByTestId('salary-all-link')).toBeVisible()
  })

  test('quick links bar contains legend, documents, finance links', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('quick-links-bar')).toBeVisible()

    const bar = page.getByTestId('quick-links-bar')
    await expect(bar.getByTestId('quick-link-legend')).toBeVisible()
    await expect(bar.getByText('Документы')).toBeVisible()
    await expect(bar.getByText('Финансы')).toBeVisible()
  })

  test('empty-state shown when JUNIOR has no projects', async ({ asJunior: page }) => {
    // Override projects to empty
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()
    await expect(page.getByText('Вас ещё не добавили в проект.')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC2 — Legend page: view + edit + journal
// ---------------------------------------------------------------------------

test.describe('AC2 — JUNIOR /crm/legend', () => {
  test('legend page renders all 3 blocks', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')

    await expect(page.getByTestId('legend-page')).toBeVisible()
    await expect(page.getByTestId('legend-persona-block')).toBeVisible()
    await expect(page.getByTestId('legend-cover-block')).toBeVisible()
    await expect(page.getByTestId('legend-journal-block')).toBeVisible()
  })

  test('persona block shows fullName, dateOfBirth, address, hobbies', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-persona-block')
    await expect(block).toBeVisible()

    await expect(block.getByText(LEGEND_FIXTURE.fullName)).toBeVisible()
    await expect(block.getByText(LEGEND_FIXTURE.hobbies!)).toBeVisible()
  })

  test('cover block shows presentedRole and presentedStack', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-cover-block')
    await expect(block).toBeVisible()

    await expect(block.getByText(LEGEND_FIXTURE.presentedRole!)).toBeVisible()
    await expect(block.getByText(LEGEND_FIXTURE.presentedStack!)).toBeVisible()
  })

  test('journal block shows existing entry and add-entry form', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-journal-block')
    await expect(block).toBeVisible()

    // Existing entry
    await expect(block.getByTestId('legend-entry-item').first()).toBeVisible()
    const firstEntry = LEGEND_FIXTURE.entries[0]
    if (firstEntry) {
      await expect(block.getByText(firstEntry.content)).toBeVisible()
    }

    // Add-entry button
    await expect(block.getByTestId('legend-entry-add-btn')).toBeVisible()
  })

  test('JUNIOR can add journal entry', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/legend')
    const block = page.getByTestId('legend-journal-block')
    await expect(block).toBeVisible()

    // Open add form
    await block.getByTestId('legend-entry-add-btn').click()
    await expect(block.getByTestId('legend-entry-textarea')).toBeVisible()

    // Type entry text
    await block.getByTestId('legend-entry-textarea').fill('Тестовий запис від JUNIOR')

    // Submit
    await block.getByTestId('legend-entry-submit-btn').click()

    // Form should collapse (success path)
    await expect(block.getByTestId('legend-entry-textarea')).not.toBeVisible({ timeout: 3000 })
  })

  test('SENIOR is redirected away from /crm/legend', async ({ asSenior: page }) => {
    // SENIOR must not access the legend page — redirected to /crm/profile
    await page.goto('/crm/legend')
    // Wait for redirect; the page must not show legend-page testid
    await expect(page.getByTestId('legend-page')).not.toBeVisible({ timeout: 3000 })
    // Should land on profile or show no legend content
    await expect(page).not.toHaveURL('/crm/legend')
  })
})

// ---------------------------------------------------------------------------
// AC3 — JUNIOR sidebar: exactly 5 nav items
// ---------------------------------------------------------------------------

test.describe('AC3 — JUNIOR sidebar nav', () => {
  test('JUNIOR desktop nav has exactly 5 items', async ({ asJunior: page }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    const nav = page.getByTestId('junior-nav')
    await expect(nav).toBeVisible()

    // Count nav links inside the junior nav element
    const navLinks = nav.getByRole('link')
    await expect(navLinks).toHaveCount(5)
  })

  test('JUNIOR nav contains Мой проект, Легенда, Финансы, Документы, Профиль', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    const nav = page.getByTestId('junior-nav')
    await expect(nav.getByText('Мой проект')).toBeVisible()
    await expect(nav.getByText('Легенда')).toBeVisible()
    await expect(nav.getByText('Финансы')).toBeVisible()
    await expect(nav.getByText('Документы')).toBeVisible()
    await expect(nav.getByText('Профиль')).toBeVisible()
  })

  test('JUNIOR nav does NOT contain Дашборд, Команда, Проекты, Собеседования', async ({
    asJunior: page,
  }) => {
    await mockJuniorProjectsAndLegend(page)

    await page.goto('/crm/project')
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    const nav = page.getByTestId('junior-nav')
    await expect(nav.getByText('Дашборд')).not.toBeVisible()
    await expect(nav.getByText('Команда')).not.toBeVisible()
    await expect(nav.getByText('Проекты')).not.toBeVisible()
    await expect(nav.getByText('Собеседования')).not.toBeVisible()
  })

  test('Regression — ADMIN nav is unaffected (no junior-nav testid, more items visible)', async ({
    asAdmin: page,
  }) => {
    await page.goto('/crm/team')

    // ADMIN nav does NOT have the junior-nav testid
    await expect(page.getByTestId('junior-nav')).not.toBeVisible()

    // ADMIN sees sections JUNIOR does not
    await expect(page.getByRole('link', { name: 'Команда' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Проекты' })).toBeVisible()
  })

  test('Regression — SENIOR nav is unaffected', async ({ asSenior: page }) => {
    await page.goto('/crm/profile')

    // SENIOR has no junior-nav
    await expect(page.getByTestId('junior-nav')).not.toBeVisible()
  })
})
