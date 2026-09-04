/**
 * project-status-filter-ui.spec.ts — task-project-status-filter-ui.
 *
 * Real-API/real-UI coverage (not mocked) for AC1-AC5. The task explicitly
 * flags AC2/AC3 as needing the live stack — access and confirmation go
 * through real guards, and a mock does not execute them (this exact class
 * of gap has been walked past 3× on earlier tasks per the dispatch brief).
 *
 * AC1. Three filter values work; default is Active, matching today's list.
 * AC2. A draft is visible to ADMIN and invited approvers, invisible to
 *      everyone else — the interface never shows what the server didn't
 *      send, and never substitutes "empty" for "no access".
 * AC3. Confirm/reject work from the "approval record" for SENIOR and DROP;
 *      reject without a reason never sends. Tested for both roles: SENIOR
 *      via the /projects card, DROP via the dashboard widget (DROP has no
 *      route access to /projects at all).
 * AC4. The badge + rejection reason render; long names don't overflow at
 *      320px.
 * AC5. Responsive on all device classes, no horizontal overflow, mobile
 *      touch targets >=44px.
 *
 * Companion to project-draft-status.spec.ts, which proves the SERVER-side
 * confirmation gate (PR #630) — this file proves the UI built on top of it.
 */

import { test, expect, REAL_API_BASE, SEED_ADMIN_EMAIL, SEED_EMAILS } from './fixtures'
import {
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  onboardDropViaAPI,
  createDropProjectViaAPI,
  createSeniorProjectViaAPI,
  rejectProjectViaAPI,
  approveProjectViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

async function deleteProjectViaAPI(page: import('@playwright/test').Page, projectId: string) {
  await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
}

test.describe('Project status filter — AC1 (tabs) + AC2 (visibility)', () => {
  test('ADMIN: 4 tabs, default Active matches today, Pending/Rejected show only their own projects', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    const { projectId: draftId } = await createSeniorProjectViaAPI(page, {
      name: `AC1 Draft ${suffix}`,
      companyName: `AC1 Draft Co ${suffix}`,
      skipApproval: true,
    })
    const { projectId: activeId } = await createSeniorProjectViaAPI(page, {
      name: `AC1 Active ${suffix}`,
      companyName: `AC1 Active Co ${suffix}`,
    })

    try {
      await page.goto('/projects')

      // AC1: default tab is Active — the draft must NOT appear here (this
      // is the "список совпадает с сегодняшним" half of AC1).
      await expect(page.getByText(`AC1 Active Co ${suffix}`)).toBeVisible()
      await expect(page.getByText(`AC1 Draft Co ${suffix}`)).not.toBeVisible()

      // All 4 tabs present for ADMIN.
      const tabs = page.getByTestId('projects-status-tabs')
      await expect(tabs.getByRole('tab', { name: 'Активные' })).toBeVisible()
      await expect(tabs.getByRole('tab', { name: 'На подтверждении' })).toBeVisible()
      await expect(tabs.getByRole('tab', { name: 'Отклонённые' })).toBeVisible()
      await expect(tabs.getByRole('tab', { name: 'Архив' })).toBeVisible()

      // AC2: the draft is invisible on Active, visible on Pending — ADMIN
      // is an "invited approver" population, so this also proves AC2's
      // "viewed by ADMIN" half.
      await tabs.getByRole('tab', { name: 'На подтверждении' }).click()
      await expect(page.getByText(`AC1 Draft Co ${suffix}`)).toBeVisible()
      await expect(page.getByText(`AC1 Active Co ${suffix}`)).not.toBeVisible()
      await expect(page.getByTestId(`project-row-${draftId}-status-pending`)).toBeVisible()

      // Deep-link: reload straight onto the Pending tab via the URL the
      // page itself would produce.
      await page.goto('/projects?status=PENDING')
      await expect(page.getByText(`AC1 Draft Co ${suffix}`)).toBeVisible()
    } finally {
      await deleteProjectViaAPI(page, activeId)
      await deleteProjectViaAPI(page, draftId)
    }
  })

  test('SENIOR: only 2 tabs (no Отклонённые/Архив), sees only their OWN draft', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId: ownDraftId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `AC1 Senior Own ${suffix}`,
      companyName: `AC1 Senior Own Co ${suffix}`,
      skipApproval: true,
    })
    const { projectId: otherDraftId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorB,
      name: `AC1 Senior Other ${suffix}`,
      companyName: `AC1 Senior Other Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/projects')

      const tabsMobile = page.getByTestId('projects-status-tabs')
      await expect(tabsMobile.getByRole('tab', { name: 'Активные' })).toBeVisible()
      await expect(tabsMobile.getByRole('tab', { name: 'На подтверждении' })).toBeVisible()
      await expect(tabsMobile.getByRole('tab', { name: 'Отклонённые' })).not.toBeVisible()
      await expect(page.getByTestId('toggle-archived-projects')).not.toBeVisible()

      await tabsMobile.getByRole('tab', { name: 'На подтверждении' }).click()
      await expect(page.getByText(`AC1 Senior Own Co ${suffix}`)).toBeVisible()
      // AC2: not-my-draft is invisible even on the Pending tab.
      await expect(page.getByText(`AC1 Senior Other Co ${suffix}`)).not.toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, ownDraftId)
      await deleteProjectViaAPI(page, otherDraftId)
    }
  })

  test("AC2: HR (not an invited approver) never sees the status tabs, and the draft never leaks into HR's active list", async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId: draftId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `AC2 HR Draft ${suffix}`,
      companyName: `AC2 HR Draft Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.hrA)
      await page.goto('/projects')

      await expect(page.getByTestId('projects-status-tabs')).not.toBeVisible()
      await expect(page.getByTestId('projects-status-tabs-mobile')).not.toBeVisible()
      await expect(page.getByText(`AC2 HR Draft Co ${suffix}`)).not.toBeVisible()

      // AC2: not "нет доступа" replaced by "пусто" — this is a genuine
      // 404 at the API layer (assertAccess), not a UI-level filter. Proven
      // directly against the real guard, the same one the list relies on.
      const res = await page.request.get(`${REAL_API}/projects/${draftId}`)
      expect(res.status()).toBe(404)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, draftId)
    }
  })
})

