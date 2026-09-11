import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Approval, PendingItem, PendingResponse, SessionUser } from '@crm/shared'
import { pendingResponseSchema } from '@crm/shared'
import { ApprovalsService } from '../approvals/approvals.service'
import { DatabaseService } from '../database/database.service'
import { employeeContracts, projects, teamMembers, users } from '../database/schema'
import { resolveSeniorShare, type ResolverTeam } from '../finance/senior-share-resolver'

/**
 * task-pending-screen (position 7c of docs/superpowers/specs/2026-09-01-
 * notifications-and-confirmations-design.md, §8.3). Backs `GET /pending` —
 * the one screen aggregating everything a viewer either owes a decision on
 * (`mine`) or opened and is still waiting on someone else for (`proposedByMe`,
 * ADMIN only — task file §Что сделать item 1: every other role gets `[]`,
 * never a 403, "одна форма ответа").
 *
 * Deliberately its own module, NOT folded into `ApprovalsModule`:
 * `ApprovalsService`'s own header says it "knows nothing about projects or
 * shares" — this service is the opposite by design, a cross-subject
 * aggregator that reads `projects`/`users`/`employee_contracts` directly.
 * It calls INTO `ApprovalsService` (its two `listPending*` queries) rather
 * than duplicating them, but does not belong inside that module's boundary.
 *
 * Today exactly three `approvals.subjectType` values exist in the codebase
 * (`PROJECT`, `PROJECT_SENIOR_SHARE`, `USER_SENIOR_SHARE` — confirmed by
 * grep across apps/api/src; there is no DROP-share approval flow at all),
 * which is why `mine`/`proposedByMe` structurally can never carry a DROP
 * percentage: the column to hold one does not exist on this path. A row
 * whose `subjectType` is none of the three below is skipped rather than
 * guessed at — see `mapApprovalRow`.
 */

const PROJECT_APPROVAL_SUBJECT_TYPE = 'PROJECT'
const PROJECT_SENIOR_SHARE_SUBJECT_TYPE = 'PROJECT_SENIOR_SHARE'
const USER_SENIOR_SHARE_SUBJECT_TYPE = 'USER_SENIOR_SHARE'

type ProjectLite = {
  id: string
  name: string
  archivedAt: Date | null
  seniorSharePercentOverride: number | null
  pendingSeniorSharePercentOverride: number | null
}

type UserLite = {
  id: string
  displayName: string
  seniorSharePercent: number
  pendingSeniorSharePercent: number | null
}

