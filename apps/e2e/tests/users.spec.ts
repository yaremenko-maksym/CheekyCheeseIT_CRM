import type { Page } from '@playwright/test'
import { test, expect, ALL_USERS, USERS, mockAuthAs } from './fixtures'

// ---------------------------------------------------------------------------
// Helper: fill and submit the Create SENIOR form, capturing the POST body
// ---------------------------------------------------------------------------
/**
 * Valid 42-char USDT ERC-20 placeholder (`0x` + 40 hex chars). Matches the
 * `^0x[a-fA-F0-9]{40}$` regex in `createUserSchema` so the backend accepts
 * the Create payload — without this, `refineRequisitePresence` rejects
 * the request and the POST never fires.
 */
const VALID_USDT_WALLET = '0x' + '0'.repeat(40)

async function createSeniorViaDialog(page: Page): Promise<Record<string, unknown>> {
  const postReq = page.waitForRequest(
    (req) => req.url().includes('/api/users') && req.method() === 'POST',
  )

  await page.getByRole('button', { name: /добавить/i }).click()
  await page.getByPlaceholder('user@cheekycheese.dev').fill('newsenior@cheekycheese.dev')
  await page.getByTestId('user-dialog-name').fill('New Senior Dev')

  // For ADMIN: change role selector to SENIOR. For HR: role is locked (no combobox, just a div).
  const roleCombo = page.getByTestId('user-dialog-role-trigger')
  const hasRoleCombo = (await roleCombo.count()) > 0
  if (hasRoleCombo) {
    await roleCombo.click()
    await page.getByRole('option', { name: 'Синьор' }).click()
  }

  // Wait for the "Команда" team section to appear inside the dialog
  await expect(page.getByRole('dialog').getByText('Команда', { exact: true })).toBeVisible()

  // A3-3: legalFullName is required for all contract-eligible roles (SENIOR,
  // JUNIOR, HR, ACCOUNTANT). Without it the superRefine check in
  // createUserSchema fails client-side and the wizard blocks advance.
  await page.getByTestId('user-dialog-legal-full-name').fill('Сеніор Тестовий Іванович')

  // ut-14: SENIOR/ADMIN are USDT-only; `walletUsdtErc20` is required by the
  // shared `refineRequisitePresence` rule. Without it the safeParse fails
  // client-side and the POST never fires.
  await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

  // A3-3: create mode uses a 3-step wizard; step 1 «Далее» (wizard-next-btn)
  // submits POST /api/users. The old single-submit button (user-dialog-submit)
  // is only rendered in edit mode.
  await page.getByTestId('wizard-next-btn').click()

  const req = await postReq
  return JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
}

