/**
 * drop-attach-project.spec.ts — task-drop-attach-autotest
 *
 * E2E coverage for the "attach/detach DROP on existing project" feature
 * (PR #359, feature/drop-attach-existing-project).
 *
 * All tests are mock-based (no real backend needed). State is built by
 * overriding /projects/:id after mockAuthAs — Playwright LIFO route
 * matching means the later handler wins.
 *
 * AC covered:
 *   AC1 — attach drop happy-path → drop row appears in effective team
 *   AC2 — detach drop confirm → drop row disappears + PATCH {dropId:null}
 *   AC3 — picker absent / attach-btn hidden when drop already assigned
 *   AC4 — regression: JUNIOR/HR/ACCOUNTANT still addable via POST /members
 *   AC5 — RBAC: SENIOR has no attach/detach controls (canManage = ADMIN||HR)
 */

import { test, expect, PROJECTS, USERS } from './fixtures'

// ---------------------------------------------------------------------------
// Fixture project shapes
// ---------------------------------------------------------------------------

const PROJECT_ID = PROJECTS[0]!.id // 'project-1-id'
const DROP = USERS.drop

/** Active project with NO drop assigned. */
const PROJECT_NO_DROP = {
  ...PROJECTS[0]!,
  dropId: null,
  effectiveTeam: {
    senior: {
      id: USERS.senior.id,
      displayName: USERS.senior.displayName,
      avatarUrl: null,
      avatarDocumentId: null,
      profileNavigable: true,
    },
    drop: null,
    hrs: [
      {
        id: USERS.hr.id,
        displayName: USERS.hr.displayName,
        avatarUrl: null,
        avatarDocumentId: null,
      },
    ],
    accountants: [],
    juniors: [],
  },
}

/** Active project WITH the seed DROP user attached. */
const PROJECT_WITH_DROP = {
  ...PROJECT_NO_DROP,
  dropId: DROP.id,
  effectiveTeam: {
    ...PROJECT_NO_DROP.effectiveTeam,
    drop: {
      id: DROP.id,
      displayName: DROP.displayName,
      avatarUrl: null,
      avatarDocumentId: null,
    },
  },
}

// ---------------------------------------------------------------------------
// AC1 — Attach drop happy-path
// ---------------------------------------------------------------------------

