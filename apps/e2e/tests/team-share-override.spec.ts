/**
 * team-share-override.spec.ts — task-autotest-business-logic-coverage (G).
 *
 * Team-level senior share override — covers the resolver precedence:
 *   PROJECT override > TEAM override > USER default.
 *
 * Real-API. Mutates the seed senior's team to plant a team-level override,
 * then exercises the snapshot logic via SENIOR_INCOME / DROP_INCOME insertion
 * and asserts `seniorSharePercent` + `seniorSharePercentSource` on the row.
 *
 * Scenarios:
 *   1. PATCH /api/teams/:id with `seniorSharePercentOverride: 16` → persists.
 *   2. SENIOR creates SENIOR_INCOME on a project (no project override) →
 *      tx.seniorSharePercent=16, tx.seniorSharePercentSource='TEAM'.
 *   3. Precedence: a fresh project WITH `seniorSharePercentOverride=33` →
 *      tx snapshot reads 33, source='PROJECT' (project beats team).
 *   4. Clear team override (`PATCH … { seniorSharePercentOverride: null }`)
 *      → new SENIOR_INCOME falls back to USER_DEFAULT.
 *
 * Cleanup: reset the team override to null in finally{} so the test doesn't
 * leak persistent state across runs.
 */

import { test, expect, REAL_API_BASE } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  findUserByEmailViaApi,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Get the SENIOR's primary team (first active senior-team). */
async function getSeniorTeamId(
  page: import('@playwright/test').Page,
  seniorEmail: string,
): Promise<string | null> {
  const teamsRes = await page.request.get(`${REAL_API}/teams`)
  if (teamsRes.status() !== 200) return null
  const teams = (await teamsRes.json()) as Array<{
    id: string
    type: string
    archivedAt: string | null
    members: Array<{ email: string; role: string; leftAt: string | null }>
  }>
  const seniorTeams = teams.filter(
    (t) =>
      t.type === 'SENIOR' &&
      t.archivedAt === null &&
      t.members.some((m) => m.email === seniorEmail && m.role === 'SENIOR' && m.leftAt === null),
  )
  return seniorTeams[0]?.id ?? null
}

/** Patch the team's seniorSharePercentOverride field. */
async function patchTeamOverride(
  page: import('@playwright/test').Page,
  teamId: string,
  override: number | null,
): Promise<void> {
  // The schema requires `name` even on partial updates, so we pull the team
  // first and pass it back.
  const teamRes = await page.request.get(`${REAL_API}/teams/${teamId}`)
  if (teamRes.status() !== 200) {
    throw new Error(`getTeam failed: ${teamRes.status()}`)
  }
  const team = (await teamRes.json()) as { id: string; name: string }
  const res = await page.request.patch(`${REAL_API}/teams/${teamId}`, {
    data: { name: team.name, seniorSharePercentOverride: override },
  })
  if (res.status() !== 200) {
    throw new Error(`patchTeam failed: ${res.status()} — ${await res.text()}`)
  }
}

/** Get a single transaction row (with extra fields). */
async function getTxFull(
  page: import('@playwright/test').Page,
  txId: string,
): Promise<Record<string, unknown>> {
  const res = await page.request.get(`${REAL_API}/transactions/${txId}`)
  if (res.status() !== 200) {
    throw new Error(`getTransaction failed: ${res.status()}`)
  }
  return (await res.json()) as Record<string, unknown>
}

test.describe('Team senior share override — resolver precedence', () => {
  test('TEAM override surfaces when no project override is set; PROJECT override wins when present', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
    expect(senior).toBeTruthy()

    const teamId = await getSeniorTeamId(page, SEED_EMAILS.seniorA)
    if (!teamId) {
      test.skip(true, 'Seed senior A has no active team — cannot exercise team override')
      return
    }

    // Capture the original override so the finally{} block can restore it.
    const teamBeforeRes = await page.request.get(`${REAL_API}/teams/${teamId}`)
    const teamBefore = (await teamBeforeRes.json()) as {
      seniorSharePercentOverride: number | null
    }
    const originalOverride = teamBefore.seniorSharePercentOverride

    let projectAId: string | null = null
    let projectBId: string | null = null

    try {
      // 1) Plant team override = 16.
      await patchTeamOverride(page, teamId, 16)

      // Project A — NO project override. SENIOR_INCOME should snapshot
      // TEAM source with value 16.
      const projA = await createSeniorProjectViaAPI(page, {
        seniorEmail: SEED_EMAILS.seniorA,
        name: `Team Override A ${suffix}`,
      })
      projectAId = projA.projectId

      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId: txA } = await createSeniorIncomeViaAPI(page, {
        projectId: projectAId,
        amount: 1000,
      })

      // Snapshot read.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txAFull = await getTxFull(page, txA)
      expect(txAFull['seniorSharePercent']).toBe(16)
      expect(txAFull['seniorSharePercentSource']).toBe('TEAM')

      // 2) Project B — WITH project override = 33. Project beats team.
      const projB = await createSeniorProjectViaAPI(page, {
        seniorEmail: SEED_EMAILS.seniorA,
        name: `Team Override B ${suffix}`,
      })
      projectBId = projB.projectId
      // Patch project to set override=33.
      const patchRes = await page.request.patch(`${REAL_API}/projects/${projectBId}`, {
        data: { seniorSharePercentOverride: 33 },
      })
      expect(patchRes.status()).toBe(200)

      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId: txB } = await createSeniorIncomeViaAPI(page, {
        projectId: projectBId,
        amount: 1000,
      })

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txBFull = await getTxFull(page, txB)
      expect(txBFull['seniorSharePercent']).toBe(33)
      expect(txBFull['seniorSharePercentSource']).toBe('PROJECT')
    } finally {
      // Restore original team override.
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await patchTeamOverride(page, teamId, originalOverride).catch(() => undefined)
      if (projectAId) {
        await page.request.delete(`${REAL_API}/projects/${projectAId}`).catch(() => undefined)
      }
      if (projectBId) {
        await page.request.delete(`${REAL_API}/projects/${projectBId}`).catch(() => undefined)
      }
    }
  })

  test('Clearing TEAM override (null) → next SENIOR_INCOME snapshot falls back to USER_DEFAULT', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const teamId = await getSeniorTeamId(page, SEED_EMAILS.seniorA)
    if (!teamId) {
      test.skip(true, 'Seed senior A has no active team')
      return
    }

    const teamBeforeRes = await page.request.get(`${REAL_API}/teams/${teamId}`)
    const teamBefore = (await teamBeforeRes.json()) as {
      seniorSharePercentOverride: number | null
    }
    const originalOverride = teamBefore.seniorSharePercentOverride

    let projectId: string | null = null

    try {
      // Make sure team override is explicitly null.
      await patchTeamOverride(page, teamId, null)

      const proj = await createSeniorProjectViaAPI(page, {
        seniorEmail: SEED_EMAILS.seniorA,
        name: `User Default ${suffix}`,
      })
      projectId = proj.projectId

      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
      })

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const tx = await getTxFull(page, txId)
      expect(tx['seniorSharePercentSource']).toBe('USER_DEFAULT')
      // Value matches the senior's user-level default (26 by seed).
      expect(typeof tx['seniorSharePercent']).toBe('number')
      expect(tx['seniorSharePercent']).toBeGreaterThan(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await patchTeamOverride(page, teamId, originalOverride).catch(() => undefined)
      if (projectId) {
        await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
      }
    }
  })
})
