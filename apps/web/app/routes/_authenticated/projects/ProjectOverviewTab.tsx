import { motion } from 'framer-motion'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  Briefcase,
  Building2,
  CreditCard,
  Laptop,
  Percent,
  RefreshCw,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react'
import type { ProjectDetailDto, ProjectMemberDto, Role } from '@crm/shared'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLegendSection } from '@/components/projects/ProjectLegendSection'
import { ProjectCredentialsSection } from '@/components/projects/ProjectCredentialsSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { EDIT_FIELD_LABEL_MESSAGES, PAYMENT_TYPE_MESSAGES } from './constants'
import { InfoRow, ProjectShareInfo, ProjectDropShareInfo } from './ProjectInfoRows'
import { MemberRow } from './ProjectTeamCards'

export interface ProjectOverviewTabProps {
  project: ProjectDetailDto
  projectId: string
  /** `viewerId` of the viewer, forwarded to `ProjectShareInfo`. */
  viewerId: string | undefined
  /** `viewerRole` of the viewer, gates the payment-type and drop rows and the profile links. */
  viewerRole: Role | undefined
  /** RBAC flags computed by the page (`useProjectPermissions`), passed through unchanged. */
  canManage: boolean
  canRemoveMembers: boolean
  canSeeProjectFinance: boolean
  canEditOverride: boolean
  canAccessLegend: boolean
  canManageCredentials: boolean
  /** Number of users the page found addable; 0 disables the add-member button. */
  availableToAddCount: number
  onAddMember: () => void
  onRemoveMember: (member: ProjectMemberDto) => void
}

/**
 * Overview tab of the project detail page (details card, team card, legend and credentials
 * sections), moved verbatim from `$projectId.tsx`. The page keeps owning dialog state and the
 * permission computation; it passes flags and callbacks down. Renders a fragment so the DOM
 * stays identical to the inline version (the three blocks were siblings in the page).
 */
