/**
 * senior-roles.spec.ts — roles PR 5, Task 5.5.
 *
 * A SENIOR is described by technical roles instead of a three-technology stack
 * (`docs/design/senior-roles-ui.md`, plan `docs/superpowers/plans/2026-11-16-senior-roles.md`).
 * Three forms write them through the shared `RolesSection` (admin `UserDialog`, HR
 * `HrCreateSeniorDialog`, the senior's own `ProfileEditFields`) and the read surfaces render
 * `RoleChips`.
 *
 * Pattern: REAL stack. `loginViaApi` plants a real JWT cookie and every assertion about a write, a
 * read-back or a refusal is made against the live API, so a backend regression cannot be masked by
 * a fixture — which is the point of test 5 in particular (a mocked route proves nothing about a
 * guard). Needs a running API + web pair against a SCRATCH database, never `crm_db`
 * (`live-db-access.md`); see `tests/fixtures/api-helpers/common.ts` for the four env vars.
 *
 * THE ONE EXCEPTION is the queue-card overlap indicator (tests 7 and the card half of 6): the
 * session is still a real one, but the `/job-queue` reads are answered by `mockJobQueue`. Not a
 * preference — the real stack CANNOT produce the state. The card's `skillOverlap` is read straight
 * out of `job_opportunity_matches.evidence` (`queue-read-sql.ts`, `m.evidence -> 'skillOverlap'`)
 * and only the funnel's own evaluation ever writes that key (`tech-match.ts`,
 * `recompute-inputs.ts`). The 7.6a seed's `leadEvidence` writes `score`, `reasons` and
 * `rankWarnings` and no overlap, so EVERY seeded LEAD answers `skillOverlap: null` and the
 * indicator is correctly gated off — measured on a freshly seeded scratch database, not inferred:
 * `GET /api/job-queue/<id>` as `hrA` answered `skillOverlap: null` for every senior of every
 * seeded LEAD card, and `select count(*) from job_opportunity_matches where evidence ?
 * 'skillOverlap'` is 0 of 6. The paths that would fill it are all out of reach here:
 * `POST /job-queue/recompute` only enqueues work for a cron behind
 * `JOB_MATCH_RECONCILIATION_ENABLED` (and would re-evaluate the matches `job-queue.spec.ts` wave 2
 * freezes at seed time), `POST /job-queue/manual` writes no match row at all, and teaching the
 * seed to carry an overlap is a Coder-zone change to `apps/api/**`. So what these two cover is the
 * RENDERING contract of §7.3 on a real browser; that a real API ever emits a non-null
 * `skillOverlap` is covered by unit tests (`tech-match.spec.ts`, `job-queue.service.spec.ts`), and
 * the API→card path for it has no E2E. The mock is the schema-parsed `apps/e2e/fixtures/job-queue`
 * one, shared with `job-queue.spec.ts` scenarios 7-9 and 13, so a DTO drift fails it loudly.
 *
 * Seeded SENIORs carry NO technical roles (`seed.ts` never writes the column, whose default is
 * `'{}'`), so they are the plan's "legacy senior" case. The API refuses to put a senior back to
 * none (`assertSeniorRoleFloor`), so the self-edit tests do not try to restore that: each sets its
 * own `BASELINE_ROLES` first and restores it afterwards, and each uses a senior of its own
 * (`fullyParallel: true` lets two tests of this file run at once).
 */

import { randomUUID } from 'node:crypto'
import {
  test,
  expect,
  REAL_API_BASE,
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  VALID_USDT_WALLET,
  loginViaApi,
  findUserByEmailViaApi,
} from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
import type { Page } from '@playwright/test'
import { card, cardSenior, mockJobQueue, MOCK_IDS } from '../fixtures/job-queue'
import type { QueueCardSenior } from '../fixtures/job-queue'
import { SENIOR_ROLES, pickRoles } from './fixtures/senior-roles'

/**
 * The state a profile test starts from and restores. Set, never read: a seeded senior holds none
 * (the plan's legacy case) and the API refuses to put a senior back to none, so a test that read
 * the starting state would inherit whatever the previous run left. Outside `SENIOR_ROLES`, so the
 * role a test adds is unambiguous.
 */
const BASELINE_ROLES = ['DEVOPS_ENGINEER'] as const

/** One run must not collide with the next: every created senior gets its own address. */
function uniqueEmail(tag: string): string {
  return `e2e.roles5.${tag}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@cheekycheese.dev`
}

