import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  forwardRef,
} from '@nestjs/common'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type {
  ArchiveImpact,
  CreateProjectDto,
  DropProjectDto,
  PendingSeniorShare,
  SessionUser,
  UpdateProjectDto,
} from '@crm/shared'
import { NOTIFICATION_TITLES, projectPaymentTypeSchema } from '@crm/shared'
import { apiError } from '../common/api-error'
import { NotificationsService } from '../notifications/notifications.service'
import { ApprovalsService } from '../approvals/approvals.service'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import {
  // security-review PR #456 round 2: `nonDeletedTransactions` (VIEW), never the
  // raw `transactions` table — this module is outside `finance/**` and the
  // ESLint no-restricted-imports rule bans the raw import here.
  nonDeletedTransactions,
  projectFinanceSettings,
  projectMembers,
  projects,
  teamMembers,
  teams,
  users,
  type Interview,
  type Project,
  type User,
} from '../database/schema'
import {
  ProjectAccessService,
  PROJECT_APPROVAL_SUBJECT_TYPE,
  PROJECT_SENIOR_SHARE_SUBJECT_TYPE,
} from './project-access.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectDraftService } from './project-draft.service'
import { ProjectMembersService } from './project-members.service'
import { ProjectReadService } from './project-read.service'
import { canSeePendingSeniorShare } from './project-visibility.util'
import { mapProjectToDto, type ProjectWithRelations } from './project-map.util'
import { assertLogoDocument } from './project-logo.util'
import { UsersService } from '../users/users.service'
import {
  isDropOverrideChange,
  isSeniorOverrideChange,
  pickDropDefault,
  pickSeniorDefault,
  resolveOverrideEffective,
} from './project-share.util'
import type { DrizzleTx } from '../database/types'

// task-pending-share (position 5). Pulled out of `notifyPendingSeniorShareProposed`'s
// own signature so that method fits on one line — see that method's doc
// comment for why (a Stryker disable-comment / multi-line-inline-type
// interaction).
type NotifyPendingShareInput = {
  subjectId: string
  approverUserId: string
  proposedPercent: number | null
  previousPercent: number | null
  /**
   * task-notification-types-producers (позиция 6). Название снимается В МОМЕНТ
   * предложения и передаётся сюда вызывающим, у которого строка проекта уже на
   * руках. Не читается заново: лишний запрос на пути, где данные уже есть, — и
   * уведомление, пережившее проект (§7.4), осталось бы безымянным.
   */
  projectName: string | null
  /**
   * QA-H-1 (manual-qa круг 3, #664): строка `approvals`, которую это
   * уведомление и представляет. Берётся из возврата
   * `ApprovalsService.proposeInTx` — то есть это ИМЕННО та строка, что
   * открылась сейчас, а не «согласование по такому-то объекту вообще».
   * Повторное предложение открывает новое поколение строк, и без этого
   * идентификатора старое уведомление оставалось активным рядом с новым.
   */
  approvalId: string
}

@Injectable()
export class ProjectsService {
  constructor(
    private db: DatabaseService,
    private projectAuditLogService: ProjectAuditLogService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private readonly hrAccess: HrAccessService,
    private readonly approvals: ApprovalsService,
    // task-notification-types-producers (позиция 6). Производитель трёх типов:
    // «вас добавили в проект», «ждёт решения: новый проект» и — через шов
    // `notifyPendingSeniorShareProposed` ниже — «ждёт решения: новая доля».
    private readonly notifications: NotificationsService,
    // Optional so the many positional `new ProjectsService(a..f)` spec
    // factories keep working; Nest injects the provider, otherwise it is
    // built from the same db/approvals the service already holds.
    @Optional() access?: ProjectAccessService,
    @Optional() members?: ProjectMembersService,
    @Optional() read?: ProjectReadService,
    @Optional() draft?: ProjectDraftService,
  ) {
    this.access = access ?? new ProjectAccessService(db, approvals)
    this.read = read ?? new ProjectReadService(db, this.access, approvals)
    this.members = members ?? new ProjectMembersService(db, this.access, notifications)
    this.draft = draft ?? new ProjectDraftService(db, approvals, this.read)
  }

  private readonly access: ProjectAccessService
  private readonly members: ProjectMembersService
  private readonly read: ProjectReadService
  private readonly draft: ProjectDraftService

  /** task-project-draft-status. `subjectType` this module registers approvals under. */
  private static readonly APPROVAL_SUBJECT_TYPE = PROJECT_APPROVAL_SUBJECT_TYPE

  /**
   * task-pending-share (position 5). `subjectType` for a PROJECT-level
   * senior-share-override change — distinct from `APPROVAL_SUBJECT_TYPE`
   * above ('PROJECT', the draft-confirmation subject): the same project id
   * can carry a live draft-confirmation proposal AND a live share-change
   * proposal at once (different subject TYPES on the same subject id never
   * collide — `uq_approvals_live_subject_approver` is keyed on
   * (subjectType, subjectId, approverUserId)).
   */
  private static readonly SENIOR_SHARE_SUBJECT_TYPE = PROJECT_SENIOR_SHARE_SUBJECT_TYPE

  private mapProject(
    project: ProjectWithRelations,
    teamOverridesBySeniorId:
      Map<string, { id: string; seniorSharePercentOverride: number | null }[]> | undefined,
    viewerRole: SessionUser['role'],
    rejectionReasonByProjectId: Map<string, string> = new Map(),
    pendingApproverIdsByProjectId: Map<string, Set<string>> = new Map(),
    pendingSeniorShare?: PendingSeniorShare | null,
  ) {
    return mapProjectToDto(
      project,
      teamOverridesBySeniorId,
      viewerRole,
      rejectionReasonByProjectId,
      pendingApproverIdsByProjectId,
      pendingSeniorShare,
    )
  }

