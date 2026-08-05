/**
 * mobile-keyboard-attributes.spec.ts — task-mobile-keyboards.md AC4.
 *
 * `mobile-keyboard-fields.spec.ts` (apps/web + apps/landing unit guards)
 * prove every classified field's SOURCE carries the right static
 * attributes. This spec is the complement the task explicitly asks for:
 * a representative of each taxonomy class, rendered on a REAL mobile
 * viewport, asserted to have reached the actual DOM — not just the JSX.
 *
 * Mock-based (no live server needed), matching the existing
 * `profile-self-edit.spec.ts` / `projects.spec.ts` pattern — `mockAuthAs` +
 * fixture routes only.
 */
import { test, expect, USERS, mockAuthAs } from '../fixtures'

const MOBILE_VIEWPORT = { width: 375, height: 812 }

test.describe('Mobile keyboard attributes on a real mobile viewport — task-mobile-keyboards.md AC4', () => {
  test('profile self-edit: money-adjacent identity fields carry the right keyboard hints', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT)
    await mockAuthAs(page, USERS.junior)
    await page.goto('/profile')
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // PERSON_NAME — own display name, autofill wanted.
    const nameInput = page.getByLabel('Имя')
    await expect(nameInput).toHaveAttribute('autocapitalize', 'words')
    await expect(nameInput).toHaveAttribute('autocomplete', 'name')

    // HANDLE — Telegram, must NOT autocapitalize/autocorrect.
    const telegramInput = page.getByLabel('Telegram')
    await expect(telegramInput).toHaveAttribute('autocapitalize', 'off')
    await expect(telegramInput).toHaveAttribute('autocorrect', 'off')

    // PHONE — no <label htmlFor>, target by the PhoneInput's own placeholder
    // (same selector profile-self-edit.spec.ts already uses).
    const phoneInput = page.getByPlaceholder('Номер телефона')
    await expect(phoneInput).toHaveAttribute('type', 'tel')
  })

  test('profile requisites: wallet/IBAN/RNOKPP fields carry the right keyboard hints', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT)
    // JUNIOR is not USDT-only (SENIOR/ADMIN are) — both payment tabs render.
    // The fixture's paymentMethod is BANK_UAH_FOP, so that tab is active by
    // default (USDT is the OTHER tab — asserted second, after switching).
    await mockAuthAs(page, USERS.junior)
    await page.goto('/profile?tab=requisites')
    await expect(page.getByRole('heading', { name: 'Реквизиты для выплат' })).toBeVisible()

    // BANK_ID — IBAN must FORCE uppercase (schema is case-sensitive `/^UA\d{27}$/`).
    const ibanInput = page.locator('#bankIban')
    await expect(ibanInput).toHaveAttribute('autocapitalize', 'characters')
    await expect(ibanInput).toHaveAttribute('autocorrect', 'off')
    await expect(ibanInput).toHaveAttribute('spellcheck', 'false')

    // INTEGER_TEXT — RNOKPP, pure-digit identifier.
    const rnokppInput = page.locator('#bankRnokpp')
    await expect(rnokppInput).toHaveAttribute('inputmode', 'numeric')
    await expect(rnokppInput).toHaveAttribute('pattern', '[0-9]*')

    // Switch to the USDT ERC-20 tab.
    await page.getByRole('button', { name: 'USDT ERC-20' }).click()

    // WALLET_HASH — USDT wallet address, must resist
    // autocapitalize/autocorrect/spellcheck/autocomplete mangling.
    const walletInput = page.locator('#walletUsdtErc20')
    await expect(walletInput).toHaveAttribute('autocapitalize', 'off')
    await expect(walletInput).toHaveAttribute('autocorrect', 'off')
    await expect(walletInput).toHaveAttribute('spellcheck', 'false')
    await expect(walletInput).toHaveAttribute('autocomplete', 'off')
  })

  test('projects list: search box carries the search keyboard hint', async ({ asAdmin: page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT)
    await page.goto('/projects')

    // SEARCH — type="search" + enterKeyHint="search".
    const search = page.getByTestId('projects-search-input')
    await expect(search).toHaveAttribute('type', 'search')
    await expect(search).toHaveAttribute('enterkeyhint', 'search')
  })

  test('create-project dialog: the rate field is a decimal money field, not type="number"', async ({
    asAdmin: page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT)
    await page.goto('/projects')
    await page.getByRole('button', { name: /новый проект/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // MONEY — AmountCurrencyInput's «Ставка» field. AC2: type="text" +
    // inputMode="decimal", never type="number" (which silently drops a
    // comma-decimal value in ru/uk locales).
    const amountInput = page.getByTestId('amount-currency-amount-input')
    await expect(amountInput).toHaveAttribute('type', 'text')
    await expect(amountInput).toHaveAttribute('inputmode', 'decimal')
  })
})
