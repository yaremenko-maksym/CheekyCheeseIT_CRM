/**
 * dashboard-russian-strings.spec.ts — task-e2e-fragile-points-audit.
 *
 * Regression catcher for English strings on the dashboard placeholder.
 * The dashboard widgets (`/crm` root + `/crm/dashboard`) were originally
 * scaffolded with English copy («Active Candidates», «Recent Candidates»,
 * «Connect DB» hints) and were translated to Russian in PR #66.
 *
 * Per project policy (CLAUDE.md «Язык UI: Русский»), all interface text
 * must be Russian. A reverted translation slips silently because the
 * placeholder cards render fine — only a human spot-check catches it.
 *
 * This spec asserts:
 *   1. `/crm/dashboard` for each non-DROP role contains the Russian
 *      labels («Активных проектов», «Сотрудников», etc.) and does NOT
 *      contain English placeholders.
 *   2. `/crm` (root) for each non-DROP role contains «Активные кандидаты»,
 *      «Открытые вакансии», «Найм за месяц», etc.
 *   3. None of these pages contain «Active Candidates», «Recent Candidates»,
 *      «Connect DB», or other English leftovers.
 *
 * Mock-based using the fixture authentication. DROP is intentionally
 * excluded because the dashboard pages redirect DROP to /crm/profile.
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

const RU_INDEX_TOKENS = [
  'Активные кандидаты',
  'Открытые вакансии',
  'Найм за месяц',
  'Среднее время найма',
  'Дашборд',
  'Последние кандидаты',
  'Роли команды',
]

test.describe('Dashboard placeholder — Russian-only copy', () => {
  for (const role of ['Admin', 'Senior', 'Hr', 'Junior'] as const) {
    test(`/crm/dashboard for ${role.toUpperCase()} has Russian copy and NO English leftovers`, async ({
      asAdmin,
      asSenior,
      asHr,
      asJunior,
    }) => {
      const page =
        role === 'Admin'
          ? asAdmin
          : role === 'Senior'
            ? asSenior
            : role === 'Hr'
              ? asHr
              : asJunior

      await page.goto('/crm/dashboard')
      // Wait for the page to settle (motion staggers fade-in).
      const main = page.locator('main')
      await expect(main).toBeVisible({ timeout: 8_000 })

      // All RU tokens present.
      for (const token of RU_DASHBOARD_TOKENS) {
        await expect(
          main.getByText(token, { exact: false }).first(),
          `Expected RU token «${token}» on /crm/dashboard for ${role}`,
        ).toBeVisible({ timeout: 6_000 })
      }

      // Snapshot the rendered text — any English leftovers in the blocklist
      // is an immediate fail. Use innerText to avoid matching against
      // hidden / ARIA-only text.
      const mainText = (await main.innerText()).replace(/\s+/g, ' ')
      for (const enRegex of ENGLISH_BLOCKLIST) {
        expect(
          enRegex.test(mainText),
          `Forbidden English token ${enRegex} found on /crm/dashboard for ${role}`,
        ).toBe(false)
      }
    })

    test(`/crm root for ${role.toUpperCase()} has Russian copy and NO English leftovers`, async ({
      asAdmin,
      asSenior,
      asHr,
      asJunior,
    }) => {
      const page =
        role === 'Admin'
          ? asAdmin
          : role === 'Senior'
            ? asSenior
            : role === 'Hr'
              ? asHr
              : asJunior

      await page.goto('/crm')
      const main = page.locator('main')
      await expect(main).toBeVisible({ timeout: 8_000 })

      // All RU tokens present.
      for (const token of RU_INDEX_TOKENS) {
        await expect(
          main.getByText(token, { exact: false }).first(),
          `Expected RU token «${token}» on /crm root for ${role}`,
        ).toBeVisible({ timeout: 6_000 })
      }

      const mainText = (await main.innerText()).replace(/\s+/g, ' ')
      for (const enRegex of ENGLISH_BLOCKLIST) {
        expect(
          enRegex.test(mainText),
          `Forbidden English token ${enRegex} found on /crm root for ${role}`,
        ).toBe(false)
      }
    })
  }
})
