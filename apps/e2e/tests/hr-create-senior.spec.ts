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

import { test, expect, API_RE } from './fixtures'
import { SENIOR_TECH_STACK, addTechnologies, techStackInput } from './fixtures/senior-tech'

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
    await addTechnologies(dialog)
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
      techStack: [...SENIOR_TECH_STACK],
    })
    // HR never sends requisites or a legal name.
    // The untouched phone widget's seeded "+380" is not sent as a phone number either.
    for (const key of [
      'paymentMethod',
      'walletUsdtErc20',
      'legalFullName',
      'bankUahIban',
      'phone',
    ]) {
      expect(body).not.toHaveProperty(key)
    }
    // And no validation-failure toast.
    await expect(page.getByText('Не вдалося створити команду')).toHaveCount(0)
  })

  test('with 2 technologies the dialog shows the floor error inline and does not POST', async ({
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
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill('two.techs@cheekycheese.dev')
    await dialog.getByPlaceholder('Іван Іваненко').fill('Іван Іваненко')
    await addTechnologies(dialog, SENIOR_TECH_STACK.slice(0, 2))
    await dialog.getByRole('button', { name: 'Створити', exact: true }).click()

    const error = dialog.getByText('Сеньйору потрібно щонайменше 3 різні технології')
    await expect(error).toBeVisible()
    const input = await techStackInput(dialog)
    await expect(input).toHaveAttribute('aria-describedby', (await error.getAttribute('id')) ?? '')
    await expect(dialog).toBeVisible()
    expect(posts).toBe(0)
  })
})
