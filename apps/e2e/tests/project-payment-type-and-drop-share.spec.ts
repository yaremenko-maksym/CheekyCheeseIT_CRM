/**
 * project-payment-type-and-drop-share.spec.ts — task-drop-share-e2e
 * (Flow 3 AC3 + Flow 4 AC4).
 *
 * ADR `docs/architecture/2026-07-13-payment-type-income-routing.md` (D1, D6).
 * Mocked-fixture coverage of the project-edit-form surfaces added by this PR:
 *
 *   Flow 3 — «Тип оплаты» field-scoped RBAC (Surface C):
 *     - ADMIN/ACCOUNTANT: editable enum Select (`project-payment-type-trigger`).
 *     - SENIOR: the edit dialog is unreachable at all (`canOpenEdit` never
 *       includes SENIOR — pre-existing, unrelated to this PR) — sees the
 *       value read-only via the Overview «Детали проекта» InfoRow instead.
 *     - JUNIOR: the field is hidden entirely (client-side gate `role !==
 *       'JUNIOR'`, mirrors the backend Q5 masking to `null`).
 *
 *   Flow 4 — per-project drop-share override (Surface A):
 *     - ADMIN changes the «Доля дропа (%)» slider on a drop-project → the
 *       Финансы-tab breakdown panel (`project-drop-distribution`) reflects
 *       the new effective %.
 *     - The slider section is entirely absent on a non-drop project.
 *
 * Per feedback_mocked_e2e_guards: field-scoped RBAC 403s (HR/SENIOR/JUNIOR
 * attempting to PATCH `paymentType`/`dropSharePercentOverride`) are already
 * covered by backend unit/integration tests (task-drop-share-backend AC6).
 * These specs check the RENDERED UI (Select disabled state / field presence
 * / distribution math), not the backend guard.
 */
import { test, expect, USERS, PROJECTS, mockAuthAs } from './fixtures'

type ProjectOverrides = Partial<(typeof PROJECTS)[number]> & {
  dropId?: string | null
  dropName?: string | null
  dropSharePercent?: number | null
  dropSharePercentOverride?: number | null
  dropSharePercentDefault?: number | null
  effectiveDropSharePercent?: number | null
  effectiveDropShareSource?: 'PROJECT' | 'USER_DEFAULT' | null
  paymentType?: string | null
  effectiveTeam?: unknown
}

/**
 * Register a `/api/projects/:id` override AFTER `mockAuthAs` (LIFO — wins).
 * PATCH merges the body into the in-memory `detail` so a subsequent GET
 * (after the edit dialog saves) reflects the change — mirrors the pattern in
 * `projects-senior-share-override.spec.ts`. A PATCH touching
 * `dropSharePercentOverride` also recomputes `effectiveDropSharePercent` so
 * the Финансы breakdown panel (which reads the effective field, not the raw
 * override) updates too.
 */
function mockProjectDetail(
  page: import('@playwright/test').Page,
  overrides: ProjectOverrides = {},
) {
  const detail: Record<string, unknown> = {
    ...PROJECTS[0],
    dropId: null,
    dropName: null,
    dropSharePercent: null,
    dropSharePercentOverride: null,
    dropSharePercentDefault: 5,
    effectiveDropSharePercent: null,
    effectiveDropShareSource: null,
    paymentType: 'FOP',
    ...overrides,
    effectiveTeam: {
      senior: {
        id: USERS.senior.id,
        displayName: USERS.senior.displayName,
        email: USERS.senior.email,
        avatarUrl: null,
        avatarDocumentId: null,
        role: 'SENIOR' as const,
        profileNavigable: true,
      },
      drop: null,
      hrs: [],
      accountants: [],
      juniors: [],
      ...(overrides.effectiveTeam as object | undefined),
    },
  }
  return page.route(`**/api/projects/${PROJECTS[0]!.id}`, (r) => {
    if (r.request().method() === 'PATCH') {
      const body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>
      Object.assign(detail, body)
      if ('dropSharePercentOverride' in body) {
        const override = body.dropSharePercentOverride as number | null
        detail.effectiveDropSharePercent = override ?? (detail.dropSharePercentDefault as number)
        detail.effectiveDropShareSource = override != null ? 'PROJECT' : 'USER_DEFAULT'
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(detail),
      })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) })
  })
}