test.describe('Drop attach — happy-path (AC1)', () => {
  test('ADMIN sees attach-drop-btn when project has no drop', async ({ asAdmin: page }) => {
    // Override /projects/:id (LIFO, wins over mockAuthAs default)
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_NO_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await expect(page.getByTestId('attach-drop-btn')).toBeVisible()
  })

  test('attach-drop-btn opens picker with DROP candidate and blue badge', async ({
    asAdmin: page,
  }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_NO_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()
    await page.getByTestId('attach-drop-btn').click()

    const dialog = page.getByTestId('attach-drop-dialog')
    await expect(dialog).toBeVisible()
    // Drop candidate row visible in picker
    await expect(dialog.getByText(DROP.displayName)).toBeVisible()
    // Blue "Дроп" badge in picker
    await expect(dialog.getByText('Дроп').first()).toBeVisible()
    // Per-user assign button exists
    await expect(page.getByTestId(`assign-drop-btn-${DROP.id}`)).toBeVisible()
  })

  test('clicking assign fires PATCH {dropId} and drop row appears in team', async ({
    asAdmin: page,
  }) => {
    const patchBodies: string[] = []
    // Stateful: after PATCH, subsequent GETs return project WITH drop
    let projectState = PROJECT_NO_DROP as typeof PROJECT_NO_DROP | typeof PROJECT_WITH_DROP

    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(projectState),
        })
      }
      if (r.request().method() === 'PATCH') {
        patchBodies.push(r.request().postData() ?? '')
        // Transition state so re-fetch after invalidation returns WITH drop
        projectState = PROJECT_WITH_DROP
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PROJECT_WITH_DROP),
        })
      }
      return r.fallback()
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()
    await page.getByTestId('attach-drop-btn').click()

    const dialog = page.getByTestId('attach-drop-dialog')
    await expect(dialog).toBeVisible()

    await page.getByTestId(`assign-drop-btn-${DROP.id}`).click()

    // Dialog closes after success
    await expect(dialog).not.toBeVisible()

    // PATCH sent with correct dropId
    expect(patchBodies.length).toBeGreaterThan(0)
    const body = JSON.parse(patchBodies[0]!) as Record<string, unknown>
    expect(body.dropId).toBe(DROP.id)

    // Drop row now visible in effective team after re-fetch
    await expect(page.getByTestId('effective-team-drop')).toBeVisible()
    const main = page.locator('main')
    await expect(main.getByText(DROP.displayName)).toBeVisible()
  })

  test('HR can also use attach-drop flow', async ({ asHr: page }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_NO_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await expect(page.getByTestId('attach-drop-btn')).toBeVisible()
    await page.getByTestId('attach-drop-btn').click()
    await expect(page.getByTestId('attach-drop-dialog')).toBeVisible()
    await expect(page.getByTestId(`assign-drop-btn-${DROP.id}`)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC2 — Detach drop confirm flow
// ---------------------------------------------------------------------------

test.describe('Drop detach — confirm flow (AC2)', () => {
  test('detach-drop-btn visible on drop row when ADMIN views project with drop', async ({
    asAdmin: page,
  }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_WITH_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await expect(page.getByTestId('effective-team-drop')).toBeVisible()
    await expect(page.getByTestId('detach-drop-btn')).toBeVisible()
  })

  test('detach-drop-btn opens confirm dialog with drop name', async ({ asAdmin: page }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_WITH_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await page.getByTestId('detach-drop-btn').click()

    // Confirm button appears
    await expect(page.getByTestId('detach-drop-confirm-btn')).toBeVisible()

    // Dialog body mentions the drop's name
    const main = page.locator('main')
    await expect(main.getByText(DROP.displayName, { exact: false })).toBeVisible()
  })

  test('confirming detach fires PATCH {dropId:null} and drop row disappears', async ({
    asAdmin: page,
  }) => {
    const patchBodies: string[] = []
    // Stateful: after PATCH, subsequent GETs return project WITHOUT drop
    let projectState = PROJECT_WITH_DROP as typeof PROJECT_NO_DROP | typeof PROJECT_WITH_DROP

    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(projectState),
        })
      }
      if (r.request().method() === 'PATCH') {
        patchBodies.push(r.request().postData() ?? '')
        // Transition state so re-fetch returns WITHOUT drop
        projectState = PROJECT_NO_DROP
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PROJECT_NO_DROP),
        })
      }
      return r.fallback()
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await page.getByTestId('detach-drop-btn').click()
    await expect(page.getByTestId('detach-drop-confirm-btn')).toBeVisible()
    await page.getByTestId('detach-drop-confirm-btn').click()

    // Confirm dialog closes
    await expect(page.getByTestId('detach-drop-confirm-btn')).not.toBeVisible()

    // PATCH sent with dropId: null
    expect(patchBodies.length).toBeGreaterThan(0)
    const body = JSON.parse(patchBodies[0]!) as Record<string, unknown>
    expect(body.dropId).toBeNull()

    // Drop row removed from effective team after re-fetch
    await expect(page.getByTestId('effective-team-drop')).not.toBeVisible()
  })

  test('cancelling detach dialog leaves drop row intact, no PATCH', async ({ asAdmin: page }) => {
    let patchCalled = false
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/projects/')) patchCalled = true
    })

    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_WITH_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await page.getByTestId('detach-drop-btn').click()
    await expect(page.getByTestId('detach-drop-confirm-btn')).toBeVisible()

    // Cancel
    await page.getByRole('button', { name: 'Отмена' }).click()
    await expect(page.getByTestId('detach-drop-confirm-btn')).not.toBeVisible()

    // Drop row still present, no PATCH fired
    await expect(page.getByTestId('effective-team-drop')).toBeVisible()
    expect(patchCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC3 — attach-drop-btn absent when drop already assigned
// ---------------------------------------------------------------------------

test.describe('Picker hidden when drop already assigned (AC3)', () => {
  test('attach-drop-btn not visible when project already has a drop', async ({ asAdmin: page }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_WITH_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    // Button must NOT appear — dropCandidates is [] when project.dropId != null
    await expect(page.getByTestId('attach-drop-btn')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC4 — Regression: JUNIOR/HR/ACCOUNTANT still addable via POST /members
// ---------------------------------------------------------------------------

test.describe('Regression — non-DROP members still addable (AC4)', () => {
  test('add-member dialog shows JUNIOR but not DROP user', async ({ asAdmin: page }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_NO_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    // "Добавить" button lives on the "Обзор" (overview) tab in the team card header
    // (not on the "Состав" tab which shows ProjectEffectiveTeamCard)
    // The button is wrapped in a Tooltip, scoped to the team-section area.
    // Use tab-overview explicitly to ensure we're on the right tab.
    await page.getByTestId('tab-overview').click()

    // "Добавить" in the overview team card — exclude credentials-add-btn
    const addBtn = page
      .getByRole('button', { name: /^добавить$/i })
      .and(page.locator(':not([data-testid="credentials-add-btn"])'))
    await expect(addBtn).toBeVisible()
    await addBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // JUNIOR appears in the regular picker
    await expect(dialog.getByText(USERS.junior.displayName)).toBeVisible()

    // DROP user must NOT appear (excluded by availableToAdd filter)
    await expect(dialog.getByText(DROP.displayName)).not.toBeVisible()
  })

  test('adding JUNIOR fires POST /members (not blocked by DROP filter)', async ({
    asAdmin: page,
  }) => {
    const postBodies: string[] = []

    await page.route(/\/api\/projects\/[^/?]+\/members/, (r) => {
      if (r.request().method() !== 'POST') return r.fallback()
      postBodies.push(r.request().postData() ?? '')
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          ...PROJECTS[0]!,
          members: [{ userId: USERS.junior.id }],
        }),
      })
    })

    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_NO_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    // "Добавить" is on overview tab, in the "Команда" card header
    await page.getByTestId('tab-overview').click()

    const addBtn = page
      .getByRole('button', { name: /^добавить$/i })
      .and(page.locator(':not([data-testid="credentials-add-btn"])'))
    await expect(addBtn).toBeVisible()
    await addBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(USERS.junior.displayName)).toBeVisible()

    // Click "Добавить" button for Junior inside the dialog.
    // The dialog has one Добавить button per candidate; Junior is first in
    // availableToAdd (HR already in team, accountant in team, junior is free).
    // Using first() avoids strict-mode violation from nested div matches.
    await dialog
      .getByRole('button', { name: /^добавить$/i })
      .first()
      .click()

    // POST /members must fire with junior's userId
    await expect(async () => {
      expect(postBodies.length).toBeGreaterThan(0)
    }).toPass({ timeout: 5_000 })

    const body = JSON.parse(postBodies[0]!) as Record<string, unknown>
    expect(body.userId).toBe(USERS.junior.id)
    // Must NOT be the DROP user
    expect(body.userId).not.toBe(DROP.id)
  })
})

// ---------------------------------------------------------------------------
// AC5 — RBAC: SENIOR/JUNIOR cannot see drop identity or manage drop
// ---------------------------------------------------------------------------

test.describe('RBAC — SENIOR cannot manage drop (AC5)', () => {
  test('SENIOR: drop row fully hidden (maskedDrop=null) and no attach/detach controls', async ({
    asSenior: page,
  }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_WITH_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    // Drop identity fully masked for SENIOR — row not rendered at all (maskedDrop = null)
    await expect(page.getByTestId('effective-team-drop')).not.toBeAttached()

    // No management controls either
    await expect(page.getByTestId('attach-drop-btn')).not.toBeAttached()
    await expect(page.getByTestId('detach-drop-btn')).not.toBeAttached()
  })

  test('SENIOR: no attach-drop-btn on project without drop', async ({ asSenior: page }) => {
    await page.route(/\/api\/projects\/[^/?]+$/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT_NO_DROP),
      })
    })

    await page.goto(`/projects/${PROJECT_ID}`)
    await page.getByRole('tab', { name: 'Состав' }).click()

    await expect(page.getByTestId('attach-drop-btn')).not.toBeAttached()
  })
})
