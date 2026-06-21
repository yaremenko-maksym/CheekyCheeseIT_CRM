/**
 * drop-junior-rbac.spec.ts — task-expand-drop-e2e-coverage (AC6).
 *
 * Verifies that a JUNIOR cannot view a drop-team via the direct URL
 * `/team/<drop-team-id>` — the backend returns 403 / 404 / empty
 * (depending on how the controller scopes it) and the UI either renders
 * an empty state or redirects to a non-team page.
 *
 * This spec uses real-API setup (creating a drop + drop-team as ADMIN)
 * then logs in as a seed JUNIOR via dev-login and hits the direct URL.
 *
 * Acceptance: page does NOT render the team's member grid (no leak of
 * drop / HR / accountant identities to an unrelated junior).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop-team direct URL — JUNIOR RBAC (AC6)', () => {
  test('JUNIOR hitting /team/<drop-team-id> directly sees no drop-team contents', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac6-junior-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC6 Junior ${suffix}`

    // Step 1: provision drop-team as ADMIN.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    try {
      // Step 2: re-login as JUNIOR (replaces the cookie).
      await loginViaApi(page, SEED_EMAILS.juniorA)

      // Step 3: hit the direct URL.
      await page.goto(`/team/${teamId}`)

      // The teams.controller filters by RBAC. A JUNIOR can only see their
      // own team(s) — the drop-team is *not* theirs. Possible UI outcomes:
      //   (a) The route guard redirects them away from /team.
      //   (b) The page renders with an «empty» / «not found» state.
      //   (c) The API returns 404 and the page surfaces an error toast.
      //
      // None of those should leak the drop's display name or the team
      // detail header. Assertion: the drop's name does NOT appear in <main>.
      const main = page.locator('main')
      await expect(main).toBeVisible({ timeout: 10_000 })

      // Strong assertion: the drop's display name must not surface anywhere
      // on the page (header, members list, etc.).
      await expect(page.getByText(dropDisplayName, { exact: false })).toHaveCount(0)

      // Sanity: the «team-archive-button» (ADMIN-only) is never rendered.
      await expect(page.getByTestId('team-archive-button')).toHaveCount(0)
      await expect(page.getByTestId('team-edit-button')).toHaveCount(0)
    } finally {
      // Re-login as ADMIN to clean up the drop.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
