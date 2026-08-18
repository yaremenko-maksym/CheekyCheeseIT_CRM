/**
 * senior-create-default.spec.ts — Drop role - phase 1 (AC3, regression).
 *
 * AC3 asserts that the legacy «Создать свою команду» path remains intact:
 * an ADMIN-driven SENIOR creation defaults to `teamMode='CREATE_NEW'`, the
 * HR/Accountant chips auto-select (single-fixture case) and the dialog
 * submits a normal CreateUserDto without `teamMode` / `dropTeamId`.
 *
 * This is the regression-safety net for AC2/AC9 — if we ever lose the
 * default behavior, this spec catches it before merge.
 *
 * Mock-based — `/teams` returns only the legacy senior team (no drop-team
 * available) so the JOIN_DROP_TEAM radio is disabled and the user has
 * exactly one obvious path forward.
 */

import { test, expect, USERS, TEAMS, API_RE } from './fixtures'

const VALID_USDT_WALLET = '0x' + '0'.repeat(40)

test.describe('Senior creation — CREATE_NEW default (AC3 regression)', () => {
  test('default radio is «Создать свою команду» and CREATE_NEW HR chip is auto-selected', async ({
    asAdmin: page,
  }) => {
    // Override teams so only the legacy senior team is present — guarantees
    // no JOIN_DROP_TEAM option is plausible by accident.
    await page.route(new RegExp(`${API_RE}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([TEAMS[0]]),
      }),
    )
    await page.goto('/users')
    await page.getByTestId('users-create-button').click()

    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    await expect(dialog.getByTestId('user-dialog-team-mode-create-new')).toBeVisible()
    // ADMIN sees the picker — default is CREATE_NEW so the HR chip
    // pre-populated from the single-HR fixture is visible.
    await expect(dialog.getByTestId(`user-dialog-hr-chip-${USERS.hr.id}`)).toBeVisible()
    // Drop-team picker is hidden in CREATE_NEW.
    await expect(dialog.getByTestId('user-dialog-drop-team-trigger')).toHaveCount(0)
  })

  test('explicit click on «Создать свою команду» keeps the CREATE_NEW path active', async ({
    asAdmin: page,
  }) => {
    await page.route(new RegExp(`${API_RE}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([TEAMS[0]]),
      }),
    )
    await page.goto('/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    // Belt-and-braces: explicitly tap the default radio. The test exists
    // to capture the regression where a future refactor inverts the
    // default — clicking the label should never leave the dialog in a
    // broken state.
    await dialog.getByText('Создать свою команду').click({ force: true })

    await expect(dialog.getByTestId(`user-dialog-hr-chip-${USERS.hr.id}`)).toBeVisible()
    // Drop-team selector must not surface.
    await expect(dialog.getByTestId('user-dialog-drop-team-trigger')).toHaveCount(0)
  })

  test('SENIOR creation POST omits teamMode/dropTeamId — backend defaults to CREATE_NEW', async ({
    asAdmin: page,
  }) => {
    await page.route(new RegExp(`${API_RE}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([TEAMS[0]]),
      }),
    )
    await page.goto('/users')

    const postReq = page.waitForRequest(
      (req) =>
        req.url().includes('/api/users') &&
        !req.url().includes('/users/drops') &&
        !req.url().includes('/users/me') &&
        req.method() === 'POST',
    )

    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill('senior-default@cheekycheese.dev')
    await page.getByTestId('user-dialog-name').fill('Default Senior')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    // SENIOR is USDT-only — fill the wallet so the shared refine passes.
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

    // Submit without touching the team-mode radio: the default is CREATE_NEW.
    await page.getByTestId('user-dialog-submit').click()

    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>

    expect(body).toMatchObject({
      email: 'senior-default@cheekycheese.dev',
      displayName: 'Default Senior',
      role: 'SENIOR',
    })
    // hrIds / accountantId are populated from the auto-selected chip.
    expect(Array.isArray(body.hrIds)).toBe(true)
    expect(body.hrIds as string[]).toContain(USERS.hr.id)
    expect(body.accountantId).toBe(USERS.accountant.id)
    // Legacy flow → teamMode field is intentionally omitted.
    expect(body.teamMode).toBeUndefined()
    expect(body.dropTeamId).toBeUndefined()
  })
})
