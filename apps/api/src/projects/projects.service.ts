import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  forwardRef,
} from '@nestjs/common'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
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
import { projects, teamMembers, users, type Interview, type User } from '../database/schema'
import { ProjectAccessService, PROJECT_APPROVAL_SUBJECT_TYPE } from './project-access.service'
import { ProjectArchiveService } from './project-archive.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectDraftService } from './project-draft.service'
import { ProjectInterviewSeedService } from './project-interview-seed.service'
import { ProjectMembersService } from './project-members.service'
import { ProjectReadService } from './project-read.service'
import { ProjectScopedReadService } from './project-scoped-read.service'
import { ProjectShareChangeService } from './project-share-change.service'
import { canSeePendingSeniorShare } from './project-visibility.util'
import { mapProjectToDto, type ProjectWithRelations } from './project-map.util'
import { assertLogoDocument } from './project-logo.util'
import {
  assertFinanceFieldsAllowed,
  buildProjectUpdateData,
  isFinanceOnlyPatch,
  resolveActiveDropId,
} from './project-update-data.util'
import { UsersService } from '../users/users.service'
import {
  isDropOverrideChange,
  isSeniorOverrideChange,
  pickDropDefault,
  pickSeniorDefault,
  resolveOverrideEffective,
} from './project-share.util'
import type { DrizzleTx } from '../database/types'

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
    @Optional() archiveService?: ProjectArchiveService,
    @Optional() shareChange?: ProjectShareChangeService,
    @Optional() interviewSeed?: ProjectInterviewSeedService,
    @Optional() scopedRead?: ProjectScopedReadService,
  ) {
    this.access = access ?? new ProjectAccessService(db, approvals)
    this.read = read ?? new ProjectReadService(db, this.access, approvals)
    this.members = members ?? new ProjectMembersService(db, this.access, notifications)
    this.draft = draft ?? new ProjectDraftService(db, approvals, this.read)
    this.archiveService =
      archiveService ??
      new ProjectArchiveService(db, projectAuditLogService, usersService, this.read)
    this.shareChange =
      shareChange ??
      new ProjectShareChangeService(db, approvals, this.read, projectAuditLogService, notifications)
    this.interviewSeed =
      interviewSeed ?? new ProjectInterviewSeedService(db, approvals, notifications)
    this.scopedRead = scopedRead ?? new ProjectScopedReadService(db, hrAccess)
  }

  private readonly access: ProjectAccessService
  private readonly members: ProjectMembersService
  private readonly read: ProjectReadService
  private readonly draft: ProjectDraftService
  private readonly archiveService: ProjectArchiveService
  private readonly shareChange: ProjectShareChangeService
  private readonly interviewSeed: ProjectInterviewSeedService
  private readonly scopedRead: ProjectScopedReadService

  /** task-project-draft-status. `subjectType` this module registers approvals under. */
  private static readonly APPROVAL_SUBJECT_TYPE = PROJECT_APPROVAL_SUBJECT_TYPE

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
  findDropOwnProjects(currentUser: SessionUser): Promise<DropProjectDto[]> {
    return this.scopedRead.findDropOwnProjects(currentUser)
  }

  findOne(id: string, currentUser: SessionUser) {
    return this.read.findOne(id, currentUser)
  }

  async create(data: CreateProjectDto, currentUser: SessionUser) {
    // Field-scoped RBAC (senior/drop override, paymentType: ADMIN/ACCOUNTANT only)
    // runs BEFORE the create-role check so an HR caller sending a finance field
    // still gets the more-specific 403.
    const role = currentUser.role
    assertFinanceFieldsAllowed(data, role)

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
    const resolvedDropId =
      data.dropId !== undefined && data.dropId !== null
        ? await resolveActiveDropId(this.db.db, data.dropId)
        : null

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
      await this.shareChange.syncFinanceSettingsOverride(project.id, override, currentUser.id)
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

  approveSeniorShareChange(id: string, currentUser: SessionUser) {
    return this.shareChange.approveSeniorShareChange(id, currentUser)
  }

  rejectSeniorShareChange(id: string, reason: string, currentUser: SessionUser) {
    return this.shareChange.rejectSeniorShareChange(id, reason, currentUser)
  }

  cancelSeniorShareChange(id: string, currentUser: SessionUser) {
    return this.shareChange.cancelSeniorShareChange(id, currentUser)
  }

  async update(id: string, data: UpdateProjectDto, currentUser: SessionUser) {
    // Field-scoped RBAC (senior/drop override incl. explicit null, paymentType):
    // ADMIN/ACCOUNTANT only. HR keeps full edit access to every other field.
    // Checked BEFORE the role narrow so ACCOUNTANT-only finance patches pass.
    const role = currentUser.role
    assertFinanceFieldsAllowed(data, role)

    // ACCOUNTANT may patch only when EVERY field touched is finance-scoped.
    const hasOnlyOverride = isFinanceOnlyPatch(data)

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
      resolvedDropId =
        data.dropId === null ? null : await resolveActiveDropId(this.db.db, data.dropId)
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

    // Validate the logo FK before applying (null clears the document path).
    if (data.logoDocumentId !== undefined) {
      await assertLogoDocument(this.db.db, data.logoDocumentId, id)
    }
    // task-pending-share (position 5): `seniorSharePercentOverride` is
    // DELIBERATELY excluded from the patch — `overrideEffective` is routed
    // through `proposeSeniorShareChange` below instead (SENIOR must confirm).
    const updateData = buildProjectUpdateData(data, resolvedDropId, dropOverrideEffective)

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
      await this.shareChange.proposeSeniorShareChange(
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

  archive(id: string, currentUser: SessionUser) {
    return this.archiveService.archive(id, currentUser)
  }

  unarchive(id: string, currentUser: SessionUser, cascade = false) {
    return this.archiveService.unarchive(id, currentUser, cascade)
  }

  getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    return this.archiveService.getArchiveImpact(id, currentUser)
  }

  addMember(projectId: string, userId: string, currentUser: SessionUser) {
    return this.members.addMember(projectId, userId, currentUser)
  }

  removeMember(projectId: string, userId: string, currentUser: SessionUser) {
    return this.members.removeMember(projectId, userId, currentUser)
  }

  /** See ProjectInterviewSeedService.createFromInterview for the full contract. */
  createFromInterview(
    interview: Interview & { senior: User | null },
    currentUser: SessionUser,
    tx?: DrizzleTx,
  ) {
    return this.interviewSeed.createFromInterview(interview, currentUser, tx)
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
  getHrContact(
    projectId: string,
    currentUser: SessionUser,
  ): Promise<{
    displayName: string | null
    telegram: string | null
    phone: string | null
    avatarUrl: string | null
  }> {
    return this.scopedRead.getHrContact(projectId, currentUser)
  }

  // Thin delegate kept (not inlined): unit specs stub the guard via
  // `vi.spyOn(service, 'assertAccess')`.
  private assertAccess(project: ProjectWithRelations, currentUser: SessionUser) {
    return this.access.assertAccess(project, currentUser)
  }
}
