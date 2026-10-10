import type { PendingSeniorShare, SessionUser } from '@crm/shared'
import { resolveDropShare, DEFAULT_DROP_SHARE_PERCENT } from '../finance/drop-share-resolver'
import { resolveSeniorShare } from '../finance/senior-share-resolver'
import type { Legend, Project, ProjectMember, User } from '../database/schema'
import { canSeePendingSeniorShare } from './project-visibility.util'

export type ProjectWithRelations = Project & {
  senior: User | null
  // Drop role - phase 2: relation joined by `with: { drop: true }` when
  // mapping a project. Null for regular senior-projects (no dropId).
  drop?: User | null
  members: Array<ProjectMember & { user: User | null }>
  // task-junior-ux-1-backend: legend persona for this project.
  // Loaded via `with: { legend: true }` in all findMany/findFirst queries.
  // `null` when no legend has been created for this project yet.
  legend?: Legend | null
}

/**
 * Pure project DTO mapper + all RBAC masking (extracted verbatim from
 * `ProjectsService.mapProject`, leaf P-L2). Synchronous, no I/O.
 */
export function mapProjectToDto(
  project: ProjectWithRelations,
  teamOverridesBySeniorId:
    Map<string, { id: string; seniorSharePercentOverride: number | null }[]> | undefined,
  viewerRole: SessionUser['role'],
  /**
   * task-project-status-filter-ui. Pre-computed (batched, never queried
   * per-row here — `mapProject` stays synchronous) rejection-reason
   * lookup, keyed by project id. No entry for a given id → `null` on the
   * DTO. Defaults to an empty map (not `undefined`) so every call site —
   * including the ones that structurally never carry a REJECTED project
   * (`approveDraft`'s response) — can omit the argument without an
   * optional-chaining fallback that would never be exercised.
   * Callers: `findAll`/`findOne` pass a batch built via
   * `ApprovalsService.getRejectionReasons`; `rejectDraft` (via
   * `loadForResponse`) passes a single-entry map built from the reason it
   * already has in scope (no query needed for "the project I just
   * rejected").
   */
  rejectionReasonByProjectId: Map<string, string> = new Map(),
  /**
   * SPEC-M-2 (PR #646 fix-round 1). Same batched-lookup contract as
   * `rejectionReasonByProjectId` immediately above, for "which invited
   * approver(s) still owe a decision" (`ApprovalsService.
   * getPendingApproverIds`) — keyed by project id, value is the RAW
   * (pre-mask) set of still-pending approver user ids, checked below
   * against `project.seniorId`/`project.dropId` (also raw) to produce the
   * two DTO booleans — see `seniorApprovalPending`'s schema doc for why
   * booleans, not the raw ids, cross the mapping boundary. Defaults to an
   * empty map for the same reason as its REJECTED sibling: call sites
   * that structurally never carry a DRAFT project (e.g. `rejectDraft`'s
   * response, always REJECTED) can omit the argument.
   */
  pendingApproverIdsByProjectId: Map<string, Set<string>> = new Map(),
  /**
   * task-pending-share (position 5). Pre-resolved by the CALLER (this
   * method itself stays synchronous — `ApprovalsService.getStatus` is
   * async) and only on the single-project read paths that need it
   * (findOne / update / loadForResponse). `undefined` on the list
   * endpoint (findAll) and on `create` (a brand-new project cannot yet
   * have a pending share proposal) — both render the DTO field as `null`,
   * same as an explicit "nothing pending" would.
   */
  pendingSeniorShare?: PendingSeniorShare | null,
) {
  // task-team-senior-share-override. Compute effective share + source for
  // the UI. The resolver mirrors the snapshot logic in
  // TransactionsService.createSeniorIncome / PaymentChannelService so the
  // value rendered here equals the value that *would* be stamped on the
  // next income created against this project.
  const senior = project.senior
  let effectiveSeniorSharePercent: number | null = null
  let effectiveSeniorShareSource: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null = null
  if (senior) {
    // Stryker disable next-line ArrayDeclaration: equivalent mutant — `resolveSeniorShare` keeps only team elements whose `seniorSharePercentOverride` is non-null; Stryker's canned replacement (a bare string) has no such property, so it is filtered out exactly like `[]`.
    const applicableTeams = teamOverridesBySeniorId?.get(senior.id) ?? []
    const resolved = resolveSeniorShare(
      { seniorSharePercentOverride: project.seniorSharePercentOverride },
      { seniorSharePercent: senior.seniorSharePercent },
      applicableTeams,
    )
    effectiveSeniorSharePercent = resolved.value
    effectiveSeniorShareSource = resolved.source
  }

  // task-drop-share-override-and-receiver (Part A / D6). Effective drop share +
  // source for the UI hint — same resolver the DROP_INCOME snapshot uses, so
  // the value rendered here equals what would be stamped on the next drop
  // income. Only meaningful for drop-projects (project.drop present).
  const drop = project.drop
  let effectiveDropSharePercent: number | null = null
  let effectiveDropShareSource: 'PROJECT' | 'USER_DEFAULT' | null = null
  if (drop) {
    const resolvedDrop = resolveDropShare(
      { dropSharePercentOverride: project.dropSharePercentOverride },
      { dropSharePercent: drop.dropSharePercent },
    )
    effectiveDropSharePercent = resolvedDrop.value
    effectiveDropShareSource = resolvedDrop.source
  }
  // Allowlist masking for JUNIOR viewers (RBAC A01):
  // JUNIOR must not receive senior identity, drop identity, or any financial
  // data. All sensitive fields are emitted as null so the DTO itself carries
  // no sensitive data regardless of UI rendering. Members list is also
  // emptied — JUNIOR knows they are a member of the project (they navigated
  // here) but must not see the rest of the team roster via this endpoint.
  const isJuniorViewer = viewerRole === 'JUNIOR'

  // task-admin-as-senior: when the project's senior is an ADMIN user,
  // only ADMIN and ACCOUNTANT viewers get the real seniorId (navigable profile).
  // All other non-JUNIOR roles (SENIOR, HR, DROP) get seniorId=null — they see
  // the displayName but cannot navigate to the admin's profile (403 for them).
  // JUNIOR falls through to the existing null path regardless.
  const isPrivilegedViewer = viewerRole === 'ADMIN' || viewerRole === 'ACCOUNTANT'
  const isAdminSenior = project.senior?.role === 'ADMIN'

  // Effective seniorId for non-JUNIOR viewers:
  //   - Regular project (senior role ≠ ADMIN): real seniorId
  //   - Admin-project + privileged viewer (ADMIN/ACCOUNTANT): real seniorId
  //   - Admin-project + non-privileged viewer (SENIOR/HR/DROP): null (no link)
  const effectiveSeniorId: string | null = isJuniorViewer
    ? null
    : isAdminSenior && !isPrivilegedViewer
      ? null
      : (project.seniorId ?? null)

  // task-junior-ux-1-backend: legend persona enrichment for JUNIOR.
  // JUNIOR sees the persona name/role instead of real identity (which stays null).
  // Non-JUNIOR viewers get null for these fields (they use seniorName/seniorId).
  // Real identity fields (seniorId, dropId, contacts) remain null for JUNIOR —
  // allowlist is ENRICHED (persona name/role added), NOT opened (real ID stays null).
  const legend = project.legend ?? null
  const seniorPresentedRole: string | null =
    isJuniorViewer && legend ? (legend.presentedRole ?? null) : null

  return {
    id: project.id,
    name: project.name,
    companyName: project.companyName,
    domain: project.domain,
    logoDocumentId: project.logoDocumentId ?? null,
    logoExternalUrl: project.logoExternalUrl ?? null,
    startDate: project.startDate.toISOString(),
    // Identity masking (RBAC A01): JUNIOR must not know who the senior is.
    // task-admin-as-senior: non-privileged viewers also get null for admin-projects.
    seniorId: effectiveSeniorId,
    // JUNIOR: persona fullName from legend (or null if no legend). Non-JUNIOR: real displayName.
    seniorName: isJuniorViewer ? (legend?.fullName ?? null) : (project.senior?.displayName ?? ''),
    // Legend persona role — JUNIOR only. Non-JUNIOR viewers get null (unused by their UI).
    seniorPresentedRole,
    // Drop identity masking:
    //   JUNIOR  — must not know the drop exists or who it is (full mask).
    //   SENIOR  — must not receive drop identity (displayName/email/avatarUrl) per
    //             RBAC rule #2 (legend: subject = drop ?? senior). Only opaque
    //             dropId and financial dropSharePercent are kept so the FE can
    //             mount the ProjectDropDistribution widget and perform the
    //             subject-check (user?.id === project?.dropId).
    // Drop role - phase 1: surfaced on the wire so FE can render drop-aware
    // hints/badges. NULL = legacy senior-project OR JUNIOR viewer.
    dropId: isJuniorViewer ? null : (project.dropId ?? null),
    // Drop role - phase 2: snapshot of the DROP user's display name.
    // Masked for JUNIOR (no identity) AND SENIOR (identity hidden, opaque dropId kept).
    dropName:
      isJuniorViewer || viewerRole === 'SENIOR' ? null : (project.drop?.displayName ?? null),
    dropSharePercent: isJuniorViewer ? null : (project.drop?.dropSharePercent ?? null),
    // task-drop-share-override-and-receiver (Part A / D6). Per-project DROP
    // share override + computed default + effective resolution (project
    // override → user default → 5). Masked for JUNIOR. `null` when there is
    // no drop on the project.
    dropSharePercentOverride: isJuniorViewer ? null : (project.dropSharePercentOverride ?? null),
    dropSharePercentDefault: isJuniorViewer
      ? null
      : drop
        ? (drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT)
        : null,
    effectiveDropSharePercent: isJuniorViewer ? null : effectiveDropSharePercent,
    effectiveDropShareSource: isJuniorViewer ? null : effectiveDropShareSource,
    // Finance masking (RBAC A01): JUNIOR members must not receive rate,
    // currency, or share breakdown — these are emitted as null so the
    // DTO itself carries no sensitive data regardless of UI rendering.
    rate: isJuniorViewer ? null : project.rate,
    currency: isJuniorViewer ? null : project.currency,
    // Per-project SENIOR share override. NULL = senior's global default.
    seniorSharePercentOverride: isJuniorViewer
      ? null
      : (project.seniorSharePercentOverride ?? null),
    // Computed default for UI hints — falls back to 26 when senior is
    // unreachable (e.g. soft-deleted) so the front-end never sees `null`.
    // Masked for JUNIOR (they should not see the default either).
    seniorSharePercentDefault: isJuniorViewer ? 0 : (project.senior?.seniorSharePercent ?? 26),
    // task-team-senior-share-override. Pre-resolved effective share for
    // the project's senior. Masked for JUNIOR.
    effectiveSeniorSharePercent: isJuniorViewer ? null : effectiveSeniorSharePercent,
    effectiveSeniorShareSource: isJuniorViewer ? null : effectiveSeniorShareSource,
    // task-648-fix-round-1 (QA-HIGH-1/QA-MED-2). Narrower allow-list than
    // `seniorSharePercentOverride`/`effectiveSeniorSharePercent` above: a
    // PENDING (unconfirmed) proposal is visible only to ADMIN and the
    // affected SENIOR themselves — task file: "ожидающее значение — только
    // ADMIN и сам синьор". `assertAccess` already guarantees a SENIOR
    // viewer reaching this point IS `project.seniorId` (a SENIOR can only
    // ever fetch their OWN project), so `viewerRole === 'SENIOR'` alone is
    // exactly "the affected senior" here — no extra id comparison needed.
    // ACCOUNTANT/HR/DROP see the ACTIVE `effectiveSeniorSharePercent`
    // (payroll / team-management need-to-know) but must not learn a change
    // is even proposed. `undefined` (list endpoint / create) collapses to
    // `null` here too — the field is simply absent on those responses.
    pendingSeniorShare: canSeePendingSeniorShare(viewerRole) ? (pendingSeniorShare ?? null) : null,
    techStack: project.techStack ?? null,
    teamSize: project.teamSize ?? null,
    benefits: project.benefits ?? null,
    // Additional fields masked for JUNIOR: payment terms and salary review
    // contain compensation context that JUNIOR must not see.
    paymentType: isJuniorViewer ? null : (project.paymentType ?? null),
    salaryReview: isJuniorViewer ? null : (project.salaryReview ?? null),
    corpTech: project.corpTech ?? null,
    // Internal notes masked for JUNIOR.
    notesGeneral: isJuniorViewer ? null : (project.notesGeneral ?? null),
    // task-project-draft-status: never masked — a DRAFT/REJECTED project is
    // only ever mapped for a viewer `assertAccess`/`findAll` already
    // confirmed is ADMIN or an invited approver, so there is nobody left to
    // mask this field FROM.
    status: project.status,
    // SR-M-5 (PR #646 fix-round 2). ADMIN ONLY — narrower than the
    // "REJECTED project" access gate above. Design spec §1/§2/§6 say
    // three times that the rejection reason is an ADMIN-only view; the
    // reason text is free-form and AUTHORED BY an invited approver
    // (senior or drop), so showing it to the OTHER invited approver would
    // let that free text identify the author regardless of the identity
    // masking this same method already does elsewhere (`dropName: null`
    // for a SENIOR viewer, RBAC rule #2) — a drop's rejection reason
    // reaching the senior it is deliberately hidden from is exactly the
    // "DTO itself carries no sensitive data" violation the JUNIOR-masking
    // comments a few lines up describe for finance fields. The reject
    // dialog's own copy ("причину увидит админ") is what makes this
    // narrowing correct, not just a policy choice, so viewer identity is
    // used as-is, not the project's `assertAccess` outcome — an invited
    // approver reading their OWN rejected project gets `null` here even
    // though they legitimately see everything else about the row.
    rejectionReason:
      project.status === 'REJECTED' && viewerRole === 'ADMIN'
        ? (rejectionReasonByProjectId.get(project.id) ?? null)
        : null,
    // SPEC-M-2. Checked against `project.seniorId`/`project.dropId` —
    // the RAW, pre-mask columns on this method's own `project` param, not
    // the (possibly-masked-to-null) `effectiveSeniorId` local above — see
    // the schema doc for why a masked id here would silently misreport.
    // Same "nobody left to mask this FROM" reasoning as `rejectionReason`:
    // only ever meaningful for a DRAFT project.
    seniorApprovalPending:
      project.status === 'DRAFT' &&
      (pendingApproverIdsByProjectId.get(project.id)?.has(project.seniorId) ?? false),
    dropApprovalPending:
      project.status === 'DRAFT' &&
      !!project.dropId &&
      (pendingApproverIdsByProjectId.get(project.id)?.has(project.dropId) ?? false),
    archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    // Members allowlist: JUNIOR sees an empty array — they know they are a
    // member via project access, but must not see the full roster (senior/HR/
    // accountant identities). SENIOR viewers have JUNIOR identity redacted
    // (RBAC rule #1) but see all other members.
    members: isJuniorViewer
      ? []
      : project.members.map((m) => {
          const isJuniorMember = (m.user?.role ?? 'JUNIOR') === 'JUNIOR'
          const redact = viewerRole === 'SENIOR' && isJuniorMember
          return {
            id: m.id,
            userId: redact ? '[redacted]' : m.userId,
            displayName: redact ? '' : (m.user?.displayName ?? ''),
            email: redact ? '' : (m.user?.email ?? ''),
            avatarUrl: redact ? null : (m.user?.avatarUrl ?? null),
            avatarDocumentId: redact ? null : (m.user?.avatarDocumentId ?? null),
            role: m.user?.role ?? 'JUNIOR',
            joinedAt: m.joinedAt.toISOString(),
            leftAt: m.leftAt ? m.leftAt.toISOString() : null,
          }
        }),
  }
}
