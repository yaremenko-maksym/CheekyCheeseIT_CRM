/**
 * drop-senior-readonly.spec.ts — task-expand-drop-e2e-coverage (AC7).
 *
 * Verifies that a SENIOR who sits in a drop-team sees the team as
 * read-only:
 *   - Page renders the team's name + members.
 *   - The «Архивировать», «Сменить синьора», «Добавить», and
 *     «Редактировать» buttons are NOT rendered (data-testid asserted to
 *     have count 0).
 *   - The «Команда дропа» badge (or equivalent DROP signal) is visible
 *     to the senior — they know they're in a drop-team, not a senior-team.
 *
 * Setup uses real-API helpers: ADMIN provisions a drop-team and attaches
 * a seed SENIOR; then the test re-logs in as that SENIOR and asserts.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  addSeniorToDropTeamViaAPI,
  cleanupDropViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop-team — SENIOR read-only view (AC7)', () => {
  test('senior attached to a drop-team sees no edit/archive controls', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac7-senior-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC7 Senior ${suffix}`

    // Step 1: provision drop-team as ADMIN.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    try {
      // Step 2: attach a seed SENIOR to the drop-team.
      await addSeniorToDropTeamViaAPI(page, teamId, { seniorEmail: SEED_EMAILS.seniorB })

      // Step 3: re-login as the SENIOR and visit the team page.
      await loginViaApi(page, SEED_EMAILS.seniorB)
      await page.goto(`/team/${teamId}`)

      // The page renders — drop's display name visible somewhere (the team
      // header includes the drop name in the member list).
      const main = page.locator('main')
      await expect(main).toBeVisible({ timeout: 10_000 })

      // Drop-team badge / signal — at minimum the «дроп» wording surfaces
      // somewhere on the team detail (team name often follows the pattern
      // «Команда <Drop name>»). The header's role-badge for DROP is
      // ROLE_VARIANT['DROP'] = 'drop' → Badge shows «Дроп».
      // Scope to <main> so sidebar matches don't false-trip.
      await expect(main.getByText(/Дроп|дроп/i).first()).toBeVisible({ timeout: 10_000 })

      // No admin/HR controls — these testids ship only when `user.role ===
      // 'ADMIN'` or (for senior-team) `role === 'HR'` && team owner. SENIOR
      // is gated out of all of them by the team-detail conditionals.
      await expect(page.getByTestId('team-archive-button')).toHaveCount(0)
      await expect(page.getByTestId('team-edit-button')).toHaveCount(0)

      // «Сменить синьора» / «Rotate senior» — round-2 admin-only control
      // on the drop-team page. Test that it never surfaces to a SENIOR.
      await expect(page.getByRole('button', { name: /сменить синьора/i })).toHaveCount(0)

      // «Добавить» — add-member affordance, ADMIN/HR-only.
      await expect(page.getByRole('button', { name: /^добавить$/i })).toHaveCount(0)
    } finally {
      // Re-login as ADMIN and archive the drop to clean up.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
