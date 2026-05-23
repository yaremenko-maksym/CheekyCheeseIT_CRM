/**
 * E2E coverage for per-project SENIOR share % override.
 *
 * Spec: docs/specs/tasks/task-projects-senior-share-override.md (AC16)
 *
 * Scenarios:
 *   A) ADMIN can edit → field saves → reload shows "Override" badge.
 *   B) HR can open the dialog but the override input is disabled; other
 *      fields still patch successfully (no override in body).
 *   C) ACCOUNTANT can edit and the badge appears.
 *   D) Snapshot is honored: SENIOR_INCOME row renders "Доля: X%" from the
 *      transaction snapshot, not the user's global default.
 *   E) PayoutDialog preview reads the snapshot ("Ваша доля 30%", "К оплате 70%").
 *
 * All scenarios run against the mocked /api/* responses defined in fixtures.ts.
 */
import { test, expect, USERS, PROJECTS, mockAuthAs } from './fixtures'

// Helper — register a one-off override of the /api/projects/:id response so
// each scenario can present the project in whatever override state it needs.
function mockProjectDetail(
  page: import('@playwright/test').Page,
  overrides: Partial<(typeof PROJECTS)[number]> & { effectiveTeam?: unknown } = {},
) {
  const detail = {
    ...PROJECTS[0],
    ...overrides,
    effectiveTeam: {
      senior: {
        id: USERS.senior.id,
        displayName: USERS.senior.displayName,
        email: USERS.senior.email,
        avatar: null,
        role: 'SENIOR' as const,
      },
      hrs: [],
      accountants: [],
      juniors: [],
      ...(overrides.effectiveTeam as object | undefined),
    },
  }
  // page.route registered AFTER mockAuthAs takes precedence — Playwright runs
  // route handlers in reverse-registration order.
  return page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, (r) => {
    if (r.request().method() === 'PATCH') {
      const body = JSON.parse(r.request().postData() ?? '{}') as Partial<typeof detail>
      Object.assign(detail, body)
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(detail),
      })
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(detail),
    })
  })
}

test.describe('per-project SENIOR share override', () => {
  test.describe('Scenario A — ADMIN can edit', () => {
    test('saves new override → badge appears after reload', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await expect(page.getByTestId('project-senior-share')).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toContainText('26%')
      await expect(page.getByTestId('project-senior-share')).toContainText('(по умолчанию)')

      // Open the edit dialog and set override = 30.
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeEnabled()
      await input.fill('30')

      const patchReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/projects/${PROJECTS[0]!.id}`) &&
          req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body['seniorSharePercentOverride']).toBe(30)

      // After save, the read view reflects the new value.
      await expect(page.getByTestId('project-senior-share')).toContainText('30%')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()
    })
  })

  test.describe('Scenario B — HR blocked from changing override', () => {
    test('HR opens dialog, override input is disabled, other fields still save', async ({ asHr: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // HR sees the read-only badge.
      await expect(page.getByTestId('project-senior-share')).toContainText('30%')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()

      // HR can open edit but the override field is disabled.
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeDisabled()
      const reset = page.getByTestId('project-edit-senior-share-reset')
      await expect(reset).toBeDisabled()

      // HR may change another field (e.g. notes) — request must succeed
      // without `seniorSharePercentOverride` in the body. The textarea is
      // not wired to its <Label>, so target by role + scoped to the dialog.
      const dialog = page.getByRole('dialog')
      await dialog.locator('textarea').first().fill('HR comment')
      const patchReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/projects/${PROJECTS[0]!.id}`) &&
          req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect('seniorSharePercentOverride' in body).toBe(false)
    })
  })

  test.describe('Scenario C — ACCOUNTANT can edit override', () => {
    test('ACCOUNTANT opens edit, sets override = 35, saves', async ({ page }) => {
      await mockAuthAs(page, USERS.accountant)
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()

      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeEnabled()
      await input.fill('35')

      const patchReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/projects/${PROJECTS[0]!.id}`) &&
          req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body['seniorSharePercentOverride']).toBe(35)

      await expect(page.getByTestId('project-senior-share')).toContainText('35%')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()
    })
  })

  test.describe('Scenario D — SENIOR_INCOME row shows snapshot %', () => {
    test('row "Доля: 30%" pulled from tx.seniorSharePercent snapshot', async ({ asAdmin: page }) => {
      const incomeTx = {
        id: 'tx-snapshot-1',
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '1000.000000',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'TechCorp AI',
        senderName: null,
        receiverId: USERS.senior.id,
        receiverLabel: null,
        receiverName: USERS.senior.displayName,
        projectId: PROJECTS[0]!.id,
        projectName: PROJECTS[0]!.name,
        payoutRequestId: null,
        // Snapshot captured at creation, after the project override was set to 30.
        seniorSharePercent: 30,
        receiptUrl: null,
        notes: null,
        rejectionReason: null,
        validatedBy: null,
        validatedAt: null,
        salaryMonth: null,
        txHash: null,
        txDate: '2026-05-10T00:00:00.000Z',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
        createdBy: USERS.senior.id,
      }
      await page.route('http://localhost:3001/api/transactions', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([incomeTx]) }),
      )

      await page.goto('/crm/finance')
      const row = page.getByTestId(`tx-row-senior-share-${incomeTx.id}`)
      await expect(row).toBeVisible()
      await expect(row).toContainText('Доля: 30%')
    })
  })

  test.describe('Scenario E — PayoutDialog preview reads snapshot', () => {
    test('SENIOR sees "Ваша доля 30%: 300" + "К оплате 70%: 700"', async ({ asSenior: page }) => {
      const incomeTx = {
        id: 'tx-payout-1',
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '1000.000000',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'TechCorp AI',
        senderName: null,
        receiverId: USERS.senior.id,
        receiverLabel: null,
        receiverName: USERS.senior.displayName,
        projectId: PROJECTS[0]!.id,
        projectName: PROJECTS[0]!.name,
        payoutRequestId: null,
        seniorSharePercent: 30,
        receiptUrl: null,
        notes: null,
        rejectionReason: null,
        validatedBy: USERS.admin.id,
        validatedAt: '2026-05-10T00:00:00.000Z',
        salaryMonth: null,
        txHash: null,
        txDate: '2026-05-10T00:00:00.000Z',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
        createdBy: USERS.senior.id,
        // SENIOR createdBy=self so the senderId filter (line 350 in finance/index.tsx)
        // does include this row. The dialog uses `senderId === userId` filter:
      }
      // The validatedForPayout filter in finance/index.tsx requires senderId === userId.
      // We aren't strict on that field in the mock — just ensure transactions list returns one row.
      const txForPayout = { ...incomeTx, senderId: USERS.senior.id }
      await page.route('http://localhost:3001/api/transactions', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([txForPayout]) }),
      )

      await page.goto('/crm/finance')

      // Open the payout dialog.
      await page.getByRole('button', { name: /Выплатить/i }).click()

      // Select the transaction.
      const checkbox = page.locator('input[type="checkbox"]').first()
      await checkbox.check()

      // Per-tx preview row appears.
      const previewRow = page.getByTestId(`payout-preview-row-${txForPayout.id}`)
      await expect(previewRow).toBeVisible()
      await expect(previewRow).toContainText('Ваша доля 30%')
      await expect(previewRow).toContainText('К оплате 70%')

      // Totals block — total payable = 700.
      const total = page.getByTestId('payout-preview-total')
      await expect(total).toBeVisible()
      await expect(total).toContainText('700')
    })
  })
})
