import { devices } from '@playwright/test'
import { test, expect, USERS, mockAuthAs } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

/**
 * task-crm-tab-distinguishable — AC1/AC2 (E2E companion to the source-level
 * regression guard in apps/web/app/__tests__/document-title.test.ts).
 *
 * Mobile browser tabs truncate the title from the left edge. Before this
 * task, the CRM tab ("CheekyCheeseIT CRM") and the landing tab
 * ("CheekyCheeseIT — AI, EdTech, E-Commerce") both truncated to the same
 * "CheekyCheese…" prefix — indistinguishable in the tab strip/switcher.
 * "CRM CheekyCheeseIT" fixes that by diverging in the first characters.
 *
 * Mobile profile (Pixel 5): the reported issue is specifically about a
 * mobile browser's tab UI, and the task explicitly asks to verify in
 * mobile mode (real viewport + touch + UA), not just a narrow desktop
 * window.
 */
test.use({ ...devices['Pixel 5'] })

const CRM_TITLE = 'CRM CheekyCheeseIT'

test.describe('CRM tab title (task-crm-tab-distinguishable)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
  })

  test('AC1: title starts with "CRM" on first load', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(CRM_TITLE)
    expect(await page.title()).toMatch(/^CRM/)
  })

  test('AC2: title does not reset across client-side navigation between sections', async ({
    page,
  }) => {
    // task-i18n-stage3a (Task 1), SPEC-H-1: `nav-sidebar.tsx` is migrated —
    // nav link names are `uk` catalog entries, not the pre-migration
    // Russian literal this test used to click by.
    const uk = await loadMessages('uk')
    await page.goto('/')
    await expect(page).toHaveTitle(CRM_TITLE)

    // Client-side navigation via the mobile Sheet nav (burger → link click) —
    // NOT page.goto(), which would just re-read index.html on every call and
    // could never catch a route component that calls `document.title = ...`.
    const burger = page.getByRole('button', { name: assertInCatalog(uk, 'Відкрити меню') })
    await burger.click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await sheet.getByRole('link', { name: assertInCatalog(uk, 'Фінанси') }).click()

    await expect(page).toHaveURL(/\/finance/)
    await expect(page).toHaveTitle(CRM_TITLE)

    await burger.click()
    await expect(sheet).toBeVisible()
    await sheet.getByRole('link', { name: assertInCatalog(uk, 'Дашборд') }).click()

    await expect(page).toHaveURL(/\/$/)
    await expect(page).toHaveTitle(CRM_TITLE)
  })
})
