/**
 * pending.spec.ts — task-pending-screen (position 7c), web-half coverage:
 * AC4 (actions), AC5 (nav badge + footer link), AC6 (empty state — happy
 * path only; loading/error/unknown-kind are unit-tested, not reachable
 * live), AC7 (responsive), and the SR-L-6 widget regression (no /projects
 * request from the dashboard widget). AC1-AC3's server-side masking is the
 * API-half's integration spec, not duplicated here (see
 * mutation-gate-integration-specs.md — this file is real-API/real-UI, not a
 * mock, so it exercises the actual RBAC/masking as a side effect, but that
 * is not what it is asserting on).
 *
 * Real API, real UI — same pattern as project-status-filter-ui.spec.ts:
 * every fixture call hits the real backend (page.request.*), no
 * page.route mocking. Requires the API half's `GET /pending` +
 * `listPendingProposedBy` to already be on this branch — see this task's
 * own "Разделение на две половины" note.
 */
import { test, expect, REAL_API_BASE, SEED_ADMIN_EMAIL, SEED_EMAILS } from './fixtures'
import {
  loginViaApi,
  createSeniorProjectViaAPI,
  patchUserSharePercentViaAPI,
  createDropViaAPI,
  cleanupDropViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

async function deleteProjectViaAPI(page: import('@playwright/test').Page, projectId: string) {
  await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
}

test.describe('/pending — AC4: project approval actions', () => {
  test('SENIOR: confirm a pending project — row disappears, toast, badge count drops by one', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Pending AC4 ${suffix}`,
      companyName: `Pending AC4 Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/pending')
      await expect(page.getByTestId('pending-page')).toBeVisible()
      await expect(page.getByText(`Pending AC4 Co ${suffix}`)).toBeVisible()

      const badgeBefore = await page
        .getByTestId('nav-pending-badge')
        .first()
        .textContent()
        .catch(() => null)

      await page.getByTestId(`project-approval-approve-${projectId}`).click()

      await expect(page.getByText(`Pending AC4 Co ${suffix}`)).not.toBeVisible()
      // COPY-M-8 wording ("Проект «X» подтверждён" / "Вы подтвердили. Ждём …") —
      // asserting the shared substring both branches carry.
      await expect(page.getByText(/подтвержд/i)).toBeVisible()

      if (badgeBefore && /^\d+$/.test(badgeBefore)) {
        const badgeAfter = await page
          .getByTestId('nav-pending-badge')
          .first()
          .textContent()
          .catch(() => '0')
        expect(Number(badgeAfter ?? '0')).toBe(Number(badgeBefore) - 1)
      }
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    }
  })

  test('SENIOR: reject a pending project with a reason — row disappears, toast; submit is disabled with an empty reason', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Pending Reject ${suffix}`,
      companyName: `Pending Reject Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/pending')
      await expect(page.getByText(`Pending Reject Co ${suffix}`)).toBeVisible()

      await page.getByTestId(`project-approval-reject-${projectId}`).click()
      const submit = page.getByTestId('project-approval-reject-submit')
      await expect(submit).toBeDisabled()

      await page.getByTestId('project-approval-reject-reason').fill('Нет бюджета на Q4')
      await expect(submit).toBeEnabled()
      await submit.click()

      await expect(page.getByText(`Pending Reject Co ${suffix}`)).not.toBeVisible()
      await expect(page.getByText('Проект отклонён, админ увидит причину')).toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    }
  })
})

// .serial: both tests below mutate the seed senior's own
// seniorSharePercent (a PENDING proposal is per-user, not per-run-scoped
// like a freshly created project) — running them in parallel workers would
// race on the same row. Same precedent as vacancies.spec.ts's describe.serial.
test.describe.serial('/pending — AC4: senior-share approval actions', () => {
  test('SENIOR: confirm a pending base-share change from /pending — row disappears from the Доли section', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const usersRes = await page.request.get(`${REAL_API}/users`)
    const users = (await usersRes.json()) as Array<{ id: string; email: string }>
    const seniorA = users.find((u) => u.email === SEED_EMAILS.seniorA)
    if (!seniorA) throw new Error('seed senior A not found')

    // Propose a base-share change — patchUserSharePercentViaAPI only
    // PROPOSES now (task-pending-share), it does not apply immediately.
    await patchUserSharePercentViaAPI(page, seniorA.id, { seniorSharePercent: 31 })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/pending')
      await expect(page.getByText('Доля по умолчанию')).toBeVisible()
      await expect(page.getByText(/предлагают 31%/)).toBeVisible()

      await page.getByTestId(`senior-share-approve-user-${seniorA.id}`).click()

      await expect(page.getByText('Доля по умолчанию')).not.toBeVisible()
      await expect(page.getByText(/Ваша доля теперь 31%/)).toBeVisible()
    } finally {
      // Best-effort restore — leaves the seed account at a known percent for
      // the next run rather than at whatever this test proposed.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await patchUserSharePercentViaAPI(page, seniorA.id, { seniorSharePercent: 26 })
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.request
        .post(`${REAL_API}/users/${seniorA.id}/senior-share/approve`)
        .catch(() => undefined)
    }
  })

  test('ADMIN: sees a pending base-share proposal under «Ждут решения других» and can cancel it', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const usersRes = await page.request.get(`${REAL_API}/users`)
    const users = (await usersRes.json()) as Array<{
      id: string
      email: string
      displayName: string
    }>
    const seniorB = users.find((u) => u.email === SEED_EMAILS.seniorB)
    if (!seniorB) throw new Error('seed senior B not found')

    await patchUserSharePercentViaAPI(page, seniorB.id, { seniorSharePercent: 33 })

    await page.goto('/pending')
    await expect(page.getByText(new RegExp(seniorB.displayName))).toBeVisible()

    await page.getByTestId(`cancel-pending-share-user`).first().click()
    await page.getByTestId('cancel-pending-share-confirm-button-user').click()

    await expect(page.getByText(new RegExp(`ждём.*${seniorB.displayName}`))).not.toBeVisible()
  })
})