export function ProjectOverviewTab({
  project,
  projectId,
  viewerId,
  viewerRole,
  canManage,
  canRemoveMembers,
  canSeeProjectFinance,
  canEditOverride,
  canAccessLegend,
  canManageCredentials,
  availableToAddCount,
  onAddMember,
  onRemoveMember,
}: ProjectOverviewTabProps) {
  const { t, i18n } = useLingui()
  const activeMembers = project.members.filter((m) => m.leftAt === null)
  const pastMembers = project.members.filter((m) => m.leftAt !== null)
  // seniorId/seniorName are null for JUNIOR viewers (identity masking by backend allowlist).
  // task-admin-as-senior: for non-privileged viewers of admin-projects, seniorId is null
  // but seniorName is still set (displayName is safe to show). We show the row without a link
  // by setting userId=null (ProfileNameLink nonNavigable prop handles the plain-text render).
  const senior =
    project.seniorId != null || project.seniorName != null
      ? {
          // null when backend masks it (admin-project + non-privileged viewer)
          userId: project.seniorId ?? null,
          displayName: project.seniorName ?? '',
          role: 'SENIOR',
          avatarUrl: null as string | null,
          avatarDocumentId: null as string | null,
        }
      : null
  // Drop member for display in Team card (Обзор tab). API masks drop=null for
  // SENIOR/JUNIOR viewers (PR #363), so the UI condition simply checks for null.
  const dropMember = project.effectiveTeam?.drop ?? null
  const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
  const activeHRs = activeMembers.filter((m) => m.role === 'HR')
  const activeAccountants = activeMembers.filter((m) => m.role === 'ACCOUNTANT')

  return (
    <>
      <motion.div
        className="grid grid-cols-1 gap-4 lg:grid-cols-2"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.08 }}
      >
        {/* Details card */}
        <Card className="min-w-0 border-border/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {t`Деталі проєкту`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 divide-y divide-border/40">
            <InfoRow
              icon={<Briefcase className="h-3.5 w-3.5" />}
              label={i18n._(EDIT_FIELD_LABEL_MESSAGES.techStack)}
            >
              {project.techStack ? (
                <span className="font-medium">{project.techStack}</span>
              ) : (
                <span className="text-muted-foreground/40 italic">—</span>
              )}
            </InfoRow>
            <InfoRow
              icon={<Users className="h-3.5 w-3.5" />}
              label={i18n._(EDIT_FIELD_LABEL_MESSAGES.teamSize)}
            >
              {project.teamSize ? (
                <span className="font-medium">{project.teamSize}</span>
              ) : (
                <span className="text-muted-foreground/40 italic">—</span>
              )}
            </InfoRow>
            <InfoRow
              icon={<Building2 className="h-3.5 w-3.5" />}
              label={i18n._(EDIT_FIELD_LABEL_MESSAGES.benefits)}
            >
              {project.benefits ? (
                <span className="font-medium">{project.benefits}</span>
              ) : (
                <span className="text-muted-foreground/40 italic">—</span>
              )}
            </InfoRow>
            {/* task-drop-share-override-and-receiver (Surface C, Q5). Backend
                  masks paymentType to `null` for JUNIOR — the row is ALSO
                  explicitly hidden client-side (defense-in-depth per the design
                  spec, not relying solely on the null value). HR still sees it
                  (read value), only JUNIOR loses the row entirely. */}
            {viewerRole !== 'JUNIOR' && (
              <InfoRow
                icon={<CreditCard className="h-3.5 w-3.5" />}
                label={i18n._(EDIT_FIELD_LABEL_MESSAGES.paymentType)}
              >
                {project.paymentType ? (
                  <span className="font-medium">
                    {i18n._(PAYMENT_TYPE_MESSAGES[project.paymentType])}
                  </span>
                ) : (
                  <span className="text-muted-foreground/40 italic">—</span>
                )}
              </InfoRow>
            )}
            <InfoRow
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              label={i18n._(EDIT_FIELD_LABEL_MESSAGES.salaryReview)}
            >
              {project.salaryReview ? (
                <span className="font-medium">{project.salaryReview}</span>
              ) : (
                <span className="text-muted-foreground/40 italic">—</span>
              )}
            </InfoRow>
            <InfoRow
              icon={<Laptop className="h-3.5 w-3.5" />}
              label={i18n._(EDIT_FIELD_LABEL_MESSAGES.corpTech)}
            >
              {project.corpTech ? (
                <span className="font-medium">{project.corpTech}</span>
              ) : (
                <span className="text-muted-foreground/40 italic">—</span>
              )}
            </InfoRow>
            <div className="flex items-start gap-2 py-3 text-sm">
              <StickyNote className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground mb-1">{t`Загальні нотатки`}</p>
                {project.notesGeneral ? (
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">
                    {project.notesGeneral}
                  </p>
                ) : (
                  <span className="text-muted-foreground/40 italic">—</span>
                )}
              </div>
            </div>
            {/* Per-project SENIOR share — read-only view. Renders the same
                ProjectShareInfo widget used in the Финансы по проекту section
                below so the two stay in sync. RBAC enforcement lives at the
                API layer; UI ut-fix-round2 also hides this row for HR. */}
            {canSeeProjectFinance && (
              <InfoRow
                icon={<Percent className="h-3.5 w-3.5" />}
                label={t`Частка сеньйора`}
                // task-648-fix-round-3 (COPY-H-7): only when a proposal
                // is live does this row carry a named button; only then
                // does it need the full width. Without a proposal it is
                // «26% (по умолчанию)» and the ordinary row is right.
                stackOnMobile={!!project.pendingSeniorShare}
              >
                <ProjectShareInfo
                  project={project}
                  canCancelPendingShare={canEditOverride}
                  viewerId={viewerId}
                />
              </InfoRow>
            )}
            {/* task-drop-share-override-and-receiver (Surface A). Same
                  read-only pattern as «Доля синьора» above, drop-projects only. */}
            {canSeeProjectFinance && project.dropId != null && (
              <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label={t`Частка дропа`}>
                <ProjectDropShareInfo project={project} />
              </InfoRow>
            )}
          </CardContent>
        </Card>

        {/* Team card */}
        <Card className="border-border/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t`Склад`}
              </CardTitle>
              {canManage && !project.archivedAt && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                        disabled={availableToAddCount === 0}
                        onClick={onAddMember}
                      >
                        <UserPlus className="h-3 w-3" />
                        <Trans>Додати до складу</Trans>
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {availableToAddCount === 0 && (
                    <TooltipContent>
                      <Trans>Немає кого додати</Trans>
                    </TooltipContent>
                  )}
                </Tooltip>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-1 divide-y divide-border/30">
            {/* Senior row — hidden for JUNIOR viewers (seniorId masked by backend allowlist).
                  task-admin-as-senior: when seniorId is null but seniorName is set, the senior
                  is an ADMIN and this viewer lacks profile access — render name without link. */}
            {senior != null && (
              <div className="pb-3">
                {/* senior.userId is null when backend masks it (admin-project + non-privileged viewer).
                      In that case we render a non-navigable span via ProfileNameLink nonNavigable prop. */}
                {/* LOW fix: when nonNavigable=true (seniorId=null → admin-project without access),
                      userId is not consumed by ProfileNameLink (renders span). Pass it only when
                      navigation is possible (exactOptionalPropertyTypes: conditional spread). */}
                <ProfileNameLink
                  {...(senior.userId != null ? { userId: senior.userId } : {})}
                  viewerRole={viewerRole ?? 'JUNIOR'}
                  nonNavigable={senior.userId == null}
                  className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
                >
                  <Avatar className="h-8 w-8 shrink-0 ring-2 ring-[#6366f1]/30">
                    <AvatarFallback className="text-[11px] font-semibold">
                      {getInitialsBySpaceSplit(senior.displayName)}
                    </AvatarFallback>
                  </Avatar>
                  {/* MED1: no hover:underline — element may be non-navigable (nonNavigable=true)
                        when viewer cannot access the admin's profile. A non-clickable span
                        must not show pointer/underline hover styles. */}
                  <span className="text-sm font-medium truncate text-primary">
                    {senior.displayName}
                  </span>
                  <Badge variant="senior" className="shrink-0 text-[9px] ml-auto">
                    {i18n._(ROLE_LABEL_MESSAGES.SENIOR)}
                  </Badge>
                </ProfileNameLink>
              </div>
            )}

            {/* Drop row — display-only; after senior, before HR.
                  RBAC: ADMIN/HR/ACCOUNTANT only (API masks drop=null for SENIOR/JUNIOR, PR #363).
                  No manage buttons here — drop management is on the «Состав» tab. */}
            {dropMember != null &&
              (viewerRole === 'ADMIN' || viewerRole === 'HR' || viewerRole === 'ACCOUNTANT') && (
                <div className="pb-3" data-testid="team-card-drop-row">
                  <ProfileNameLink
                    userId={dropMember.id}
                    viewerRole={viewerRole ?? 'JUNIOR'}
                    className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
                  >
                    <Avatar className="h-8 w-8 shrink-0">
                      {dropMember.avatarUrl && (
                        <AvatarImage src={dropMember.avatarUrl} alt={dropMember.displayName} />
                      )}
                      <AvatarFallback className="text-[11px] font-semibold">
                        {getInitialsBySpaceSplit(dropMember.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium truncate text-primary">
                      {dropMember.displayName}
                    </span>
                    <Badge
                      variant="outline"
                      className="border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px] ml-auto"
                    >
                      {i18n._(ROLE_LABEL_MESSAGES.DROP)}
                    </Badge>
                  </ProfileNameLink>
                </div>
              )}

            {/* HR */}
            <div className="pt-3 pb-3">
              {activeHRs.length === 0 ? (
                <p className="text-xs text-muted-foreground/50 italic">{t`Не призначено`}</p>
              ) : (
                <div className="space-y-1.5">
                  {activeHRs.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      canManage={canRemoveMembers}
                      onRemove={() => onRemoveMember(m)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Accountants */}
            <div className="pt-3 pb-3">
              {activeAccountants.length === 0 ? (
                <p className="text-xs text-muted-foreground/50 italic">{t`Не призначено`}</p>
              ) : (
                <div className="space-y-1.5">
                  {activeAccountants.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      canManage={canRemoveMembers}
                      onRemove={() => onRemoveMember(m)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Junior */}
            <div className="pt-3">
              {activeJuniors.length === 0 ? (
                <p className="text-xs text-amber-500/80 font-medium">{t`Джуніор не призначений`}</p>
              ) : (
                <div className="space-y-1.5">
                  {activeJuniors.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      canManage={canRemoveMembers}
                      onRemove={() => onRemoveMember(m)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Past members */}
            {pastMembers.length > 0 && (
              <div className="pt-3">
                <p className="text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider mb-2">
                  {t`Залишили проєкт`}
                </p>
                <div className="space-y-1.5 opacity-50">
                  {pastMembers.map((m) => (
                    <MemberRow key={m.id} member={m} canManage={false} onRemove={() => {}} />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
      {/* Legend section — subject (seniorId/dropId) excluded per RBAC contract */}
      <ProjectLegendSection projectId={projectId} canAccess={canAccessLegend} />

      {/* Credentials section — ADMIN/HR managers (self-hides on 403) */}
      {canManageCredentials && <ProjectCredentialsSection projectId={projectId} canEdit />}
    </>
  )
}
