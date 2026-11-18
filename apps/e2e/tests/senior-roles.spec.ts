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
 * `'{}'`), so they are the plan's "legacy senior" case. The API refuses to put a senior back to
 * none (`assertSeniorRoleFloor`), so the self-edit tests do not try to restore that: each sets its
 * own `BASELINE_ROLES` first and restores it afterwards, and each uses a senior of its own
 * (`fullyParallel: true` lets two tests of this file run at once).
 *
 * NOT covered here: "the queue card shows the overlap label for a seeded LEAD" and the card-label
 * half of the mobile test. Task 5.4 has since landed on this branch, so both are writable now:
 * the indicator rows carry `job-queue-senior-overlap-${seniorId}` and
 * `job-queue-senior-no-resume-${seniorId}`, and the label reads «{matched} з {total} навичок».
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

/**
 * The state a profile test starts from and restores. Set, never read: a seeded senior holds none
 * (the plan's legacy case) and the API refuses to put a senior back to none, so a test that read
 * the starting state would inherit whatever the previous run left. Outside `SENIOR_ROLES`, so the
 * role a test adds is unambiguous.
 */
const BASELINE_ROLES = ['DEVOPS_ENGINEER'] as const

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
  // `GET /users/:id` answers the profile view `{ user, permissions, data }` (user-profile.service),
  // so the roles live one level down; reading the root silently yields `[]` for every viewer.
  const view = (await res.json()) as { user?: { technicalRoles?: readonly string[] } }
  return view.user?.technicalRoles ?? []
}

/** Puts a senior's roles back to `roles` through the ADMIN endpoint (test teardown). */
async function setRolesViaApi(
  page: import('@playwright/test').Page,
  id: string,
  roles: readonly string[],
): Promise<void> {
  // The API refuses to leave a SENIOR with none (`assertSeniorRoleFloor`), so every caller passes a
  // non-empty set; a silent no-op here would let a test start from whatever the previous one left.
  expect(roles.length, 'a senior is never restored to zero roles').toBeGreaterThan(0)
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const res = await page.request.patch(`${REAL_API_BASE}/api/users/${id}`, {
    data: { technicalRoles: [...roles] },
  })
  expect(res.status(), 'teardown: restore the seeded roles').toBeLessThan(400)
}

/**
 * Picks an HR in the admin create wizard. `hrIds` is required and the seed has several HRs, so none
 * is pre-selected: without this the wizard blocks on "Виберіть щонайменше одного HR" — which would
 * also make the "no request leaves" test below pass for the wrong reason.
 * The option's own `onSelect` closes the popover (`HrChipsField.tsx`), so nothing is dismissed here.
 */
async function pickHr(page: import('@playwright/test').Page, hrId: string): Promise<void> {
  await page.getByTestId('user-dialog-hr-add-trigger').click()
  await page.getByTestId(`user-dialog-hr-option-${hrId}`).click()
  await expect(page.getByTestId(`user-dialog-hr-chip-${hrId}`)).toBeVisible()
}

/** A create request, matched on the collection endpoint only (`/api/users/<id>` is a PATCH target). */
function createRequests(page: import('@playwright/test').Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/users(\?|$)/.test(req.url())) seen.push(req.url())
  })
  return seen
}

test.describe('Senior technical roles — forms, surfaces and the backend floor', () => {
  test('ADMIN creates a SENIOR with roles; the users list shows the role chips', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    const email = uniqueEmail('admin')
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const hr = await findUserByEmailViaApi(page, SEED_EMAILS.hrA)
    expect(hr, `seed HR ${SEED_EMAILS.hrA} must exist`).not.toBeNull()
    await page.goto('/users')

    await expect(page.getByTestId('users-list')).toBeVisible()
    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill(email)
    await page.getByTestId('user-dialog-name').fill('Roles Five E2E')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
    await page.getByTestId('user-dialog-legal-full-name').fill('Ролі П’ять Тестовий')
    await pickRoles(page)
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
    await pickHr(page, hr!.id)

    const created = page.waitForResponse(
      (res) =>
        /\/api\/users(\?|$)/.test(res.url()) &&
        res.request().method() === 'POST' &&
        res.status() < 400,
    )
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
    const hr = await findUserByEmailViaApi(page, SEED_EMAILS.hrA)
    expect(hr, `seed HR ${SEED_EMAILS.hrA} must exist`).not.toBeNull()
    await page.goto('/users')
    await expect(page.getByTestId('users-list')).toBeVisible()

    // Counted on the real network: the assertion is that no create request happens at all, which
    // a toast assertion would not prove.
    const posts = createRequests(page)

    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill(uniqueEmail('noroles'))
    await page.getByTestId('user-dialog-name').fill('No Roles E2E')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
    await page.getByTestId('user-dialog-legal-full-name').fill('Без Ролей Тестовий')
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
    await pickHr(page, hr!.id)
    // Every other required field is filled — including the HR the wizard also demands — so the
    // roles floor is the only thing left that can block the submit.
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

    await page.locator('main').getByRole('button', { name: 'Створити сеньйора' }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill(email)
    await dialog.getByPlaceholder('Іван Іваненко').fill('Сеньйор Ролей')
    await pickRoles(dialog)

    const created = page.waitForResponse(
      (res) =>
        /\/api\/users(\?|$)/.test(res.url()) &&
        res.request().method() === 'POST' &&
        res.status() < 400,
    )
    await dialog.getByRole('button', { name: 'Створити', exact: true }).click()

    const body = (await (await created).json()) as { id: string }
    const id = body.id
    try {
      await expect(dialog).toBeHidden()
      // HR's dialog wrote the roles through the real API, not just into a form. Read back as ADMIN:
      // what HR may SEE on a profile is a different gate, and not what this test is about.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
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
    await setRolesViaApi(page, id, BASELINE_ROLES)

    try {
      await loginViaApi(page, SEED_EMAILS.seniorC)
      await page.goto('/profile')
      await expect(page.getByTestId('roles-section')).toBeVisible()

      // Clear the baseline, so the add below is the only source of roles.
      for (const role of BASELINE_ROLES) {
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
      // The empty selection never reached the API: the stored value is still the single role.
      // (`ProfileEditFields` cancels the pending save, so there is nothing in flight to outrun.)
      expect(await rolesOf(page, id)).toEqual([role])
    } finally {
      await setRolesViaApi(page, id, BASELINE_ROLES)
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
      // A senior of its own: two workers editing one senior's roles would race (the local matrix
      // runs several).
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorShared)
      expect(senior, `seed senior ${SEED_EMAILS.seniorShared} must exist`).not.toBeNull()
      const id = senior!.id
      await setRolesViaApi(page, id, BASELINE_ROLES)

      try {
        await loginViaApi(page, SEED_EMAILS.seniorShared)
        await page.goto('/profile')
        await expect(page.getByTestId('roles-section')).toBeVisible()
        for (const role of BASELINE_ROLES) {
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
        await setRolesViaApi(page, id, BASELINE_ROLES)
      }
    })
  })
})