test.describe('/pending — AC5: nav badge + notifications-bell footer link', () => {
  test('a freshly created, unattached DROP has no badge (mine.length === 0)', async ({ page }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, email } = await createDropViaAPI(page, {
      email: `pending-badge-${suffix}@cheekycheese.dev`,
      displayName: `Pending Badge Drop ${suffix}`,
      hrEmails: [SEED_EMAILS.hrA],
      accountantEmail: SEED_EMAILS.accountant,
    })

    try {
      await loginViaApi(page, email)
      await page.goto('/')
      await expect(page.getByTestId('nav-pending-badge')).toHaveCount(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('notifications-bell footer link navigates to /pending and closes the dropdown', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/')
    await page.getByTestId('notifications-bell-trigger').click()
    await expect(page.getByTestId('notifications-bell-dropdown')).toBeVisible()

    await page.getByTestId('notifications-bell-footer-pending-link').click()

    await expect(page).toHaveURL(/\/pending$/)
    await expect(page.getByTestId('notifications-bell-dropdown')).not.toBeVisible()
  })
})

test.describe('/pending — AC6: contract row (happy path, no live setup needed)', () => {
  test('SENIOR B (seeded READY_TO_SIGN) sees a Контракты row with the badge and an Открыть link — does not complete signing', async ({
    page,
  }) => {
    // dmytro.marchenko (SEED_EMAILS.seniorB) is deliberately parked at
    // READY_TO_SIGN forever for the onboarding-wizard specs (see
    // onboardDropViaAPI's own doc in fixtures.ts) — read-only here, no
    // mutation, so this test does not consume that state for anyone else.
    await loginViaApi(page, SEED_EMAILS.seniorB)
    await page.goto('/pending')

    await expect(page.getByText('Контракт сотрудника')).toBeVisible()
    await expect(page.getByText('готов к подписанию')).toBeVisible()
    // No approve/reject pair on this kind (task «Границы» — signing stays in
    // ContractTab/ContractActionBar).
    await expect(page.getByRole('button', { name: 'Подтвердить' })).toHaveCount(0)
  })
})

test.describe('/pending — AC7: responsive', () => {
  const WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920]

  test('no horizontal overflow at any tested width, with an 80-character project title', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const longTitle = 'A'.repeat(76) + suffix.slice(0, 4) // 80 chars total, unique enough to isolate

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `AC7 ${suffix}`,
      companyName: longTitle,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/pending')
      await expect(page.getByTestId(`pending-item-row-PROJECT_APPROVAL-${projectId}`)).toBeVisible()

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(100)

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        )
        expect(overflow, `horizontal overflow at ${width}px`).toBe(false)

        const row = page.getByTestId(`pending-item-row-PROJECT_APPROVAL-${projectId}`)
        const rowBox = await row.boundingBox()
        expect(rowBox, `row not measurable at ${width}px`).not.toBeNull()
        if (rowBox) {
          expect(
            rowBox.x + rowBox.width,
            `row right edge past viewport at ${width}px`,
          ).toBeLessThanOrEqual(width + 1)
        }

        if (width === 320 || width === 375) {
          const approveBox = await page
            .getByTestId(`project-approval-approve-${projectId}`)
            .boundingBox()
          expect(approveBox, `approve button not measurable at ${width}px`).not.toBeNull()
          if (approveBox) {
            expect(approveBox.height, `touch target < 44px at ${width}px`).toBeGreaterThanOrEqual(
              44,
            )
          }
        }
      }
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    }
  })
})

test.describe('/pending — SR-L-6: dashboard widget reads GET /pending, never GET /projects', () => {
  test('DROP dashboard load requests /pending for the widget, and never requests /projects', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, email } = await createDropViaAPI(page, {
      email: `pending-widget-${suffix}@cheekycheese.dev`,
      displayName: `Pending Widget Drop ${suffix}`,
      hrEmails: [SEED_EMAILS.hrA],
      accountantEmail: SEED_EMAILS.accountant,
    })

    try {
      await loginViaApi(page, email)

      const requestedUrls: string[] = []
      page.on('request', (req) => {
        const url = req.url()
        if (url.includes('/api/pending') || url.includes('/api/projects')) requestedUrls.push(url)
      })

      await page.goto('/')
      await page.waitForTimeout(500)

      expect(requestedUrls.some((u) => u.includes('/api/pending'))).toBe(true)
      expect(requestedUrls.some((u) => u.includes('/api/projects'))).toBe(false)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