test.describe('«Тип оплаты» field-scoped RBAC — project edit (Flow 3, AC3)', () => {
  test('ADMIN sees an ENABLED paymentType Select, changes it, PATCH carries the enum value', async ({
    asAdmin: page,
  }) => {
    await mockProjectDetail(page, { paymentType: 'FOP' })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await page.getByTestId('project-edit-button').click()
    const trigger = page.getByTestId('project-payment-type-trigger')
    await expect(trigger).toBeVisible()
    await expect(trigger).toBeEnabled()

    await trigger.click()
    await page.getByRole('option', { name: 'USDT', exact: true }).click()

    const patchReq = page.waitForRequest(
      (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
    )
    await page.getByRole('button', { name: 'Сохранить' }).click()
    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body.paymentType).toBe('USDT')
  })

  test('ACCOUNTANT sees an ENABLED paymentType Select too', async ({ asAccountant: page }) => {
    await mockProjectDetail(page, { paymentType: 'FOP' })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await page.getByTestId('project-edit-button').click()
    const trigger = page.getByTestId('project-payment-type-trigger')
    await expect(trigger).toBeVisible()
    await expect(trigger).toBeEnabled()
  })

  test('SENIOR cannot open the edit dialog at all — sees the value read-only on Overview', async ({
    asSenior: page,
  }) => {
    // PROJECTS[0].seniorId === USERS.senior.id by default (fixtures.ts) — the
    // viewing SENIOR IS this project's senior.
    await mockProjectDetail(page, { paymentType: 'GIG_CONTRACT' })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await expect(page.getByTestId('project-edit-button')).not.toBeAttached()
    // Read-only display on the Overview «Детали проекта» card — RU label,
    // not the raw enum.
    await expect(page.getByText('гіг-контракт')).toBeVisible()
  })

  test('JUNIOR does not see the «Тип оплаты» row at all (masked, client-side hidden)', async ({
    asJunior: page,
  }) => {
    // Backend masks paymentType to null for JUNIOR (Q5) — simulate that DTO
    // shape directly; the row is ALSO explicitly gated client-side
    // (`user?.role !== 'JUNIOR'`), defense-in-depth per the design spec.
    await mockProjectDetail(page, { paymentType: null })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await expect(page.getByText('Тип оплаты')).not.toBeAttached()
  })
})

test.describe('Per-project drop-share override — project edit (Flow 4, AC4)', () => {
  test('ADMIN changes the drop-share slider → Финансы breakdown reflects the new effective %', async ({
    asAdmin: page,
  }) => {
    await mockProjectDetail(page, {
      dropId: USERS.drop.id,
      dropName: USERS.drop.displayName,
      dropSharePercent: 5,
      dropSharePercentOverride: null,
      dropSharePercentDefault: 5,
      effectiveDropSharePercent: 5,
      effectiveDropShareSource: 'USER_DEFAULT',
      seniorSharePercentOverride: null,
      seniorSharePercentDefault: 26,
    })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await page.getByTestId('project-edit-button').click()
    const section = page.getByTestId('project-edit-drop-share-section')
    await expect(section).toBeVisible()
    const input = page.getByTestId('project-edit-drop-share-override')
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue('5') // effective default shown initially
    await input.fill('20')

    const patchReq = page.waitForRequest(
      (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
    )
    await page.getByRole('button', { name: 'Сохранить' }).click()
    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body.dropSharePercentOverride).toBe(20)

    // Switch to Финансы tab — the breakdown panel reflects the new 20% share
    // ($1000 example × 20% = $200), NOT the stale 5% default.
    await page.getByTestId('tab-finance').click()
    const distribution = page.getByTestId('project-drop-distribution')
    await expect(distribution).toBeVisible()
    await expect(page.getByTestId('dist-drop-share')).toContainText('$200')
  })

  test('drop-share slider section is entirely absent on a non-drop project', async ({
    asAdmin: page,
  }) => {
    await mockProjectDetail(page, { dropId: null })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await page.getByTestId('project-edit-button').click()
    await expect(page.getByTestId('project-edit-drop-share-section')).not.toBeAttached()
  })

  test('distribution panel is entirely absent on a non-drop project (Финансы tab)', async ({
    asAdmin: page,
  }) => {
    await mockProjectDetail(page, { dropId: null })
    await page.goto(`/projects/${PROJECTS[0]!.id}`)

    await page.getByTestId('tab-finance').click()
    await expect(page.getByTestId('project-drop-distribution')).not.toBeAttached()
  })
})
