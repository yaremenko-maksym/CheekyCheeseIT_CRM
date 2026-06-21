/**
 * drop-multi-hr.spec.ts — task-expand-drop-e2e-coverage (AC5).
 *
 * Verifies that the drop creation form supports adding 2+ HRs and that
 * the backend persists both as active team_members.
 *
 * Setup uses real API helpers — the spec posts to /api/users/drops with
 * both seed HR ids (Anna + Kateryna) and then verifies via GET that the
 * resulting drop-team has both HR rows with `leftAt = null`.
 *
 * This complements `drop-create.spec.ts` (which only covers single-HR
 * auto-select) by asserting the multi-HR contract end-to-end.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  getTeamViaAPI,
  findUserByEmailViaApi,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop create — multi-HR (AC5)', () => {
  test('creating a drop with 2 HRs persists both as active team_members', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac5-multihr-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC5 MultiHR ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Resolve HR ids up-front so we can assert membership cleanly later.
    const hrA = await findUserByEmailViaApi(page, SEED_EMAILS.hrA)
    const hrB = await findUserByEmailViaApi(page, SEED_EMAILS.hrB)
    if (!hrA || !hrB) {
      throw new Error(`Seed HR users missing — expected ${SEED_EMAILS.hrA} and ${SEED_EMAILS.hrB}`)
    }

    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
      hrEmails: [SEED_EMAILS.hrA, SEED_EMAILS.hrB],
    })

    try {
      // API-level assertion: both HRs present in team_members with leftAt=null.
      const team = await getTeamViaAPI(page, teamId)
      const activeMembers = team.members.filter((m) => m.leftAt === null)
      const activeHrIds = activeMembers.filter((m) => m.role === 'HR').map((m) => m.userId)
      expect(activeHrIds).toContain(hrA.id)
      expect(activeHrIds).toContain(hrB.id)

      // UI-level assertion: drop-team detail surfaces both HRs in the members
      // grid (each HR row carries the user's display name).
      await page.goto(`/team/${teamId}`)
      // Members section scope — exclude sidebar / header repetitions.
      const main = page.locator('main')
      await expect(main.getByText(hrA.displayName, { exact: false })).toBeVisible({
        timeout: 10_000,
      })
      await expect(main.getByText(hrB.displayName, { exact: false })).toBeVisible()
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
