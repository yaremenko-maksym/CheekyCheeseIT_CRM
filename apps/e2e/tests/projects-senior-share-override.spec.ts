/**
 * E2E coverage for per-project SENIOR share % override.
 *
 * Spec: docs/specs/tasks/task-projects-senior-share-override.md (AC16)
 *       docs/specs/tasks/task-fix-pr39-ui-round2.md (UI round 2 — implicit null)
 *
 * Round-3 UI (PR #39 round 2 — task-fix-pr39-ui-round2):
 *   - Checkbox «Использовать переопределение» + кнопка «Сбросить» удалены.
 *   - <ShareSlider> всегда виден для ADMIN/ACCOUNTANT/SENIOR; disabled для
 *     SENIOR; полностью скрыт для HR (DOM не содержит секцию).
 *   - Implicit null: если slider value === senior's default, backend пишет
 *     `null` в projects.* и в project_finance_settings.*.
 *   - HR не видит финансовую информацию по проекту: табу «Финансы»,
 *     info-row «Доля синьора» в Обзоре, секцию ShareSlider в edit-форме.
 *
 * Scenarios:
 *   A) ADMIN can edit → переопределение сохраняется → "Override" badge.
 *   B) HR не видит секцию ShareSlider в edit-форме (DOM целиком отсутствует).
 *   C) ACCOUNTANT может редактировать → бэйдж появляется.
 *   D) Snapshot honored: SENIOR_INCOME row показывает Доля% из tx snapshot.
 *   E) PayoutDialog preview читает snapshot ("Ваша доля 30%", "К оплате 70%").
 *   F) Boundary 0 / 100 (ADMIN).
 *   G) ShareSlider клиентский clamp (0..100).
 *   H) Implicit null: ADMIN ставит value === default → PATCH carries default,
 *      и в read-view после save показывается "(по умолчанию)" + badge скрыт.
 *   I) Cross-screen consistency (live invalidation без reload).
 *   J) MyProjectShares widget (SENIOR-only).
 *   K) Legacy tx без snapshot → "approx" badge в PayoutDialog.
 *   L) Backend RBAC negative path: HR не отправляет override field.
 *   N) Финансы по проекту card renders ProjectShareInfo.
 *   O) HR не видит табу «Финансы» в /crm/projects/:id (новый round-2 scenario).
 *   P) HR не видит info-row «Доля синьора» на табе «Обзор» (новый round-2 scenario).
 *   Q) ADMIN/SENIOR всё ещё видят табу «Финансы» + info-row (regression check).
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

      // Round-3 UI: слайдер виден всегда без toggle. Открываем edit и
      // вбиваем 30 в число-поле слайдера.
      await page.getByTestId('project-edit-button').click()
      // Секция помечена `project-edit-senior-share-section` — родитель ShareSlider.
      await expect(page.getByTestId('project-edit-senior-share-section')).toBeVisible()
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeVisible()
      await expect(input).toBeEnabled()
      // По умолчанию слайдер показывает effective % (default = 26).
      await expect(input).toHaveValue('26')
      await input.fill('30')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
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

  test.describe('Scenario B — HR can no longer see the share section', () => {
    test('HR opens edit dialog, ShareSlider section is fully absent (not just disabled)', async ({
      asHr: page,
    }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // HR не видит info-row «Доля синьора» в Обзоре (round-2 scope).
      await expect(page.getByTestId('project-senior-share')).toHaveCount(0)

      // HR может открыть редактирование, но секция ShareSlider в DOM
      // полностью отсутствует (не disabled).
      await page.getByTestId('project-edit-button').click()
      await expect(page.getByTestId('project-edit-senior-share-section')).toHaveCount(0)
      await expect(page.getByTestId('project-edit-senior-share-override')).toHaveCount(0)

      // HR может править другое поле — request успешен БЕЗ
      // seniorSharePercentOverride в теле.
      const dialog = page.getByRole('dialog')
      await dialog.locator('textarea').first().fill('HR comment')
      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
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

      // Слайдер виден всегда, без toggle.
      await expect(page.getByTestId('project-edit-senior-share-section')).toBeVisible()
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeEnabled()
      await input.fill('35')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
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
    test('row "Доля: 30%" pulled from tx.seniorSharePercent snapshot', async ({
      asAdmin: page,
    }) => {
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
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([incomeTx]),
        }),
      )

      await page.goto('/crm/finance')
      const row = page.getByTestId(`tx-row-senior-share-${incomeTx.id}`)
      await expect(row).toBeVisible()
      await expect(row).toContainText('Доля: 30%')
    })
  })

  // Scenario E удалён в task-payout-auto-on-validate: PayoutDialog с per-tx
  // share% preview больше не существует. Snapshot share% теперь применяется
  // backend в auto-created PAYOUT row (amount = income * (1 - share/100)).
  // Покрытие snapshot — Scenario D (SENIOR_INCOME row показывает "Доля: 30%")
  // плюс finance-senior-flow.spec.ts шаг 5 (PayoutDetailDialog показывает
  // payable amount уже после server-side вычисления).

  // -------------------------------------------------------------------------
  // Edge-case coverage added by AutoTest (post-Coder verification)
  // -------------------------------------------------------------------------
  //
  // Coder shipped the happy paths A–E. The following scenarios cover boundary
  // values, validation, the MyProjectShares widget and a negative API-tampering
  // check.
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

    test('ADMIN saves override = 100 → badge shows "100%" + Override', async ({
      asAdmin: page,
    }) => {
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

  test.describe('Scenario G — ShareSlider client clamping (0..100)', () => {
    // The number input inside <ShareSlider> calls `clamp(value)` in onChange,
    // so out-of-range values are never propagated to the form state.
    test('value > 100 → clamped to 100, PATCH carries 100', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')

      await input.fill('150')
      // Clamp runs on `change`, so the DOM value is reset to '100' immediately.
      await expect(input).toHaveValue('100')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      expect(body['seniorSharePercentOverride']).toBe(100)
    })

    test('negative value → clamped to 0', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByTestId('project-edit-button').click()
      const input = page.getByTestId('project-edit-senior-share-override')

      await input.fill('-5')
      await expect(input).toHaveValue('0')
    })
  })

  test.describe('Scenario H — implicit null when value === default', () => {
    test('ADMIN с активным override (30) → выставляет slider на default (26) → save → backend пишет null, badge скрыт', async ({
      asAdmin: page,
    }) => {
      // Mock project с активным override = 30. Backend (мокаем тут как
      // прокси: при PATCH с body.value === senior_default=26 ответ возвращает
      // override=null) — implicit null применился.
      const detail = {
        ...PROJECTS[0],
        seniorSharePercentOverride: 30,
        seniorSharePercentDefault: 26,
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
        },
      }
      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, (r) => {
        if (r.request().method() === 'PATCH') {
          const body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>
          // Эмулируем implicit-null detection в backend: если override === default → null.
          const overrideRaw = body['seniorSharePercentOverride']
          if (overrideRaw === 26) {
            detail.seniorSharePercentOverride = null as unknown as number
          } else if (typeof overrideRaw === 'number') {
            detail.seniorSharePercentOverride = overrideRaw
          } else if (overrideRaw === null) {
            detail.seniorSharePercentOverride = null as unknown as number
          }
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

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // Sanity — badge изначально виден (override = 30).
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeVisible()

      await page.getByTestId('project-edit-button').click()
      // Слайдер виден, выставлен на 30 (= override).
      const input = page.getByTestId('project-edit-senior-share-override')
      await expect(input).toBeVisible()
      await expect(input).toHaveValue('30')

      // Ставим slider на default (26) — это implicit reset.
      await input.fill('26')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      // Фронт отправляет 26 (то что в слайдере) — backend сам решает что это null.
      expect('seniorSharePercentOverride' in body).toBe(true)
      expect(body['seniorSharePercentOverride']).toBe(26)

      // После save read-view синхронизируется: badge исчезает,
      // показывается "(по умолчанию)".
      await expect(page.getByTestId('project-senior-share')).toContainText('(по умолчанию)')
      await expect(page.getByTestId('project-senior-share-override-badge')).toBeHidden()
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

      // Edit → set 42 (different from default 26).
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

  test.describe('Scenario J — SENIOR share % in projects list (task-senior-ui-followups §2b)', () => {
    // The MyProjectShares widget was removed from /crm/finance (§2a).
    // Instead, the effective share % appears as an inline badge in each
    // ProjectRow on /crm/projects (only when viewerRole === 'SENIOR').
    test('SENIOR does NOT see the old MyProjectShares widget on /crm/finance', async ({
      asSenior: page,
    }) => {
      await page.goto('/crm/finance')
      // Widget was removed — must not be present in DOM at all.
      await expect(page.getByTestId('my-project-shares')).toHaveCount(0)
    })

    test('ADMIN does not see the SENIOR-only share badge on /crm/projects', async ({
      asAdmin: page,
    }) => {
      const projects = [
        {
          ...PROJECTS[0]!,
          id: 'proj-admin-view',
          name: 'AdminProject',
          seniorSharePercentOverride: 42,
          seniorSharePercentDefault: 26,
          archivedAt: null,
        },
      ]
      await page.route('http://localhost:3001/api/projects**', (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(projects),
          })
        }
        return r.fallback()
      })
      await page.goto('/crm/projects')
      // ADMIN viewer — no senior-share badge rendered for ADMIN role
      await expect(page.getByTestId('project-row-proj-admin-view-senior-share')).toHaveCount(0)
    })

    test('SENIOR sees effective share % badge in each ProjectRow on /crm/projects', async ({
      asSenior: page,
    }) => {
      // One project with override, one using default share.
      const projects = [
        {
          ...PROJECTS[0]!,
          id: 'proj-w-override',
          name: 'OverrideProject',
          seniorSharePercentOverride: 42,
          seniorSharePercentDefault: 26,
          archivedAt: null,
        },
        {
          ...PROJECTS[0]!,
          id: 'proj-default',
          name: 'DefaultProject',
          seniorSharePercentOverride: null,
          seniorSharePercentDefault: 26,
          archivedAt: null,
        },
      ]
      await page.route('http://localhost:3001/api/projects**', (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(projects),
          })
        }
        return r.fallback()
      })

      await page.goto('/crm/projects')

      // Project with override: badge shows "42%"
      const overrideBadge = page.getByTestId('project-row-proj-w-override-senior-share')
      await expect(overrideBadge).toBeVisible()
      await expect(overrideBadge).toContainText('42%')

      // Project using default: badge shows "26%" (seniorSharePercentDefault)
      const defaultBadge = page.getByTestId('project-row-proj-default-senior-share')
      await expect(defaultBadge).toBeVisible()
      await expect(defaultBadge).toContainText('26%')
    })
  })

  // Scenario K удалён в task-payout-auto-on-validate: «approx» badge жил
  // только в PayoutDialog preview (frontend-only fallback). После перехода
  // на auto-create, legacy fallback (`senior.seniorSharePercent ?? 26`)
  // выполняется server-side в transactions.service.ts validateTransaction
  // (см. строку `tx.seniorSharePercent ?? senior.seniorSharePercent ?? 26`),
  // и UI больше не показывает estimate badge — итоговая сумма уже точная.

  test.describe('Scenario L — backend RBAC enforcement (negative path)', () => {
    test('HR не отправляет seniorSharePercentOverride в PATCH (DOM-section отсутствует)', async ({
      asHr: page,
    }) => {
      // Stand-in for a real backend RBAC failure: интерсептим PATCH и
      // возвращаем 403 если поле override присутствует. Frontend для HR
      // больше не имеет секции в DOM — поле никогда не отправляется.
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

      // Sanity — секция отсутствует, override никогда не отправится.
      await expect(page.getByTestId('project-edit-senior-share-section')).toHaveCount(0)

      // Change a non-restricted field — should succeed.
      const dialog = page.getByRole('dialog')
      await dialog.locator('textarea').first().fill('HR-edited notes')
      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )
      await page.getByRole('button', { name: 'Сохранить' }).click()
      const body = JSON.parse((await patchReq).postData() ?? '{}') as Record<string, unknown>
      expect('seniorSharePercentOverride' in body).toBe(false)
      // Confirm our 403 guard was never triggered.
      expect(receivedOverrideField).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Scenario N — финансовая секция «Финансы по проекту» (ADMIN-only видна,
  // т.к. HR не может попасть на табу «Финансы» в round-2).
  // -------------------------------------------------------------------------

  test.describe('Scenario N — finance section share row mirrors the read view', () => {
    test('CardHeader renders the same effective % + Override badge (ADMIN)', async ({
      asAdmin: page,
    }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 33 })
      // The transactions list is empty, but the header still has to render.
      await page.route('http://localhost:3001/api/transactions**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
      )

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)

      // Read-only Info card has its widget (Обзор tab — default).
      await expect(page.getByTestId('project-senior-share')).toContainText('33%')

      // The Финансы по проекту block lives under the «Финансы» tab.
      await page.getByRole('tab', { name: 'Финансы' }).click()

      // Финансы по проекту header has the same widget with a distinct testId.
      const financeRow = page.getByTestId('project-transactions-senior-share')
      await expect(financeRow).toBeVisible()
      await expect(financeRow).toContainText('33%')
      await expect(financeRow).toContainText('Доля синьора')
      await expect(
        page.getByTestId('project-transactions-senior-share-override-badge'),
      ).toBeVisible()
    })

    test('without override: row shows "(по умолчанию)" copy (ADMIN)', async ({ asAdmin: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: null })
      await page.route('http://localhost:3001/api/transactions**', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
      )

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByRole('tab', { name: 'Финансы' }).click()

      const financeRow = page.getByTestId('project-transactions-senior-share')
      await expect(financeRow).toBeVisible()
      await expect(financeRow).toContainText('26%')
      await expect(financeRow).toContainText('(по умолчанию)')
      await expect(
        page.getByTestId('project-transactions-senior-share-override-badge'),
      ).toHaveCount(0)
    })
  })

  // -------------------------------------------------------------------------
  // PR #39 round 2 — HR RBAC new scenarios (task-fix-pr39-ui-round2)
  // -------------------------------------------------------------------------

  test.describe('Scenario O — HR не видит табу «Финансы» в /crm/projects/:id', () => {
    test('HR opens project detail → tab «Финансы» is absent', async ({ asHr: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // Табы «Обзор» и «Состав» доступны.
      await expect(page.getByRole('tab', { name: 'Обзор' })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Состав' })).toBeVisible()
      // А «Финансы» — НЕ должно быть.
      await expect(page.getByRole('tab', { name: 'Финансы' })).toHaveCount(0)
    })
  })

  test.describe('Scenario P — HR не видит info-row «Доля синьора» в Обзоре', () => {
    test('HR на /crm/projects/:id Обзор не видит ProjectShareInfo', async ({ asHr: page }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 33 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // Sanity — мы на «Обзоре».
      await expect(page.getByRole('tab', { name: 'Обзор' })).toBeVisible()
      // Виджет project-senior-share полностью отсутствует в DOM для HR.
      await expect(page.getByTestId('project-senior-share')).toHaveCount(0)
      // Бейдж тоже отсутствует.
      await expect(page.getByTestId('project-senior-share-override-badge')).toHaveCount(0)
    })
  })

  test.describe('Scenario Q — ADMIN/SENIOR/ACCOUNTANT всё ещё видят финансовые элементы (regression)', () => {
    test('ADMIN на /crm/projects/:id видит табу «Финансы» + info-row', async ({
      asAdmin: page,
    }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await expect(page.getByRole('tab', { name: 'Финансы' })).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toContainText('30%')
    })

    test('SENIOR на /crm/projects/:id видит табу «Финансы» + info-row', async ({
      asSenior: page,
    }) => {
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await expect(page.getByRole('tab', { name: 'Финансы' })).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toContainText('30%')
    })

    test('ACCOUNTANT на /crm/projects/:id видит табу «Финансы» + info-row + ShareSlider editable', async ({
      page,
    }) => {
      await mockAuthAs(page, USERS.accountant)
      await mockProjectDetail(page, { seniorSharePercentOverride: 30 })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await expect(page.getByRole('tab', { name: 'Финансы' })).toBeVisible()
      await expect(page.getByTestId('project-senior-share')).toBeVisible()

      await page.getByTestId('project-edit-button').click()
      await expect(page.getByTestId('project-edit-senior-share-section')).toBeVisible()
      await expect(page.getByTestId('project-edit-senior-share-override')).toBeEnabled()
    })
  })
})

// ---------------------------------------------------------------------------
// Login auth-guard — Round-1 round-2 PR #39 fix (правка 3).
// ---------------------------------------------------------------------------
//
// Once a user is already authenticated, navigating to /crm/login should
// auto-redirect them to /crm (the dashboard). Previously broken because
// <AuthProvider skip> blocked the /auth/me query.

test.describe('login auth-guard', () => {
  // Wait for the URL to leave /crm/login. The TanStack Router redirect lands
  // on /crm (the index dashboard) but we don't want to over-couple to that
  // exact path — any non-/login pathname under /crm counts as "redirected".
  const waitForRedirect = async (page: import('@playwright/test').Page) =>
    page.waitForURL((url) => new URL(url).pathname !== '/crm/login', {
      timeout: 5_000,
    })

  test('ADMIN visiting /crm/login is redirected to /crm', async ({ asAdmin: page }) => {
    // The fixture already mocked /api/auth/me to return USERS.admin.
    await page.goto('/crm/login')
    await waitForRedirect(page)
    expect(new URL(page.url()).pathname).not.toBe('/crm/login')
    expect(new URL(page.url()).pathname).toMatch(/^\/crm/)
  })

  test('SENIOR visiting /crm/login is redirected to /crm', async ({ asSenior: page }) => {
    await page.goto('/crm/login')
    await waitForRedirect(page)
    expect(new URL(page.url()).pathname).not.toBe('/crm/login')
    expect(new URL(page.url()).pathname).toMatch(/^\/crm/)
  })

  test('unauthenticated visitor stays on /crm/login', async ({ page }) => {
    // No mockAuthAs → /api/auth/me would otherwise hit the real backend. We
    // intercept it to force a 401 so the spec is deterministic.
    await page.route('http://localhost:3001/api/auth/me', (r) =>
      r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    )
    await page.goto('/crm/login')
    // Give the redirect effect a chance to (not) fire.
    await page.waitForTimeout(500)
    expect(new URL(page.url()).pathname).toBe('/crm/login')
    // The login UI is rendered (header copy serves as a fingerprint).
    await expect(page.getByText('CheekyCheeseIT CRM')).toBeVisible()
  })
})
