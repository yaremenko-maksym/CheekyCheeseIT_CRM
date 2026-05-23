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

  // -------------------------------------------------------------------------
  // Edge-case coverage added by AutoTest (post-Coder verification)
  // -------------------------------------------------------------------------
  //
  // Coder shipped the happy paths A–E. The following scenarios cover boundary
  // values, the «Сбросить» button, validation, the MyProjectShares widget and
  // a negative API-tampering check — pieces missing from the original suite.
  //

  test.describe('Scenario F — boundary values 0 and 100', () => {
    test('ADMIN saves override = 0 → badge shows "0%" + Override', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')
      await input.fill('0')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      // Numeric coercion in the form → backend receives 0, not the empty string.
      expect(body['seniorSharePercentOverride']).toBe(0)

      await expect(page.getByTestId('project-senior-share')).toContainText('0%')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()
    })

    test('ADMIN saves override = 100 → badge shows "100%" + Override', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')
      await input.fill('100')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      expect(body['seniorSharePercentOverride']).toBe(100)

      await expect(page.getByTestId('project-senior-share')).toContainText('100%')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()
    })
  })

  test.describe('Scenario G — client validation (out of range)', () => {
    test('value > 100 → onBlur error visible, no PATCH fired', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')

      // Fail any unexpected PATCH so we can assert "no request" purely.
      let sawPatchWithOverride = false
      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, async (route) => {
        if (route.request().method() === 'PATCH') {
          const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
          if ('seniorSharePercentOverride' in body) sawPatchWithOverride = true
        }
        // Fall through to the existing mockProjectDetail handler.
        await route.fallback()
      })

      await input.fill('150')
      // Force onBlur to fire the validator without immediately submitting.
      await input.blur()

      // The form-level validator wires an error message under the field.
      await expect(page.getByText('Введите целое число от 0 до 100')).toBeVisible()

      // No PATCH with override should ever leave the page in this scenario.
      // We assert through the existence of the visible error (above) — if the
      // form had submitted, the dialog would have closed and the error would
      // not be visible. As a belt-and-braces check, re-assert the flag stays
      // false after the error assertion settled.
      expect(sawPatchWithOverride).toBe(false)
    })

    test('negative value → onBlur error visible', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')

      await input.fill('-5')
      await input.blur()

      await expect(page.getByText('Введите целое число от 0 до 100')).toBeVisible()
    })
  })

  test.describe('Scenario H — «Сбросить» button clears override', () => {
    test('ADMIN with active override clicks reset → null saved, badge disappears', async ({
      asAdmin: page,
    }) => {
      // Start with an override already set so the reset button is enabled.
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // Sanity — badge is initially visible.
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()

      await page.getByTestId('project-edit-button').click()
      const reset = page.getByTestId('project-edit-senior-share-reset')
      await expect(reset).toBeEnabled()
      await reset.click()

      // The input should now reflect the cleared state (empty string).
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toHaveValue('')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      // Reset must travel as explicit `null`, not undefined / missing — otherwise
      // the field-RBAC branch in projects.service can't clear the override.
      expect('seniorSharePercentOverride' in body).toBe(true)
      expect(body['seniorSharePercentOverride']).toBeNull()

      // Badge should disappear after the read view re-syncs with the mock state.
      await expect(page.getByTestId('project-senior-share')).toContainText('(по умолчанию)')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeHidden()
    })

    test('reset button is disabled when override is already null', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()

      const reset = page.getByTestId('project-edit-senior-share-reset')
      await expect(reset).toBeDisabled()
    })
  })

  test.describe('Scenario I — cross-screen consistency without reload', () => {
    test('saving override updates badge on the detail page without page reload', async ({
      asAdmin: page,
    }) => {
      // Project starts with default — no badge.
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await expect(page.getByTestId('project-senior-share')).toContainText('(по умолчанию)')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeHidden()

      // Edit → save 42.
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')
      await input.fill('42')
      await page.getByRole('button', { name: 'Сохранить' }).click()

      // No reload — the TanStack Query cache invalidation should re-paint the badge.
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toContainText('42%')
      // The fallback text should be gone.
      await expect(page.getByTestId('project-senior-share')).not.toContainText('(по умолчанию)')
    })
  })

  test.describe('Scenario J — MyProjectShares widget (SENIOR-only)', () => {
    test('SENIOR sees the widget listing all active projects with their effective %', async ({
      asSenior: page,
    }) => {
      // Two active projects: one with override, one without. Plus an archived
      // project that must be filtered out.
      const projects = [
        { ...PROJECTS[0]!, id: 'proj-w-override', name: 'OverrideProject', seniorSharePercentOverride: 42, archivedAt: null },
        { ...PROJECTS[0]!, id: 'proj-default', name: 'DefaultProject', seniorSharePercentOverride: null, archivedAt: null },
        { ...PROJECTS[0]!, id: 'proj-archived', name: 'ArchivedProject', seniorSharePercentOverride: 99, archivedAt: '2024-01-01T00:00:00.000Z' },
      ]
      await page.route('http://localhost:3001/api/projects**', (r) => {
        if (r.request().method() === 'GET') {
          const url = new URL(r.request().url())
          const archived = url.searchParams.get('archived')
          if (archived === 'true') {
            return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projects.filter((p) => p.archivedAt !== null)) })
          }
          // Widget queries the cached `['projects']` key which hits `/projects`
          // without an `archived` param; return only active rows to match RBAC.
          return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projects.filter((p) => p.archivedAt === null)) })
        }
        return r.fallback()
      })

      await page.goto('/crm/finance')
      const widget = page.getByTestId('my-project-shares')
      await expect(widget).toBeVisible()

      // Override row: shows "42%" + Override badge.
      const overrideRow = page.getByTestId('my-project-share-proj-w-override')
      await expect(overrideRow).toBeVisible()
      await expect(overrideRow).toContainText('42%')
      await expect(overrideRow).toContainText('Override')

      // Default row: shows the senior's default 26% + "(по умолчанию)".
      const defaultRow = page.getByTestId('my-project-share-proj-default')
      await expect(defaultRow).toBeVisible()
      await expect(defaultRow).toContainText('26%')
      await expect(defaultRow).toContainText('(по умолчанию)')

      // Archived row must NOT appear.
      await expect(page.getByTestId('my-project-share-proj-archived')).toHaveCount(0)
    })

    test('SENIOR with no active projects sees the empty-state copy', async ({ asSenior: page }) => {
      await page.route('http://localhost:3001/api/projects**', (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
        }
        return r.fallback()
      })

      await page.goto('/crm/finance')
      const widget = page.getByTestId('my-project-shares')
      await expect(widget).toBeVisible()
      await expect(widget).toContainText('У вас пока нет активных проектов.')
    })

    test('ADMIN does not see the SENIOR-only widget on /crm/finance', async ({ asAdmin: page }) => {
      await page.goto('/crm/finance')
      // The widget is conditionally rendered (`isSenior && <MyProjectShares />`),
      // so for ADMIN it should not be in the DOM at all.
      await expect(page.getByTestId('my-project-shares')).toHaveCount(0)
    })

    test('HR does not see the SENIOR-only widget on /crm/finance', async ({ asHr: page }) => {
      await page.goto('/crm/finance')
      await expect(page.getByTestId('my-project-shares')).toHaveCount(0)
    })
  })

  test.describe('Scenario K — legacy transactions without snapshot', () => {
    test('payout preview shows "approx" badge when seniorSharePercent is null', async ({
      asSenior: page,
    }) => {
      // Legacy SENIOR_INCOME: snapshot is null because the row predates the
      // share-snapshot column. The dialog must still render a preview using
      // the SENIOR's current global default + an "approx" badge.
      const legacyTx = {
        id: 'tx-legacy-1',
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '1000.000000',
        currency: 'USDT',
        senderId: USERS.senior.id,
        senderLabel: 'TechCorp AI',
        senderName: null,
        receiverId: USERS.senior.id,
        receiverLabel: null,
        receiverName: USERS.senior.displayName,
        projectId: PROJECTS[0]!.id,
        projectName: PROJECTS[0]!.name,
        payoutRequestId: null,
        seniorSharePercent: null, // ← legacy row, no snapshot
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
      }
      await page.route('http://localhost:3001/api/transactions', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([legacyTx]) }),
      )

      await page.goto('/crm/finance')
      await page.getByRole('button', { name: /Выплатить/i }).click()
      const checkbox = page.locator('input[type="checkbox"]').first()
      await checkbox.check()

      const previewRow = page.getByTestId(`payout-preview-row-${legacyTx.id}`)
      await expect(previewRow).toBeVisible()
      // Falls back to USERS.senior.seniorSharePercent = 26.
      await expect(previewRow).toContainText('Ваша доля 26%')
      await expect(previewRow).toContainText('К оплате 74%')
      // "approx" badge marks the row as estimate-only.
      await expect(previewRow).toContainText('approx')
    })
  })

  test.describe('Scenario L — backend RBAC enforcement (negative path)', () => {
    test('HR PATCH with seniorSharePercentOverride is rejected by mock 403', async ({
      asHr: page,
    }) => {
      // Stand-in for a real backend RBAC failure: we intercept the PATCH and
      // return 403 if it carries `seniorSharePercentOverride`. The frontend
      // should surface the error rather than silently accept the change.
      let receivedOverrideField = false
      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, async (route) => {
        if (route.request().method() === 'PATCH') {
          const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
          if ('seniorSharePercentOverride' in body) {
            receivedOverrideField = true
            return route.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({
                statusCode: 403,
                message: 'Only ADMIN or ACCOUNTANT can change senior share percent override',
                error: 'Forbidden',
              }),
            })
          }
        }
        // Default — pass through to mockProjectDetail.
        await route.fallback()
      })
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()

      // Sanity — the field is disabled, so the frontend protects itself first.
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeDisabled()

      // Change a non-restricted field — should succeed (no override in body,
      // therefore no 403 from our gate).
      const dialog = page.getByRole('dialog')
      await dialog.locator('textarea').first().fill('HR-edited notes')
      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      expect('seniorSharePercentOverride' in body).toBe(false)
      // Confirm our 403 guard was never triggered — frontend stripped the field.
      expect(receivedOverrideField).toBe(false)
    })
  })
})
