/**
 * dashboard-russian-strings.spec.ts — task-e2e-fragile-points-audit.
 *
 * Regression catcher for English strings on the dashboard.
 * The dashboard widgets were originally scaffolded with English copy
 * («Active Candidates», «Recent Candidates», «Connect DB» hints) and were
 * translated to Russian in PR #66.
 *
 * Dashboard consolidation: the role-dispatch dashboard now lives ONLY at the
 * CRM root `/` (index.tsx); the separate `/dashboard` route and the old
 * generic candidates/vacancies placeholder were removed. ADMIN/SENIOR see the
 * generic dashboard; HR sees HRDashboard; DROP/ACCOUNTANT/JUNIOR have their own
 * surfaces and are excluded here (DROP/JUNIOR redirect off /crm; ACCOUNTANT hub
 * is covered by accountant-dashboard.spec).
 *
 * Per project policy (CLAUDE.md «Язык UI: Русский»), all interface text
 * must be Russian. A reverted translation slips silently because the
 * placeholder cards render fine — only a human spot-check catches it.
 *
 * This spec asserts, for each covered role on `/`:
 *   1. The Russian dashboard labels are present.
 *   2. None of the pages contain «Active Candidates», «Recent Candidates»,
 *      «Connect DB», or other English leftovers.
 *
 * NOTE: each test destructures EXACTLY ONE auth fixture. All `asX` fixtures
 * share the same `page` (they call mockAuthAs on it), so destructuring more
 * than one in a single test silently re-authenticates the page as the
 * last-resolved role — separate per-role tests avoid that trap.
 *
 * Mock-based using the fixture authentication.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const ENGLISH_BLOCKLIST = [
  /Active Candidates/i,
  /Recent Candidates/i,
  /Connect DB/i,
  /Open Positions/i,
  /Hires this month/i,
  /Average time to hire/i,
  /Active Projects/i,
  /Employees/i,
  /Transactions/i, // EN noun; RU equivalent is «Транзакций»
  /Welcome to/i, // catches «Welcome to CheekyCheeseIT»
]

const RU_DASHBOARD_TOKENS = [
  'Активных проектов',
  'Сотрудников',
  'Транзакций',
  'Собеседований',
  'Дашборд',
]

// HR renders HRDashboard (рекрутинг хаб) on /crm instead of the generic
// dashboard — assert its own RU copy. Russian-only + checked against the same
// English blocklist below.
const RU_HR_DASHBOARD_TOKENS = [
  'Дашборд',
  'Рекрутинг хаб HR-менеджера',
  'Открытые собеседования',
  'Нанято за месяц',
]

/**
 * Navigate to /crm, assert all expected RU tokens are visible and no English
 * leftover from the blocklist appears in the dashboard <main>.
 */
async function assertDashboardRu(page: Page, role: string, expectedTokens: string[]) {
  await page.goto('/')
  // HRDashboard renders its own nested <main data-testid="hr-dashboard-hub">,
  // so scope to the OUTER layout <main> (.first()) — it contains the hub too.
  const main = page.locator('main').first()
  await expect(main).toBeVisible({ timeout: 8_000 })

  for (const token of expectedTokens) {
    await expect(
      main.getByText(token, { exact: false }).first(),
      `Expected RU token «${token}» on /crm for ${role}`,
    ).toBeVisible({ timeout: 6_000 })
  }

  // Snapshot the rendered text — any English leftovers in the blocklist is an
  // immediate fail. Use innerText to avoid matching hidden / ARIA-only text.
  const mainText = (await main.innerText()).replace(/\s+/g, ' ')
  for (const enRegex of ENGLISH_BLOCKLIST) {
    expect(
      enRegex.test(mainText),
      `Forbidden English token ${enRegex} found on /crm for ${role}`,
    ).toBe(false)
  }
}

test.describe('Dashboard — Russian-only copy (consolidated /crm root)', () => {
  test('/crm for ADMIN has Russian copy and NO English leftovers', async ({ asAdmin: page }) => {
    await assertDashboardRu(page, 'ADMIN', RU_DASHBOARD_TOKENS)
  })

  test('/crm for SENIOR has Russian copy and NO English leftovers', async ({ asSenior: page }) => {
    await assertDashboardRu(page, 'SENIOR', RU_DASHBOARD_TOKENS)
  })

  test('/crm for HR has Russian copy and NO English leftovers', async ({ asHr: page }) => {
    await assertDashboardRu(page, 'HR', RU_HR_DASHBOARD_TOKENS)
  })
})
