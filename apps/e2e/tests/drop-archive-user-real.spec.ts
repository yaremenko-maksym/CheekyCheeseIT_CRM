/**
 * drop-archive-user-real.spec.ts — task-expand-drop-e2e-coverage (AC2).
 *
 * REAL-API coverage of archiving a DROP user via /users (the row-level
 * archive button). The cascade contract for DROP role:
 *   - drop.archivedAt set
 *   - drop-team.archivedAt set (cascade through `archiveDropTeam`)
 *   - active SENIOR (if any) detached (team_members.leftAt set) but
 *     senior.archivedAt stays null
 *   - drop-projects archived
 *
 * The legacy mock spec (drop-archive-cascade.spec.ts) checks only that the
 * dialog opens. This spec follows the click through to a real backend call
 * (DELETE /api/users/<dropId>) and verifies the cascade via GET requests.
 *
 * Pre-conditions:
 *   - Backend running on :3001 with the dev seed (CI workflow handles this).
 *   - The seed ADMIN (`yaremenkomaksym99@gmail.com`) exists.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  addSeniorToDropTeamViaAPI,
  cleanupDropViaAPI,
  getTeamViaAPI,
  getTeamAuditLogViaAPI,
  getUserViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop user archive — real-API (AC2)', () => {
  test('ADMIN archives DROP via /users — cascade detaches senior, archives team', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac2-user-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC2 User ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Setup: drop + drop-team via API.
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    let cleanedUp = false
    try {
      // Attach a senior so we can verify detach (not archive).
      const { seniorId } = await addSeniorToDropTeamViaAPI(page, teamId, {
        seniorEmail: SEED_EMAILS.seniorB,
      })

      // Navigate to /users and locate the drop row's archive button.
      await page.goto('/users')

      // Wait for the users list to render. We don't filter on archived
      // status — the freshly-created drop is active, so it surfaces on
      // the default «Активные» tab.
      const archiveBtn = page.getByTestId(`user-row-archive-${dropId}`)
      await expect(archiveBtn).toBeVisible({ timeout: 10_000 })
      await archiveBtn.click()

      // The per-user dialog (`components/users/ArchiveConfirmDialog`)
      // surfaces with a name-input gating the destructive submit.
      const dialog = page.getByTestId('archive-confirm-dialog')
      await expect(dialog).toBeVisible({ timeout: 8_000 })
      await expect(dialog.getByText(/Архивировать пользователя/i)).toBeVisible()

      // Confirm-input: name match (per-user variant uses `displayName`).
      await page.getByTestId('archive-confirm-name-input').fill(dropDisplayName)
      const submit = page.getByTestId('archive-confirm-submit')
      await expect(submit).toBeEnabled()

      const deleteReq = page.waitForResponse(
        (resp) =>
          resp.url().endsWith(`/api/users/${dropId}`) && resp.request().method() === 'DELETE',
      )
      await submit.click()
      const resp = await deleteReq
      expect(resp.status()).toBeLessThan(400)

      // Assertions via real API — drop + team archived, senior detached
      // but active.
      const drop = await getUserViaAPI(page, dropId)
      expect(drop.archivedAt).not.toBeNull()

      const team = await getTeamViaAPI(page, teamId)
      expect(team.archivedAt).not.toBeNull()

      const senior = await getUserViaAPI(page, seniorId)
      expect(senior.archivedAt).toBeNull()

      // Backlog item 139: `TeamsService.mapDropTeam` (security-review PR
      // #541 round 3) filters a drop-team's `members` to ACTIVE rows only
      // (`leftAt === null`) — a detached member is NEVER returned by
      // `GET /api/teams/:id`. Assert absence from the active list + the
      // audit trail `archiveDropTeam` writes for the specific detach — see
      // the identical fix (and full rationale) in drop-archive-real.spec.ts.
      expect(team.members.find((m) => m.userId === seniorId)).toBeUndefined()

      const auditLog = await getTeamAuditLogViaAPI(page, teamId)
      const detachEntry = auditLog.find(
        (e) => e.action === 'team_member_removed' && e.changes['userId']?.before === seniorId,
      )
      expect(detachEntry).toBeTruthy()
      expect(detachEntry!.changes['role']?.before).toBe('SENIOR')
      expect(detachEntry!.changes['userId']?.after).toBeNull()

      cleanedUp = true
    } finally {
      if (!cleanedUp) {
        await cleanupDropViaAPI(page, dropId)
      }
    }
  })
})
