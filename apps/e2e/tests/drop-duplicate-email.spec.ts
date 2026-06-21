/**
 * drop-duplicate-email.spec.ts — task-expand-drop-e2e-coverage (AC3).
 *
 * Verifies the duplicate-email flow when creating a DROP via the unified
 * UserDialog. Round-2 user testing surfaced that the 409 toast and
 * dialog-stays-open behavior was never exercised against the live
 * backend — the legacy drop-create.spec.ts mocks /users/drops 201.
 *
 * Flow:
 *   1. Create a drop via real API (`createDropViaAPI`).
 *   2. Open /users → Добавить → DROP role → fill in the *same* email.
 *   3. Submit → backend returns 409 → frontend shows tailored toast
 *      «Пользователь с таким email уже существует».
 *   4. Dialog must stay open (operator can fix the email).
 *   5. Change the email → submit again → success (toast «Дроп создан»).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  VALID_USDT_WALLET,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop create — duplicate email UI flow (AC3)', () => {
  test('409 from /users/drops shows toast and keeps the dialog open; second submit succeeds', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dupEmail = `drop-ac3-dup-${suffix}@cheekycheese.dev`
    const firstDisplayName = `Drop AC3 Dup ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Seed: create the first drop holding `dupEmail`.
    const { dropId: firstDropId } = await createDropViaAPI(page, {
      email: dupEmail,
      displayName: firstDisplayName,
    })
    // Track a second drop created later in the flow for cleanup.
    let secondDropId: string | null = null

    try {
      // Navigate to /users and open the unified Add dialog.
      await page.goto('/users')
      await page.getByTestId('users-create-button').click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog).toBeVisible({ timeout: 8_000 })

      // Pick DROP role.
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Дроп' }).click()

      // Fill in the *duplicate* email.
      await dialog.getByTestId('user-dialog-email').fill(dupEmail)
      await dialog.getByTestId('user-dialog-name').fill('Different Display Name')

      // Required requisites — USDT wallet to satisfy refineRequisitePresence.
      await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
      await dialog.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

      // Wait for the 409 response from /api/users/drops so we know the
      // backend rejected the request.
      const conflictResp = page.waitForResponse(
        (resp) =>
          resp.url().endsWith('/api/users/drops') &&
          resp.request().method() === 'POST' &&
          resp.status() === 409,
      )
      await dialog.getByTestId('user-dialog-submit').click()
      await conflictResp

      // Toast surfaces the tailored 409 message — `sonner` renders a region
      // attached to the body. The exact wording comes from
      // `explainUserMutationError` in UserDialog.tsx.
      await expect(
        page.getByText('Пользователь с таким email уже существует', { exact: false }),
      ).toBeVisible({ timeout: 8_000 })

      // Dialog must stay open so the operator can edit the email and retry.
      await expect(dialog).toBeVisible()

      // Fix the email and retry — submit must succeed this time.
      const fixedEmail = `drop-ac3-fixed-${suffix}@cheekycheese.dev`
      const emailInput = dialog.getByTestId('user-dialog-email')
      await emailInput.fill(fixedEmail)

      const successResp = page.waitForResponse(
        (resp) =>
          resp.url().endsWith('/api/users/drops') &&
          resp.request().method() === 'POST' &&
          resp.status() >= 200 &&
          resp.status() < 300,
      )
      await dialog.getByTestId('user-dialog-submit').click()
      const successBody = (await (await successResp).json()) as { user: { id: string } } | undefined
      if (successBody?.user?.id) secondDropId = successBody.user.id

      // Toast «Дроп создан» surfaces — also asserts that the dialog flow
      // closes cleanly (navigation to the new team detail happens but the
      // assertion runs against the body root, not the dialog).
      await expect(page.getByText(/Дроп создан/i)).toBeVisible({ timeout: 8_000 })
    } finally {
      await cleanupDropViaAPI(page, firstDropId)
      if (secondDropId) await cleanupDropViaAPI(page, secondDropId)
    }
  })
})