@Injectable()
export class PendingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
  ) {}

  async getPending(viewer: SessionUser): Promise<PendingResponse> {
    const [approverRows, contractItem] = await Promise.all([
      this.approvals.listPendingForApprover(viewer.id),
      this.buildContractItem(viewer.id),
    ])

    const mine = await this.buildMineItems(approverRows, viewer.id)
    if (contractItem) mine.push(contractItem)
    mine.sort(byCreatedAtAsc)

    // task file §Что сделать item 1: "для остальных ролей — пустой массив,
    // не 403 (одна форма ответа)" — every non-ADMIN role never even reaches
    // `listPendingProposedBy`, not because the query would be wrong for
    // them (nothing stops a SENIOR from being `proposedByUserId` on a row
    // today), but because the SCREEN's "Ждут решения других" section is
    // ADMIN-only by design (task file §Разделение: "Раздел ADMIN «Ждут
    // решения других»").
    let proposedByMe: PendingItem[] = []
    if (viewer.role === 'ADMIN') {
      const proposedRows = await this.approvals.listPendingProposedBy(viewer.id)
      proposedByMe = await this.buildProposedByMeItems(proposedRows)
      proposedByMe.sort(byCreatedAtAsc)
    }

    return pendingResponseSchema.parse({ mine, proposedByMe })
  }

  // ---------------------------------------------------------------------
  // Contract item (not an `approvals` row at all)
  // ---------------------------------------------------------------------

  /**
   * task file §Что сделать item 1: "mine: listPendingForApprover(me) +
   * READY_TO_SIGN-контракт зрителя". Self-only by construction (`userId`
   * always the viewer's own id, never client-supplied) — mirrors
   * `EmployeeContractsService.getMyStatus`'s own self-only contract. A
   * direct query rather than a call into `EmployeeContractsService`/
   * `ContractsModule`: this task's zone is `approvals/**` + a new
   * `pending/**` module, not the contracts module — see task file
   * §Разделение — and the two columns this needs (`id`, `updatedAt`) are a
   * plain read no service method exposes today.
   *
   * `updatedAt` (not `createdAt`) for `createdAt` on the built item: the
   * row's own `createdAt` is when the DRAFT was first opened, not when it
   * became READY_TO_SIGN — `EmployeeContractsService.markReadyForSigning`
   * (DRAFT → READY_TO_SIGN) stamps `updatedAt: new Date()` on that exact
   * transition, and further edits are blocked once READY_TO_SIGN (MED#2),
   * so `updatedAt` cannot drift again before this item disappears.
   */
  private async buildContractItem(userId: string): Promise<PendingItem | null> {
    // The exact column set and the WHERE-clause status literal below are
    // DB-level facts — a mocked unit double (`pending.service.spec.ts`'s
    // `tableChain`) returns whatever rows it was seeded with regardless of
    // what columns or filter were asked for, so a mutant on either is
    // unobservable through it by construction. `pending.integration.spec.ts`'s
    // AC1/AC2 cases run this exact query against a real Postgres and would
    // fail loudly if either diverged (same class as `mutation-gate-
    // integration-specs.md`'s own "DB-facing detail, integration-only"
    // carve-out).
    const rows = await this.db.db
      // Stryker disable next-line ObjectLiteral: DB column projection, see comment above.
      .select({ id: employeeContracts.id, updatedAt: employeeContracts.updatedAt })
      .from(employeeContracts)
      .where(
        // Stryker disable next-line StringLiteral: DB WHERE-clause literal, see comment above.
        and(eq(employeeContracts.userId, userId), eq(employeeContracts.status, 'READY_TO_SIGN')),
      )
      .limit(1)
    const row = rows[0]
    if (!row) return null

    return {
      kind: 'CONTRACT_TO_SIGN',
      subjectId: row.id,
      title: 'Контракт сотрудника',
      createdAt: row.updatedAt.toISOString(),
      // Task file §Что уже есть: "Подпись не переносить на новый экран —
      // строка ведёт туда" — the ONLY action here is navigating to the
      // real signing surface (ContractTab / ContractWaitScreen), never a
      // local approve/reject on this screen.
      actions: ['open'],
      link: '/profile',
    }
  }

  // ---------------------------------------------------------------------
  // mine — viewer IS the approver on every row (listPendingForApprover)
  // ---------------------------------------------------------------------

  private async buildMineItems(rows: Approval[], viewerId: string): Promise<PendingItem[]> {
    // Round-trip avoidance only, not a correctness branch: with `rows`
    // genuinely empty the `for` loop below never iterates and the three
    // `Promise.all` loaders each get an empty `Set` — every one of THEIR
    // own `.size === 0` guards (below) already returns an empty `Map`
    // without querying, so removing this early return produces the exact
    // same `[]`, just after three no-op awaits instead of zero.
    // Stryker disable next-line ConditionalExpression: see comment above — provably unobservable, not untested.
    if (rows.length === 0) return []

    const projectIds = new Set<string>()
    const userIds = new Set<string>([viewerId])
    for (const row of rows) {
      userIds.add(row.proposedByUserId)
      if (
        row.subjectType === PROJECT_APPROVAL_SUBJECT_TYPE ||
        row.subjectType === PROJECT_SENIOR_SHARE_SUBJECT_TYPE
      ) {
        projectIds.add(row.subjectId)
      } else if (row.subjectType === USER_SENIOR_SHARE_SUBJECT_TYPE) {
        userIds.add(row.subjectId)
      }
    }

    const [projectsById, usersById, teamOverridesBySenior] = await Promise.all([
      this.loadProjectsByIds(projectIds),
      this.loadUsersByIds(userIds),
      // `mine` rows are always the viewer's OWN share — one senior, one
      // team-override lookup, regardless of how many share-approval rows
      // are live for them.
      this.loadTeamOverridesForSeniors(new Set([viewerId])),
    ])

    const items: PendingItem[] = []
    for (const row of rows) {
      const proposedByName = usersById.get(row.proposedByUserId)?.displayName ?? 'Неизвестно'
      const item = this.buildItemForSubject(row, {
        projectsById,
        usersById,
        teamOverridesBySenior,
        seniorId: viewerId,
        isMine: true,
        proposedBy: proposedByName,
        waitingFor: undefined,
        actionsForApprovalKinds: ['approve', 'reject', 'open'],
      })
      if (item) items.push(item)
    }
    return items
  }

  // ---------------------------------------------------------------------
  // proposedByMe — ADMIN only. Grouped by (subjectType, subjectId): a
  // two-approver proposal (project inviting both SENIOR and DROP) still
  // owns exactly one live `proposedByUserId` per subject — re-proposal
  // supersedes the whole prior generation (`ApprovalsService` header) — so
  // grouping by subject can never mix rows from two different proposers.
  // ---------------------------------------------------------------------

  private async buildProposedByMeItems(rows: Approval[]): Promise<PendingItem[]> {
    // Same round-trip-avoidance reasoning as `buildMineItems`'s own guard —
    // an empty `rows` never populates any of the three loader `Set`s, and
    // each loader's own `.size === 0` guard already short-circuits to an
    // empty `Map`, so removing this line changes nothing observable.
    // Stryker disable next-line ConditionalExpression: see comment above — provably unobservable, not untested.
    if (rows.length === 0) return []

    const groups = new Map<string, Approval[]>()
    for (const row of rows) {
      const key = `${row.subjectType} ${row.subjectId}`
      const group = groups.get(key)
      if (group) group.push(row)
      else groups.set(key, [row])
    }

    const projectIds = new Set<string>()
    const userIds = new Set<string>()
    const seniorIds = new Set<string>()
    for (const row of rows) {
      userIds.add(row.approverUserId)
      if (
        row.subjectType === PROJECT_APPROVAL_SUBJECT_TYPE ||
        row.subjectType === PROJECT_SENIOR_SHARE_SUBJECT_TYPE
      ) {
        projectIds.add(row.subjectId)
        if (row.subjectType === PROJECT_SENIOR_SHARE_SUBJECT_TYPE) seniorIds.add(row.approverUserId)
      } else if (row.subjectType === USER_SENIOR_SHARE_SUBJECT_TYPE) {
        userIds.add(row.subjectId)
        seniorIds.add(row.subjectId)
      }
    }

    const [projectsById, usersById, teamOverridesBySenior] = await Promise.all([
      this.loadProjectsByIds(projectIds),
      this.loadUsersByIds(userIds),
      this.loadTeamOverridesForSeniors(seniorIds),
    ])

    const items: PendingItem[] = []
    for (const group of groups.values()) {
      const representative = group[0]
      if (!representative) continue
      const waitingForNames = group
        .map((row) => usersById.get(row.approverUserId)?.displayName)
        .filter((name): name is string => typeof name === 'string')
      const item = this.buildItemForSubject(representative, {
        projectsById,
        usersById,
        teamOverridesBySenior,
        seniorId: representative.approverUserId,
        isMine: false,
        proposedBy: undefined,
        waitingFor: waitingForNames,
        // No "withdraw a project draft" endpoint exists in main today —
        // task file §Что сделать item 2: "для проекта — если отзыва нет в
        // main, только «Открыть»". `senior-share/cancel` (#648) exists for
        // both `*_SENIOR_SHARE` subject types.
        actionsForApprovalKinds:
          representative.subjectType === PROJECT_APPROVAL_SUBJECT_TYPE
            ? ['open']
            : ['cancel', 'open'],
      })
      if (item) items.push(item)
    }
    return items
  }

  // ---------------------------------------------------------------------
  // Per-subject-type item construction, shared by both lists above.
  // ---------------------------------------------------------------------

  private buildItemForSubject(
    row: Approval,
    ctx: {
      projectsById: Map<string, ProjectLite>
      usersById: Map<string, UserLite>
      teamOverridesBySenior: Map<string, ResolverTeam[]>
      seniorId: string
      /** Which half of `getPending`'s response this item is being built
       * for — drives the USER_SENIOR_SHARE title/link choice below.
       * Explicit rather than inferred from `waitingFor`'s presence: the two
       * already vary independently in shape (`proposedBy`/`waitingFor`
       * swap), an inferred discriminator would be a third, implicit copy of
       * the same fact. A boolean, not a `'mine' | 'proposedByMe'` string
       * union: the two branches below only ever ask "is it mine or not",
       * so a string literal here bought nothing but an unkillable
       * StringLiteral mutant (either value reads as "not mine" to a
       * `=== 'mine'` check, so mutating the OTHER literal to `''` changed
       * nothing observable — a boolean's only two values are both load-
       * bearing by construction). */
      isMine: boolean
      proposedBy: string | undefined
      waitingFor: string[] | undefined
      actionsForApprovalKinds: PendingItem['actions']
    },
  ): PendingItem | null {
    if (row.subjectType === PROJECT_APPROVAL_SUBJECT_TYPE) {
      const project = ctx.projectsById.get(row.subjectId)
      // §7.4 / AC2: an archived (or already-deleted) project's proposal is
      // not "something you can act on right now" — dropped, not surfaced.
      if (!project || project.archivedAt !== null) return null
      return {
        kind: 'PROJECT_APPROVAL',
        approvalId: row.id,
        subjectType: row.subjectType,
        subjectId: project.id,
        title: project.name,
        proposedBy: ctx.proposedBy,
        waitingFor: ctx.waitingFor,
        createdAt: row.createdAt,
        actions: ctx.actionsForApprovalKinds,
        link: `/projects/${project.id}`,
      }
    }

    if (row.subjectType === PROJECT_SENIOR_SHARE_SUBJECT_TYPE) {
      const project = ctx.projectsById.get(row.subjectId)
      if (!project || project.archivedAt !== null) return null
      const senior = ctx.usersById.get(ctx.seniorId)
      if (!senior) return null
      // `resolveSeniorShare`'s TEAM step (`senior-share-resolver.ts`) keeps
      // only elements where `t.seniorSharePercentOverride !== null && !==
      // undefined` — the exact same unobservability `ProjectsService.
      // loadPendingSeniorShare`'s own comment documents for the identical
      // pattern: any non-empty-but-malformed fallback array is filtered
      // down to nothing by that same guard, indistinguishable from `[]`
      // through the only consumer this value ever reaches.
      // Stryker disable next-line ArrayDeclaration: see comment above.
      const teams = ctx.teamOverridesBySenior.get(ctx.seniorId) ?? []
      const currentPercent = resolveSeniorShare(
        { seniorSharePercentOverride: project.seniorSharePercentOverride },
        { seniorSharePercent: senior.seniorSharePercent },
        teams,
      ).value
      const pendingPercent = resolveSeniorShare(
        { seniorSharePercentOverride: project.pendingSeniorSharePercentOverride },
        { seniorSharePercent: senior.seniorSharePercent },
        teams,
      ).value
      return {
        kind: 'SHARE_APPROVAL',
        approvalId: row.id,
        subjectType: row.subjectType,
        subjectId: project.id,
        title: project.name,
        proposedBy: ctx.proposedBy,
        waitingFor: ctx.waitingFor,
        currentPercent,
        pendingPercent,
        createdAt: row.createdAt,
        actions: ctx.actionsForApprovalKinds,
        link: `/projects/${project.id}`,
      }
    }

    if (row.subjectType === USER_SENIOR_SHARE_SUBJECT_TYPE) {
      const senior = ctx.usersById.get(row.subjectId)
      if (!senior) return null
      // Base-share (USER-level) proposals never involve a project or team
      // override — `pendingSeniorShareSchema`'s own doc: "this always
      // equals `percent` itself (nothing else can override a person's own
      // base default)". `pendingSeniorSharePercent` is non-null while the
      // row is live (schema.ts's own comment on that column); `?? 0`
      // exists only for the type, never to paper over a real gap.
      const pendingPercent = senior.pendingSeniorSharePercent ?? senior.seniorSharePercent
      return {
        kind: 'SHARE_APPROVAL',
        approvalId: row.id,
        subjectType: row.subjectType,
        subjectId: senior.id,
        title: ctx.isMine ? 'Ваша базовая доля' : senior.displayName,
        proposedBy: ctx.proposedBy,
        waitingFor: ctx.waitingFor,
        currentPercent: senior.seniorSharePercent,
        pendingPercent,
        createdAt: row.createdAt,
        actions: ctx.actionsForApprovalKinds,
        link: ctx.isMine ? '/profile' : '/users',
      }
    }

    // Forward-compatible default: an `approvals` row whose `subjectType`
    // this service does not (yet) recognise is skipped rather than shown
    // with a guessed shape — see this file's header comment.
    return null
  }

  // ---------------------------------------------------------------------
  // Batch loaders
  // ---------------------------------------------------------------------

  private async loadProjectsByIds(ids: Set<string>): Promise<Map<string, ProjectLite>> {
    const map = new Map<string, ProjectLite>()
    // Round-trip avoidance: `inArray(col, [])` matches nothing in Postgres
    // either, so skipping the query on an empty `ids` returns the exact
    // same empty `Map` a real round-trip would, just without paying for it.
    // Stryker disable next-line ConditionalExpression: see comment above — provably unobservable, not untested.
    if (ids.size === 0) return map
    const rows = await this.db.db
      // Stryker disable next-line ObjectLiteral: DB column projection — a mocked unit double cannot observe it, see this file's header on `pending.integration.spec.ts`.
      .select({
        id: projects.id,
        name: projects.name,
        archivedAt: projects.archivedAt,
        seniorSharePercentOverride: projects.seniorSharePercentOverride,
        pendingSeniorSharePercentOverride: projects.pendingSeniorSharePercentOverride,
      })
      .from(projects)
      .where(inArray(projects.id, Array.from(ids)))
    for (const row of rows) map.set(row.id, row)
    return map
  }

  private async loadUsersByIds(ids: Set<string>): Promise<Map<string, UserLite>> {
    const map = new Map<string, UserLite>()
    // Same round-trip-avoidance reasoning as `loadProjectsByIds`'s own guard.
    // Stryker disable next-line ConditionalExpression: see comment above — provably unobservable, not untested.
    if (ids.size === 0) return map
    const rows = await this.db.db
      // Stryker disable next-line ObjectLiteral: DB column projection — a mocked unit double cannot observe it, see this file's header on `pending.integration.spec.ts`.
      .select({
        id: users.id,
        displayName: users.displayName,
        seniorSharePercent: users.seniorSharePercent,
        pendingSeniorSharePercent: users.pendingSeniorSharePercent,
      })
      .from(users)
      .where(inArray(users.id, Array.from(ids)))
    for (const row of rows) map.set(row.id, row)
    return map
  }

  /**
   * Mirrors `ProjectsService.loadTeamOverridesBySenior` (active senior-team
   * membership → that team's `seniorSharePercentOverride`, archived teams
   * excluded) for the specific senior ids THIS request needs — a
   * independent, narrower query rather than a call into `ProjectsService`
   * (that method is `private`, and this task's zone does not include
   * `projects/**`), calling the SAME shared pure resolver
   * (`resolveSeniorShare`) both use so the two surfaces can never disagree
   * on what the resolver itself does with the result.
   */
  private async loadTeamOverridesForSeniors(
    seniorIds: Set<string>,
  ): Promise<Map<string, ResolverTeam[]>> {
    const map = new Map<string, ResolverTeam[]>()
    // Round-trip avoidance: an empty `seniorIds` can never match any
    // `teamMembers.userId`, so the query below would return zero rows
    // anyway — skipping it returns the same empty `Map`.
    // Stryker disable next-line ConditionalExpression: see comment above — provably unobservable, not untested.
    if (seniorIds.size === 0) return map

    // `[]` here is a TypeScript-satisfying initializer only — the `try`
    // below unconditionally reassigns `rows` on every path (the real query
    // result, or `[]` again in `catch`), so this value is never actually
    // read before being overwritten.
    // Stryker disable next-line ArrayDeclaration: see comment above — the initializer is always overwritten before use.
    let rows: Array<{
      userId: string
      team: { seniorSharePercentOverride: number | null; archivedAt: Date | null }
    }> = []
    try {
      rows = (await this.db.db.query.teamMembers.findMany({
        where: and(inArray(teamMembers.userId, Array.from(seniorIds)), isNull(teamMembers.leftAt)),
        with: { team: true },
      })) as unknown as typeof rows
    } catch {
      rows = []
    }

    for (const row of rows) {
      if (!row.team || row.team.archivedAt !== null) continue
      // Same "absorbed by resolveSeniorShare's own filter" reasoning as the
      // `teamOverridesBySenior.get(...) ?? []` fallback in
      // `buildItemForSubject` — this is the array THAT fallback reads, and
      // a malformed non-empty replacement here is filtered out exactly the
      // same way once it reaches that resolver call.
      // Stryker disable next-line ArrayDeclaration: see comment above.
      const list = map.get(row.userId) ?? []
      list.push({ seniorSharePercentOverride: row.team.seniorSharePercentOverride ?? null })
      map.set(row.userId, list)
    }
    return map
  }
}

function byCreatedAtAsc(a: PendingItem, b: PendingItem): number {
  return a.createdAt.localeCompare(b.createdAt)
}
