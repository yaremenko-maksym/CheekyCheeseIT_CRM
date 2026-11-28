/**
 * hr-create-senior.spec.ts — HR "Створити сеньйора" dialog submits.
 *
 * Regression for the dead HR path: the dialog validated its payload with
 * `createUserSchema`, which FORCES a SENIOR to carry USDT_ERC20 + a wallet +
 * `legalFullName`. The dialog collects none of those (HR provisions a senior
 * without requisites), so `safeParse` always failed, an error toast showed and
 * nothing was ever POSTed — HR could not create a senior at all.
 *
 * Mocked API (no real backend): asserts the dialog now POSTs /api/users with a
 * requisite-less SENIOR payload, shows the success toast and closes.
 */

import { test, expect, API_RE, USERS, mockAuthAs } from './fixtures'
import { assertInCatalog, loadMessages } from '../fixtures/catalog'
import { SENIOR_ROLES, pickRoles } from './fixtures/senior-roles'

test.describe('HR create senior dialog', () => {
  test('HR fills email + name and the dialog POSTs a valid requisite-less SENIOR payload', async ({
    asHr: page,
  }) => {
    const posted: Array<Record<string, unknown>> = []
    await page.route(new RegExp(`${API_RE}/users$`), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      posted.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-senior-id', role: 'SENIOR' }),
      })
    })

    await page.goto('/team')
    await page.locator('main').getByRole('button', { name: 'Створити сеньйора' }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill('new.senior@cheekycheese.dev')
    await dialog.getByPlaceholder('Іван Іваненко').fill('Іван Іваненко')
    await pickRoles(dialog)
    await dialog.getByRole('button', { name: 'Створити', exact: true }).click()

    // The dialog closes and a success toast confirms the creation.
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Сеньйора створено, команду сформовано')).toBeVisible()

    expect(posted).toHaveLength(1)
    const body = posted[0]!
    expect(body).toMatchObject({
      email: 'new.senior@cheekycheese.dev',
      displayName: 'Іван Іваненко',
      role: 'SENIOR',
      seniorSharePercent: 26,
      technicalRoles: [...SENIOR_ROLES],
    })
    // HR never sends requisites or a legal name.
    // The untouched phone widget's seeded "+380" is not sent as a phone number either.
    // `techStack` too: a SENIOR is described by its roles, and the dialog no longer collects a stack.
    for (const key of [
      'paymentMethod',
      'walletUsdtErc20',
      'legalFullName',
      'bankUahIban',
      'phone',
      'techStack',
    ]) {
      expect(body).not.toHaveProperty(key)
    }
    // And no validation-failure toast.
    await expect(page.getByText('Не вдалося створити команду')).toHaveCount(0)
  })

  test('with no role the dialog shows the floor error inline and does not POST', async ({
    asHr: page,
  }) => {
    let posts = 0
    await page.route(new RegExp(`${API_RE}/users$`), (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      posts += 1
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    })

    await page.goto('/team')
    await page.locator('main').getByRole('button', { name: 'Створити сеньйора' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill('no.roles@cheekycheese.dev')
    await dialog.getByPlaceholder('Іван Іваненко').fill('Іван Іваненко')
    await dialog.getByRole('button', { name: 'Створити', exact: true }).click()

    const error = dialog.getByTestId('roles-section-error')
    await expect(error).toHaveText('Сеньйору потрібна щонайменше одна технічна роль')
    const trigger = dialog.getByTestId('roles-section-add-trigger')
    await expect(trigger).toHaveAttribute(
      'aria-describedby',
      (await error.getAttribute('id')) ?? '',
    )
    await expect(dialog).toBeVisible()
    expect(posts).toBe(0)
  })

  test('en: the floor error renders in English, tied to the add control (SPEC-M-2)', async ({
    page,
  }) => {
    const en = await loadMessages('en')
    await mockAuthAs(page, { ...USERS.hr, locale: 'en' })
    let posts = 0
    await page.route(new RegExp(`${API_RE}/users$`), (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      posts += 1
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    })

    await page.goto('/team')
    await page
      .locator('main')
      .getByRole('button', { name: assertInCatalog(en, 'Create senior') })
      .first()
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill('en.senior@cheekycheese.dev')
    await dialog.getByPlaceholder(assertInCatalog(en, 'Ivan Ivanenko')).fill('Ivan Ivanenko')
    await dialog.getByRole('button', { name: assertInCatalog(en, 'Create'), exact: true }).click()

    const error = dialog.getByTestId('roles-section-error')
    await expect(error).toHaveText(
      assertInCatalog(en, 'A senior needs at least one technical role'),
    )
    const trigger = dialog.getByTestId('roles-section-add-trigger')
    await expect(trigger).toHaveAttribute(
      'aria-describedby',
      (await error.getAttribute('id')) ?? '',
    )
    expect(posts).toBe(0)
  })
})
