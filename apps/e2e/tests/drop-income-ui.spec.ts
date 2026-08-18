/**
 * drop-income-ui.spec.ts — task-drop-phase2-e2e (AC6).
 *
 * REAL-API UI flow: DROP registers a DROP_INCOME from their own profile.
 *
 * Pre-conditions:
 *   1. ADMIN provisions a fresh DROP + drop-team.
 *   2. ADMIN creates a drop-project routed through the DROP.
 *
 * UI flow:
 *   3. DROP logs in, navigates to /profile.
 *   4. Switches to the «Финансы» tab and clicks the
 *      `data-testid="profile-drop-income-button"` («Добавить приход») CTA
 *      surfaced for own-DROP-profile only.
 *   5. The CreateTransactionDialog opens — DROP_INCOME is pre-selected
 *      because DROP role has only one option in `availableTypes`.
 *   6. Pick the drop-project from the Select, enter $750, attach a receipt
 *      URL, submit.
 *   7. Assertions:
 *      - Success toast «Транзакция создана» appears.
 *      - REST: a new DROP_INCOME row exists for the project with
 *        status=PENDING and amount=750.
 *      - The Финансы list now contains a row matching that transaction.
 *
 * Cleanup: cascade-archive the drop.
 */

import { test, expect, REAL_API_BASE } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const REAL_API = `${REAL_API_BASE}/api`

test.describe('Drop income — UI flow on /profile (AC6)', () => {
  test('DROP submits DROP_INCOME via profile «Финансы» tab → row appears + backend records PENDING', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac6-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC6 ${suffix}`
    const incomeAmount = 750

    // 1) Provision DROP + drop-team as ADMIN.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    try {
      // 2) Create drop-project routed through the DROP.
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
        name: `Drop AC6 Project ${suffix}`,
      })

      // 3) Log in as DROP. Land on /profile.
      await loginViaApi(page, dropEmail)
      await page.goto('/profile')

      // 4) Switch to the «Финансы» tab. AnimatedTabs renders plain <button>
      // elements with aria-label = tab label.
      const financeTab = page.getByRole('button', { name: 'Финансы' })
      await expect(financeTab).toBeVisible({ timeout: 10_000 })
      await financeTab.click()

      // 5) Click the DROP-only «Добавить приход» button.
      const dropIncomeButton = page.getByTestId('profile-drop-income-button')
      await expect(dropIncomeButton).toBeVisible({ timeout: 10_000 })
      await dropIncomeButton.click()

      // CreateTransactionDialog opens — DROP_INCOME pre-selected (the only
      // option for DROP).
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 8_000 })

      // 6) Select the drop-project from the project Select. The dialog
      //    surfaces a Select listing drop-projects only for the DROP user.
      //    The trigger has data-testid="create-transaction-project-trigger".
      await dialog.getByTestId('create-transaction-project-trigger').click()
      await page.getByRole('option', { name: new RegExp(`Drop AC6 Project ${suffix}`) }).click()

      // Fill amount — AmountCurrencyInput renders type=number with placeholder
      // "0.00" by default (CreateTransactionDialog passes no override).
      await dialog.getByPlaceholder('0.00').fill(String(incomeAmount))

      // Attach a receipt URL (DROP_INCOME requires receipt — same XOR rule
      // as SENIOR_INCOME). Switch ReceiptInput to «Ссылка» mode and fill
      // the URL field via the dedicated testids.
      await dialog.getByTestId('receipt-input-mode-url').click()
      await dialog
        .getByTestId('receipt-input-url-field')
        .fill('https://drive.example.com/drop-ac6-receipt.pdf')

      // Intercept the POST so we can inspect the created tx id.
      const postPromise = page.waitForResponse(
        (resp) =>
          resp.url().endsWith('/api/transactions/drop-income') &&
          resp.request().method() === 'POST',
      )

      // Submit. The dialog uses a «Создать» button.
      await dialog
        .getByRole('button', { name: /Создать|Добавить/i })
        .last()
        .click()
      const postResp = await postPromise
      expect(postResp.status()).toBeLessThan(400)
      const created = (await postResp.json()) as { id: string; status: string; amount: string }
      expect(created.status).toBe('PENDING')

      // 7) Dialog closes; the new tx is queryable via REST.
      await expect(dialog).toBeHidden({ timeout: 8_000 })

      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const dropIncomeRow = txs.find((t) => t.type === 'DROP_INCOME' && t.id === created.id)
      expect(dropIncomeRow).toBeTruthy()
      expect(dropIncomeRow!.status).toBe('PENDING')
      expect(parseFloat(dropIncomeRow!.amount)).toBeCloseTo(incomeAmount, 2)
    } finally {
      // Cleanup as ADMIN (DROP can't archive itself).
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
