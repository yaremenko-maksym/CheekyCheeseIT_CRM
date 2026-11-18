/**
 * senior-roles.spec.ts — roles PR 5, Task 5.5.
 *
 * A SENIOR is described by technical roles instead of a three-technology stack
 * (`docs/design/senior-roles-ui.md`, plan `docs/superpowers/plans/2026-11-16-senior-roles.md`).
 * Three forms write them through the shared `RolesSection` (admin `UserDialog`, HR
 * `HrCreateSeniorDialog`, the senior's own `ProfileEditFields`) and the read surfaces render
 * `RoleChips`.
 *
 * Pattern: REAL stack (no `page.route` mocks). `loginViaApi` plants a real JWT cookie and every
 * assertion below is made against the live API, so a backend regression cannot be masked by a
 * fixture — which is the point of test 5 in particular (a mocked route proves nothing about a
 * guard). Needs a running API + web pair against a SCRATCH database, never `crm_db`
 * (`live-db-access.md`); see `tests/fixtures/api-helpers/common.ts` for the four env vars.
 *
 * Seeded SENIORs carry NO technical roles (`seed.ts` never writes the column, whose default is
 * `'{}'`), so they are the plan's "legacy senior" case — the self-edit tests start from an empty
 * section and restore what they found.
 *
 * NOT covered here: "the queue card shows the overlap label for a seeded LEAD" and the card-label
 * half of the mobile test. Both need Task 5.4 (`skillOverlap`), which is not on `origin/main` yet.
 */

import {
  test,
  expect,
  REAL_API_BASE,
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  VALID_USDT_WALLET,
  loginViaApi,
  findUserByEmailViaApi,
} from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
import { SENIOR_ROLES, pickRoles } from './fixtures/senior-roles'

/** One run must not collide with the next: every created senior gets its own address. */
function uniqueEmail(tag: string): string {
  return `e2e.roles5.${tag}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@cheekycheese.dev`
}

/** Archives a user created by a test, so the next run starts from the same state. */
async function archiveUserViaApi(page: import('@playwright/test').Page, id: string): Promise<void> {
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const res = await page.request.delete(`${REAL_API_BASE}/api/users/${id}`)
  expect(res.status(), 'cleanup: archive the created senior').toBeLessThan(400)
}

/** The roles the API currently stores for `email`. */
async function rolesOf(
  page: import('@playwright/test').Page,
  id: string,
): Promise<readonly string[]> {
  const res = await page.request.get(`${REAL_API_BASE}/api/users/${id}`)
  expect(res.status(), `GET /users/${id}`).toBe(200)
  const user = (await res.json()) as { technicalRoles?: readonly string[] }
  return user.technicalRoles ?? []
}

/** Puts a senior's roles back to `roles` through the ADMIN endpoint (test teardown). */
async function setRolesViaApi(
  page: import('@playwright/test').Page,
  id: string,
  roles: readonly string[],
): Promise<void> {
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  // A senior cannot be left with none, so an empty restore goes through nothing: the API would
  // refuse it, and the seeded state is reached by the test's own last removal instead.
  if (roles.length === 0) return
  const res = await page.request.patch(`${REAL_API_BASE}/api/users/${id}`, {
    data: { technicalRoles: [...roles] },
  })
  expect(res.status(), 'teardown: restore the seeded roles').toBeLessThan(400)
}