/** Archives a user created by a test, so the next run starts from the same state. */
async function archiveUserViaApi(page: import('@playwright/test').Page, id: string): Promise<void> {
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const res = await page.request.delete(`${REAL_API_BASE}/api/users/${id}`)
  expect(res.status(), 'cleanup: archive the created senior').toBeLessThan(400)
}

/** The roles the API currently stores for `email`. */
async function rolesOf(
  page: import('@playwright/test').Page,
  id: string,
): Promise<readonly string[]> {
  const res = await page.request.get(`${REAL_API_BASE}/api/users/${id}`)
  expect(res.status(), `GET /users/${id}`).toBe(200)
  // `GET /users/:id` answers the profile view `{ user, permissions, data }` (user-profile.service),
  // so the roles live one level down; reading the root silently yields `[]` for every viewer.
  const view = (await res.json()) as { user?: { technicalRoles?: readonly string[] } }
  return view.user?.technicalRoles ?? []
}

/** Puts a senior's roles back to `roles` through the ADMIN endpoint (test teardown). */
async function setRolesViaApi(
  page: import('@playwright/test').Page,
  id: string,
  roles: readonly string[],
): Promise<void> {
  // The API refuses to leave a SENIOR with none (`assertSeniorRoleFloor`), so every caller passes a
  // non-empty set; a silent no-op here would let a test start from whatever the previous one left.
  expect(roles.length, 'a senior is never restored to zero roles').toBeGreaterThan(0)
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const res = await page.request.patch(`${REAL_API_BASE}/api/users/${id}`, {
    data: { technicalRoles: [...roles] },
  })
  expect(res.status(), 'teardown: restore the seeded roles').toBeLessThan(400)
}

/**
 * Picks an HR in the admin create wizard. `hrIds` is required and the seed has several HRs, so none
 * is pre-selected: without this the wizard blocks on "Виберіть щонайменше одного HR" — which would
 * also make the "no request leaves" test below pass for the wrong reason.
 * The option's own `onSelect` closes the popover (`HrChipsField.tsx`), so nothing is dismissed here.
 */
async function pickHr(page: import('@playwright/test').Page, hrId: string): Promise<void> {
  await page.getByTestId('user-dialog-hr-add-trigger').click()
  await page.getByTestId(`user-dialog-hr-option-${hrId}`).click()
  await expect(page.getByTestId(`user-dialog-hr-chip-${hrId}`)).toBeVisible()
}

/** A create request, matched on the collection endpoint only (`/api/users/<id>` is a PATCH target). */
function createRequests(page: import('@playwright/test').Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/users(\?|$)/.test(req.url())) seen.push(req.url())
  })
  return seen
}

/**
 * The overlap indicator's four §7.3 states, one senior each, so a single card open covers the
 * whole rendering contract. The ids are fresh per call because the testids are built out of them
 * and `fullyParallel: true` runs the tests of this file side by side.
 */
function overlapSeniors(matched: string[], total: number) {
  return {
    hits: cardSenior({
      seniorId: randomUUID(),
      displayName: 'Overlap Hits',
      skillOverlap: { kind: 'OVERLAP', matched, total },
    }),
    zero: cardSenior({
      seniorId: randomUUID(),
      displayName: 'Overlap Zero',
      skillOverlap: { kind: 'OVERLAP', matched: [], total },
    }),
    noResume: cardSenior({
      seniorId: randomUUID(),
      displayName: 'Overlap No Resume',
      skillOverlap: { kind: 'NO_RESUME' },
    }),
    legacy: cardSenior({
      seniorId: randomUUID(),
      displayName: 'Overlap Legacy',
      skillOverlap: null,
    }),
  }
}

/**
 * Opens the one mocked queue card holding `seniors`. The session stays the real one; only the
 * `/job-queue` reads are mocked, and why that is unavoidable here is the header's EXCEPTION note.
 */
async function openMockedCard(page: Page, seniors: QueueCardSenior[]): Promise<void> {
  await mockJobQueue(page, { card: [card({ matchedSeniorCount: seniors.length }, seniors)] })
  await page.goto('/job-queue')
  await page.getByTestId(`job-queue-row-${MOCK_IDS.opportunity}`).click()
  await expect(page.getByTestId('job-queue-card')).toBeVisible()
}