test.describe('Users management page', () => {
  // ---------------------------------------------------------------------------
  // RBAC: access control
  // ---------------------------------------------------------------------------

  test.describe('Access control', () => {
    test('ADMIN can access users page', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
      await expect(page.getByText(/доступ только для администратора/i)).not.toBeVisible()
    })

    test('SENIOR accessing /crm/users gets redirected to /crm/dashboard (route-guard)', async ({
      asSenior: page,
    }) => {
      // PR #184 route-guard: /crm/users is ADMIN-only. resolveRoleHome('SENIOR')
      // = '/crm/dashboard'. Old in-page «Доступ только для администратора» panel
      // is no longer rendered — guard redirects before the page mounts.
      await page.goto('/crm/users')
      await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
      await expect(page).not.toHaveURL(/\/crm\/users/)
    })

    test('HR accessing /crm/users gets redirected to /crm/dashboard (route-guard)', async ({
      asHr: page,
    }) => {
      // PR #184 route-guard: /crm/users is ADMIN-only. resolveRoleHome('HR')
      // = '/crm/dashboard'. Guard redirects before the page mounts.
      await page.goto('/crm/users')
      await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
      await expect(page).not.toHaveURL(/\/crm\/users/)
    })

    test('JUNIOR accessing /crm/users gets redirected to /crm/project (route-guard)', async ({
      asJunior: page,
    }) => {
      // PR #184 route-guard: /crm/users is ADMIN-only. resolveRoleHome('JUNIOR')
      // = '/crm/project'. Guard redirects before the page mounts.
      await page.goto('/crm/users')
      await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
      await expect(page).not.toHaveURL(/\/crm\/users/)
    })
  })

  // ---------------------------------------------------------------------------
  // List rendering
  // ---------------------------------------------------------------------------

  test.describe('List rendering', () => {
    test('shows all users in the list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      for (const u of ALL_USERS) {
        await expect(page.getByTestId(`user-row-${u.id}`)).toBeVisible()
      }
    })

    test('shows email in row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('senior@cheekycheese.dev')).toBeVisible()
    })

    test('shows role badge in row', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const adminRow = page.getByTestId(`user-row-${USERS.admin.id}`)
      await expect(adminRow.getByText('Администратор')).toBeVisible()
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('Синьор')).toBeVisible()
    })

    test('shows telegram handle inside row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('@seniordev')).toBeVisible()
    })

    test('marks current user with "Вы" label', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const adminRow = page.getByTestId(`user-row-${USERS.admin.id}`)
      await expect(adminRow.getByText('Вы', { exact: true })).toBeVisible()
    })

    test('shows "Добавить" button', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByTestId('users-create-button')).toBeVisible()
    })

    test(`shows total count "${ALL_USERS.length} из ${ALL_USERS.length}" in header`, async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(new RegExp(`из ${ALL_USERS.length}`))).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Search and filter
  // ---------------------------------------------------------------------------

  test.describe('Search and filter', () => {
    test('search by name filters list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('Senior')
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toHaveCount(0)
    })

    test('search by email filters list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('junior@')
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toHaveCount(0)
    })

    test('search by telegram filters list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('seniordev')
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
    })

    test('filter by role shows only matching users', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      // Filter combobox shows "Все роли"
      await page.getByRole('combobox').filter({ hasText: 'Все роли' }).click()
      await page.getByRole('option', { name: 'Джун' }).click()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toHaveCount(0)
    })

    test('clear search shows all users again', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const search = page.getByPlaceholder(/поиск по имени/i)
      await search.fill('Senior')
      await search.clear()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
    })

    test('no results shows reduced count', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('zzznomatch')
      await expect(page.getByText(/0 из/)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Create user dialog
  // ---------------------------------------------------------------------------

  test.describe('Create user', () => {
    test('opens create dialog with correct title', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByTestId('user-dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: /новый пользователь/i })).toBeVisible()
    })

    test('submits POST with all required fields', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/api/users') && req.method() === 'POST',
      )

      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('newuser@cheekycheese.dev')
      await page.getByTestId('user-dialog-name').fill('New User')

      // A3-3: legalFullName required for contract-eligible roles (JUNIOR included).
      await page.getByTestId('user-dialog-legal-full-name').fill('Новий Користувач Іванович')

      // Role is already default (JUNIOR). JUNIOR defaults to BANK_UAH_FOP
      // requisites; switch to USDT_ERC20 (smaller surface to fill) and
      // provide the wallet so `refineRequisitePresence` passes. ut-15: the
      // selector is a segmented toggle, not <label>+radio anymore.
      const dialog = page.getByTestId('user-dialog')
      await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
      await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

      // A3-3: create mode uses wizard — step 1 «Далее» (wizard-next-btn) fires
      // POST /api/users. The old user-dialog-submit is edit-mode only.
      await page.getByTestId('wizard-next-btn').click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({
        email: 'newuser@cheekycheese.dev',
        displayName: 'New User',
      })
    })

    test('validation: invalid email shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      const emailInput = page.getByPlaceholder('user@cheekycheese.dev')
      await emailInput.fill('not-an-email')
      await emailInput.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('validation: empty display name shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      const nameInput = page.getByTestId('user-dialog-name')
      await nameInput.focus()
      await nameInput.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('validation: invalid telegram shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      // Use a value that actually fails the shared telegram regex
      // (`^@?[a-zA-Z0-9_]{5,32}$`). "notelegram" matches it (10 latin chars,
      // optional `@`), so the previous test never surfaced an error. "no!"
      // is too short and contains an illegal character.
      await page.getByPlaceholder('@username').fill('no!')
      await page.getByPlaceholder('@username').blur()
      await expect(page.locator('p.text-destructive').first()).toBeVisible()
    })

    test('can select different role', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/api/users') && req.method() === 'POST',
      )

      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('senior2@cheekycheese.dev')
      await page.getByTestId('user-dialog-name').fill('Another Senior')

      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      // Wait for team section — signals role switch has settled in the form.
      await expect(page.getByRole('dialog').getByText('Команда', { exact: true })).toBeVisible()

      // A3-3: legalFullName required for SENIOR (contract-eligible role).
      await page.getByTestId('user-dialog-legal-full-name').fill('Сеніор Другий Іванович')

      // ut-14: SENIOR/ADMIN are USDT-only; without `walletUsdtErc20` the
      // shared `refineRequisitePresence` blocks safeParse and no POST fires.
      await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

      // A3-3: create mode uses wizard — step 1 «Далее» (wizard-next-btn) fires POST.
      await page.getByTestId('wizard-next-btn').click()

      const req = await postReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ role: 'SENIOR' })
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByTestId('user-dialog')).toBeVisible()
      await page.getByTestId('user-dialog').getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('user-dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Edit user dialog
  // ---------------------------------------------------------------------------

  test.describe('Edit user', () => {
    test('opens edit dialog with user data pre-filled', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog).toBeVisible()
      await expect(page.getByRole('heading', { name: /редактировать/i })).toBeVisible()
      // Name is pre-filled
      const nameInput = page.getByTestId('user-dialog-name')
      await expect(nameInput).toHaveValue('Senior Dev')
    })

    test('edit sends PATCH request with updated data', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'PATCH',
      )

      const nameInput = page.getByTestId('user-dialog-name')
      await nameInput.clear()
      await nameInput.fill('Senior Developer Updated')
      await page.getByTestId('user-dialog-submit').click()

      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({
        displayName: 'Senior Developer Updated',
      })
    })

    test('edit cancel closes dialog without PATCH', async ({ asAdmin: page }) => {
      let patchCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users/') && req.method() === 'PATCH') patchCalled = true
      })

      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()
      await page.getByTestId('user-dialog').getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('user-dialog')).not.toBeVisible()
      expect(patchCalled).toBe(false)
    })

    test('cannot archive self from list (archive button disabled for current user)', async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/users')
      const archiveBtn = page.getByTestId(`user-row-archive-${USERS.admin.id}`)
      await expect(archiveBtn).toBeVisible()
      await expect(archiveBtn).toBeDisabled()
    })
  })

  // ---------------------------------------------------------------------------
  // Archive user dialog (was Delete user)
  // ---------------------------------------------------------------------------

  test.describe('Archive user', () => {
    test('opens archive confirm dialog with user name', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()

      const dialog = page.getByTestId('archive-confirm-dialog')
      await expect(dialog).toBeVisible()
      // SENIOR variant warning (pair-archive)
      await expect(dialog.getByTestId('archive-warning-senior')).toBeVisible()
      await expect(dialog.getByTestId('archive-confirm-user-name')).toHaveText('Senior Dev')
    })

    test('confirm sends DELETE request after name confirmation', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'DELETE',
      )
      await page.getByTestId('archive-confirm-name-input').fill('Senior Dev')
      await page.getByTestId('archive-confirm-submit').click()
      await deleteReq
    })

    test('cancel closes dialog without DELETE', async ({ asAdmin: page }) => {
      let deleteCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users/') && req.method() === 'DELETE') deleteCalled = true
      })

      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()
      await page
        .getByTestId('archive-confirm-dialog')
        .getByRole('button', { name: 'Отмена' })
        .click()
      await expect(page.getByTestId('archive-confirm-dialog')).not.toBeVisible()
      expect(deleteCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // ut-18: Sort relocated from column headers to filter bar.
  // Sort key = Select (`users-sort-key`); direction = ghost button
  // (`users-sort-direction`) with `data-dir` attribute toggling asc/desc.
  // ---------------------------------------------------------------------------

  test.describe('Sorting', () => {
    test('clicking sort-direction toggles asc → desc', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const dir = page.getByTestId('users-sort-direction')
      await expect(dir).toBeVisible()
      // Default asc; click → desc
      await expect(dir).toHaveAttribute('data-dir', 'asc')
      await dir.click()
      await expect(dir).toHaveAttribute('data-dir', 'desc')
      await expect(page.getByTestId(`user-row-${USERS.admin.id}`)).toBeVisible()
    })

    test('selecting "По дате добавления" sorts by date', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const sortKey = page.getByTestId('users-sort-key')
      await sortKey.click()
      await page.getByRole('option', { name: 'По дате добавления' }).click()
      await expect(page.getByTestId(`user-row-${USERS.admin.id}`)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty users list renders without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route(/\/api\/users(\?.*)?$/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/users')
      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
    })

    test('API error on create shows no crash', async ({ asAdmin: page }) => {
      await page.route(/\/api\/users(\?.*)?$/, (r) => {
        if (r.request().method() === 'POST') {
          return r.fulfill({
            status: 400,
            contentType: 'application/json',
            body: '{"message":"Email already exists"}',
          })
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(ALL_USERS),
        })
      })

      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('existing@cheekycheese.dev')
      await page.getByTestId('user-dialog-name').fill('Existing User')
      // A3-3: legalFullName required for JUNIOR (contract-eligible).
      await page.getByTestId('user-dialog-legal-full-name').fill('Існуючий Користувач Іванович')
      // JUNIOR defaults to BANK_UAH_FOP — switch to USDT to skip bank fields.
      const dialog = page.getByTestId('user-dialog')
      await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
      await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
      // A3-3: wizard step 1 «Далее» (wizard-next-btn) fires POST.
      await page.getByTestId('wizard-next-btn').click()

      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
    })

    test('telegram visible in row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('@seniordev')).toBeVisible()
    })

    test('email visible in row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('senior@cheekycheese.dev')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // SENIOR creation flow — team assignment (hrIds + accountantId)
  // ---------------------------------------------------------------------------

  test.describe('Create SENIOR — team assignment', () => {
    test('ADMIN: POST includes hrIds array when HR is checked', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect(body.role).toBe('SENIOR')
      expect(Array.isArray(body.hrIds)).toBe(true)
      expect((body.hrIds as string[]).length).toBeGreaterThan(0)
    })

    test('ADMIN: POST includes accountantId when accountant auto-selected', async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect(body.accountantId).toBeTruthy()
      expect(typeof body.accountantId).toBe('string')
    })

    test('ADMIN: POST contains correct hrId from fixtures', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect(body.hrIds as string[]).toContain(USERS.hr.id)
    })

    test('ADMIN: POST contains correct accountantId from fixtures', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect(body.accountantId).toBe(USERS.accountant.id)
    })

    test('ADMIN: Финансы and Команда sections visible for SENIOR role', async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()

      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog.getByText('Финансы', { exact: true })).toBeVisible()
      await expect(dialog.getByText('Команда', { exact: true })).toBeVisible()
      await expect(dialog.locator('label').filter({ hasText: 'HR' }).first()).toBeVisible()
      await expect(dialog.getByText('Бухгалтер')).toBeVisible()
    })

    test('ADMIN: HR chip pre-selected when only one HR exists (ut-16)', async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog.getByText('HR Manager')).toBeVisible()
      // ut-16: single HR — chip is rendered, no remove (×) button (locked).
      const chip = page.getByTestId(`user-dialog-hr-chip-${USERS.hr.id}`)
      await expect(chip).toBeVisible()
      await expect(page.getByTestId(`user-dialog-hr-remove-${USERS.hr.id}`)).toHaveCount(0)
    })

    test('ADMIN: validation error when no HR selected (ut-16)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('newsenior2@cheekycheese.dev')
      await page.getByTestId('user-dialog-name').fill('Another Senior')
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      // ut-16: HR is now a chip with × button. We can only meaningfully
      // exercise this assertion when there is >1 HR in the system so the chip
      // is removable. The single-HR fixture renders it locked — skip in that
      // case to avoid asserting against an intentional UX safeguard.
      const removeBtn = page.getByTestId(`user-dialog-hr-remove-${USERS.hr.id}`)
      const removable = await removeBtn.count()
      test.skip(removable === 0, 'Skipped: only one HR in fixtures — chip is locked')

      await removeBtn.click()
      await page.getByTestId('user-dialog-submit').click()
      await expect(page.getByText(/выберите хотя бы одного HR/i)).toBeVisible()
    })

    test('HR: accessing /crm/users gets redirected to /crm/dashboard (route-guard)', async ({
      asHr: page,
    }) => {
      // PR #184 route-guard: /crm/users is ADMIN-only. HR is redirected to
      // resolveRoleHome('HR') = '/crm/dashboard'. The in-page «Доступ только
      // для администратора» notice is no longer rendered — guard fires first.
      await page.goto('/crm/users')
      await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
      await expect(page).not.toHaveURL(/\/crm\/users/)
    })
  })
})