test.describe('Senior technical roles — forms, surfaces and the backend floor', () => {
  test('ADMIN creates a SENIOR with roles; the users list shows the role chips', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    const email = uniqueEmail('admin')
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/users')

    await expect(page.getByTestId('users-list')).toBeVisible()
    const created = page.waitForResponse(
      (res) =>
        res.url().includes('/api/users') && res.request().method() === 'POST' && res.status() < 400,
    )

    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill(email)
    await page.getByTestId('user-dialog-name').fill('Roles Five E2E')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
    await page.getByTestId('user-dialog-legal-full-name').fill('Ролі П’ять Тестовий')
    await pickRoles(page)
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
    await page.getByTestId('wizard-next-btn').click()

    const body = (await (await created).json()) as { id: string; technicalRoles?: string[] }
    const id = body.id
    try {
      // The API stored exactly what the form collected, in canonical order.
      expect(await rolesOf(page, id)).toEqual([...SENIOR_ROLES])

      // And the list renders one chip per role on that senior's row.
      await page.goto('/users')
      const row = page.getByTestId(`user-row-${id}`)
      await expect(row).toBeVisible()
      for (const role of SENIOR_ROLES) {
        await expect(row.getByTestId(`role-chip-${role}`)).toBeVisible()
      }
    } finally {
      await archiveUserViaApi(page, id)
    }
  })

  test('ADMIN cannot save a SENIOR with no roles: inline error, no request leaves', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/users')
    await expect(page.getByTestId('users-list')).toBeVisible()

    // Counted on the real network: the assertion is that no create request happens at all, which
    // a toast assertion would not prove.
    const posts: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/users(\?|$)/.test(req.url())) posts.push(req.url())
    })

    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill(uniqueEmail('noroles'))
    await page.getByTestId('user-dialog-name').fill('No Roles E2E')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
    await page.getByTestId('user-dialog-legal-full-name').fill('Без Ролей Тестовий')
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
    // Every other field is valid: the roles floor is the only thing that can block the submit.
    await page.getByTestId('wizard-next-btn').click()

    const error = page.getByTestId('roles-section-error')
    await expect(error).toBeVisible()
    // The error names the add control, so a screen reader reaches it from the trigger.
    await expect(page.getByTestId('roles-section-add-trigger')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(posts, 'no create request left the page').toEqual([])
  })

  test('HR creates a senior with roles from the team list', async ({ page }) => {
    const email = uniqueEmail('hr')
    await loginViaApi(page, SEED_EMAILS.hrA)
    await page.goto('/team')

    const created = page.waitForResponse(
      (res) =>
        res.url().includes('/api/users') && res.request().method() === 'POST' && res.status() < 400,
    )
    await page.locator('main').getByRole('button', { name: 'Створити сеньйора' }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill(email)
    await dialog.getByPlaceholder('Іван Іваненко').fill('Сеньйор Ролей')
    await pickRoles(dialog)
    await dialog.getByRole('button', { name: 'Створити', exact: true }).click()

    const body = (await (await created).json()) as { id: string }
    const id = body.id
    try {
      await expect(dialog).toBeHidden()
      // HR's dialog wrote the roles through the real API, not just into a form.
      expect(await rolesOf(page, id)).toEqual([...SENIOR_ROLES])
    } finally {
      await archiveUserViaApi(page, id)
    }
  })

  test('a SENIOR edits own roles on the profile; clearing all roles shows the error', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorC)
    expect(senior, `seed senior ${SEED_EMAILS.seniorC} must exist`).not.toBeNull()
    const id = senior!.id
    const before = await rolesOf(page, id)

    try {
      await loginViaApi(page, SEED_EMAILS.seniorC)
      await page.goto('/profile')
      await expect(page.getByTestId('roles-section')).toBeVisible()

      // Remove whatever the senior starts with, so the add below is the only source of roles.
      for (const role of before) {
        await page.getByTestId(`roles-section-remove-${role}`).click()
      }

      const [role] = SENIOR_ROLES
      const saved = page.waitForResponse(
        (res) =>
          res.url().includes('/api/users/me') &&
          res.request().method() === 'PATCH' &&
          res.status() < 400,
      )
      await pickRoles(page, [role])
      await expect(page.getByTestId(`roles-section-chip-${role}`)).toBeVisible()
      // The debounced autosave reaches the API, and the API stored it.
      await saved
      await expect
        .poll(async () => (await rolesOf(page, id)).join(','), {
          message: 'the autosaved role reaches the database',
        })
        .toBe(role)

      // Clearing the last role is refused in the form itself: the message says it was not saved.
      await page.getByTestId(`roles-section-remove-${role}`).click()
      await expect(page.getByTestId('roles-section-error')).toBeVisible()
      await expect(page.getByTestId(`roles-section-chip-${role}`)).toHaveCount(0)
      // And the stored value is untouched — the pending save was cancelled, not sent empty.
      expect(await rolesOf(page, id)).toEqual([role])
    } finally {
      await setRolesViaApi(page, id, before)
    }
  })

  test('HR PATCH /users/:id with technicalRoles is refused with 403 at the backend', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
    expect(senior, `seed senior ${SEED_EMAILS.seniorA} must exist`).not.toBeNull()
    const id = senior!.id
    const before = await rolesOf(page, id)

    // A real request under the HR session — no mocked route, so this is the guard's own answer.
    await loginViaApi(page, SEED_EMAILS.hrA)
    const res = await page.request.patch(`${REAL_API_BASE}/api/users/${id}`, {
      data: { technicalRoles: ['DEVOPS_ENGINEER'] },
    })
    expect(res.status()).toBe(403)

    // The refusal is a refusal: nothing was written on the way out.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    expect(await rolesOf(page, id)).toEqual([...before])
  })

  test.describe('mobile 390px', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('RolesSection is usable by tap and nothing overflows horizontally', async ({ page }) => {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorC)
      expect(senior, `seed senior ${SEED_EMAILS.seniorC} must exist`).not.toBeNull()
      const id = senior!.id
      const before = await rolesOf(page, id)

      try {
        await loginViaApi(page, SEED_EMAILS.seniorC)
        await page.goto('/profile')
        await expect(page.getByTestId('roles-section')).toBeVisible()
        for (const role of before) {
          await page.getByTestId(`roles-section-remove-${role}`).tap()
        }

        // Add by tap: the popover, the search list and the row all have to work under touch.
        const [role] = SENIOR_ROLES
        await pickRoles(page, [role], { tap: true })
        const chip = page.getByTestId(`roles-section-chip-${role}`)
        await expect(chip).toBeVisible()
        // Design spec §5.8 / a11y 2.5.8: the remove target is 24px or more on touch.
        const box = await page.getByTestId(`roles-section-remove-${role}`).boundingBox()
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(24)
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(24)

        // Nothing the section renders pushes the page sideways at 390px.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow, 'no horizontal overflow at 390px').toBeLessThanOrEqual(0)

        // Remove by tap: the chip goes, and the error appears because none are left.
        await page.getByTestId(`roles-section-remove-${role}`).tap()
        await expect(chip).toHaveCount(0)
        await expect(page.getByTestId('roles-section-error')).toBeVisible()
      } finally {
        await setRolesViaApi(page, id, before)
      }
    })
  })
})
