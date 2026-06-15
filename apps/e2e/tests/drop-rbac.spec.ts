/**
 * drop-rbac.spec.ts — Drop role RBAC visibility sweep.
 *
 * Phase 1 (AC8): sidebar items, dashboard redirect, /crm/users redirect,
 *   profile self-view tabs.
 *
 * Phase 2 update (PR #189): resolveRoleHome(DROP) changed to /crm/routing.
 *   All redirect expectations updated from /crm/profile to /crm/routing.
 *   Sidebar now has 4 items: Дашборд / Финансы / Команда / Профиль
 *   (data-testid="drop-nav" from nav-sidebar.tsx).
 *
 * Dashboard consolidation: the role-dispatch dashboard moved from /crm/dashboard
 *   (DELETED) to the CRM root /crm. resolveRoleHome(DROP) === '/crm'.
 *   /crm root renders DropDashboard for DROP; /crm/routing → /crm.
 *   Sidebar «Дашборд» link href → /crm. All DROP home expectations → /crm.
 *
 * Mock-based — `asDrop` fixture authenticates as `USERS.drop` and pumps
 * the standard `/api/users/me` mock that returns the self-view from
 * `buildSelfView(USERS.drop)`.
 */

import { test, expect } from './fixtures'

// CRM root, anchored — matches `/crm` (and `/crm/`) but NOT `/crm/team` etc.
const CRM_ROOT = /\/crm\/?$/

