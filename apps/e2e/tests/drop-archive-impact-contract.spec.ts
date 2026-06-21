/**
 * drop-archive-impact-contract.spec.ts — task-e2e-fragile-points-audit.
 *
 * Real-API contract test for `GET /api/teams/:id/archive-impact` on a
 * drop-team. Round-2 backend testing surfaced that the dialog needed
 * `teamType`, `dropName`, and `seniorWillBeDetached` to render the drop-
 * specific copy («Архивировать команду дропа», confirm input = drop name,
 * cascade preview text).
 *
 * The mock-based `drop-archive-cascade.spec.ts` covers the UI rendering
 * with hard-coded mock responses, but NONE of the specs verify that the
 * LIVE backend actually returns those three fields. A regression in the
 * `getArchiveImpact` service (e.g. dropping `teamType` from the response
 * shape) would only be caught after the dialog rendered with stale senior
 * wording in production.
 *
 * This spec hits the real `/api/teams/:id/archive-impact` endpoint:
 *   1. For a drop-team with a senior attached:
 *      - response.type === 'team'
 *      - response.teamType === 'DROP'
 *      - response.dropName === <provisioned drop displayName>
 *      - response.seniorWillBeDetached === true
 *   2. For a vacant drop-team (no senior):
 *      - same as above, but seniorWillBeDetached === false
 *   3. For a senior-team (sanity / regression-safe):
 *      - response.teamType === 'SENIOR'
 *      - response.dropName field is absent or empty
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  addSeniorToDropTeamViaAPI,
  cleanupDropViaAPI,
  findUserByEmailViaApi,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop archive-impact contract — real API', () => {
  test('drop-team with senior → teamType=DROP, dropName set, seniorWillBeDetached=true', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropDisplayName = `Drop Impact ${suffix}`
    const dropEmail = `drop-impact-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    try {
      // Attach a seed SENIOR so seniorWillBeDetached flips to true.
      await addSeniorToDropTeamViaAPI(page, teamId, { seniorEmail: SEED_EMAILS.seniorB })

      const res = await page.request.get(`${REAL_API}/teams/${teamId}/archive-impact`)
      expect(res.status()).toBe(200)
      const body = (await res.json()) as Record<string, unknown>

      // Discriminator: archive-impact for a team always returns type='team'.
      expect(body.type).toBe('team')
      // Drop-archive round 2 contract: teamType is the explicit discriminator
      // the frontend keys on to render drop-specific copy.
      expect(body.teamType).toBe('DROP')
      // The drop's display name is what the confirm-input prompt asks for.
      expect(body.dropName).toBe(dropDisplayName)
      // Senior present → seniorWillBeDetached must be true.
      expect(body.seniorWillBeDetached).toBe(true)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('vacant drop-team (no senior) → teamType=DROP, dropName set, seniorWillBeDetached=false', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropDisplayName = `Drop Vacant Impact ${suffix}`
    const dropEmail = `drop-vacant-impact-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    try {
      const res = await page.request.get(`${REAL_API}/teams/${teamId}/archive-impact`)
      expect(res.status()).toBe(200)
      const body = (await res.json()) as Record<string, unknown>

      expect(body.type).toBe('team')
      expect(body.teamType).toBe('DROP')
      expect(body.dropName).toBe(dropDisplayName)
      // No senior attached → flag must be false.
      expect(body.seniorWillBeDetached).toBe(false)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('senior-team → teamType=SENIOR (regression-safe — no drop fields leak)', async ({
    page,
  }) => {
    // Use the seed Alpha Team via the seniorA's own team. The TeamsService
    // resolves it via the senior's primary team membership — easier than
    // creating a fresh senior-team in tests.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
    if (!senior) throw new Error('Seed senior not found')

    const teamsRes = await page.request.get(`${REAL_API}/teams`)
    expect(teamsRes.status()).toBe(200)
    const teams = (await teamsRes.json()) as Array<{
      id: string
      type: string
      members: Array<{ userId: string; role: string; leftAt: string | null }>
    }>
    // Find a SENIOR-team containing the seed seniorA — that's the seed
    // Alpha Team.
    const seniorTeam = teams.find(
      (t) =>
        t.type === 'SENIOR' &&
        t.members.some((m) => m.userId === senior.id && m.role === 'SENIOR' && m.leftAt === null),
    )
    expect(seniorTeam, 'Expected a seed senior-team for seniorA').toBeTruthy()

    const res = await page.request.get(`${REAL_API}/teams/${seniorTeam!.id}/archive-impact`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body.type).toBe('team')
    // Regression sanity: senior-team MUST return teamType='SENIOR' so
    // the dialog doesn't accidentally render drop-copy.
    expect(body.teamType).toBe('SENIOR')
    // dropName / seniorWillBeDetached should be absent on senior-teams
    // (or null/undefined). Loose check: not equal to a non-empty string.
    if (body.dropName !== undefined) {
      // Backend may omit the field entirely OR send empty string — both
      // are acceptable. A non-empty dropName on a senior-team would be a bug.
      expect(body.dropName).toBe('')
    }
  })
})
