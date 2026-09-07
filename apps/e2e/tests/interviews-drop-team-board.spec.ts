/**
 * interviews-drop-team-board.spec.ts — task-hr-drop-team-senior-board (AC5).
 *
 * Owner repro, on the real stack (real Postgres, real guard stack, no
 * mocks): an HR who is an ACTIVE member of a DROP-type team, alongside an
 * ACTIVE SENIOR, must see that senior's board in the `/interviews` selector
 * and be able to open it — even though `TeamsService.findAll` (a separate,
 * unrelated decision about the team-LIST page) filters DROP-type teams out
 * of HR's team list. An HR with no relationship to that senior must NOT see
 * them, and a direct `?seniorId=` probe against the OLD list endpoint must
 * still 403.
 *
 * Setup mirrors `drop-multi-hr.spec.ts`'s real-API convention: a fresh
 * DROP-team is created per test run via POST /api/users/drops, a SEED
 * senior is attached via POST /api/teams/:id/members, and everything is
 * torn down in `finally`. SEED_EMAILS.hrA (Anna, Team Kovalenko) and
 * SEED_EMAILS.hrB (Kateryna, Team Marchenko) are both used deliberately:
 * neither has a BASE-seed relationship with Artem Kravchenko (Team
 * Kravchenko's senior, HR3-only) — see apps/api/src/database/seed.ts §3 —
 * so attaching Artem to a fresh drop-team with ONLY Anna as HR gives a
 * clean signal: Anna sees him because of the drop-team, Kateryna doesn't
 * because she has no relationship to him at all.
 */
import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  REAL_API_BASE,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  findUserByEmailViaApi,
  addSeniorToDropTeamViaAPI,
} from './fixtures'

const ARTEM_EMAIL = 'artem.kravchenko@cheekycheese.dev'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('HR sees a drop-team senior board on /interviews (task-hr-drop-team-senior-board)', () => {
  test('HR in the drop-team sees + opens the board; an unrelated HR does not, and a direct seniorId 403s', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-hrboard-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop HrBoard ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)

    const artem = await findUserByEmailViaApi(page, ARTEM_EMAIL)
    if (!artem) throw new Error(`Seed senior not found: ${ARTEM_EMAIL}`)

    // Fresh DROP-type team — Anna (hrA) is its ONLY HR.
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
      hrEmails: [SEED_EMAILS.hrA],
    })

    try {
      await addSeniorToDropTeamViaAPI(page, teamId, { seniorEmail: ARTEM_EMAIL })

      // ── AC1/AC5 (backend, direct): the new single-source-of-truth endpoint
      // already lists Artem for Anna before any UI is involved. ──────────────
      await loginViaApi(page, SEED_EMAILS.hrA)
      const seniorsRes = await page.request.get(`${REAL_API_BASE}/api/interviews/seniors`)
      expect(seniorsRes.status()).toBe(200)
      const seniorsBody = (await seniorsRes.json()) as Array<{ id: string; displayName: string }>
      expect(seniorsBody.map((s) => s.id)).toContain(artem.id)

      // ── AC5 (UI, the actual reported bug repro): the selector shows Artem
      // and selecting him opens his board. `toHaveCount` (not a one-shot
      // `allTextContents()` snapshot) auto-retries — the <select>'s options
      // populate asynchronously once GET /interviews/seniors resolves.
      // Viewport pinned to the "ноутбук" laptop class (responsive-design.md)
      // — a deterministic desktop layout, not Playwright's own default. ────
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto('/interviews')
      await expect(page.getByTestId('interviews-page')).toBeVisible()
      const select = page.locator('select').first()
      await expect(select).toBeVisible()
      await expect(select.locator('option', { hasText: artem.displayName })).toHaveCount(1)

      await select.selectOption({ label: artem.displayName })
      await expect(page).toHaveURL(new RegExp(`seniorId=${artem.id}`))
      // Board actually opened for HIM — the Kanban column header renders and
      // no RBAC/error state replaced it (mirrors interviews.spec.ts's own
      // `waitForBoardReady` signal).
      await expect(page.getByText('HR Screen').first()).toBeVisible()

      // ── Negative — an HR with NO relationship to Artem sees neither the
      // option NOR the board (both the new endpoint AND the OLD list
      // endpoint's direct seniorId probe must refuse). ────────────────────
      await loginViaApi(page, SEED_EMAILS.hrB)
      const outsiderSeniorsRes = await page.request.get(`${REAL_API_BASE}/api/interviews/seniors`)
      expect(outsiderSeniorsRes.status()).toBe(200)
      const outsiderSeniorsBody = (await outsiderSeniorsRes.json()) as Array<{ id: string }>
      expect(outsiderSeniorsBody.map((s) => s.id)).not.toContain(artem.id)

      await page.goto('/interviews')
      await expect(page.getByTestId('interviews-page')).toBeVisible()
      const outsiderSelect = page.locator('select').first()
      await expect(outsiderSelect).toBeVisible()
      // Prove the list actually LOADED (not just "checked too early") by
      // waiting for Kateryna's own base-seed senior (Dmytro, Team Marchenko)
      // to appear first — only THEN is "Artem is absent" a real negative.
      await expect(outsiderSelect.locator('option', { hasText: 'Dmytro Marchenko' })).toHaveCount(1)
      await expect(outsiderSelect.locator('option', { hasText: artem.displayName })).toHaveCount(0)

      const directRes = await page.request.get(
        `${REAL_API_BASE}/api/interviews?seniorId=${artem.id}`,
      )
      expect(directRes.status()).toBe(403)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
