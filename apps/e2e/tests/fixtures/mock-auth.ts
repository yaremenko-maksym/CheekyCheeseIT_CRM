import { test as base, expect, type Page } from '@playwright/test'
import { loadMessages, assertInCatalog } from '../../fixtures/catalog'
import { USERS, type MockUser } from './mock-data'
import { mockCoreRoutes } from './mock-routes-core'
import { mockProjectRoutes } from './mock-routes-projects'
import { mockFinanceRoutes } from './mock-routes-finance'
import { mockMiscRoutes } from './mock-routes-misc'

// ---------------------------------------------------------------------------
// Mock all API calls for a given authenticated user
// ---------------------------------------------------------------------------
// `user: MockUser` (see the type's own doc comment above) — not a plain
// `(typeof USERS)[keyof typeof USERS] & SessionUserShape`: every `USERS`
// entry pins `locale: 'uk' as const`, and that plain intersection would
// force `locale` down to the literal `'uk'`, rejecting the exact override
// this needs to support — `{ ...USERS.senior, locale: 'en' }` — for the
// locale-activation cases in `auth.spec.ts` (task-i18n-stage2, Task 6).
export async function mockAuthAs(page: Page, user: MockUser) {
  // All routes use origin-agnostic patterns (see API_GLOB / API_RE above)
  // so mocks match regardless of dev (:3001), preview (:3010), or CI.

  await mockCoreRoutes(page, user)
  await mockProjectRoutes(page, user)
  await mockFinanceRoutes(page, user)
  await mockMiscRoutes(page, user)
}

// ---------------------------------------------------------------------------
// Custom fixture types
// ---------------------------------------------------------------------------
type Fixtures = {
  asAdmin: Page
  asSenior: Page
  asHr: Page
  asJunior: Page
  /** Drop role - phase 1: DROP-authenticated page for AC8 RBAC sweep. */
  asDrop: Page
}

/** The first-visit bookmarklet dialog (/job-queue, HR) would cover what a spec clicks. */
export const BOOKMARKLET_USED = () => {
  try {
    localStorage.setItem('crm.bookmarkletUsed', '1')
  } catch {
    // an opaque-origin frame has no storage; only the CRM page needs the flag
  }
}

export const test = base.extend<Fixtures>({
  // a spec about the dialog itself removes the flag with a page init script of its own
  context: async ({ context }, use) => {
    await context.addInitScript(BOOKMARKLET_USED)
    await use(context)
  },
  asAdmin: async ({ page }, use) => {
    await mockAuthAs(page, USERS.admin)
    await use(page)
  },
  asSenior: async ({ page }, use) => {
    await mockAuthAs(page, USERS.senior)
    await use(page)
  },
  asHr: async ({ page }, use) => {
    await mockAuthAs(page, USERS.hr)
    await use(page)
  },
  asJunior: async ({ page }, use) => {
    await mockAuthAs(page, USERS.junior)
    await use(page)
  },
  asDrop: async ({ page }, use) => {
    await mockAuthAs(page, USERS.drop)
    await use(page)
  },
})

export { expect }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// i18n-3d-pr3 (fix-round PR #734, FIX-SPEC-M-1): both current call sites
// (finance.spec.ts, CreateTransactionDialog + AdminEditTransactionDialog
// cancel buttons) are migrated to uk — this shared helper is `getByRole`
// name-matched. The literal is loaded from the compiled catalog via
// `assertInCatalog` (not hardcoded) so a copy edit to «Скасувати» fails loud
// here instead of drifting silently (only these two callers exist — `grep
// dismissDialog` across apps/e2e/tests confirms it).
export async function dismissDialog(page: Page) {
  const uk = await loadMessages('uk')
  await page.getByRole('button', { name: assertInCatalog(uk, 'Скасувати') }).click()
}
