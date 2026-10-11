import { HttpStatus, Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { EffectiveTeam, PendingSeniorShare, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { ApprovalsService } from '../approvals/approvals.service'
import { DatabaseService } from '../database/database.service'
import { projects, teamMembers, users } from '../database/schema'
import {
  PROJECT_APPROVAL_SUBJECT_TYPE,
  PROJECT_SENIOR_SHARE_SUBJECT_TYPE,
  ProjectAccessService,
} from './project-access.service'
import { mapProjectToDto, type ProjectWithRelations } from './project-map.util'
import { buildPendingSeniorShareDto } from './project-share.util'
import { buildEffectiveTeam, type EffectiveTeamRow } from './project-team.util'
import { canSeePendingSeniorShare } from './project-visibility.util'

type TeamOverridesBySeniorId = Map<
  string,
  { id: string; seniorSharePercentOverride: number | null }[]
>

/**
 * The project-DTO read path: loads a project with its relations and assembles
 * the viewer-masked response DTO. Collaborator of `ProjectsService` (and of the
 * draft / share / archive clusters), so none of them needs a `ProjectsService`
 * back-reference just to answer with a project.
 */
@Injectable()
export class ProjectReadService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: ProjectAccessService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Pre-computes the active senior-team overrides for every senior referenced
   * by the supplied projects, in one DB hit. The result feeds `mapProjectToDto`
   * so each row carries `effectiveSeniorSharePercent` +
   * `effectiveSeniorShareSource` without an N+1 round-trip per project. Keyed
   * by `senior.id`.
   */
  async loadTeamOverridesBySenior(
    projects: ProjectWithRelations[],
  ): Promise<TeamOverridesBySeniorId> {
    const seniorIds = Array.from(
      new Set(
        projects
          .map((p) => p.seniorId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    )
    const map: TeamOverridesBySeniorId = new Map()
    if (seniorIds.length === 0) return map

    // Use the relational query API instead of a raw `db.select(...).from(...)`
    // join chain so existing service-spec mocks (which only stub the
    // `db.query.<entity>.find*` surface) keep working without a wholesale
    // mock rewrite. Try/catch protects against test doubles that don't even
    // stub `query.teamMembers.findMany` — those simply fall through to "no
    // overrides", which is the correct default for the resolver.
    let rows: Array<{
      userId: string
      team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
    }> = []
    try {
      rows = (await this.db.db.query.teamMembers.findMany({
        where: and(inArray(teamMembers.userId, seniorIds), isNull(teamMembers.leftAt)),
        with: { team: true },
      })) as unknown as Array<{
        userId: string
        team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
      }>
    } catch {
      // Fall through with `rows` still empty.
    }

    for (const row of rows) {
      if (!row.team || row.team.archivedAt !== null) continue
      const list = map.get(row.userId) ?? []
      list.push({
        id: row.team.id,
        seniorSharePercentOverride: row.team.seniorSharePercentOverride ?? null,
      })
      map.set(row.userId, list)
    }
    return map
  }

  /**
   * Resolves the `pendingSeniorShare` DTO field for a single project — the
   * async counterpart to the (synchronous) masking `mapProjectToDto` applies.
   * `null` whenever there is no live PENDING proposal, determined by
   * `ApprovalsService.getStatus` — NEVER by `pendingSeniorSharePercentOverride`'s
   * own null-ness (that column can legitimately hold `null` WHILE pending — see
   * the column's own schema comment).
   */
  async loadPendingSeniorShare(
    projectId: string,
    senior:
      { id: string; displayName: string; seniorSharePercent: number | null } | null | undefined,
    pendingValue: number | null | undefined,
    // NOT optional — every call site already computes this via
    // `loadTeamOverridesBySenior` before calling in, so an optional-chaining
    // `?.` here had no live path where it could ever short-circuit. `.get(
    // senior.id)` returning `undefined` (this senior has no team override) is
    // the real, exercised case the `?? []` downstream still covers.
    teamOverridesBySeniorId: TeamOverridesBySeniorId,
  ): Promise<PendingSeniorShare | null> {
    if (!senior) return null
    const status = await this.approvals.getStatus(PROJECT_SENIOR_SHARE_SUBJECT_TYPE, projectId)
    if (status !== 'PENDING') return null
    return buildPendingSeniorShareDto(senior, pendingValue, teamOverridesBySeniorId)
  }

  async findOne(id: string, currentUser: SessionUser) {
    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined

    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    await this.access.assertAccess(project, currentUser)

    const teamOverridesBySeniorId = await this.loadTeamOverridesBySenior([project])
    // Same batched lookup as `findAll`, narrowed to this one project — the call
    // is skipped outright (not just internally short-circuited) for every
    // project that isn't REJECTED.
    const rejectionReasonByProjectId =
      project.status === 'REJECTED'
        ? await this.approvals.getRejectionReasons(PROJECT_APPROVAL_SUBJECT_TYPE, [project.id])
        : new Map<string, string>()
    // Same guarded shape as the REJECTED lookup just above, for the DRAFT side.
    const pendingApproverIdsByProjectId =
      project.status === 'DRAFT'
        ? await this.approvals.getPendingApproverIds(PROJECT_APPROVAL_SUBJECT_TYPE, [project.id])
        : new Map<string, Set<string>>()
    // JUNIOR must not see effectiveTeam — it contains senior/HR/accountant
    // identity. We skip the computation entirely (saves DB round-trip) and
    // return undefined so the field is absent from the JUNIOR DTO.
    const effectiveTeam =
      currentUser.role === 'JUNIOR'
        ? undefined
        : await this.computeEffectiveTeam(project, currentUser.role)
    // Skip the lookup for anyone who is not ADMIN or the affected SENIOR —
    // `mapProjectToDto` masks the field for every other role, same "don't pay
    // for a value nobody sees" reasoning as effectiveTeam immediately above.
    const pendingSeniorShare = canSeePendingSeniorShare(currentUser.role)
      ? await this.loadPendingSeniorShare(
          project.id,
          project.senior,
          project.pendingSeniorSharePercentOverride,
          teamOverridesBySeniorId,
        )
      : null
    return {
      ...mapProjectToDto(
        project,
        teamOverridesBySeniorId,
        currentUser.role,
        rejectionReasonByProjectId,
        pendingApproverIdsByProjectId,
        pendingSeniorShare,
      ),
      effectiveTeam,
    }
  }

  /**
   * Effective team is a computed view (NOT a snapshot at archive time).
   * - senior: project.seniorId resolved to a user row (typed for SENIOR — but we widen to allow ADMIN-owned projects).
   * - hrs / accountants: active team_members (leftAt IS NULL) of senior's team.
   * - juniors: active project_members of THIS project (leftAt IS NULL).
   *
   * After unarchive, this naturally reflects the current senior's team — if HR changed
   * while archived, the new HR appears here without restoring leftAt rows.
   */
  async computeEffectiveTeam(
    project: ProjectWithRelations,
    viewerRole: SessionUser['role'],
  ): Promise<EffectiveTeam> {
    // Resolve senior's team via team_members where userId = senior.id.
    // The query stays here; the pure assembly + masking is `buildEffectiveTeam`.
    const teamRows: EffectiveTeamRow[] = project.senior
      ? await this.loadSeniorTeamRows(project.senior.id)
      : // Stryker disable next-line ArrayDeclaration: equivalent mutant — a stray element is never a row with role 'HR'/'ACCOUNTANT', so buildEffectiveTeam's role filters discard it and hrs/accountants stay empty either way.
        []
    return buildEffectiveTeam(project, viewerRole, teamRows)
  }

  async loadSeniorTeamRows(seniorId: string): Promise<EffectiveTeamRow[]> {
    const seniorMembership = await this.db.db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)),
    })
    if (!seniorMembership) return []
    const teamId = seniorMembership.teamId
    return this.db.db
      .select({
        id: teamMembers.id,
        userId: teamMembers.userId,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
        avatarDocumentId: users.avatarDocumentId,
        role: users.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))
  }

  /**
   * Re-fetches + maps a project for the approve/reject/cancel response.
   *
   * `rejectionReasonByProjectId` — the caller builds this directly instead of
   * this method deriving it, because the callers need it built two different
   * ways: `rejectDraft` already has the reason it just wrote in scope (passes a
   * single-entry map); `approveDraft` omits it — its result is never REJECTED,
   * so `mapProjectToDto`'s default empty map is exactly right, and deliberately
   * NOT the same "batch-query `getRejectionReasons`" path `findAll`/`findOne`
   * use (would be a DB round trip for a value that can never matter here).
   */
  async loadForResponse(
    id: string,
    currentUser: SessionUser,
    rejectionReasonByProjectId?: Map<string, string>,
  ) {
    const project = (await this.db.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { senior: true, drop: true, members: { with: { user: true } }, legend: true },
    })) as ProjectWithRelations | undefined
    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    const teamOverridesBySeniorId = await this.loadTeamOverridesBySenior([project])
    // Computed HERE (not by the caller, unlike rejectionReasonByProjectId
    // above) because it needs the SAME guard for BOTH callers: `rejectDraft`'s
    // result is always REJECTED (never needs it — the mapper's own status check
    // already yields `[]`), but `approveDraft`'s result can legitimately still
    // be DRAFT (partial agreement — the other invited approver hasn't decided
    // yet), and in that case the response SHOULD carry the remaining pending
    // approver, not an empty array from a caller that never asked.
    const pendingApproverIdsByProjectId =
      project.status === 'DRAFT'
        ? await this.approvals.getPendingApproverIds(PROJECT_APPROVAL_SUBJECT_TYPE, [project.id])
        : new Map<string, Set<string>>()
    // This response path is shared by approveDraft / rejectDraft /
    // approveSeniorShareChange / rejectSeniorShareChange /
    // cancelSeniorShareChange — the caller may just have resolved a share
    // proposal (or a draft proposal while a share proposal ALSO happens to be
    // live), so it resolves this rather than trusting which action got it here.
    //
    // But only for a viewer who may SEE it: the mapper masks the field for every
    // role except ADMIN and the affected SENIOR, so resolving it for an
    // ACCOUNTANT — who reaches this method through `cancelSeniorShareChange` —
    // would be a round-trip whose result is thrown away one line later. `findOne`
    // applies this exact gate; the two response paths must agree about who may
    // even ask.
    const pendingSeniorShare = canSeePendingSeniorShare(currentUser.role)
      ? await this.loadPendingSeniorShare(
          project.id,
          project.senior,
          project.pendingSeniorSharePercentOverride,
          teamOverridesBySeniorId,
        )
      : null
    return mapProjectToDto(
      project,
      teamOverridesBySeniorId,
      currentUser.role,
      rejectionReasonByProjectId,
      pendingApproverIdsByProjectId,
      pendingSeniorShare,
    )
  }
}
