/**
 * dashboard-russian-strings.spec.ts — task-e2e-fragile-points-audit.
 *
 * Regression catcher for English strings on the dashboard.
 * The dashboard widgets were originally scaffolded with English copy
 * («Active Candidates», «Recent Candidates», «Connect DB» hints) and were
 * translated to Russian in PR #66.
 *
 * Dashboard consolidation: the role-dispatch dashboard now lives ONLY at the
 * CRM root `/crm` (index.tsx); the separate `/crm/dashboard` route and the old
 * generic candidates/vacancies placeholder were removed. ADMIN/SENIOR see the
 * generic dashboard; HR sees HRDashboard; DROP/ACCOUNTANT/JUNIOR have their own
 * surfaces and are excluded here (DROP/JUNIOR redirect off /crm; ACCOUNTANT hub
 * is covered by accountant-dashboard.spec).
 *
 * Per project policy (CLAUDE.md «Язык UI: Русский»), all interface text
 * must be Russian. A reverted translation slips silently because the
 * placeholder cards render fine — only a human spot-check catches it.
 *
 * This spec asserts, for each covered role on `/crm`:
 *   1. The Russian dashboard labels are present.
 *   2. None of the pages contain «Active Candidates», «Recent Candidates»,
 *      «Connect DB», or other English leftovers.
 *
 * Mock-based using the fixture authentication.
 */

import { test, expect } from './fixtures'

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

test.describe('Dashboard — Russian-only copy (consolidated /crm root)', () => {
  for (const role of ['Admin', 'Senior', 'Hr'] as const) {
    test(`/crm for ${role.toUpperCase()} has Russian copy and NO English leftovers`, async ({
      asAdmin,
      asSenior,
      asHr,
    }) => {
      const page = role === 'Admin' ? asAdmin : role === 'Senior' ? asSenior : asHr

      await page.goto('/crm')
      // Wait for the page to settle (motion staggers fade-in).
      const main = page.locator('main')
      await expect(main).toBeVisible({ timeout: 8_000 })

      // HR renders its own role hub (HRDashboard) instead of the generic dashboard.
      const expectedTokens = role === 'Hr' ? RU_HR_DASHBOARD_TOKENS : RU_DASHBOARD_TOKENS

      // All RU tokens present.
      for (const token of expectedTokens) {
        await expect(
          main.getByText(token, { exact: false }).first(),
          `Expected RU token «${token}» on /crm for ${role}`,
        ).toBeVisible({ timeout: 6_000 })
      }

      // Snapshot the rendered text — any English leftovers in the blocklist
      // is an immediate fail. Use innerText to avoid matching against
      // hidden / ARIA-only text.
      const mainText = (await main.innerText()).replace(/\s+/g, ' ')
      for (const enRegex of ENGLISH_BLOCKLIST) {
        expect(
          enRegex.test(mainText),
          `Forbidden English token ${enRegex} found on /crm for ${role}`,
        ).toBe(false)
      }
    })
  }
})
