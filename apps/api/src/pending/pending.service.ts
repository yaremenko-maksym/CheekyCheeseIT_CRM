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
    const rows = await this.db.db
      .select({ id: employeeContracts.id, updatedAt: employeeContracts.updatedAt })
      .from(employeeContracts)
      .where(
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
        perspective: 'mine',
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
        perspective: 'proposedByMe',
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
       * for — drives the USER_SENIOR_SHARE title choice below. Explicit
       * rather than inferred from `waitingFor`'s presence: the two already
       * vary independently in shape (`proposedBy`/`waitingFor` swap), an
       * inferred discriminator would be a third, implicit copy of the same
       * fact. */
      perspective: 'mine' | 'proposedByMe'
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
        subjectId: senior.id,
        title: ctx.perspective === 'mine' ? 'Ваша базовая доля' : senior.displayName,
        proposedBy: ctx.proposedBy,
        waitingFor: ctx.waitingFor,
        currentPercent: senior.seniorSharePercent,
        pendingPercent,
        createdAt: row.createdAt,
        actions: ctx.actionsForApprovalKinds,
        link: ctx.perspective === 'mine' ? '/profile' : '/users',
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
    if (ids.size === 0) return map
    const rows = await this.db.db
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
    if (ids.size === 0) return map
    const rows = await this.db.db
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
    if (seniorIds.size === 0) return map

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