test.describe('Project status filter — AC3 (confirm/reject) + AC4 (badge/reason)', () => {
  test('SENIOR confirms their own draft from the /projects card — project becomes ACTIVE', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `AC3 Senior Confirm ${suffix}`,
      companyName: `AC3 Senior Confirm Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/projects?status=PENDING')

      const row = page.getByTestId(`project-row-${projectId}`)
      await expect(row).toBeVisible()
      await row.getByTestId(`project-approval-approve-${projectId}`).click()

      // The row leaves the Pending list once the mutation settles + the
      // shared query invalidates.
      await expect(row).not.toBeVisible({ timeout: 10_000 })

      const res = await page.request.get(`${REAL_API}/projects/${projectId}`)
      expect(res.status()).toBe(200)
      expect((await res.json()).status).toBe('ACTIVE')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    }
  })

  test('SENIOR rejects their own draft — button disabled until a reason is typed, project becomes REJECTED with that reason', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `AC3 Senior Reject ${suffix}`,
      companyName: `AC3 Senior Reject Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/projects?status=PENDING')

      const row = page.getByTestId(`project-row-${projectId}`)
      await row.getByTestId(`project-approval-reject-${projectId}`).click()

      const submit = page.getByTestId('project-approval-reject-submit')
      // AC4: reason required BEFORE send, not a 400 after.
      await expect(submit).toBeDisabled()

      await page.getByTestId('project-approval-reject-reason').fill('нет бюджета на Q3')
      await expect(submit).not.toBeDisabled()
      await submit.click()

      await expect(page.getByText('Отклонить проект')).not.toBeVisible()
      await expect(row).not.toBeVisible({ timeout: 10_000 })

      // SR-M-5 (PR #646 fix-round 2): rejectionReason is ADMIN-only now —
      // the SENIOR who just wrote it does NOT see it echoed back, even on
      // their own project (design spec §1/§2/§6: only ADMIN sees the
      // reason text). Re-login as ADMIN, the one audience the field is for,
      // before verifying the reason landed.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const res = await page.request.get(`${REAL_API}/projects/${projectId}`)
      const body = (await res.json()) as { status: string; rejectionReason: string | null }
      expect(body.status).toBe('REJECTED')
      expect(body.rejectionReason).toBe('нет бюджета на Q3')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    }
  })

  test('ADMIN sees the rejection reason on the Отклонённые tab (AC4)', async ({ page }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      name: `AC4 Rejected ${suffix}`,
      companyName: `AC4 Rejected Co ${suffix}`,
      skipApproval: true,
    })

    try {
      await rejectProjectViaAPI(page, projectId, SEED_EMAILS.seniorA, 'нет бюджета на Q3')
      await loginViaApi(page, SEED_ADMIN_EMAIL)

      await page.goto('/projects?status=REJECTED')
      const row = page.getByTestId(`project-row-${projectId}`)
      await expect(row).toBeVisible()
      await expect(row.getByTestId(`project-row-${projectId}-status-rejected`)).toContainText(
        'Отклонено',
      )
      await expect(row.getByText('«нет бюджета на Q3»')).toBeVisible()
    } finally {
      await deleteProjectViaAPI(page, projectId)
    }
  })

  test('DROP confirms a drop-project from the dashboard widget — DROP has no /projects route access at all', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `ac3-drop-confirm-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `AC3 Drop Confirm ${suffix}`,
    })

    try {
      await onboardDropViaAPI(page, { dropId, dropEmail })
      // onboardDropViaAPI leaves the session logged in as the drop.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
        companyName: `AC3 Drop Confirm Co ${suffix}`,
        skipApproval: true,
      })

      // createDropProjectViaAPI always invites BOTH the senior and the drop
      // (the project carries both seniorId and dropId) — it only reaches
      // ACTIVE once BOTH approve (business spec §4.1 partial agreement;
      // same fact the PendingProjectApprovalsPanel local-dismiss fix is
      // built on). Pre-approve as the senior via the API so the drop's OWN
      // confirm below — through the widget, the ONLY surface DROP can reach
      // — is the FINAL approval that actually flips status, proving the
      // full lifecycle rather than just the senior's half.
      await approveProjectViaAPI(page, projectId, SEED_EMAILS.seniorA)

      // AC3's whole reason for existing: DROP cannot open /projects at all.
      await loginViaApi(page, dropEmail)
      await page.goto('/projects')
      await expect(page).toHaveURL(/\/$/)

      await page.goto('/')
      const panel = page.getByTestId('pending-project-approvals-panel')
      await expect(panel).toBeVisible()
      const item = page.getByTestId(`pending-project-approval-${projectId}`)
      await expect(item).toBeVisible()
      await expect(item.getByText(`AC3 Drop Confirm Co ${suffix}`)).toBeVisible()

      await item.getByTestId(`project-approval-approve-${projectId}`).click()
      await expect(item).not.toBeVisible({ timeout: 10_000 })

      const res = await page.request.get(`${REAL_API}/projects/${projectId}`)
      expect((await res.json()).status).toBe('ACTIVE')

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})

test.describe('Project status filter — AC5 (responsive)', () => {
  const WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920]

  test('no horizontal overflow on any tested width, ADMIN Pending tab with a long company/approver name', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const longCompanyName = 'A Very Long International Client Company Name That Could Overflow LLC'

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `AC5 Overflow ${suffix}`,
      companyName: longCompanyName,
      skipApproval: true,
    })

    try {
      await page.goto('/projects?status=PENDING')
      await expect(page.getByTestId(`project-row-${projectId}`)).toBeVisible()

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        // Re-settle layout after resize.
        await page.waitForTimeout(100)
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        )
        expect(overflow, `horizontal overflow at ${width}px`).toBe(false)
      }
    } finally {
      await deleteProjectViaAPI(page, projectId)
    }
  })

  /**
   * COPY-H-3 = QA-H-1 (PR #646 fix-round 2). The overflow test above passed
   * throughout — the bug was never a document.scrollWidth overflow, it was
   * the status column's content (badge + caption + Confirm/Reject)
   * visually SITTING ON TOP OF its neighbor columns' content at 320-768px,
   * something `scrollWidth` cannot see (nothing forced the page wider,
   * two grid cells just occupied the same pixels). This is exactly the gap
   * QA's finding names: the design review's own fidelity check measured
   * row overflow, not cell-to-cell intersection, and passed a genuinely
   * broken layout. jsdom/happy-dom has no real layout engine (returns
   * zero-size rects for everything), so this has to be a real-browser
   * check — a Vitest/RTL unit test could only ever pin the className that
   * IMPLEMENTS the fix (as ProjectRow.test.tsx's other layout tests
   * already do throughout this file), never prove the geometry it
   * produces actually stops overlapping.
   */
  test('status column does not overlap the rate/date or senior columns at 320/375/768 — the actual QA-H-1 repro, not scrollWidth', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `ac5-overlap-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `AC5 Overlap Drop ${suffix}`,
    })

    try {
      await onboardDropViaAPI(page, { dropId, dropEmail })
      // onboardDropViaAPI leaves the session logged in as the drop.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      // Both senior and drop invited, neither approved (skipApproval) — the
      // richest status-column content this component ever renders: badge +
      // "от <дроп> и <senior>" caption (COPY-M-1: drop-first order) + BOTH
      // Confirm/Reject buttons (once
      // logged in as the invited senior below). QA's repro was on exactly
      // this shape, not the simpler senior-only case the overflow test above
      // already covers.
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
        companyName: `AC5 Overlap Co ${suffix}`,
        skipApproval: true,
      })

      await loginViaApi(page, SEED_EMAILS.seniorA)
      await page.goto('/projects?status=PENDING')
      const row = page.getByTestId(`project-row-${projectId}`)
      await expect(row).toBeVisible()
      // Confirms the fullest-content case actually rendered before trusting
      // the geometry check below — a hidden/empty button set would make
      // "doesn't overlap" a vacuous pass.
      await expect(row.getByTestId(`project-approval-approve-${projectId}`)).toBeVisible()

      // Measuring `status-column`'s OWN boundingBox() is not enough — that
      // div is a CSS grid item with `min-w-0`, so ITS box shrinks to the
      // grid track (a thin sliver, confirmed by an earlier diagnostic run:
      // 16-51px wide depending on viewport), while the overflowing CONTENT
      // (the badge, the caption `<p>`, the Confirm/Reject button group)
      // visually spills out well past it — a parent's bounding box does not
      // grow to include overflowing children. This is exactly the bug: the
      // grid track stays put, the CONTENT is what overlaps the neighbor
      // cells. So the union of every element actually rendered inside
      // status-column (not the wrapper itself) is what has to be compared
      // against the neighboring columns' own boxes.
      const contentUnionBox = (testId: string) =>
        page.evaluate((id) => {
          const root = document.querySelector(`[data-testid="${id}"]`)
          if (!root) return null
          const nodes = [root, ...root.querySelectorAll('*')]
          let left = Infinity
          let top = Infinity
          let right = -Infinity
          let bottom = -Infinity
          for (const node of nodes) {
            const r = node.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            left = Math.min(left, r.left)
            top = Math.min(top, r.top)
            right = Math.max(right, r.right)
            bottom = Math.max(bottom, r.bottom)
          }
          if (left === Infinity) return null
          return { x: left, y: top, width: right - left, height: bottom - top }
        }, testId)

      for (const width of [320, 375, 768]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(100)

        const statusBox = await contentUnionBox(`project-row-${projectId}-status-column`)
        const rateBox = await contentUnionBox(`project-row-${projectId}-rate-column`)
        const seniorBox = await contentUnionBox(`project-row-${projectId}-senior-column`)
        expect(statusBox, `status column content box at ${width}px`).not.toBeNull()
        expect(rateBox, `rate column content box at ${width}px`).not.toBeNull()
        expect(seniorBox, `senior column content box at ${width}px`).not.toBeNull()

        const intersects = (
          a: { x: number; y: number; width: number; height: number },
          b: { x: number; y: number; width: number; height: number },
        ) =>
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

        expect(
          intersects(statusBox!, rateBox!),
          `status column content overlaps rate/date column content at ${width}px`,
        ).toBe(false)
        expect(
          intersects(statusBox!, seniorBox!),
          `status column content overlaps senior column content at ${width}px`,
        ).toBe(false)
      }

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await deleteProjectViaAPI(page, projectId)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  /**
   * CR-H-2 = COPY-H-4 (PR #646 fix-round 3). copy-reviewer's own attached
   * screenshot: at 320/375 the "Синьор"/"Джун" micro-labels above each
   * column's name rendered with no `truncate`/`overflow-hidden` at all,
   * an un-breakable Cyrillic uppercase run with no valid word-break point,
   * and spilled past their own ~6.4px-wide box straight into the neighbor
   * column's text — reading as one merged word, "СИНЬОРДЖУН". The fix is
   * `hidden lg:block` on all three label instances (ProjectRow.tsx), not a
   * grid refactor (orchestrator's explicit instruction, spec §11 stays
   * intact at md+) — so the correct regression guard is TWO-SIDED: the
   * labels render NOTHING at 320/375 (nothing to merge into anything), and
   * they DO reappear, non-overlapping, from 1024px up where the fix
   * intentionally stops hiding them. Same rect-intersection method as
   * QA-H-1's own test above, applied at the ONE breakpoint where the labels
   * actually paint.
   */
  test('CR-H-2 = COPY-H-4: Синьор/Джун micro-labels are hidden at 320/375 (no "СИНЬОРДЖУН" merge possible when nothing renders) and reappear without overlapping at 1024+', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      name: `CR-H-2 Label ${suffix}`,
      companyName: `CR-H-2 Label Co ${suffix}`,
    })

    try {
      await page.goto('/projects')
      const row = page.getByTestId(`project-row-${projectId}`)
      await expect(row).toBeVisible()

      const seniorLabel = row.getByText('Синьор', { exact: true })
      const juniorLabel = row.getByText('Джун', { exact: true })

      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(50)
        await expect(seniorLabel, `Синьор label hidden at ${width}px`).toBeHidden()
        await expect(juniorLabel, `Джун label hidden at ${width}px`).toBeHidden()
      }

      await page.setViewportSize({ width: 1024, height: 900 })
      await page.waitForTimeout(50)
      await expect(seniorLabel, 'Синьор label visible again at 1024px').toBeVisible()
      await expect(juniorLabel, 'Джун label visible again at 1024px').toBeVisible()

      const seniorBox = await seniorLabel.boundingBox()
      const juniorBox = await juniorLabel.boundingBox()
      expect(seniorBox, 'senior label box at 1024px').not.toBeNull()
      expect(juniorBox, 'junior label box at 1024px').not.toBeNull()

      const intersects = (
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number },
      ) =>
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

      expect(intersects(seniorBox!, juniorBox!), 'Синьор/Джун labels overlap at 1024px').toBe(false)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await deleteProjectViaAPI(page, projectId)
    }
  })

  test('mobile (375): tab buttons meet the 44px touch-target minimum', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/projects')

    const mobileTabs = page.getByTestId('projects-status-tabs-mobile')
    await expect(mobileTabs).toBeVisible()
    const buttons = mobileTabs.locator('button')
    const count = await buttons.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('screenshots across all device classes — default (Active) tab', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/projects')
    await expect(page.getByTestId('projects-list')).toBeVisible()

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      await page.screenshot({
        path: `test-results/project-status-filter-active-${width}.png`,
        fullPage: false,
      })
    }
  })
})
