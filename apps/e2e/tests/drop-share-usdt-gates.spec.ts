/**
 * drop-share-usdt-gates.spec.ts — task-drop-share-e2e (Flow 2, AC2).
 *
 * ADR `docs/architecture/2026-07-13-payment-type-income-routing.md` (D2).
 * Mocked-fixture coverage of the CreateTransactionDialog's paymentType-based
 * UI gating:
 *
 *   - SENIOR / DROP never see a USDT-payment project in their own income
 *     project Select (`myProjects` / `dropProjects` filter out
 *     `paymentType === 'USDT'` client-side, mirroring the backend D2 gate).
 *   - When ALL of a SENIOR/DROP's projects are USDT-payment, an explanatory
 *     hint renders instead («На всех ваших проектах приход декларирует
 *     администратор»).
 *   - DROP on a FOP-payment project still declares their own income WITHOUT
 *     a receiver field in the request payload (regression guard for ADR
 *     C14 — M1's WIP briefly required `receiverId` on `createDropIncome`,
 *     reverted before this PR; this test pins the correct shape).
 *
 * Per feedback_mocked_e2e_guards: the backend 403 gate itself (D2 — SENIOR/
 * DROP calling createSeniorIncome/createDropIncome on a USDT project) is
 * ALREADY covered by real-DB backend integration tests
 * (task-drop-share-backend AC9-AC10). These specs check UI RENDERING
 * (Select contents / hint visibility / request-payload shape) — a
 * genuinely different surface, not a re-test of the guard.
 */

import { test, expect } from './fixtures'
import { USERS, mockAuthAs, API_RE } from './fixtures'

type MockProject = {
  id: string
  name: string
  seniorId: string
  dropId?: string | null
  paymentType: 'FOP' | 'GIG_CONTRACT' | 'USDT'
}

/** Register a `/projects` override AFTER `mockAuthAs` (LIFO — wins over the default fixture list). */
async function mockProjectsList(page: import('@playwright/test').Page, projects: MockProject[]) {
  await page.route(new RegExp(`${API_RE}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(projects),
    })
  })
}

/**
 * DROP has NO CreateTransactionDialog entry point on `/finance` — that route
 * renders a completely different `DropFinancePage` for the DROP role
 * (finance/index.tsx `if (isDrop) return <DropFinancePage />`). The DROP
 * reaches the SAME dialog from their home dashboard (`/`, `DropDashboard` →
 * shared `InProgressPanel` → «Добавить приход», `data-testid="drop-add-income"`).
 */
async function openDropIncomeDialog(page: import('@playwright/test').Page) {
  await page.goto('/')
  const dropIncomeButton = page.getByTestId('drop-add-income')
  await expect(dropIncomeButton).toBeVisible({ timeout: 10_000 })
  await dropIncomeButton.click()
}

test.describe('Admin-USDT payment-type gates — CreateTransactionDialog (Flow 2, AC2)', () => {
  test('SENIOR whose ONLY project is USDT-payment sees an empty project Select + gate hint', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.senior)
    await mockProjectsList(page, [
      {
        id: 'proj-usdt-only',
        name: 'USDT Only Project',
        seniorId: USERS.senior.id,
        dropId: null,
        paymentType: 'USDT',
      },
    ])

    await page.goto('/finance')
    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()

    // SENIOR_INCOME is the only/default type for a SENIOR — project Select
    // has no options (the sole project is USDT, filtered out client-side).
    await dialog.getByTestId('create-transaction-project-trigger').click()
    await expect(page.getByRole('option', { name: 'USDT Only Project' })).not.toBeAttached()
    await page.keyboard.press('Escape')

    await expect(dialog.getByTestId('senior-income-usdt-gate-hint')).toBeVisible()
  })

  test('SENIOR with a MIX of FOP + USDT projects sees only the FOP project, no gate hint', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.senior)
    await mockProjectsList(page, [
      {
        id: 'proj-fop',
        name: 'FOP Regular Project',
        seniorId: USERS.senior.id,
        dropId: null,
        paymentType: 'FOP',
      },
      {
        id: 'proj-usdt',
        name: 'USDT Only Project',
        seniorId: USERS.senior.id,
        dropId: null,
        paymentType: 'USDT',
      },
    ])

    await page.goto('/finance')
    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('create-transaction-project-trigger').click()
    await expect(page.getByRole('option', { name: 'FOP Regular Project' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'USDT Only Project' })).not.toBeAttached()
    await page.keyboard.press('Escape')

    // A mixed portfolio does NOT show the "all-USDT" hint (only shown when
    // the filtered pool is empty despite a non-empty underlying list).
    await expect(dialog.getByTestId('senior-income-usdt-gate-hint')).not.toBeAttached()
  })

  test('DROP whose ONLY project is USDT-payment sees an empty project Select + gate hint', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.drop)
    await mockProjectsList(page, [
      {
        id: 'proj-usdt-drop',
        name: 'USDT Drop Project',
        seniorId: 'some-senior-id',
        dropId: USERS.drop.id,
        paymentType: 'USDT',
      },
    ])

    await openDropIncomeDialog(page)
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('create-transaction-project-trigger').click()
    await expect(page.getByRole('option', { name: 'USDT Drop Project' })).not.toBeAttached()
    await page.keyboard.press('Escape')

    await expect(dialog.getByTestId('drop-income-usdt-gate-hint')).toBeVisible()
  })

  test('DROP on a FOP-payment project declares income WITHOUT a receiverId in the request (C14 regression guard)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.drop)
    await mockProjectsList(page, [
      {
        id: 'proj-fop-drop',
        name: 'FOP Drop Project',
        seniorId: 'some-senior-id',
        dropId: USERS.drop.id,
        paymentType: 'FOP',
      },
    ])
    await page.route(new RegExp(`${API_RE}/transactions/drop-income$`), (r) =>
      r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-drop-income-id', status: 'PENDING', amount: '500.00' }),
      }),
    )

    await openDropIncomeDialog(page)
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()

    // DROP_INCOME is pre-selected (only available type for a DROP).
    await dialog.getByTestId('create-transaction-project-trigger').click()
    await page.getByRole('option', { name: 'FOP Drop Project' }).click()

    await dialog.getByPlaceholder('0.00').fill('500')
    await dialog.getByTestId('receipt-input-mode-url').click()
    await dialog.getByTestId('receipt-input-url-field').fill('https://drive.example.com/r.pdf')

    const postReq = page.waitForRequest(
      (req) => req.url().endsWith('/api/transactions/drop-income') && req.method() === 'POST',
    )
    await dialog.getByTestId('create-transaction-submit').click()
    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>

    expect(body.projectId).toBe('proj-fop-drop')
    expect(body.amount).toBe(500)
    // ADR C14 / D7: DROP on FOP/GIG declares WITHOUT a receiver — `receiverId`
    // belongs ONLY to the new admin-USDT DTO (createUsdtIncomeSchema), never
    // to `createDropIncomeSchema`.
    expect(body).not.toHaveProperty('receiverId')

    await expect(dialog).not.toBeVisible()
  })
})
