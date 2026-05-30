/**
 * drop-archive-real.spec.ts — task-expand-drop-e2e-coverage (AC1).
 *
 * REAL-API coverage of the drop-team archive flow. Round-2 user testing
 * exposed that the legacy mock-based specs (`drop-archive-cascade.spec.ts`)
 * never noticed the backend bug where archiving a drop-team didn't
 * archive the DROP user (fixed in PR #63 by routing
 * `TeamsController.archive` through `archiveDropTeam` for `type='DROP'`).
 *
 * This spec hits the *live* backend via the helpers in `fixtures.ts`:
 *   - `loginViaApi(SEED_ADMIN_EMAIL)` plants a real JWT cookie
 *   - `createDropViaAPI` POSTs to /api/users/drops to provision a drop +
 *     drop-team atomically
 *   - `addSeniorToDropTeamViaAPI` attaches a seed SENIOR to the drop-team
 *   - The «Архивировать» button on `/crm/team/<id>` is clicked
 *   - The shared archive dialog (`ArchiveConfirmDialog` in
 *     `components/archive/`) shows DROP-specific copy: title «Архивировать
 *     команду дропа», impact text contains «дроп», confirm-input prompt
 *     asks for the *drop name* (not the senior name)
 *   - After submit, real-API assertions verify:
 *       * team.archivedAt is set
 *       * drop user.archivedAt is set
 *       * senior user.archivedAt is *null* (detach, not archive)
 *       * senior's team_members.leftAt is set (he's been removed)
 *       * any drop-projects are CLOSED + archived
 *
 * Cleanup: each test calls `cleanupDropViaAPI` to roll the drop user back
 * to archived state (idempotent — works whether the UI archived it or not).
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
  getUserViaAPI,
  getDropProjectsViaAPI,
} from './fixtures'

// Each helper test gets a unique email/displayName suffix so reruns don't
// 409 on duplicate-email from earlier test runs that crashed before cleanup.
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop-team archive — real-API (AC1)', () => {
  test('ADMIN archives a drop-team with a seed senior; cascade is correct end-to-end', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac1-cascade-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC1 Cascade ${suffix}`

    // Step 1: login as ADMIN via dev-login (real JWT cookie).
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Step 2: provision the drop + drop-team via the real endpoint.
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    let cleanedUp = false
    try {
      // Step 3: attach a seed SENIOR to the drop-team so the cascade has
      // a real detach to perform.
      const { seniorId } = await addSeniorToDropTeamViaAPI(page, teamId, {
        seniorEmail: SEED_EMAILS.seniorB,
      })

      // Step 4: navigate to the drop-team detail and click Архивировать.
      await page.goto(`/crm/team/${teamId}`)
      const archiveBtn = page.getByTestId('team-archive-button')
      await expect(archiveBtn).toBeVisible({ timeout: 10_000 })
      await archiveBtn.click()

      // Step 5: assert the dialog uses drop-specific copy.
      // Title: «Архивировать команду дропа» (drop variant of TITLES.team).
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 8_000 })
      await expect(dialog.getByText(/Архивировать команду дропа/i)).toBeVisible()
      // Impact text must mention «дроп» — round-2 backend wording.
      // Scoped to the dialog so the team-detail headline (which also says
      // «дроп») doesn't bleed into the assertion.
      await expect(dialog.getByText(/дроп/i).first()).toBeVisible()

      // Confirm-input prompt: «введите имя дропа: <dropDisplayName>».
      // The dialog renders `<strong>` containing the expected drop name —
      // assertion gates on the visible strong text matching the drop.
      await expect(dialog.getByText(dropDisplayName, { exact: false })).toBeVisible()

      // Step 6: type the drop name to enable submit, then submit.
      const input = page.getByTestId('archive-confirm-input')
      await expect(input).toBeVisible()
      await input.fill(dropDisplayName)

      const submit = page.getByTestId('archive-confirm-submit')
      await expect(submit).toBeEnabled()

      // Wait for the DELETE request to complete so the assertions below
      // run after the transaction is committed.
      const deleteReq = page.waitForResponse(
        (resp) => resp.url().endsWith(`/api/teams/${teamId}`) && resp.request().method() === 'DELETE',
      )
      await submit.click()
      const response = await deleteReq
      expect(response.status()).toBeLessThan(400)

      // Step 7: real-API assertions on the cascade.
      const team = await getTeamViaAPI(page, teamId)
      expect(team.archivedAt).not.toBeNull()

      const drop = await getUserViaAPI(page, dropId)
      expect(drop.archivedAt).not.toBeNull()

      const senior = await getUserViaAPI(page, seniorId)
      expect(senior.archivedAt).toBeNull()

      // Senior's team_members row must have leftAt set (detached).
      const seniorRow = team.members.find((m) => m.userId === seniorId)
      // Drop role - phase 1: archived team responses include all *historic*
      // members with `leftAt` set — the seed senior gets detached on archive.
      expect(seniorRow).toBeTruthy()
      expect(seniorRow!.leftAt).not.toBeNull()

      // Drop projects (if any) — verify they're archived. Fresh drops have
      // zero projects by default so this is a no-op safety net.
      const dropProjects = await getDropProjectsViaAPI(page, dropId)
      for (const p of dropProjects) {
        expect(p.archivedAt).not.toBeNull()
      }

      cleanedUp = true // archive succeeded — drop is already archived.
    } finally {
      // Idempotent fallback cleanup: if the flow died mid-test the drop is
      // still active and would block reruns via the duplicate-email guard.
      if (!cleanedUp) {
        await cleanupDropViaAPI(page, dropId)
      }
    }
  })

  test('ADMIN archives a vacant drop-team (no senior); team + drop both archived', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac1-vacant-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC1 Vacant ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    let cleanedUp = false
    try {
      await page.goto(`/crm/team/${teamId}`)
      await expect(page.getByTestId('team-archive-button')).toBeVisible({ timeout: 10_000 })
      await page.getByTestId('team-archive-button').click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 8_000 })
      // Drop wording surfaces even when no senior is attached.
      await expect(dialog.getByText(/Архивировать команду дропа/i)).toBeVisible()

      await page.getByTestId('archive-confirm-input').fill(dropDisplayName)
      const deleteReq = page.waitForResponse(
        (resp) => resp.url().endsWith(`/api/teams/${teamId}`) && resp.request().method() === 'DELETE',
      )
      await page.getByTestId('archive-confirm-submit').click()
      await deleteReq

      const team = await getTeamViaAPI(page, teamId)
      expect(team.archivedAt).not.toBeNull()
      const drop = await getUserViaAPI(page, dropId)
      expect(drop.archivedAt).not.toBeNull()

      cleanedUp = true
    } finally {
      if (!cleanedUp) {
        await cleanupDropViaAPI(page, dropId)
      }
    }
  })
})