test.describe('Drop RBAC visibility — AC8 (phase 3 update)', () => {
  test('sidebar has exactly 5 items for DROP: Дашборд / Финансы / Команда / Документы / Профиль', async ({
    asDrop: page,
  }) => {
    // Navigate to DROP home (dashboard hub at the CRM root /crm).
    await page.goto('/crm')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    // Scope to the drop-nav testid (data-testid="drop-nav" in nav-sidebar.tsx).
    const nav = page.getByTestId('drop-nav')
    await expect(nav).toBeVisible()

    // Finding 1 fix (PR #198): DROP added to /crm/documents ROUTE_ACCESS.
    // nav-sidebar uses navRolesFor('/crm/documents') → now includes DROP.
    // Phase 3 + Finding 1: 5 allowed entries.
    await expect(nav.locator('a[href="/crm"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/finance"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/team"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/documents"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/profile"]')).toBeVisible()

    // Exactly 5 nav links.
    await expect(nav.locator('a')).toHaveCount(5)

    // Forbidden entries — absent for DROP.
    await expect(nav.locator('a[href="/crm/projects"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/interviews"]')).toHaveCount(0)
    // /crm/routing no longer in nav (consolidated to the CRM root /crm)
    await expect(nav.locator('a[href="/crm/routing"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/users"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/stats"]')).toHaveCount(0)
  })

  test('DROP on /crm stays and sees drop hub (no redirect)', async ({ asDrop: page }) => {
    // /crm is DROP home; index.tsx renders DropDashboard (role-branch) — no redirect loop.
    await page.goto('/crm')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/users denies DROP access — redirects to /crm', async ({ asDrop: page }) => {
    // useRoleGuard fires navigate to resolveRoleHome('DROP') = /crm.
    await page.goto('/crm/users')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('DROP self-profile renders with correct tabs (contract tab present, no interviews)', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/profile')

    // Header h1 = displayName ('Drop User').
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    // Key change in PR #198: 'contract' tab is now included in the DROP profile view.
    // The mock for /api/users/me is matched by the generic /users/:id handler (LIFO)
    // which returns buildAdminViewingUser(DROP) → includes 'contract' tab because
    // DROP is non-ADMIN. This means the mock faithfully reflects the PR #198 backend
    // change: GET /api/users/:id/contract is now owner-or-ADMIN (not ADMIN-only),
    // so the profile service now includes 'contract' in DROP's tabs.
    //
    // AnimatedTabs renders each entry as a plain <button> (not role=tab).
    // Scope to <main> to avoid matching the sidebar «Финансы» / «Документы» links.
    const main = page.locator('main')
    await expect(main.getByRole('button', { name: /Финансы/ }).first()).toBeVisible({
      timeout: 8_000,
    })
    // «Контракт» tab MUST be present for DROP (key PR #198 regression guard)
    await expect(main.getByRole('button', { name: /Контракт/ }).first()).toBeVisible()

    // Forbidden tab — «Собеседования» must never surface for DROP.
    await expect(main.getByRole('button', { name: /^Собеседования$/ })).toHaveCount(0)
  })

  test('DROP can open /crm/finance and stays on the finance page', async ({ asDrop: page }) => {
    // Spec §4: DROP sees Finance. `useRoleGuard` on /crm/finance now
    // includes DROP, so the page renders the standard finance shell with
    // the «Финансы» header and the transactions table (may be empty).
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page).not.toHaveURL(/\/crm\/profile/)
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Финансы' })).toBeVisible({
      timeout: 8_000,
    })
  })

  test('DROP can open /crm/team and stays on the team page', async ({ asDrop: page }) => {
    // Spec §4: DROP sees Team. `useRoleGuard` on /crm/team now includes DROP.
    // PR #198 (task-drop-phase3-frontend): DROP is now added to the auto-redirect
    // alongside SENIOR/JUNIOR — when teams.length === 1, TeamPage immediately
    // navigates to /crm/team/<teamId>. So the final URL is /crm/team/<uuid>,
    // not /crm/team with an h1 «Команда» list heading.
    await page.goto('/crm/team')
    // Stays within /crm/team subtree (either list or detail page)
    await expect(page).toHaveURL(/\/crm\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page).not.toHaveURL(/\/crm\/profile/)
    // On team detail page the team name is the h1 (e.g. «Alpha Team»)
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 8_000 })
  })

  // task-drop-profile-lockdown: DROP has NO profile access — on the team page,
  // member names (and the «Дроп: …»/«Синьор: …» banner) must be PLAIN TEXT, with
  // zero links into /crm/profile/*. Inline contacts (mailto) stay visible.
  test('DROP team page renders member names as plain text — no profile links', async ({
    asDrop: page,
  }) => {
    // Go straight to the DROP team detail page (fixture DROP_TEAM id).
    await page.goto('/crm/team/drop-team-1-id')
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Drop Team Alpha' })).toBeVisible({
      timeout: 8_000,
    })

    // The senior teammate's name is shown (member roster + banner) — as text.
    await expect(main.getByText('Senior Dev').first()).toBeVisible()

    // CRITICAL: there must be ZERO anchors into the profile surface for DROP.
    await expect(page.locator('a[href^="/crm/profile/"]')).toHaveCount(0)

    // Inline contacts remain available to DROP (sufficient per the lockdown model).
    await expect(main.locator('a[href^="mailto:"]').first()).toBeVisible()
  })

  test('DROP viewing own profile — «Контракт» tab visible (owner-or-ADMIN, PR #198)', async ({
    asDrop: page,
  }) => {
    // PR #198 (drop-phase3-frontend): GET /api/users/:id/contract changed from
    // ADMIN-only to owner-or-ADMIN. DROP must see the «Контракт» tab on self-profile.
    // Fixture: buildSelfView(USERS.drop) now includes 'contract' in tabs array.
    // Mock: register a minimal contract response so the tab content renders without
    // hitting the real backend.
    const DROP_SELF_CONTRACT = {
      id: 'dc000001-0000-4000-8000-000000000001',
      userId: 'a0000000-0000-4000-8000-000000000007', // USERS.drop.id
      sourceTemplateId: 'dc000001-0000-4000-8000-000000000002',
      bodyMarkdown: '# Drop Contract',
      status: 'DRAFT',
      signedContractId: null,
      createdByUserId: 'a0000000-0000-4000-8000-000000000001',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }
    // Register AFTER asDrop mockAuthAs (LIFO) — wins over any default.
    await page.route(/\/api\/users\/[^/?]+\/contract$/, async (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(DROP_SELF_CONTRACT),
        })
      }
      return r.fallback()
    })
    await page.route(/\/api\/users\/[^/?]+\/contract\/variables$/, async (r) => {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ variables: [], customVariables: [] }),
      })
    })

    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    // «Контракт» tab must be present in DROP self-view
    const main = page.locator('main')
    const contractTabBtn = main.getByRole('button', { name: /Контракт/ }).first()
    await expect(contractTabBtn).toBeVisible({ timeout: 8_000 })

    // Click the tab and confirm read-only contract content renders.
    // Finding 2 (PR #198): DROP gets canEdit=false → contract-tab-readonly renders,
    // NOT the ADMIN editor (contract-tab). The read-only view shows status badge + PDF.
    await contractTabBtn.click()
    // Read-only wrapper must be present (Finding 2 regression guard).
    await expect(page.getByTestId('contract-tab-readonly')).toBeVisible({ timeout: 8_000 })
    // Status badge present in read-only view.
    await expect(page.getByTestId('contract-status-badge')).toBeVisible()
    // ADMIN editor must NOT be rendered for DROP (canEdit=false).
    await expect(page.getByTestId('contract-tab')).toHaveCount(0)
  })

  test('back-button NOT visible for DROP on /crm/team/$teamId (PR #198)', async ({
    asDrop: page,
  }) => {
    // PR #198: $teamId.tsx hides back-button for SENIOR, JUNIOR, and DROP.
    // DROP redirects to its single team — back would loop. Button omitted via
    // {user?.role !== 'SENIOR' && user?.role !== 'JUNIOR' && user?.role !== 'DROP'}.
    await page.goto('/crm/team')
    // DROP auto-redirects to team detail (teams.length===1)
    await expect(page).toHaveURL(/\/crm\/team\/.+/, { timeout: 8_000 })
    // back-button must be absent for DROP
    await expect(page.getByTestId('back-button')).toHaveCount(0)
  })

  test('back-button IS visible for ADMIN on /crm/team/$teamId', async ({ asAdmin: page }) => {
    // ADMIN is NOT in the hidden-roles list → back-button is rendered.
    // This is a regression guard: if someone accidentally broadens the hide condition,
    // ADMIN (and HR/ACCOUNTANT) would lose the «back» affordance.
    // Use direct goto with the fixture team id (TEAMS[0].id = 'team-1-id') to avoid
    // clicking the card which has a z-20 overlay div that intercepts pointer events.
    await page.goto('/crm/team/team-1-id')
    await expect(page).toHaveURL(/\/crm\/team\/team-1-id/, { timeout: 8_000 })
    // back-button must be present for ADMIN
    await expect(page.getByTestId('back-button')).toBeVisible({ timeout: 8_000 })
  })
})
