import type { EffectiveTeam, SessionUser } from '@crm/shared'
import type { ProjectWithRelations } from './project-map.util'

/**
 * One active row of the senior's team (team_members JOIN users), as loaded by
 * `ProjectsService.computeEffectiveTeam`. Empty array when the senior has no
 * active team membership (or the project has no senior).
 */
export type EffectiveTeamRow = {
  id: string
  userId: string
  displayName: string
  email: string
  avatarUrl: string | null
  avatarDocumentId: string | null
  role: string
}

/**
 * Pure effective-team assembly + per-viewer masking (extracted verbatim from
 * `ProjectsService.computeEffectiveTeam`, leaf P-L3). Synchronous, no I/O —
 * the team_members query stays in the service and its result arrives as
 * `teamRows`.
 */
export function buildEffectiveTeam(
  project: ProjectWithRelations,
  viewerRole: SessionUser['role'],
  teamRows: EffectiveTeamRow[],
): EffectiveTeam {
  // task-admin-as-senior: when the project's senior is an ADMIN user,
  // non-privileged viewers (SENIOR/HR/DROP) must not receive PII (email)
  // or a navigable profile link. ADMIN/ACCOUNTANT see everything as-is.
  const isAdminSeniorProject = project.senior?.role === 'ADMIN'
  const isPrivilegedViewerForSenior = viewerRole === 'ADMIN' || viewerRole === 'ACCOUNTANT'
  const maskAdminSenior = isAdminSeniorProject && !isPrivilegedViewerForSenior

  const senior = project.senior
    ? {
        id: project.senior.id,
        displayName: project.senior.displayName,
        // Mask email when senior is ADMIN and viewer is non-privileged.
        // Empty string keeps the type contract (z.string()) while leaking nothing.
        email: maskAdminSenior ? '' : project.senior.email,
        avatarUrl: project.senior.avatarUrl ?? null,
        avatarDocumentId: project.senior.avatarDocumentId ?? null,
        // EffectiveTeam.senior.role is typed as 'SENIOR' in the shared schema
        // for backward compat. We keep this literal even for ADMIN-senior projects
        // (the role field here indicates the team slot, not the DB role).
        role: 'SENIOR' as const,
        // task-admin-as-senior: whether the viewer can navigate to the senior's
        // profile. False for non-privileged viewers of admin-projects.
        profileNavigable: !maskAdminSenior,
      }
    : null

  const hrs: EffectiveTeam['hrs'] = teamRows
    .filter((r) => r.role === 'HR')
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: r.displayName,
      email: r.email,
      avatarUrl: r.avatarUrl ?? null,
      avatarDocumentId: r.avatarDocumentId ?? null,
      role: 'HR' as const,
    }))
  const accountants: EffectiveTeam['accountants'] = teamRows
    .filter((r) => r.role === 'ACCOUNTANT')
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: r.displayName,
      email: r.email,
      avatarUrl: r.avatarUrl ?? null,
      avatarDocumentId: r.avatarDocumentId ?? null,
      role: 'ACCOUNTANT' as const,
    }))

  // RBAC rule #1: SENIOR viewers must not see JUNIOR identity in effective team.
  // When viewerRole === 'SENIOR', return empty array — the slot count is still
  // visible via mapProject.members (redacted), but no personal data is leaked.
  const juniors =
    viewerRole === 'SENIOR'
      ? []
      : project.members
          .filter((m) => m.leftAt === null && m.user?.role === 'JUNIOR')
          .map((m) => ({
            id: m.id,
            userId: m.userId,
            // Stryker disable next-line OptionalChaining: equivalent mutant — the preceding .filter() guarantees m.user?.role === 'JUNIOR', so m.user is non-null here and the optional chain / fallback is unreachable (kept verbatim from the pre-extraction code).
            displayName: m.user?.displayName ?? '',
            // Stryker disable next-line OptionalChaining: equivalent mutant — the preceding .filter() guarantees m.user?.role === 'JUNIOR', so m.user is non-null here and the optional chain / fallback is unreachable (kept verbatim from the pre-extraction code).
            email: m.user?.email ?? '',
            // Stryker disable next-line OptionalChaining: equivalent mutant — the preceding .filter() guarantees m.user?.role === 'JUNIOR', so m.user is non-null here and the optional chain / fallback is unreachable (kept verbatim from the pre-extraction code).
            avatarUrl: m.user?.avatarUrl ?? null,
            // Stryker disable next-line OptionalChaining: equivalent mutant — the preceding .filter() guarantees m.user?.role === 'JUNIOR', so m.user is non-null here and the optional chain / fallback is unreachable (kept verbatim from the pre-extraction code).
            avatarDocumentId: m.user?.avatarDocumentId ?? null,
            // Stryker disable next-line OptionalChaining,LogicalOperator: equivalent mutant — the preceding .filter() guarantees m.user?.role === 'JUNIOR', so m.user is non-null here and the optional chain / fallback is unreachable (kept verbatim from the pre-extraction code).
            role: m.user?.role ?? 'JUNIOR',
            joinedAt: m.joinedAt.toISOString(),
            leftAt: null as null,
          }))

  // Drop role - phase 2. Surface the drop user (when project.dropId set)
  // so FE can render «Дроп» row in the effective-team section without an
  // extra fetch. dropSharePercent is duplicated here for the distribution
  // breakdown widget (Phase 2 AC3).
  //
  // RBAC rule #2 (mirror of JUNIOR masking above): SENIOR must not receive
  // drop identity — the legend subject is "drop ?? senior", so the drop's
  // name/email/avatar would reveal which of the two personas is the real
  // senior. We return null for the entire effectiveTeam.drop object when the
  // viewer is SENIOR (same treatment as JUNIOR identity redaction above).
  // UI: SENIOR does not render the «Дроп» row in effective-team (PR #359).
  // Detach dialog is canManage-only (ADMIN/HR) — nothing breaks.
  const drop: EffectiveTeam['drop'] =
    viewerRole === 'SENIOR'
      ? null
      : project.drop
        ? {
            id: project.drop.id,
            displayName: project.drop.displayName,
            email: project.drop.email,
            avatarUrl: project.drop.avatarUrl ?? null,
            avatarDocumentId: project.drop.avatarDocumentId ?? null,
            role: 'DROP' as const,
            dropSharePercent: project.drop.dropSharePercent ?? 5,
          }
        : null

  return { senior, drop, hrs, accountants, juniors }
}
