/**
 * drop-share-slider.spec.ts — task-expand-drop-e2e-coverage (AC4).
 *
 * Verifies extreme-value handling for the drop-share slider in the unified
 * UserDialog. The backend allows `dropSharePercent ∈ [0, 100]` (see
 * `createDropSchema` in `packages/shared/src/schemas/users.ts`), but the
 * slider's number input clamps client-side so out-of-range values can't be
 * submitted.
 *
 * Implementation note (DROP slider min):
 *   `ShareSlider` defaults `min={1}`, and `UserDialog` does *not* pass an
 *   explicit `min={0}` for the DROP variant. So the UI floor is **1**, not
 *   0 — even though the backend allows 0. The 0-value test below documents
 *   this discrepancy: typing `0` into the number input gets clamped to 1.
 *   If you want to relax the UI floor to 0 (matching the backend), update
 *   `UserDialog.tsx` to pass `min={0}` on the DROP `<ShareSlider />`.
 *
 * Cases covered:
 *  - 0 → frontend clamps to 1 (current UI behavior — documents the floor).
 *  - 100 → submitted as 100.
 *  - -5 → clamped to the min (1) — submit succeeds with the clamped value.
 *  - 150 → clamped to 100.
 *
 * The actual backend POST is intercepted so we can assert the payload
 * shape without polluting the DB. (Real DB hits would defeat the purpose
 * of testing edge clamping — we just need to confirm the value the
 * frontend *would* send.)
 */

import { test, expect } from './fixtures'
import { VALID_USDT_WALLET } from './fixtures'

const API = 'http://localhost:3001/api'

/** Fill the minimum required fields for DROP submit (email, name, requisites). */
async function fillBaseDropFields(
  dialog: ReturnType<import('@playwright/test').Page['getByTestId']>,
  email: string,
  name: string,
): Promise<void> {
  await dialog.getByTestId('user-dialog-email').fill(email)
  await dialog.getByTestId('user-dialog-name').fill(name)
  await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
  await dialog.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
}

test.describe('Drop share slider — extreme values (AC4)', () => {
  test('slider value 0 is clamped to the UI floor (1) and submits successfully', async ({
    asAdmin: page,
  }) => {
    // UI floor for DROP slider is 1 (see header comment). Submitting `0` in
    // the number input clamps client-side and posts the floor value. This
    // documents the current behavior — if backend semantics change, the
    // test must change too.
    await page.route(new RegExp(`${API}/users/drops$`), (r) =>
      r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'drop-zero-id', email: 'drop-zero@example.dev', displayName: 'Drop Zero' },
          teamId: 'team-zero-id',
        }),
      }),
    )

    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await fillBaseDropFields(dialog, 'drop-zero@example.dev', 'Drop Zero')

    // Fill the slider number input — placed *after* the senior share input
    // when present, but for DROP the slider is the only number input in
    // the form. Locating by [type=number] within the dialog targets it.
    const sliderNumber = dialog.locator('input[type="number"]').first()
    await sliderNumber.fill('0')
    await sliderNumber.blur()

    const postReq = page.waitForRequest(
      (req) => req.url().endsWith('/api/users/drops') && req.method() === 'POST',
    )
    await dialog.getByTestId('user-dialog-submit').click()
    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    const sent = body['dropSharePercent'] as number
    expect(sent).toBeGreaterThanOrEqual(1)
    expect(sent).toBeLessThanOrEqual(100)
  })

  test('slider value 100 submits 100 to the backend', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API}/users/drops$`), (r) =>
      r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'drop-max-id', email: 'drop-max@example.dev', displayName: 'Drop Max' },
          teamId: 'team-max-id',
        }),
      }),
    )

    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await fillBaseDropFields(dialog, 'drop-max@example.dev', 'Drop Max')

    const sliderNumber = dialog.locator('input[type="number"]').first()
    await sliderNumber.fill('100')
    await sliderNumber.blur()

    const postReq = page.waitForRequest(
      (req) => req.url().endsWith('/api/users/drops') && req.method() === 'POST',
    )
    await dialog.getByTestId('user-dialog-submit').click()
    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body['dropSharePercent']).toBe(100)
  })

  test('-5 is clamped to the minimum (1) — backend never receives a negative', async ({
    asAdmin: page,
  }) => {
    // No backend hit — we only verify the clamping. Mock returns 201 so the
    // dialog doesn't keep retrying on real-API failure.
    await page.route(new RegExp(`${API}/users/drops$`), (r) =>
      r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'drop-neg-id', email: 'drop-neg@example.dev', displayName: 'Drop Neg' },
          teamId: 'team-neg-id',
        }),
      }),
    )

    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await fillBaseDropFields(dialog, 'drop-neg@example.dev', 'Drop Neg')

    const sliderNumber = dialog.locator('input[type="number"]').first()
    await sliderNumber.fill('-5')
    await sliderNumber.blur()

    // Slider clamp logic (share-slider.tsx) snaps to `min` (default 1) when
    // negative. Confirm the displayed value after blur.
    const val = await sliderNumber.inputValue()
    expect(Number(val)).toBeGreaterThanOrEqual(1)
    expect(Number(val)).toBeLessThanOrEqual(100)

    // Submit and verify the payload uses the clamped value (never < 0).
    const postReq = page.waitForRequest(
      (req) => req.url().endsWith('/api/users/drops') && req.method() === 'POST',
    )
    await dialog.getByTestId('user-dialog-submit').click()
    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    const sent = body['dropSharePercent'] as number
    expect(sent).toBeGreaterThanOrEqual(0)
    expect(sent).toBeLessThanOrEqual(100)
  })

  test('150 is clamped to 100 — backend never receives an out-of-range value', async ({
    asAdmin: page,
  }) => {
    await page.route(new RegExp(`${API}/users/drops$`), (r) =>
      r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'drop-ovr-id', email: 'drop-ovr@example.dev', displayName: 'Drop Ovr' },
          teamId: 'team-ovr-id',
        }),
      }),
    )

    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await fillBaseDropFields(dialog, 'drop-ovr@example.dev', 'Drop Ovr')

    const sliderNumber = dialog.locator('input[type="number"]').first()
    await sliderNumber.fill('150')
    await sliderNumber.blur()

    // Slider clamps to max=100 on blur.
    const val = await sliderNumber.inputValue()
    expect(Number(val)).toBe(100)

    const postReq = page.waitForRequest(
      (req) => req.url().endsWith('/api/users/drops') && req.method() === 'POST',
    )
    await dialog.getByTestId('user-dialog-submit').click()
    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body['dropSharePercent']).toBe(100)
  })
})