test.describe('Senior technical roles — forms, surfaces and the backend floor', () => {
  test('ADMIN creates a SENIOR with roles; the users list shows the role chips', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    const email = uniqueEmail('admin')
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const hr = await findUserByEmailViaApi(page, SEED_EMAILS.hrA)
    expect(hr, `seed HR ${SEED_EMAILS.hrA} must exist`).not.toBeNull()
    await page.goto('/users')

    await expect(page.getByTestId('users-list')).toBeVisible()
    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill(email)
    await page.getByTestId('user-dialog-name').fill('Roles Five E2E')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
    await page.getByTestId('user-dialog-legal-full-name').fill('Ролі П’ять Тестовий')
    await pickRoles(page)
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
    await pickHr(page, hr!.id)

    const created = page.waitForResponse(
      (res) =>
        /\/api\/users(\?|$)/.test(res.url()) &&
        res.request().method() === 'POST' &&
        res.status() < 400,
    )
    await page.getByTestId('wizard-next-btn').click()

    const body = (await (await created).json()) as { id: string; technicalRoles?: string[] }
    const id = body.id
    try {
      // The API stored exactly what the form collected, in canonical order.
      expect(await rolesOf(page, id)).toEqual([...SENIOR_ROLES])

      // And the list renders one chip per role on that senior's row.
      await page.goto('/users')
      const row = page.getByTestId(`user-row-${id}`)
      await expect(row).toBeVisible()
      for (const role of SENIOR_ROLES) {
        await expect(row.getByTestId(`role-chip-${role}`)).toBeVisible()
      }
    } finally {
      await archiveUserViaApi(page, id)
    }
  })

  test('ADMIN cannot save a SENIOR with no roles: inline error, no request leaves', async ({
    page,
  }) => {
    const uk = await loadMessages('uk')
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const hr = await findUserByEmailViaApi(page, SEED_EMAILS.hrA)
    expect(hr, `seed HR ${SEED_EMAILS.hrA} must exist`).not.toBeNull()
    await page.goto('/users')
    await expect(page.getByTestId('users-list')).toBeVisible()

    // Counted on the real network: the assertion is that no create request happens at all, which
    // a toast assertion would not prove.
    const posts = createRequests(page)

    await page.getByTestId('users-create-button').click()
    await page.getByPlaceholder('user@cheekycheese.dev').fill(uniqueEmail('noroles'))
    await page.getByTestId('user-dialog-name').fill('No Roles E2E')
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
    await page.getByTestId('user-dialog-legal-full-name').fill('Без Ролей Тестовий')
    await page.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)
    await pickHr(page, hr!.id)
    // Every other required field is filled — including the HR the wizard also demands — so the
    // roles floor is the only thing left that can block the submit.
    await page.getByTestId('wizard-next-btn').click()

    const error = page.getByTestId('roles-section-error')
    await expect(error).toBeVisible()
    // The error names the add control, so a screen reader reaches it from the trigger.
    await expect(page.getByTestId('roles-section-add-trigger')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(posts, 'no create request left the page').toEqual([])
  })

  test('HR creates a senior with roles from the team list', async ({ page }) => {
    const email = uniqueEmail('hr')
    await loginViaApi(page, SEED_EMAILS.hrA)
    await page.goto('/team')

    await page.locator('main').getByRole('button', { name: 'Створити сеньйора' }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('senior@cheekycheese.dev').fill(email)
    await dialog.getByPlaceholder('Іван Іваненко').fill('Сеньйор Ролей')
    await pickRoles(dialog)

    const created = page.waitForResponse(
      (res) =>
        /\/api\/users(\?|$)/.test(res.url()) &&
        res.request().method() === 'POST' &&
        res.status() < 400,
    )
    await dialog.getByRole('button', { name: 'Створити', exact: true }).click()

    const body = (await (await created).json()) as { id: string }
    const id = body.id
    try {
      await expect(dialog).toBeHidden()
      // HR's dialog wrote the roles through the real API, not just into a form. Read back as ADMIN:
      // what HR may SEE on a profile is a different gate, and not what this test is about.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      expect(await rolesOf(page, id)).toEqual([...SENIOR_ROLES])
    } finally {
      await archiveUserViaApi(page, id)
    }
  })

  test('a SENIOR edits own roles on the profile; clearing all roles shows the error', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorC)
    expect(senior, `seed senior ${SEED_EMAILS.seniorC} must exist`).not.toBeNull()
    const id = senior!.id
    await setRolesViaApi(page, id, BASELINE_ROLES)

    try {
      await loginViaApi(page, SEED_EMAILS.seniorC)
      await page.goto('/profile')
      await expect(page.getByTestId('roles-section')).toBeVisible()

      // Clear the baseline, so the add below is the only source of roles.
      for (const role of BASELINE_ROLES) {
        await page.getByTestId(`roles-section-remove-${role}`).click()
      }

      const [role] = SENIOR_ROLES
      const saved = page.waitForResponse(
        (res) =>
          res.url().includes('/api/users/me') &&
          res.request().method() === 'PATCH' &&
          res.status() < 400,
      )
      await pickRoles(page, [role])
      await expect(page.getByTestId(`roles-section-chip-${role}`)).toBeVisible()
      // The debounced autosave reaches the API, and the API stored it.
      await saved
      await expect
        .poll(async () => (await rolesOf(page, id)).join(','), {
          message: 'the autosaved role reaches the database',
        })
        .toBe(role)

      // Clearing the last role is refused in the form itself: the message says it was not saved.
      await page.getByTestId(`roles-section-remove-${role}`).click()
      await expect(page.getByTestId('roles-section-error')).toBeVisible()
      await expect(page.getByTestId(`roles-section-chip-${role}`)).toHaveCount(0)
      // The empty selection never reached the API: the stored value is still the single role.
      // (`ProfileEditFields` cancels the pending save, so there is nothing in flight to outrun.)
      expect(await rolesOf(page, id)).toEqual([role])
    } finally {
      await setRolesViaApi(page, id, BASELINE_ROLES)
    }
  })

  test('HR PATCH /users/:id with technicalRoles is refused with 403 at the backend', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
    expect(senior, `seed senior ${SEED_EMAILS.seniorA} must exist`).not.toBeNull()
    const id = senior!.id
    const before = await rolesOf(page, id)

    // A real request under the HR session — no mocked route, so this is the guard's own answer.
    await loginViaApi(page, SEED_EMAILS.hrA)
    const res = await page.request.patch(`${REAL_API_BASE}/api/users/${id}`, {
      data: { technicalRoles: ['DEVOPS_ENGINEER'] },
    })
    expect(res.status()).toBe(403)

    // The refusal is a refusal: nothing was written on the way out.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    expect(await rolesOf(page, id)).toEqual([...before])
  })

  test('the queue card shows the overlap label for a seeded LEAD', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.hrA)
    const matched = ['React', 'PostgreSQL']
    const seniors = overlapSeniors(matched, 3)
    await openMockedCard(page, [seniors.hits, seniors.zero, seniors.noResume, seniors.legacy])

    // §7.3 row 1 — OVERLAP with hits: the count, then one chip per matched skill. The count is an
    // ICU plural, which the compiled catalog keeps as a nested array rather than a flat string, so
    // `assertInCatalog` cannot address it; the uk wording is asserted literally on purpose — a copy
    // change to it reddens this line, which is what rule 10 of `playwright-patterns` is after.
    const hits = page.getByTestId(`job-queue-senior-overlap-${seniors.hits.seniorId}`)
    await expect(hits).toContainText('2 з 3 навичок')
    for (const skill of matched) {
      await expect(hits.getByText(skill, { exact: true })).toBeVisible()
    }
    await expect(
      page.getByTestId(`job-queue-senior-no-resume-${seniors.hits.seniorId}`),
    ).toHaveCount(0)

    // §7.3 row 2 — OVERLAP with nothing matched: "0 з N" is legal and is NOT the no-resume wording.
    const zero = page.getByTestId(`job-queue-senior-overlap-${seniors.zero.seniorId}`)
    await expect(zero).toHaveText('0 з 3 навичок')
    await expect(
      page.getByTestId(`job-queue-senior-no-resume-${seniors.zero.seniorId}`),
    ).toHaveCount(0)

    // §7.3 row 3 — NO_RESUME: the words, never a count.
    await expect(
      page.getByTestId(`job-queue-senior-no-resume-${seniors.noResume.seniorId}`),
    ).toHaveText('немає резюме')
    await expect(
      page.getByTestId(`job-queue-senior-overlap-${seniors.noResume.seniorId}`),
    ).toHaveCount(0)

    // §7.3 row 4 — null (every seeded LEAD today): the senior is listed, the indicator renders
    // nothing at all, in neither of its two shapes.
    await expect(page.getByTestId(`job-queue-senior-${seniors.legacy.seniorId}`)).toBeVisible()
    await expect(
      page.getByTestId(`job-queue-senior-overlap-${seniors.legacy.seniorId}`),
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`job-queue-senior-no-resume-${seniors.legacy.seniorId}`),
    ).toHaveCount(0)
  })

  test.describe('mobile 390px', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('RolesSection is usable by tap and the card label wraps without overflow', async ({
      page,
    }) => {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      // A senior of its own: two workers editing one senior's roles would race (the local matrix
      // runs several).
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorShared)
      expect(senior, `seed senior ${SEED_EMAILS.seniorShared} must exist`).not.toBeNull()
      const id = senior!.id
      await setRolesViaApi(page, id, BASELINE_ROLES)

      try {
        await loginViaApi(page, SEED_EMAILS.seniorShared)
        await page.goto('/profile')
        await expect(page.getByTestId('roles-section')).toBeVisible()
        for (const role of BASELINE_ROLES) {
          await page.getByTestId(`roles-section-remove-${role}`).tap()
        }

        // Add by tap: the popover, the search list and the row all have to work under touch.
        const [role] = SENIOR_ROLES
        await pickRoles(page, [role], { tap: true })
        const chip = page.getByTestId(`roles-section-chip-${role}`)
        await expect(chip).toBeVisible()
        // Design spec §5.8 / a11y 2.5.8: the remove target is 24px or more on touch.
        const box = await page.getByTestId(`roles-section-remove-${role}`).boundingBox()
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(24)
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(24)

        // Nothing the section renders pushes the page sideways at 390px.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow, 'no horizontal overflow at 390px').toBeLessThanOrEqual(0)

        // Remove by tap: the chip goes, and the error appears because none are left.
        await page.getByTestId(`roles-section-remove-${role}`).tap()
        await expect(chip).toHaveCount(0)
        await expect(page.getByTestId('roles-section-error')).toBeVisible()
      } finally {
        await setRolesViaApi(page, id, BASELINE_ROLES)
      }

      // The other half of the plan's mobile test: the queue card's overlap label. Many skills and
      // one unbroken token longer than the viewport, because a label that fits on one line proves
      // nothing about wrapping.
      await loginViaApi(page, SEED_EMAILS.hrA)
      const matched = [
        'React',
        'TypeScript',
        'PostgreSQL',
        'Kubernetes',
        'Terraform',
        'GraphQL',
        'ElasticSearch',
        'NeverBreaksWithoutOverflowWrapAnywhereSoThisTokenIsTheWorstCase',
      ]
      const seniors = overlapSeniors(matched, 12)
      await openMockedCard(page, [seniors.hits])

      const overlapTestId = `job-queue-senior-overlap-${seniors.hits.seniorId}`
      await expect(page.getByTestId(overlapTestId)).toContainText('8 з 12 навичок')

      // Wrapping is asserted positively (more than one line of children) and together with the
      // containment: a row that stayed on one line, or one that escaped the card, both fail.
      const geometry = await page.evaluate((testId) => {
        const row = document.querySelector(`[data-testid="${testId}"]`)
        const panel = document.querySelector('[data-testid="job-queue-card"]')
        if (!row || !panel) throw new Error(`missing ${testId} or job-queue-card`)
        const children = [...row.children].map((child) => {
          const box = child.getBoundingClientRect()
          return { right: box.right, top: Math.round(box.top) }
        })
        return {
          children,
          lines: new Set(children.map((child) => child.top)).size,
          rowRight: row.getBoundingClientRect().right,
          panelRight: panel.getBoundingClientRect().right,
        }
      }, overlapTestId)

      expect(geometry.children.length, 'the count plus one chip per matched skill').toBe(
        matched.length + 1,
      )
      expect(geometry.lines, 'the label wraps onto more than one line at 390px').toBeGreaterThan(1)
      expect(geometry.rowRight, 'the label stays inside the card').toBeLessThanOrEqual(
        geometry.panelRight + 1,
      )
      for (const child of geometry.children) {
        expect(child.right, 'no chip escapes the card sideways').toBeLessThanOrEqual(
          geometry.panelRight + 1,
        )
      }
      const cardOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(cardOverflow, 'no horizontal overflow with the card open').toBeLessThanOrEqual(0)
    })
  })
})
