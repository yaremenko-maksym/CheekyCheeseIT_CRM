import type { Page } from '@playwright/test'
import { REAL_API_BASE, SEED_EMAILS, VALID_USDT_WALLET } from './common'
import { findUserByEmailViaApi } from './auth'

/**
 * Create a DROP user + drop-team via POST /api/users/drops.
 *
 * Pre-conditions:
 *   - Caller is logged in as ADMIN via `loginViaApi(page, SEED_EMAILS.admin)`.
 *   - The HR / accountant referenced by `hrEmails` / `accountantEmail` exist
 *     in the DB (seed users by default).
 *
 * Returns the created drop user + team id. The team is provisioned with
 * the DROP user as a member; HR/Accountant added per the payload; no
 * SENIOR attached (use `addSeniorToDropTeamViaAPI` for that).
 */
export async function createDropViaAPI(
  page: Page,
  opts: {
    email: string
    displayName: string
    hrEmails?: string[]
    accountantEmail?: string
    dropSharePercent?: number
    telegramChannel?: string | null
    /**
     * Legal full name for the MSA contract — `createDropSchema` made this
     * mandatory (see superRefine "ФИО обязательно для контракта",
     * fix/drop-legal-name-persist). Defaults to a deterministic E2E value
     * derived from `displayName` so existing callers don't need to change;
     * override when a test asserts on the exact persisted value.
     */
    legalFullName?: string
  },
): Promise<{ dropId: string; teamId: string; email: string }> {
  const hrEmails = opts.hrEmails ?? [SEED_EMAILS.hrA]
  const accountantEmail = opts.accountantEmail ?? SEED_EMAILS.accountant
  const legalFullName = opts.legalFullName ?? `E2E Drop Legal ${opts.displayName}`

  const hrIds: string[] = []
  for (const e of hrEmails) {
    const u = await findUserByEmailViaApi(page, e)
    if (!u) throw new Error(`HR seed user not found: ${e}`)
    hrIds.push(u.id)
  }
  const accountant = await findUserByEmailViaApi(page, accountantEmail)
  if (!accountant) throw new Error(`Accountant seed user not found: ${accountantEmail}`)

  const payload = {
    email: opts.email,
    displayName: opts.displayName,
    paymentMethod: 'USDT_ERC20' as const,
    walletUsdtErc20: VALID_USDT_WALLET,
    legalFullName,
    hrIds,
    accountantId: accountant.id,
    ...(opts.dropSharePercent !== undefined && { dropSharePercent: opts.dropSharePercent }),
    ...(opts.telegramChannel !== undefined && { telegramChannel: opts.telegramChannel }),
  }

  const res = await page.request.post(`${REAL_API_BASE}/api/users/drops`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(
      `createDropViaAPI failed for ${opts.email}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as {
    user: { id: string; email: string }
    teamId?: string
    team?: { id: string }
  }
  // Service returns `{ user, teamId }`; some clients (UserDialog) read
  // `team.id`. Accept both shapes defensively.
  const teamId = body.teamId ?? body.team?.id
  if (!teamId) {
    throw new Error(`createDropViaAPI response missing teamId/team.id: ${JSON.stringify(body)}`)
  }
  return { dropId: body.user.id, teamId, email: body.user.email }
}

/**
 * Add a SENIOR to an existing drop-team via POST /api/teams/:id/members.
 *
 * Used by AC1 to plant a senior on the team before archiving, so the test
 * can assert that the senior is *detached* (leftAt set) without being archived.
 */
export async function addSeniorToDropTeamViaAPI(
  page: Page,
  teamId: string,
  opts: { seniorEmail?: string } = {},
): Promise<{ seniorId: string }> {
  const seniorEmail = opts.seniorEmail ?? SEED_EMAILS.seniorA
  const senior = await findUserByEmailViaApi(page, seniorEmail)
  if (!senior) throw new Error(`Senior seed user not found: ${seniorEmail}`)
  const res = await page.request.post(`${REAL_API_BASE}/api/teams/${teamId}/members`, {
    data: { userId: senior.id },
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`addSeniorToDropTeamViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return { seniorId: senior.id }
}

/**
 * Archive a drop-team via DELETE /api/teams/:id (the contract enforced
 * by the team-detail UI «Архивировать» button after the round-2 backend
 * fix). Used by tests that need to skip the UI dialog and just plant
 * archived state.
 */
export async function archiveDropTeamViaAPI(page: Page, teamId: string): Promise<void> {
  const res = await page.request.delete(`${REAL_API_BASE}/api/teams/${teamId}`)
  if (res.status() !== 200 && res.status() !== 204) {
    throw new Error(
      `archiveDropTeamViaAPI failed for team ${teamId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

/** Fetch a team by id via GET /api/teams/:id — returns the parsed body. */
export async function getTeamViaAPI(
  page: Page,
  teamId: string,
): Promise<{
  id: string
  name: string
  type: string
  archivedAt: string | null
  members: Array<{ userId: string; role: string; leftAt: string | null }>
}> {
  const res = await page.request.get(`${REAL_API_BASE}/api/teams/${teamId}`)
  if (res.status() !== 200) {
    throw new Error(`GET /api/teams/${teamId} failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return (await res.json()) as Awaited<ReturnType<typeof getTeamViaAPI>>
}

/**
 * Fetch a team's audit-log via GET /api/teams/:id/audit-log (ADMIN-only).
 *
 * `TeamsService.mapDropTeam` (security-review PR #541 round 3) filters
 * `members` to ACTIVE rows only (`leftAt === null`) — a drop-team's GET
 * response NEVER includes a detached (leftAt-set) historic member, by
 * design. Specs proving "the senior was detached, not archived" during a
 * drop-team/drop-user archive cascade therefore cannot observe the
 * `leftAt` timestamp via `getTeamViaAPI` — the member simply disappears
 * from the list. This helper reads the audit trail `archiveDropTeam`
 * writes instead (`action: 'team_member_removed'`, `changes.userId.before`
 * = the detached user, `changes.role.before` = their pre-detach role) —
 * the actual observable proof that the cascade ran, not an inference from
 * absence. Caller must be ADMIN.
 */
export async function getTeamAuditLogViaAPI(
  page: Page,
  teamId: string,
): Promise<
  Array<{
    id: string
    actorId: string | null
    targetId: string
    action: string
    changes: Record<string, { before: unknown; after: unknown }>
    createdAt: string
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/teams/${teamId}/audit-log`)
  if (res.status() !== 200) {
    throw new Error(
      `getTeamAuditLogViaAPI failed for team ${teamId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { entries: Awaited<ReturnType<typeof getTeamAuditLogViaAPI>> }
  return body.entries
}

/** Fetch a user by id via GET /api/users/:id — returns the user shell. */
export async function getUserViaAPI(
  page: Page,
  userId: string,
): Promise<{ id: string; email: string; role: string; archivedAt: string | null }> {
  const res = await page.request.get(`${REAL_API_BASE}/api/users/${userId}`)
  if (res.status() !== 200) {
    throw new Error(`GET /api/users/${userId} failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as {
    user: { id: string; email: string; role: string; archivedAt: string | null }
  }
  return body.user
}

/**
 * Fetch projects filtered by `?dropId=` via GET /api/projects (real-API
 * branch — backend may not expose this exact filter; in that case the
 * helper falls back to listing all archived projects and filtering by
 * dropId client-side).
 */
export async function getDropProjectsViaAPI(
  page: Page,
  dropId: string,
): Promise<Array<{ id: string; dropId: string | null; archivedAt: string | null }>> {
  // Round 5: projects list takes `?archived=true|false`. Fetch both and
  // filter by dropId client-side — the backend doesn't expose a `?dropId`
  // filter in the public route.
  const [activeRes, archivedRes] = await Promise.all([
    page.request.get(`${REAL_API_BASE}/api/projects`),
    page.request.get(`${REAL_API_BASE}/api/projects?archived=true`),
  ])
  const active =
    activeRes.status() === 200
      ? ((await activeRes.json()) as Array<{
          id: string
          dropId: string | null
          archivedAt: string | null
        }>)
      : []
  const archived =
    archivedRes.status() === 200
      ? ((await archivedRes.json()) as Array<{
          id: string
          dropId: string | null
          archivedAt: string | null
        }>)
      : []
  return [...active, ...archived].filter((p) => p.dropId === dropId)
}

/**
 * Cleanup helper — archive the drop (cascade-archives the team + projects)
 * to leave the DB clean between tests. Idempotent: silently ignores
 * 4xx errors when the drop is already archived or missing.
 */
export async function cleanupDropViaAPI(page: Page, dropId: string): Promise<void> {
  await page.request.delete(`${REAL_API_BASE}/api/users/drops/${dropId}`).catch(() => undefined)
}