  async findAll(currentUser: SessionUser, filter: { archived?: boolean | 'all' } = {}) {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived projects (used by the «Все» tab); boolean keeps legacy behavior.
    const archivedWhere =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(projects.archivedAt)
          : isNull(projects.archivedAt)
    const allProjects = await this.db.db.query.projects.findMany({
      ...(archivedWhere ? { where: archivedWhere } : {}),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })

    let filtered = allProjects as ProjectWithRelations[]

    // task-project-draft-status, item 4 ("узкий путь к черновику") + decision
    // Д1: a DRAFT/REJECTED project is dropped from the list UNLESS the viewer
    // is ADMIN or was invited to approve it (senior/drop, current OR any past
    // generation — see `ApprovalsService.isApprover`'s own doc for why "ever
    // asked" is correct here). Runs BEFORE the per-role filters below so
    // ACCOUNTANT — who otherwise sees every ACTIVE project unconditionally —
    // does not also see drafts it was never asked about.
    if (currentUser.role !== 'ADMIN') {
      const invitedProjectIds = await this.approvals.listSubjectIdsForApprover(
        ProjectsService.APPROVAL_SUBJECT_TYPE,
        currentUser.id,
      )
      filtered = filtered.filter((p) => p.status === 'ACTIVE' || invitedProjectIds.has(p.id))
    }

    if (currentUser.role === 'SENIOR') {
      // SENIOR sees their own senior-projects (legacy) AND drop-projects of
      // their current drop-team (Phase 1 visibility — full drop-project
      // distribution lands in Phase 2). The base senior-project filter is
      // unchanged.
      const ownerProjects = filtered.filter((p) => p.seniorId === currentUser.id)
      // Drop role - phase 1: senior in drop-team sees the team's drop-projects.
      const dropTeam = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, currentUser.id), isNull(teamMembers.leftAt)),
        with: { team: true },
      })
      let dropProjects: ProjectWithRelations[] = []
      if (dropTeam?.team?.type === 'DROP') {
        // Find this drop-team's DROP user, then projects with dropId === that user.
        const dropMember = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(
            and(
              eq(teamMembers.teamId, dropTeam.teamId),
              eq(users.role, 'DROP'),
              isNull(teamMembers.leftAt),
            ),
          )
          .then((rows) => rows[0])
        if (dropMember) {
          dropProjects = filtered.filter((p) => p.dropId === dropMember.userId)
        }
      }
      // Dedupe by id (senior+drop overlap is unlikely but possible).
      const merged = new Map<string, ProjectWithRelations>()
      for (const p of [...ownerProjects, ...dropProjects]) merged.set(p.id, p)
      filtered = Array.from(merged.values())
    } else if (currentUser.role === 'HR') {
      const seniorIds = await this.access.getHrSeniorIds(currentUser.id)
      filtered = filtered.filter((p) => p.seniorId !== null && seniorIds.includes(p.seniorId))
    } else if (currentUser.role === 'JUNIOR') {
      filtered = filtered.filter((p) =>
        p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
      )
    } else if (currentUser.role === 'DROP') {
      // Drop role - phase 1: DROP sees only drop-projects they own.
      filtered = filtered.filter((p) => p.dropId === currentUser.id && p.archivedAt === null)
    }
    // ADMIN, ACCOUNTANT see all

    // task-team-senior-share-override. Batch-load team overrides for every
    // senior referenced by the filtered set so `mapProject` resolves the
    // effective share + source without N+1 queries.
    const teamOverridesBySeniorId = await this.read.loadTeamOverridesBySenior(filtered)
    // task-project-status-filter-ui. Batch-load rejection reasons for every
    // REJECTED project in the filtered set — one round trip for the whole
    // list, not one per row. The `.length` guard here (not just inside
    // `getRejectionReasons`) is deliberate: it keeps `this.approvals` free
    // of a call at all — not just a cheap one — for the common case where
    // nothing in the list was ever rejected, same reasoning as the
    // `listSubjectIdsForApprover` ADMIN-skip a few lines up.
    const rejectedIds = filtered.filter((p) => p.status === 'REJECTED').map((p) => p.id)
    const rejectionReasonByProjectId =
      rejectedIds.length > 0
        ? await this.approvals.getRejectionReasons(
            ProjectsService.APPROVAL_SUBJECT_TYPE,
            rejectedIds,
          )
        : new Map<string, string>()
    // SPEC-M-2 (PR #646 fix-round 1). Same batched-lookup, same zero-cost
    // guard, for the DRAFT side (see mapProject's own doc for why this
    // exists — the caption needs "who's STILL pending", not "does the
    // project have a drop at all").
    const draftIds = filtered.filter((p) => p.status === 'DRAFT').map((p) => p.id)
    const pendingApproverIdsByProjectId =
      draftIds.length > 0
        ? await this.approvals.getPendingApproverIds(
            ProjectsService.APPROVAL_SUBJECT_TYPE,
            draftIds,
          )
        : new Map<string, Set<string>>()
    return filtered.map((p) =>
      this.mapProject(
        p,
        teamOverridesBySeniorId,
        currentUser.role,
        rejectionReasonByProjectId,
        pendingApproverIdsByProjectId,
      ),
    )
  }

  /**
   * Self-only DROP project feed for `GET /api/projects/drop/me`.
   *
   * Drop role - phase 2 (task-drop-2-backend). RBAC: DROP only — every other
   * role gets 403. Returns ALL drop-projects the caller owns — both active and
   * closed (`dropId = self.id`, no archivedAt filter), each enriched with:
   *   - `seniorDisplayName` — the senior's REAL display name. Unlike the JUNIOR
   *     legend persona, the drop coordinates directly with the senior, so this
   *     is NOT masked (design spec §10.1).
   *   - `incomesCount`      — number of DROP_INCOME rows the drop owns on this
   *     project (`receiverId = self.id AND projectId = project.id`).
   *   - `status`            — project archival mapped to active|closed.
   *
   * archivedAt IS NOT filtered out here: DropProjectDto.status is
   * 'active'|'closed' per spec §10.1 — showing only active projects made the
   * 'closed' branch unreachable (dead code). Fix: MED review finding code-review-1.
   * incomesCount is computed from a single batched read of this drop's
   * DROP_INCOME rows (no N+1).
   */
  async findDropOwnProjects(currentUser: SessionUser): Promise<DropProjectDto[]> {
    if (currentUser.role !== 'DROP') {
      throw apiError('DROP_PROJECT_ACCESS_DENIED', HttpStatus.FORBIDDEN)
    }

    const ownProjects = (await this.db.db.query.projects.findMany({
      // No archivedAt filter: drop sees both active and closed own projects
      // (Д1 — the drop is an invited approver, so a still-DRAFT or REJECTED
      // project belongs on their own list too). status is derived from
      // archivedAt + projects.status in the mapping below.
      where: eq(projects.dropId, currentUser.id),
      with: { senior: { columns: { displayName: true } } },
    })) as Array<Project & { senior: { displayName: string } | null }>

    // Batch-count this drop's DROP_INCOME rows per project in one read (self-
    // scoped: receiverId = self). Avoids a per-project query.
    // security-review PR #456 round 2: sourced from the `nonDeletedTransactions`
    // VIEW — a deleted income cannot inflate this badge no matter what (see
    // schema.ts's doc on the view). `projects/` is outside `finance/`, so this
    // is exactly the cross-module case the round-1 scanner failed to hold.
    const dropIncomes = await this.db.db
      .select({ projectId: nonDeletedTransactions.projectId })
      .from(nonDeletedTransactions)
      .where(
        and(
          eq(nonDeletedTransactions.type, 'DROP_INCOME'),
          eq(nonDeletedTransactions.receiverId, currentUser.id),
        ),
      )
    const incomesByProject = new Map<string, number>()
    for (const tx of dropIncomes) {
      if (!tx.projectId) continue
      incomesByProject.set(tx.projectId, (incomesByProject.get(tx.projectId) ?? 0) + 1)
    }

    return ownProjects.map((p) => ({
      id: p.id,
      companyName: p.companyName,
      seniorDisplayName: p.senior?.displayName ?? '',
      incomesCount: incomesByProject.get(p.id) ?? 0,
      // SR-M-2 (task-project-draft-status, security-review round 3): this DTO
      // only ever had a 2-value status (active/closed) — before this fix it
      // derived it from `archivedAt` ALONE, so a DRAFT or REJECTED project
      // (never archived) showed as 'active', indistinguishable from a
      // confirmed one, on the drop's own finance-facing list. A DRAFT/
      // REJECTED project cannot yet accept transactions (Д2) — it belongs on
      // the SAME "not yet usable" side of this boolean-shaped enum as an
      // archived one, not on the 'active' side.
      status:
        p.archivedAt === null && p.status === 'ACTIVE' ? ('active' as const) : ('closed' as const),
    }))
  }

  findOne(id: string, currentUser: SessionUser) {
    return this.read.findOne(id, currentUser)
  }

  async create(data: CreateProjectDto, currentUser: SessionUser) {
    // seniorSharePercentOverride is field-scoped RBAC: only ADMIN and
    // ACCOUNTANT may set it. We check this BEFORE the create-role check so
    // an HR caller sending the field still gets the more-specific 403
    // (and so TS doesn't narrow `currentUser.role` away from ACCOUNTANT).
    const role = currentUser.role
    if (
      data.seniorSharePercentOverride !== undefined &&
      role !== 'ADMIN' &&
      role !== 'ACCOUNTANT'
    ) {
      throw apiError('SENIOR_SHARE_OVERRIDE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    // task-drop-share-override-and-receiver (D1/D6). Field-scoped RBAC for
    // paymentType + dropSharePercentOverride — same contract as the senior
    // override: only ADMIN/ACCOUNTANT may send these fields.
    if (data.dropSharePercentOverride !== undefined && role !== 'ADMIN' && role !== 'ACCOUNTANT') {
      throw apiError('DROP_SHARE_OVERRIDE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    if (data.paymentType !== undefined && role !== 'ADMIN' && role !== 'ACCOUNTANT') {
      throw apiError('PAYMENT_TYPE_CHANGE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    if (role !== 'ADMIN' && role !== 'HR') {
      throw new ForbiddenException()
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.seniorId),
    })
    if (!senior) throw apiError('SENIOR_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (senior.role !== 'SENIOR' && senior.role !== 'ADMIN')
      throw apiError('USER_NOT_SENIOR_OR_ADMIN', HttpStatus.BAD_REQUEST)

    // HR cross-team scoping: HR may only create projects for seniors in their own teams.
    await this.access.assertHrCanManageProject(data.seniorId, currentUser)

    const override =
      data.seniorSharePercentOverride === undefined ? null : data.seniorSharePercentOverride

    // task-drop-share-override-and-receiver (D6). Per-project drop override,
    // stored raw (mirrors the senior override at create time — implicit-null
    // reset only applies on update). null = use the drop's global default.
    const dropOverride =
      data.dropSharePercentOverride === undefined ? null : data.dropSharePercentOverride

    // task-drop-share-override-and-receiver (D1). Validate the loose write
    // value against the enum (throws 400 on an unknown value). Undefined/null →
    // omitted from the insert so the DB default ('FOP') applies.
    const validatedPaymentType =
      data.paymentType === undefined || data.paymentType === null
        ? undefined
        : projectPaymentTypeSchema.parse(data.paymentType)

    // Drop role - phase 2: validate `dropId` references an active DROP user.
    // `undefined`/`null` = regular senior-project (no drop). Reject any other
    // role to keep the FK invariant (`projects.dropId` → users WHERE role=DROP).
    let resolvedDropId: string | null = null
    if (data.dropId !== undefined && data.dropId !== null) {
      const drop = await this.db.db.query.users.findFirst({
        where: eq(users.id, data.dropId),
      })
      if (!drop) throw apiError('DROP_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (drop.role !== 'DROP') throw apiError('USER_NOT_DROP', HttpStatus.BAD_REQUEST)
      if (drop.archivedAt) throw apiError('DROP_ARCHIVED', HttpStatus.BAD_REQUEST)
      resolvedDropId = drop.id
    }

    // Validate logo document FK before insert — if it points at a non-LOGO
    // document or a deleted row, fail with 400 instead of catching a DB
    // constraint violation. Project does not exist yet, so projectId is null.
    if (data.logoDocumentId !== undefined && data.logoDocumentId !== null) {
      await assertLogoDocument(this.db.db, data.logoDocumentId, null)
    }

    // task-project-draft-status, decision Д1: "Строки согласования создаются
    // в той же транзакции, что и черновик — поэтому запасного пути не
    // требуется: черновика без строк согласования не существует." The insert
    // and the approvals proposal are ONE `db.transaction` — if the proposal
    // half fails (e.g. a duplicate-approver constraint), the project insert
    // rolls back too, so a DRAFT can never exist without its approval rows.
    // Approvers: the senior always; the drop too, when the project has one
    // (spec §3 decision 4, "Проект подтверждают оба").
    const approverUserIds = resolvedDropId ? [data.seniorId, resolvedDropId] : [data.seniorId]

    const [project] = await this.db.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(projects)
        .values({
          name: data.name,
          companyName: data.companyName,
          domain: data.domain,
          logoDocumentId: data.logoDocumentId ?? null,
          logoExternalUrl: data.logoExternalUrl ?? null,
          startDate: new Date(data.startDate),
          seniorId: data.seniorId,
          dropId: resolvedDropId,
          rate: data.rate,
          currency: data.currency,
          seniorSharePercentOverride: override,
          dropSharePercentOverride: dropOverride,
          techStack: data.techStack ?? null,
          teamSize: data.teamSize ?? null,
          benefits: data.benefits ?? null,
          // Omit when undefined so the NOT NULL column falls back to DEFAULT 'FOP'.
          ...(validatedPaymentType !== undefined ? { paymentType: validatedPaymentType } : {}),
          salaryReview: data.salaryReview ?? null,
          corpTech: data.corpTech ?? null,
          notesGeneral: data.notesGeneral ?? null,
          // task-project-draft-status: every new project starts life
          // unconfirmed, regardless of who created it (ADMIN or HR) — see
          // this.approvals below for the mechanism that flips it to ACTIVE.
          status: 'DRAFT',
        })
        .returning()
      // Stryker disable next-line ConditionalExpression: defensive-only — a single-row `.insert(...).values({...}).returning()` with no `WHERE` cannot return an empty array on a real Postgres (it either inserts the one row or the whole INSERT throws), so no mock or integration fixture can construct the `!inserted` branch without lying about what Postgres does. Same class as the "practically unreachable, kept for type-narrowing" defensive branches already accepted elsewhere in this codebase (e.g. `pending-settlement.service.ts`'s own `if (!source)` comment).
      if (!inserted) throw new Error('Failed to insert project')

      const approvalRows = await this.approvals.proposeInTx(tx, {
        subjectType: ProjectsService.APPROVAL_SUBJECT_TYPE,
        subjectId: inserted.id,
        approverUserIds,
        proposedByUserId: currentUser.id,
      })

      // task-notification-types-producers (позиция 6): «ждёт решения: новый
      // проект» — приглашённым подтверждающим, в ТОЙ ЖЕ транзакции, что и
      // черновик со строками согласования. Черновика без просьбы подтвердить
      // не существует — по той же причине, по которой не существует черновика
      // без строк согласования (решение Д1 позиции 4).
      // SR-H-2 (security-review круг 2): путь производителя целиком — во
      // ВЛОЖЕННОЙ транзакции (SAVEPOINT). Событие уже состоялось; уронить его
      // из-за того, что уведомление о нём не собралось, — ровно то вето,
      // которое круг 2 запретил. Откат события по-прежнему уносит и запись:
      // savepoint вложен в транзакцию события, а не заменяет её.
      await this.notifications.emitInTx(tx, async (sp) => {
        await this.notifications.createManyInTx(
          sp,
          // QA-H-1 (круг 3): список строится из СТРОК СОГЛАСОВАНИЯ, а не из
          // `approverUserIds`. Это те же люди — `proposeInTx` вставляет по
          // строке на каждого, — но у строки есть ещё и идентификатор, который
          // уведомление обязано унести с собой: иначе повторное предложение
          // (новое поколение строк) не погасит старое уведомление, и
          // подтверждающий увидит два активных с разными цифрами. Запасного
          // значения здесь нет и не нужно: неоткуда взяться подтверждающему
          // без своей строки.
          approvalRows
            .filter((row) => row.approverUserId !== (currentUser.impersonatorId ?? currentUser.id))
            .map((row) => ({
              userId: row.approverUserId,
              type: 'PROJECT_CONFIRM_REQUIRED' as const,
              title: NOTIFICATION_TITLES.PROJECT_CONFIRM_REQUIRED,
              subjectType: 'PROJECT' as const,
              subjectId: inserted.id,
              // ORCH-3 (fix-round 7): `companyName`, не `projects.name` — попап
              // называет проект тем же словом, что экран «Ждут решения» (copy r2 на
              // #667). Ключ данных `projectName` остаётся, меняется только источник.
              data: { projectName: inserted.companyName, approvalId: row.id },
            })),
        )
      })

      return [inserted]
    })

    // Mirror to project_finance_settings so the existing
    // transactions.service.ts SENIOR_INCOME calc keeps reading the same
    // effective value via `project.financeSettings.seniorSharePercentOverride`.
    if (project && data.seniorSharePercentOverride !== undefined) {
      await this.syncFinanceSettingsOverride(project.id, override, currentUser.id)
    }

    const created = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, project!.id),
      // Drop role - phase 2: load `drop` relation so mapProject can emit
      // dropName/dropSharePercent for the «Drop-проект» badge + breakdown.
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations

    const teamOverridesBySeniorId = await this.read.loadTeamOverridesBySenior([created])
    // SPEC-M-2 (PR #646 fix-round 1). Unlike rejectionReason (structurally
    // impossible here — a project this method just inserted is always
    // DRAFT, never REJECTED), a fresh DRAFT's pendingApproverIds is NOT
    // empty: every one of `approverUserIds` (built just above, right before
    // `proposeInTx`) is PENDING the instant `propose` inserts their row — no
    // DB round-trip needed, we already know the answer from what THIS call
    // just proposed.
    const pendingApproverIdsByProjectId = new Map<string, Set<string>>([
      [created.id, new Set(approverUserIds)],
    ])
    // Pass currentUser.role so mapProject can apply SENIOR dropName masking
    // (defense-in-depth: callers of create are ADMIN/HR whose role never triggers
    // the mask, but the contract is explicit and mirrors findOne/findAll).
    return this.mapProject(
      created,
      teamOverridesBySeniorId,
      currentUser.role,
      undefined,
      pendingApproverIdsByProjectId,
    )
  }

  approveDraft(id: string, currentUser: SessionUser) {
    return this.draft.approveDraft(id, currentUser)
  }

  rejectDraft(id: string, reason: string, currentUser: SessionUser) {
    return this.draft.rejectDraft(id, reason, currentUser)
  }

  /**
   * «Ждёт решения: новая доля» — тому, чья доля меняется, и никому больше
   * (§7.2 + §7.3). Позиция 5 оставила этот шов пустым и Stryker-подавленным,
   * потому что типа уведомления ещё не существовало; позиция 6 его заполняет —
   * подавление снято, метод стал настоящим и проверяется как всякий другой.
   *
   * Изменились две вещи против прежней подписи, обе намеренно:
   *   - появился `tx` — запись пишется в ТОЙ ЖЕ транзакции, что и само
   *     предложение (см. `proposeSeniorShareChange` ниже);
   *   - метод стал асинхронным.
   * Спека-хендофф (`projects.pending-share.spec.ts`) обновлена под обе.
   */
  private async notifyPendingSeniorShareProposed(
    tx: DrizzleTx,
    input: NotifyPendingShareInput,
  ): Promise<void> {
    // SR-H-2 (security-review круг 2): путь производителя — во вложенной
    // транзакции (SAVEPOINT); подробности у близнеца в `UsersService`.
    await this.notifications.emitInTx(tx, async (sp) => {
      await this.notifications.createInTx(sp, {
        userId: input.approverUserId,
        type: 'SHARE_CONFIRM_REQUIRED',
        title: NOTIFICATION_TITLES.SHARE_CONFIRM_REQUIRED,
        subjectType: 'PROJECT',
        subjectId: input.subjectId,
        // Проценты — ДАННЫЕ, не текст: «26% → 30%» рисует клиент. В письмо
        // (позиция 7) уходит только нейтральный заголовок выше — цифры за
        // пределы нашего контура не идут (§10).
        data: {
          scope: 'PROJECT',
          projectName: input.projectName,
          previousPercent: input.previousPercent,
          proposedPercent: input.proposedPercent,
          approvalId: input.approvalId,
        },
        // Ключа НЕТ намеренно: повторное предложение обязано спросить заново —
        // именно это и означает `supersededAt` на предыдущем поколении строк
        // согласования. Заглушить второе предложение значило бы потерять
        // подтверждение.
      })
    })
  }

  /**
   * task-pending-share (position 5, design spec §4.3). Opens (or re-opens —
   * `ApprovalsService.proposeInTx` supersedes the previous generation on its
   * own) a proposal for a NEW `seniorSharePercentOverride` value. Writes
   * ONLY `pendingSeniorSharePercentOverride` — `update()` never writes the
   * active column directly any more; `approveSeniorShareChange` is what
   * swaps them. `proposedValue` may legitimately be `null` — "propose
   * clearing the override back to the team/user default" is a real proposal
   * (see the column's own schema.ts comment).
   */
  private async proposeSeniorShareChange(
    projectId: string,
    approverUserId: string,
    proposedValue: number | null,
    actorId: string,
    // Caller (`update()`) already has this on hand from the row it read
    // before deciding to propose — no need for a second SELECT here.
    previousValue: number | null,
    // То же самое и по той же причине — название проекта для подписи
    // уведомления (позиция 6).
    projectName: string | null,
  ): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      const [approval] = await this.approvals.proposeInTx(tx, {
        subjectType: ProjectsService.SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [approverUserId],
        proposedByUserId: actorId,
      })
      // Stryker disable next-line all: defensive-only (и условие, и текст сообщения) — `proposeInTx` вставляет по строке на каждого подтверждающего и возвращает `.returning()`; при непустом `approverUserIds` пустой массив на настоящем Postgres невозможен.
      if (!approval) throw new Error('Failed to open senior-share approval')
      await tx
        .update(projects)
        .set({ pendingSeniorSharePercentOverride: proposedValue, updatedAt: new Date() })
        .where(eq(projects.id, projectId))

      // task-notification-types-producers (позиция 6). Вызов ПЕРЕЕХАЛ внутрь
      // транзакции: позиция 5 оставляла шов пустым и звала его после коммита,
      // потому что звать было нечего. Теперь он пишет строку, и предложение
      // без просьбы подтвердить — как и просьба без предложения — становятся
      // структурно невозможны.
      await this.notifyPendingSeniorShareProposed(tx, {
        subjectId: projectId,
        approverUserId,
        proposedPercent: proposedValue,
        previousPercent: previousValue,
        projectName,
        approvalId: approval.id,
      })
    })
  }

  /**
   * task-pending-share, AC3: the pending → active swap (AND the
   * project_finance_settings mirror sync) happens as ONE operation —
   * `approveInTx` and both writes below run in the SAME transaction, so no
   * caller can ever observe a state where the approval is APPROVED but the
   * active percent (or its mirror) has not moved yet. `impersonatorId` guard
   * mirrors `approveDraft` exactly — consent must come from the invited
   * approver's own session, not an admin impersonating them.
   */
  async approveSeniorShareChange(id: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-648-fix-round-1 (COPY-H-1): its own Russian string — see
      // `UsersService.approveSeniorShareChange`'s identical comment.
      // task-648-fix-round-2 (COPY-M-13): wording matches
      // `ImpersonationBanner`'s «Вы вошли как …» — see the users-half twin.
      throw apiError('SHARE_APPROVE_IMPERSONATION_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      await this.approvals.approveInTx(tx, {
        subjectType: ProjectsService.SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
      })
      const [row] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .for('update')
        .limit(1)
      // task-648-fix-round-1 (COPY-H-1): Russian — defensive-only (approveInTx
      // above already proved a live PENDING row exists; only a project
      // deleted in the instant between that check and this re-select could
      // reach here), but still user-facing text if it ever fires.
      if (!row) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      // `row.pendingSeniorSharePercentOverride` is read as-is (including
      // `null`, a legitimate "clear the override" outcome) — safe to trust
      // here because `approveInTx` above already threw for "no live PENDING
      // row for this subject/approver", so reaching this line means a real
      // proposal existed.
      const newOverride = row.pendingSeniorSharePercentOverride
      await tx
        .update(projects)
        .set({
          seniorSharePercentOverride: newOverride,
          pendingSeniorSharePercentOverride: null,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id))
      await this.syncFinanceSettingsOverride(id, newOverride, currentUser.id, tx)
      await this.projectAuditLogService.record(
        {
          actorId: currentUser.id,
          targetId: id,
          action: 'project_edited',
          changes: {
            seniorSharePercentOverride: {
              before: row.seniorSharePercentOverride ?? null,
              after: newOverride,
            },
          },
        },
        tx,
      )
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * task-pending-share, design spec §3 decision 3: rejection requires a
   * reason (Zod-validated at the controller boundary, DB-enforced as the
   * backstop by `approvals`'s own CHECK constraint) and discards the pending
   * value — the active `seniorSharePercentOverride` is untouched, exactly
   * "При отказе ожидающее отбрасывается, действующее не трогается" (task
   * file, "Что сделать" §1).
   */
  async rejectSeniorShareChange(id: string, reason: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-648-fix-round-1 (COPY-H-1): same reasoning as approve above.
      throw apiError('SHARE_REJECT_IMPERSONATION_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      await this.approvals.rejectInTx(tx, {
        subjectType: ProjectsService.SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
        reason,
      })
      await tx
        .update(projects)
        .set({ pendingSeniorSharePercentOverride: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * task-648-fix-round-1 (SR-H-1), revised in round 2 (SR-H-2).
   * ADMIN/ACCOUNTANT withdraws an open proposal for this project's senior
   * share outright — the counterpart to `proposeSeniorShareChange` above.
   * This is the ONLY way to withdraw one: the "Отменить предложение" button
   * next to the pending indicator (and inside the edit dialog) posts here.
   * Round 1 additionally treated "slider returned to the active value" as an
   * implicit cancel; round 2 removed that branch — see `update()`'s own note
   * for why an implicit cancel through a side effect was the wrong shape.
   *
   * RBAC mirrors the PROPOSE gate in `update()` (ADMIN/ACCOUNTANT), not the
   * approve/reject pair above — cancelling a proposal you opened is the
   * proposer's prerogative, never the invited approver's (they get reject()
   * for that, which requires a reason; this doesn't, because withdrawing
   * your own draft answers to nobody).
   *
   * The core/public split this method used to have died with the implicit
   * cancel: with `update()` no longer calling in, there was exactly one
   * caller left and the indirection bought nothing.
   */
  async cancelSeniorShareChange(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      // task-648-fix-round-1 (COPY-H-1): user-facing text is Russian
      // (russian-language.md) — see `UsersService.cancelSeniorShareChange`'s
      // identical comment.
      throw apiError('SHARE_CANCEL_ADMIN_ACCOUNTANT_ONLY', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      // task-648-fix-round-3 (SR-M-8 / CR-H-4): `approvals` FIRST, then the
      // project row — the exact shape `approveSeniorShareChange` above uses,
      // and the order propose/approve/reject on this service have always
      // used. Round 2 wrote this method the other way round, which made it
      // the one path on this half that inverted the pair: an ADMIN
      // withdrawing while the senior confirms could deadlock (`40P01`,
      // surfaced to the admin as a 500), reproduced on a scratch database by
      // the security reviewer. Both properties this ordering used to carry
      // survive the move: `cancelInTx` throws when there is no live
      // proposal, the lock+404 guard below still runs before any write, and
      // `pendingSeniorSharePercentOverride` is untouched by `cancelInTx`, so
      // `row` still holds the pre-cancel value the audit entry reports as
      // `before`. A project deleted in the instant between the two now
      // throws AFTER `cancelInTx` ran — harmless, because the throw aborts
      // this transaction and the withdrawal rolls back with it.
      await this.approvals.cancelInTx(tx, ProjectsService.SENIOR_SHARE_SUBJECT_TYPE, id)
      const [row] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .for('update')
        .limit(1)
      if (!row) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      // Reaching this line means `cancelInTx` found a real PENDING proposal
      // for `id` (it throws otherwise) — same "no separate existence check
      // needed" reasoning `approveSeniorShareChange` documents above.
      await tx
        .update(projects)
        .set({ pendingSeniorSharePercentOverride: null, updatedAt: new Date() })
        .where(eq(projects.id, id))
      // task-648-fix-round-2 (SR-M-7 / CR-M-2): a withdrawal is an
      // administrative act on a money field and now names its actor, exactly
      // like `approveSeniorShareChange` above already did. Same transaction
      // as the write it describes, so the log can never claim a withdrawal
      // that rolled back. `impersonatorId ?? id` — the REAL operator, the
      // convention every other audit call on this service follows.
      await this.projectAuditLogService.record(
        {
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: id,
          action: 'project_edited',
          changes: {
            pendingSeniorSharePercentOverride: {
              before: row.pendingSeniorSharePercentOverride ?? null,
              after: null,
            },
          },
        },
        tx,
      )
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * Upsert the projects.senior_share_percent_override mirror into
   * project_finance_settings. Keeps the existing finance path (which reads
   * from financeSettings only) in sync with the new direct column.
   *
   * task-pending-share (position 5): now also called from
   * `approveSeniorShareChange`, which must swap the live column AND this
   * mirror atomically (task AC3 — "одной операцией") — hence the optional
   * `db` parameter (defaults to the plain pool handle, same
   * `DatabaseService['db'] | DrizzleTx` pattern `UsersService.updateUserRow`
   * already uses) so a caller inside a transaction can pass its own `tx`.
   */
  private async syncFinanceSettingsOverride(
    projectId: string,
    override: number | null,
    actorId: string,
    db: DatabaseService['db'] | DrizzleTx = this.db.db,
  ) {
    const existing = await db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })
    if (existing) {
      await db
        .update(projectFinanceSettings)
        .set({
          seniorSharePercentOverride: override,
          updatedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(projectFinanceSettings.projectId, projectId))
    } else {
      await db.insert(projectFinanceSettings).values({
        projectId,
        seniorSharePercentOverride: override,
        juniorSalaryOverride: null,
        updatedBy: actorId,
      })
    }
  }

  async update(id: string, data: UpdateProjectDto, currentUser: SessionUser) {
    // Field-scoped RBAC: `seniorSharePercentOverride` (including explicit
    // null to clear) is restricted to ADMIN and ACCOUNTANT. HR keeps full
    // edit access to every other field — we only deny when this specific
    // field is in the payload. Check BEFORE the create/update role narrow
    // so ACCOUNTANT-only updates (just the override) are accepted.
    const role = currentUser.role
    if (
      data.seniorSharePercentOverride !== undefined &&
      role !== 'ADMIN' &&
      role !== 'ACCOUNTANT'
    ) {
      throw apiError('SENIOR_SHARE_OVERRIDE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    // task-drop-share-override-and-receiver (D1/D6). Field-scoped RBAC for
    // paymentType + dropSharePercentOverride (including explicit null) — only
    // ADMIN/ACCOUNTANT may touch these fields.
    if (data.dropSharePercentOverride !== undefined && role !== 'ADMIN' && role !== 'ACCOUNTANT') {
      throw apiError('DROP_SHARE_OVERRIDE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    if (data.paymentType !== undefined && role !== 'ADMIN' && role !== 'ACCOUNTANT') {
      throw apiError('PAYMENT_TYPE_CHANGE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    // ACCOUNTANT may patch only when EVERY field touched is finance-scoped
    // (senior/drop override or paymentType) — the fields the field-level RBAC
    // above already gated to ADMIN/ACCOUNTANT. This extends the original
    // senior-only `hasOnlyOverride` to the drop override + paymentType.
    const FINANCE_SCOPED_FIELDS = [
      'seniorSharePercentOverride',
      'dropSharePercentOverride',
      'paymentType',
    ]
    const dataKeys = Object.keys(data)
    const hasOnlyOverride =
      dataKeys.length > 0 && dataKeys.every((k) => FINANCE_SCOPED_FIELDS.includes(k))

    if (role !== 'ADMIN' && role !== 'HR' && !(role === 'ACCOUNTANT' && hasOnlyOverride)) {
      throw new ForbiddenException()
    }

    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined

    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

    // SR-H-1 (PR #646 fix-round 2). update() is a WRITE path, and predates
    // the draft-visibility gate (task-project-draft-status) — it never
    // asserted DRAFT/REJECTED visibility because at the time it was written
    // there was nothing draft-shaped to hide. Fix-round 1 (CR-M-1, SPEC-M-2)
    // started returning rejectionReason and the two ApprovalPending booleans
    // from its response WITHOUT adding this gate, so HR/ACCOUNTANT — who
    // findOne already 404s on any non-ACTIVE project, per assertAccess's own
    // "INCLUDING ACCOUNTANT" comment below — could PATCH a field they are
    // allowed to touch (e.g. `name`) on a REJECTED project and get the full
    // rejection reason back in the response, despite never being able to
    // GET that project at all. Same gate, same place in the call order,
    // same reasoning as findOne: MUST run before any role-specific
    // early-return so a DRAFT/REJECTED project is never visible-by-write
    // even to a role that would otherwise pass.
    await this.assertAccess(project, currentUser)

    // HR cross-team scoping: HR may only update projects for seniors in their own teams.
    // ACCOUNTANT doing a hasOnlyOverride patch is exempted (their patch is finance-scoped,
    // not team-scoped — the field-level RBAC check above already ran).
    if (!(role === 'ACCOUNTANT' && hasOnlyOverride)) {
      await this.access.assertHrCanManageProject(project.seniorId, currentUser)
    }

    // Drop role - phase 2: validate updated `dropId` (when present). Same
    // contract as create: `null` → clear, uuid → set to existing DROP user.
    // `undefined` (key absent) → leave unchanged.
    let resolvedDropId: string | null | undefined = undefined
    if (data.dropId !== undefined) {
      if (data.dropId === null) {
        resolvedDropId = null
      } else {
        const drop = await this.db.db.query.users.findFirst({
          where: eq(users.id, data.dropId),
        })
        if (!drop) throw apiError('DROP_NOT_FOUND', HttpStatus.NOT_FOUND)
        if (drop.role !== 'DROP') throw apiError('USER_NOT_DROP', HttpStatus.BAD_REQUEST)
        if (drop.archivedAt) throw apiError('DROP_ARCHIVED', HttpStatus.BAD_REQUEST)
        resolvedDropId = drop.id
      }
    }

    // security-review round 3 (SR-M-4, task-project-draft-status) — DECLINED,
    // not fixed. Assigning a NEW drop to an already-ACTIVE project (dropId
    // null -> uuid) does not touch `status` or create an approval row for
    // that drop — no re-confirmation, no chance for them to decline. This is
    // real: the drop becomes a party carrying a share without ever being
    // asked.
    //
    // Not fixed here because it is out of THIS task's scope, not because it
    // is fine. §9 "Порядок работ" of the design spec (docs/superpowers/specs
    // /2026-09-01-notifications-and-confirmations-design.md) lists "Ожидающая
    // доля" (pending-share: a changed share value goes through a pending
    // slot + re-confirmation before taking effect, §4.3) as position 5 — a
    // SEPARATE, not-yet-built work item, deliberately sequenced after
    // position 4 (draft/confirmation status, this task) specifically because
    // it needs 2-5 to already exist. Assigning a drop where none existed is
    // arguably a third case neither position covers exactly (a new PARTY,
    // not a changed VALUE on an existing one) — which is itself a reason
    // this needs a decision from whoever owns position 5's design, not a
    // guessed fix bolted onto position 4's gate. Flagged for the owner;
    // resolve when position 5 is scoped.

    // Round-3 implicit-null detection (PR #39 round 2): UI больше не имеет
    // toggle/«Сбросить» — слайдер всегда виден. Когда ADMIN/ACCOUNTANT
    // ставит значение === эффективному дефолту синьера, мы интерпретируем
    // это как сброс переопределения (пишем `null`). Иначе — пишем число.
    // Это касается и `projects.seniorSharePercentOverride`, и mirror в
    // `project_finance_settings.seniorSharePercentOverride`.
    const overrideEffective = resolveOverrideEffective(
      data.seniorSharePercentOverride,
      pickSeniorDefault(project.senior),
    )

    // task-drop-share-override-and-receiver (D6). Implicit-null reset mirrors the
    // senior override: a value equal to the drop's effective default is stored
    // as null so the resolver keeps falling back to the user default.
    const dropOverrideEffective = resolveOverrideEffective(
      data.dropSharePercentOverride,
      pickDropDefault(project.drop),
    )

    const updateData: Partial<typeof projects.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (data.name !== undefined) updateData.name = data.name
    if (data.companyName !== undefined) updateData.companyName = data.companyName
    if (data.domain !== undefined) updateData.domain = data.domain
    if (data.logoDocumentId !== undefined) {
      // Validate the FK before applying. Null clears the document path.
      await assertLogoDocument(this.db.db, data.logoDocumentId, id)
      updateData.logoDocumentId = data.logoDocumentId ?? null
      // XOR invariant: setting documentId clears externalUrl, even when the
      // caller didn't pass externalUrl explicitly. Without this the DB CHECK
      // would block an update from "external set" to "doc set".
      if (data.logoDocumentId !== null && data.logoExternalUrl === undefined) {
        updateData.logoExternalUrl = null
      }
    }
    if (data.logoExternalUrl !== undefined) {
      updateData.logoExternalUrl = data.logoExternalUrl ?? null
      // Mirror invariant — setting external clears doc id when caller didn't
      // pass it. Skip if logoDocumentId was already set above to non-null.
      if (data.logoExternalUrl !== null && data.logoDocumentId === undefined) {
        updateData.logoDocumentId = null
      }
    }
    if (data.rate !== undefined) updateData.rate = data.rate
    if (data.currency !== undefined) updateData.currency = data.currency
    // task-pending-share (position 5): `seniorSharePercentOverride` is
    // DELIBERATELY excluded from `updateData` — the live column is no
    // longer written here. `overrideEffective` (computed above, implicit-
    // null-at-default transform unchanged) is routed through
    // `proposeSeniorShareChange` further down instead, which requires the
    // project's SENIOR to confirm before it takes effect.
    // task-drop-share-override-and-receiver (D6). Write the drop override column
    // when the caller included it (undefined = unchanged; null / default-equal
    // → null via implicit reset above).
    if (dropOverrideEffective !== undefined) {
      updateData.dropSharePercentOverride = dropOverrideEffective
    }
    // Drop role - phase 2. Only write the column when caller explicitly
    // included `dropId` (undefined = unchanged). `null` clears.
    if (resolvedDropId !== undefined) {
      updateData.dropId = resolvedDropId
    }
    if (data.techStack !== undefined) updateData.techStack = data.techStack ?? null
    if (data.teamSize !== undefined) updateData.teamSize = data.teamSize ?? null
    if (data.benefits !== undefined) updateData.benefits = data.benefits ?? null
    // task-drop-share-override-and-receiver (D1). paymentType is a NOT NULL enum
    // column — validate the loose write value and only apply a real value (null
    // is ignored: you cannot clear a NOT NULL enum; the frontend Select always
    // sends a concrete value).
    if (data.paymentType !== undefined && data.paymentType !== null) {
      updateData.paymentType = projectPaymentTypeSchema.parse(data.paymentType)
    }
    if (data.salaryReview !== undefined) updateData.salaryReview = data.salaryReview ?? null
    if (data.corpTech !== undefined) updateData.corpTech = data.corpTech ?? null
    if (data.notesGeneral !== undefined) updateData.notesGeneral = data.notesGeneral ?? null

    await this.db.db.update(projects).set(updateData).where(eq(projects.id, id))

    // task-pending-share (position 5): a REQUESTED change to the SENIOR
    // share override opens a proposal instead of applying immediately — no
    // proposal (and no audit log entry; the audit log records what actually
    // CHANGED, and nothing has, yet — see `approveSeniorShareChange`, which
    // logs the real before/after once the swap happens) when the requested
    // value equals what is already active, mirroring the exact
    // "actual-change, not mere presence" gate `updateUserRow` applies to
    // every other entitlement column (no proposal spam on a routine resubmit
    // of an unchanged form).
    if (isSeniorOverrideChange(overrideEffective, project.seniorSharePercentOverride)) {
      await this.proposeSeniorShareChange(
        id,
        project.seniorId,
        overrideEffective,
        // task-648-fix-round-1 (SR-M-2): attribute to the real operator
        // under impersonation, not the impersonated identity — regression
        // of the same fix `update()`'s OWN audit-log calls already apply a
        // few lines below (security-review round 2, authz-hardening).
        currentUser.impersonatorId ?? currentUser.id,
        project.seniorSharePercentOverride ?? null,
        // ORCH-3 (fix-round 7): companyName, не projects.name — параметр остаётся
        // projectName (см. NotifyPendingShareInput/proposeSeniorShareChange).
        project.companyName,
      )
    }
    // task-648-fix-round-2 (SR-H-2): there is deliberately NO `else` branch
    // here. Round 1 made "requested == active" cancel a live proposal;
    // round 2 revokes that. On this surface the branch was unreachable from
    // the product anyway (the edit form only sends
    // `seniorSharePercentOverride` when it DIFFERS from the active value —
    // `$projectId.tsx`'s `overrideChanged` gate), and on the user half the
    // same shape let an unrelated field edit kill a live proposal
    // (SR-M-5 / QA-HIGH-3). Withdrawing a proposal is EXPLICIT only, via
    // `cancelSeniorShareChange` behind the "Отменить предложение" button.

    // task-drop-share-override-and-receiver (D6). Audit the drop override change
    // (no project_finance_settings mirror sync — the canonical value lives on
    // projects.dropSharePercentOverride, which the resolver reads directly).
    if (isDropOverrideChange(dropOverrideEffective, project.dropSharePercentOverride)) {
      // security-review round 2 (authz-hardening): attribute to the real
      // operator under impersonation — see sessionUserSchema.impersonatorId's doc.
      await this.projectAuditLogService.record({
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: id,
        action: 'project_edited',
        changes: {
          dropSharePercentOverride: {
            before: project.dropSharePercentOverride ?? null,
            after: dropOverrideEffective,
          },
        },
      })
    }

    const updated = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations

    const teamOverridesBySeniorId = await this.read.loadTeamOverridesBySenior([updated])
    // CR-M-1 (PR #646 fix-round 1): update() is reachable on a REJECTED
    // project too — ProjectRow's row-Link is unconditional for isRejected,
    // same as isArchived — so a PATCH here must not silently answer
    // rejectionReason: null for the one project status where AC4 requires
    // it to render. Same guarded batch-lookup as findOne (skipped outright,
    // not just internally short-circuited, for every non-REJECTED project).
    const rejectionReasonByProjectId =
      updated.status === 'REJECTED'
        ? await this.approvals.getRejectionReasons(ProjectsService.APPROVAL_SUBJECT_TYPE, [
            updated.id,
          ])
        : new Map<string, string>()
    // SPEC-M-2 (PR #646 fix-round 1). update() is reachable on a DRAFT
    // project too (ADMIN/HR editing a draft's name/company before anyone
    // has confirmed it) — same guarded batch-lookup as findOne, DRAFT side.
    const pendingApproverIdsByProjectId =
      updated.status === 'DRAFT'
        ? await this.approvals.getPendingApproverIds(ProjectsService.APPROVAL_SUBJECT_TYPE, [
            updated.id,
          ])
        : new Map<string, Set<string>>()
    // task-pending-share: resolve so the admin sees "proposal opened"
    // immediately in this PATCH's own response, no extra round-trip needed.
    //
    // task-648-fix-round-3 (SR-L-4): gated by role, exactly like `findOne` and
    // `loadForResponse` already were. `mapProject` below masks the field for
    // every role except ADMIN and the affected SENIOR, and ACCOUNTANT is an
    // admitted caller of this method (the propose-gate names them) — so this
    // was the third response path asking `approvals` a question whose answer
    // it then threw away, the one SR-bm-3 missed in round 2.
    const pendingSeniorShare = canSeePendingSeniorShare(currentUser.role)
      ? await this.read.loadPendingSeniorShare(
          updated.id,
          updated.senior,
          updated.pendingSeniorSharePercentOverride,
          teamOverridesBySeniorId,
        )
      : null
    // Pass currentUser.role so mapProject can apply SENIOR dropName masking
    // (defense-in-depth: callers of update are ADMIN/HR/ACCOUNTANT whose role
    // never triggers the mask, but the contract is explicit and mirrors findOne/findAll).
    return this.mapProject(
      updated,
      teamOverridesBySeniorId,
      currentUser.role,
      rejectionReasonByProjectId,
      pendingApproverIdsByProjectId,
      pendingSeniorShare,
    )
  }

  /**
   * Soft-archive a project. Independent — does NOT touch senior or team.
   * Sets project_members.leftAt for active JUNIORs.
   */
  async archive(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    return this.db.db.transaction(async (tx) => {
      const project = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0])
      if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (project.archivedAt) throw apiError('PROJECT_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)

      const now = new Date()
      await tx.update(projects).set({ archivedAt: now, updatedAt: now }).where(eq(projects.id, id))

      // Remove active juniors via leftAt.
      const activeJuniors = await tx
        .select({ id: projectMembers.id, userId: projectMembers.userId, role: users.role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(
          and(
            eq(projectMembers.projectId, id),
            isNull(projectMembers.leftAt),
            eq(users.role, 'JUNIOR'),
          ),
        )
      if (activeJuniors.length > 0) {
        const ids = activeJuniors.map((j) => j.id)
        await tx.update(projectMembers).set({ leftAt: now }).where(inArray(projectMembers.id, ids))
        // security-review round 2 (authz-hardening): attribute to the real
        // operator under impersonation — see sessionUserSchema.impersonatorId's doc.
        for (const j of activeJuniors) {
          await this.projectAuditLogService.record(
            {
              actorId: currentUser.impersonatorId ?? currentUser.id,
              targetId: id,
              action: 'project_member_removed',
              changes: { userId: { before: j.userId, after: null } },
            },
            tx,
          )
        }
      }

      await this.projectAuditLogService.record(
        {
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: id,
          action: 'project_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      return this.findOne(id, currentUser)
    })
  }

  /**
   * Unarchive a project.
   *  - If senior or team is also archived → 409 with { requiresCascade: true, entities }.
   *    Client retries with `cascade=true` to pair-unarchive.
   *  - On success: projects.archivedAt = NULL; project_members.leftAt NOT restored
   *    (admin re-adds juniors via Projects page).
   */
  async unarchive(id: string, currentUser: SessionUser, cascade = false) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    return this.db.db.transaction(async (tx) => {
      const project = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0])
      if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (!project.archivedAt) throw apiError('PROJECT_NOT_ARCHIVED', HttpStatus.BAD_REQUEST)

      const senior = await tx
        .select()
        .from(users)
        .where(eq(users.id, project.seniorId))
        .then((rows) => rows[0])
      // Senior's team via team_members lookup.
      let team: typeof teams.$inferSelect | undefined
      if (senior) {
        const seniorMembership = await tx
          .select()
          .from(teamMembers)
          .where(eq(teamMembers.userId, senior.id))
          .then((rows) => rows[0])
        if (seniorMembership) {
          team = await tx
            .select()
            .from(teams)
            .where(eq(teams.id, seniorMembership.teamId))
            .then((rows) => rows[0])
        }
      }

      const entitiesToCascade: { type: 'user' | 'team'; id: string; name: string }[] = []
      if (senior?.archivedAt)
        entitiesToCascade.push({ type: 'user', id: senior.id, name: senior.displayName })
      if (team?.archivedAt) entitiesToCascade.push({ type: 'team', id: team.id, name: team.name })

      if (entitiesToCascade.length > 0 && !cascade) {
        throw new ConflictException({
          requiresCascade: true,
          entities: entitiesToCascade,
        })
      }

      const now = new Date()
      const previousArchivedAt = project.archivedAt

      if (cascade && senior?.archivedAt) {
        // Pair-unarchive senior + team via the SAME outer transaction (`tx`).
        // We deliberately DO NOT call `this.usersService.unarchive(...)` because
        // that opens its own `db.transaction()` — making it impossible to roll
        // back together with the project mutations below if anything throws.
        // security-review round 2 (authz-hardening): attribute to the real
        // operator under impersonation — see sessionUserSchema.impersonatorId's doc.
        await this.usersService.unarchivePairTx(
          tx,
          senior.id,
          currentUser.impersonatorId ?? currentUser.id,
        )
      }

      await tx.update(projects).set({ archivedAt: null, updatedAt: now }).where(eq(projects.id, id))

      await this.projectAuditLogService.record(
        {
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: id,
          action: 'project_unarchived',
          changes: { archivedAt: { before: previousArchivedAt.toISOString(), after: null } },
        },
        tx,
      )

      // project_members.leftAt intentionally NOT restored.
      return this.findOne(id, currentUser)
    })
  }

  async getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
    })
    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

    const activeJuniors = await this.db.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, id),
          isNull(projectMembers.leftAt),
          eq(users.role, 'JUNIOR'),
        ),
      )

    return { type: 'project', activeMembersCount: activeJuniors.length }
  }

  addMember(projectId: string, userId: string, currentUser: SessionUser) {
    return this.members.addMember(projectId, userId, currentUser)
  }

  removeMember(projectId: string, userId: string, currentUser: SessionUser) {
    return this.members.removeMember(projectId, userId, currentUser)
  }

  /**
   * Create a project from a HIRED interview.
   *
   * Audit (HIGH): accepts an optional `tx` so the caller (`InterviewsService.move`)
   * can run this INSIDE the same transaction that flips the interview to HIRED.
   * Without it, the interview stage update committed before this insert, so a
   * failure here orphaned the interview in HIRED with no project. With `tx`
   * threaded through every write, a failure rolls the stage change back too.
   * When `tx` is omitted, behaviour is unchanged (`this.db.db`).
   *
   * Backlog #136: the HR/ACCOUNTANT this seeds onto the new project come from
   * the senior's team membership below — see the `isNull(teamMembers.leftAt)`
   * filters on both queries it runs. Both must stay: one keeps a team the
   * senior has LEFT from contributing staff at all, the other keeps a
   * teammate who left THAT team from being seated even while the team is
   * still active for the senior.
   *
   * security-review round 2 (SR-H-6): this is the SECOND door into
   * `insert(projects)` — `create()` above is the first — and round 1 missed
   * it entirely: no explicit `status: 'DRAFT'` and no approval proposal, so a
   * project hired straight out of an interview shipped fully `ACTIVE` (the
   * column DEFAULT) with zero rows in `approvals`, unconfirmable by
   * construction (`approveDraft` 404s everyone — there is no live row to
   * confirm). BIZ-07 reaches this from `PATCH /api/interviews/:id/move`,
   * which HR and SENIOR can call too, not just ADMIN. Same gate, same
   * reason as `create()`: the senior whose money this project will move
   * should agree to it in CRM before it starts, regardless of which door
   * created the row. Interview-sourced projects never carry a `dropId` (no
   * such field exists on `Interview`), so the senior is the sole invited
   * approver here — no `[seniorId, dropId]` branch to mirror from `create()`.
   */
  async createFromInterview(
    interview: Interview & { senior: User | null },
    currentUser: SessionUser,
    tx?: DrizzleTx,
  ) {
    const conn = tx ?? this.db.db
    const domain = interview.notesDomain ?? 'Other'

    const [project] = await conn
      .insert(projects)
      .values({
        name: interview.companyName,
        companyName: interview.companyName,
        domain,
        logoDocumentId: null,
        logoExternalUrl: null,
        startDate: new Date(),
        seniorId: interview.seniorId,
        rate: 0,
        currency: 'USDT',
        techStack: interview.notesTechStack ?? null,
        teamSize: interview.notesTeamSize ?? null,
        benefits: interview.notesBenefits ?? null,
        // task-drop-share-override-and-receiver (D1 / C10). `interview.notesPaymentType`
        // is a free-text interview note — NOT a project_payment_type enum value.
        // Leave paymentType at the DB default ('FOP'); ADMIN/ACCOUNTANT set the
        // real enum later via the project edit form.
        salaryReview: interview.notesSalaryReview ?? null,
        corpTech: interview.notesCorpTech ?? null,
        notesGeneral: interview.notesGeneral ?? null,
        // security-review round 2 (SR-H-6). See the method doc above — this
        // is the door round 1 left open.
        status: 'DRAFT',
      })
      .returning()

    if (!project) return project

    // security-review round 2 (SR-H-6). Open the approval proposal in the
    // SAME connection as the insert above — when the caller passed a `tx`
    // (the only real caller, `InterviewsService.move`, always does), this is
    // the SAME transaction, so a DRAFT project without its approval row
    // stays impossible here too (decision Д1's own invariant, see `create()`
    // above). `conn` is `DrizzleTx | NodePgDatabase` depending on whether a
    // `tx` was passed; `proposeInTx` only ever calls query-builder methods
    // both share, so the cast is the same shape already used elsewhere in
    // this codebase for the identical mismatch (e.g.
    // `transactions.service.ts`'s `this.db.db as unknown as DrizzleTx`).
    const [approval] = await this.approvals.proposeInTx(conn as unknown as DrizzleTx, {
      subjectType: ProjectsService.APPROVAL_SUBJECT_TYPE,
      subjectId: project.id,
      approverUserIds: [interview.seniorId],
      proposedByUserId: currentUser.id,
    })
    // Stryker disable next-line all: defensive-only (и условие, и текст сообщения) — `proposeInTx` возвращает `.returning()` по строке на подтверждающего; пустой массив при непустом `approverUserIds` на настоящем Postgres невозможен.
    if (!approval) throw new Error('Failed to open project approval')

    // SR-L-1 (security-review круг 1): ВТОРАЯ дверь в черновик проекта — и
    // производитель обязан стоять у обеих. `create` выше уже просит синьора
    // подтвердить; проект, приехавший из нанятого собеседования, открывает
    // ровно такое же согласование, и без этой строки синьор о нём не узнавал
    // (кнопка «подтвердить» есть, просьбы нет).
    //
    // Тот же контур, что и у `create`: получатели — приглашённые
    // подтверждающие, автор действия исключён (§8.1 — своё подтверждает тост,
    // а не колокольчик), запись идёт по тому же соединению, что и сам
    // черновик, поэтому откат события уносит и её.
    // SR-H-2 (security-review круг 2): именно ЗДЕСЬ вето и поймали
    // исполнением — `TypeError` на этом пути откатывал переход собеседования в
    // HIRED вместе с созданием проекта и записью `created_project_id` (BIZ-07).
    // Теперь путь производителя идёт во вложенной транзакции (SAVEPOINT):
    // ошибка откатывает ровно её, а событие живёт.
    await this.notifications.emitInTx(conn as unknown as DrizzleTx, async (sp) => {
      if (interview.seniorId !== (currentUser.impersonatorId ?? currentUser.id)) {
        await this.notifications.createInTx(sp, {
          userId: interview.seniorId,
          type: 'PROJECT_CONFIRM_REQUIRED',
          title: NOTIFICATION_TITLES.PROJECT_CONFIRM_REQUIRED,
          subjectType: 'PROJECT',
          subjectId: project.id,
          // ORCH-3 (fix-round 7): companyName, не projects.name (здесь равны при
          // создании из собеседования, но источник — companyName).
          // QA-H-1 (круг 3): плюс идентификатор открывшейся строки согласования.
          data: { projectName: project.companyName, approvalId: approval.id },
        })
      }
    })

    // Find all teams where this senior is CURRENTLY a member. Backlog #136:
    // this query used to ignore `leftAt`, so a team the senior had already
    // left still fed its HR/ACCOUNTANT into a brand-new project — a stale
    // team membership was outliving the membership itself.
    const seniorTeamMemberships = await conn.query.teamMembers.findMany({
      where: and(eq(teamMembers.userId, interview.seniorId), isNull(teamMembers.leftAt)),
    })
    const teamIds = seniorTeamMemberships.map((m) => m.teamId)

    if (teamIds.length > 0) {
      // task-archived-user-completeness (AC1, security-review MED-3). This is
      // the SECOND door into `project_members`, and it was open. `addMember`
      // now refuses to seat a dismissed person on a live project; seeding a
      // project from a HIRED interview has to obey the same invariant, or the
      // rule holds only on the door someone happened to look at.
      //
      // TWO filters, because a dismissed teammate could arrive here by two
      // different routes:
      //
      //   • `isNull(leftAt)` — `UsersService.archive` closes an HR's /
      //     ACCOUNTANT's team memberships by stamping `leftAt`, and this query
      //     did not look at it. A dismissed HR whose membership had been
      //     closed months ago was still returned here and handed a fresh
      //     ACTIVE row on a brand-new project.
      //   • `archivedAt` — belt and braces for the row that is archived while
      //     its membership is somehow still open (a cascade that missed, a
      //     hand-edited row, a future archive path that forgets). `leftAt`
      //     tracks TEAM membership; `archivedAt` tracks EMPLOYMENT, and the
      //     question "may this person be seated on a project" belongs to the
      //     second one — the same split spelled out on `addMember`.
      //
      // No money moves through this today (only the JUNIOR branch of
      // `createMonthlySalaries` mints from project membership, and it re-reads
      // `user.archivedAt`; HR/ACCOUNTANT salaries come from a separate query
      // that already filters archived). This is about the invariant being true
      // wherever it is stated, not about a live leak.
      const teammates = await conn.query.teamMembers.findMany({
        where: and(inArray(teamMembers.teamId, teamIds), isNull(teamMembers.leftAt)),
        with: { user: { columns: { id: true, role: true, archivedAt: true } } },
      })

      const addedUserIds = new Set<string>()
      for (const m of teammates) {
        const u = (
          m as typeof m & { user: { id: string; role: string; archivedAt: Date | null } | null }
        ).user
        if (!u) continue
        if (u.archivedAt) continue
        if (u.role !== 'HR' && u.role !== 'ACCOUNTANT') continue
        if (addedUserIds.has(u.id)) continue
        addedUserIds.add(u.id)
        await conn.insert(projectMembers).values({
          projectId: project.id,
          userId: u.id,
        })
      }
    }

    return project
  }

  /**
   * GET /api/projects/:id/hr-contact
   *
   * Returns the HR contact for the project's senior team.
   * Allowlist-only: displayName, telegram, phone — no ids/roles/finance.
   * Returns null fields when no HR is assigned.
   *
   * Access:
   *   - ADMIN → always
   *   - Active JUNIOR project member → yes (their primary consumer)
   *   - HR of project's team → yes
   *   - All others → 403
   */
  async getHrContact(
    projectId: string,
    currentUser: SessionUser,
  ): Promise<{
    displayName: string | null
    telegram: string | null
    phone: string | null
    avatarUrl: string | null
  }> {
    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined

    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)

    // RBAC: ADMIN, active JUNIOR member, HR of project's team
    const isAdmin = currentUser.role === 'ADMIN'
    const isActiveJunior =
      currentUser.role === 'JUNIOR' &&
      project.members.some((m) => m.userId === currentUser.id && m.leftAt === null)
    const isTeamHr =
      currentUser.role === 'HR' &&
      project.seniorId !== null &&
      (await this.hrAccess.hrSharesActiveTeamWith(currentUser.id, project.seniorId))

    if (!isAdmin && !isActiveJunior && !isTeamHr) {
      throw apiError('NO_HR_CONTACT_ACCESS', HttpStatus.FORBIDDEN)
    }

    if (!project.seniorId) {
      return { displayName: null, telegram: null, phone: null, avatarUrl: null }
    }

    // Find HR in the senior's active team
    const seniorMembership = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.userId, project.seniorId), isNull(teamMembers.leftAt)),
    })
    if (!seniorMembership) {
      return { displayName: null, telegram: null, phone: null, avatarUrl: null }
    }

    const hrRow = await this.db.db
      .select({
        displayName: users.displayName,
        telegram: users.telegram,
        phone: users.phone,
        avatarUrl: users.avatarUrl,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, seniorMembership.teamId),
          eq(users.role, 'HR'),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null)

    return {
      displayName: hrRow?.displayName ?? null,
      telegram: hrRow?.telegram ?? null,
      phone: hrRow?.phone ?? null,
      avatarUrl: hrRow?.avatarUrl ?? null,
    }
  }

  // Thin delegate kept (not inlined): unit specs stub the guard via
  // `vi.spyOn(service, 'assertAccess')`.
  private assertAccess(project: ProjectWithRelations, currentUser: SessionUser) {
    return this.access.assertAccess(project, currentUser)
  }
}
