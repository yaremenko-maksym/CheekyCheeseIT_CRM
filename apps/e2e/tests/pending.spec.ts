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
  onboardDropViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

async function deleteProjectViaAPI(page: import('@playwright/test').Page, projectId: string) {
  await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
}

/**
 * design spec §7: `0` renders no badge at all, `1-9` an exact number, `10+`
 * capped at "99+". `parseInt` (not `Number`) tolerates the trailing `+` —
 * returns `0` when the badge element is absent (nav-pending-badge only
 * renders when `mine.length > 0`), never throws, so callers can always
 * assert unconditionally instead of branching on presence.
 */
async function navPendingBadgeCount(page: import('@playwright/test').Page): Promise<number> {
  const badge = page.getByTestId('nav-pending-badge').first()
  if ((await badge.count()) === 0) return 0
  const text = (await badge.textContent()) ?? '0'
  return parseInt(text, 10) || 0
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
      const row = page.getByTestId(`pending-item-row-PROJECT_APPROVAL-${projectId}`)
      await expect(row).toBeVisible()
      await expect(row).toContainText(`Pending AC4 Co ${suffix}`)

      const badgeBefore = await navPendingBadgeCount(page)

      await page.getByTestId(`project-approval-approve-${projectId}`).click()

      // Anchored on the ROW, not on the company name as free text: the
      // success toast QUOTES that same name ("Проект «…» подтверждён"), so a
      // text-based `not.toBeVisible()` would wait out the toast's own 4s
      // lifetime and then assert against a page where it is already gone —
      // which is exactly how this line failed before (measured, not guessed).
      await expect(row).toBeHidden()
      // COPY-M-8 wording ("Проект «X» подтверждён" / "Вы подтвердили. Ждём …") —
      // asserting the shared substring both branches carry.
      await expect(page.getByText(/подтвержд/i)).toBeVisible()

      const badgeAfter = await navPendingBadgeCount(page)
      expect(badgeAfter).toBe(badgeBefore - 1)
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
      // Row-anchored for the same reason as the confirm test above — plus
      // the reject DIALOG's own heading quotes the company name too
      // («Отклонить проект «…»»), so bare text here is a strict-mode
      // violation the moment the dialog opens.
      const row = page.getByTestId(`pending-item-row-PROJECT_APPROVAL-${projectId}`)
      await expect(row).toBeVisible()
      await expect(row).toContainText(`Pending Reject Co ${suffix}`)

      await page.getByTestId(`project-approval-reject-${projectId}`).click()
      const submit = page.getByTestId('project-approval-reject-submit')
      await expect(submit).toBeDisabled()

      await page.getByTestId('project-approval-reject-reason').fill('Нет бюджета на Q4')
      await expect(submit).toBeEnabled()
      await submit.click()

      await expect(row).toBeHidden()
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
      // Row-anchored, and deliberately NOT `getByText('Доля по умолчанию')`:
      // since COPY-L-1 the toast says «Доля по умолчанию теперь 31%», which
      // CONTAINS the row's title. A text-based "row is gone" assertion would
      // therefore also wait for the toast to expire — and then the toast
      // assertion below could only ever look at an empty toast region
      // (measured: that is exactly how this test failed once).
      const shareRow = page.getByTestId(`pending-item-row-SHARE_APPROVAL-${seniorA.id}`)
      await expect(shareRow).toBeVisible()
      await expect(shareRow).toContainText('Доля по умолчанию')
      await expect(page.getByText(/предлагают 31%/)).toBeVisible()

      await page.getByTestId(`senior-share-approve-user-${seniorA.id}`).click()

      // Transient first (a toast outlives neither the wait above nor a long
      // poll), persistent second.
      await expect(page.getByText(/Доля по умолчанию теперь 31%/)).toBeVisible()
      await expect(shareRow).toBeHidden()
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
    // Row-anchored: the person's name is in the row title («Доля по
    // умолчанию — {имя}», COPY-M-4), and the same name also appears in the
    // users list this ADMIN view renders elsewhere — matching it as free
    // text is a strict-mode violation by construction.
    // (Before COPY-M-4 the name was printed twice inside this row alone:
    // as the whole title AND in the «ждём: …» meta. That duplicate is what
    // the finding removed; the meta here is now «Сейчас X% → предложено Y%»
    // on one line and the давность on the next.)
    const row = page.getByTestId(`pending-item-row-SHARE_APPROVAL-${seniorB.id}`)
    await expect(row).toBeVisible()
    await expect(row).toContainText(seniorB.displayName)

    await page.getByTestId(`cancel-pending-share-user`).first().click()
    await page.getByTestId('cancel-pending-share-confirm-button-user').click()

    await expect(row).toBeHidden()
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

// ---------------------------------------------------------------------------
// AC6 — the CONTRACT_TO_SIGN row has NO live E2E, on purpose (integration
// decision 6, 2026-09-11).
//
// A user whose contract is still unsigned never reaches this screen: the
// server refuses every non-onboarding endpoint for them, `GET /pending`
// included. Measured against the running stack, not assumed:
//
//   GET /api/pending as dmytro.marchenko (seeded READY_TO_SIGN)
//   → 403 {"error":"ONBOARDING_REQUIRED","missing":["contract","tos"]}
//
// and the web router redirects the same user to /onboarding before the route
// even mounts (`_authenticated/route.tsx`'s onboarding gate). The kind stays
// in the schema and in the aggregate — it becomes reachable the day a
// contract appears for an ALREADY-onboarded user — and it keeps its
// server-side coverage (`pending.integration.spec.ts` AC1's
// JUNIOR/HR/ACCOUNTANT cases build it against a real Postgres) plus its
// client-side rendering coverage (`PendingItemRow.test.tsx`'s
// CONTRACT_TO_SIGN cases). What cannot exist today is the live browser path,
// so there is no test pretending to walk it.
// ---------------------------------------------------------------------------

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
        expect(
          (rowBox as { x: number; width: number }).x +
            (rowBox as { x: number; width: number }).width,
          `row right edge past viewport at ${width}px`,
        ).toBeLessThanOrEqual(width + 1)
      }

      // Separate loop (not a branch inside the one above — playwright/no-
      // conditional-expect forbids expect() under an if): touch-target
      // floor only applies at the two mobile widths (responsive-design.md).
      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 900 })
        // `expect.poll`, not a fixed wait + one measurement: the rows sit in
        // a framer-motion `layout` list, and a viewport change starts a
        // layout transition whose transform is included in
        // `boundingBox()`. A single read 100 ms in caught the button
        // mid-transition at 40.4px — the settled value is 44 (h-11). Polling
        // asserts the value the user actually ends up with, without
        // hard-coding how long the animation happens to take.
        await expect
          .poll(
            async () =>
              (await page.getByTestId(`project-approval-approve-${projectId}`).boundingBox())
                ?.height ?? 0,
            { message: `touch target < 44px at ${width}px`, timeout: 5000 },
          )
          .toBeGreaterThanOrEqual(44)
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
      // Backlog item 139 (same requirement drop-distribution.spec.ts's own
      // comment names): a freshly created DROP has an unsigned contract —
      // OnboardingGuard's client-side redirect gate sends them to
      // /onboarding on the VERY FIRST navigation, before the dashboard (and
      // therefore the widget under test) ever mounts. Measured live: without
      // this call, `page.goto('/')` renders the onboarding wizard's "Шаг 1
      // из 2 — Подписание контракта" screen, and the widget's own /pending
      // fetch never fires at all — this is not a timing race, the dashboard
      // route never mounts.
      await onboardDropViaAPI(page, { dropId, dropEmail: email })
      await loginViaApi(page, email)

      const requestedUrls: string[] = []
      page.on('request', (req) => {
        const url = req.url()
        if (url.includes('/api/pending') || url.includes('/api/projects')) requestedUrls.push(url)
      })

      await page.goto('/')
      await page.waitForTimeout(500)

      expect(requestedUrls.some((u) => u.includes('/api/pending'))).toBe(true)
      // The LIST endpoint specifically — `/api/projects` or
      // `/api/projects?...` — not any path that merely starts with it. SR-L-6
      // is about the full, unmasked `ProjectDto[]` reaching a DROP; the
      // dashboard's own `GET /api/projects/drop/me` is a different,
      // drop-scoped endpoint returning `DropProjectDto` (no `rate`, no
      // `notesGeneral`, no `members[].email`) and has always been part of
      // this screen. A plain `.includes('/api/projects')` failed on it —
      // measured on the live stack, not assumed.
      expect(requestedUrls.filter((u) => /\/api\/projects(\?|$)/.test(u))).toEqual([])
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
