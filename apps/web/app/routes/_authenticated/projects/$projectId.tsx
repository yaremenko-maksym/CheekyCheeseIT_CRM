import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Trans, useLingui } from '@lingui/react/macro'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
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
import { useState } from 'react'
import type { ProjectDto, ProjectDetailDto, ProjectMemberDto, UpdateProjectDto } from '@crm/shared'
import { IT_DOMAINS, type ItDomain } from '@crm/shared'
import { type ExchangeRates } from '@/routes/_authenticated/finance/constants'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLegendSection } from '@/components/projects/ProjectLegendSection'
import { ProjectCredentialsSection } from '@/components/projects/ProjectCredentialsSection'
import { Badge } from '@/components/ui/badge'
import { pendingShareAudience } from '@/components/pending-share/cancel-pending-share'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { EDIT_FIELD_LABEL_MESSAGES, PAYMENT_TYPE_MESSAGES } from './constants'
import { ProjectEditFields } from './ProjectEditFields'
import { InfoRow, ProjectShareInfo, ProjectDropShareInfo } from './ProjectInfoRows'
import { PendingShareApprovalBanner } from './ProjectApprovalBanners'
import { ProjectEffectiveTeamCard, MemberRow } from './ProjectTeamCards'
import { ProjectTransactions } from './ProjectTransactions'
import { useProjectPermissions } from './use-project-permissions'
import { ProjectDropDialogs } from './ProjectDropDialogs'
import { ProjectMemberDialogs, type UserForAdd } from './ProjectMemberDialogs'
import { ProjectHero } from './ProjectHero'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { type UnarchiveCascadeEntity } from '@/hooks/use-archive'
import { ProjectCascadeUnarchiveModal } from './ProjectUnarchive'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'

/**
 * Defensive coercion: if a project row has a `domain` value that is not
 * a member of the current `IT_DOMAINS` enum (legacy seed data, or
 * external/manual writes that bypass the API validator), fall back to
 * `'Other'`. This prevents the edit dialog from silently submitting the
 * stale value and hitting a 400 «Invalid option: domain» from
 * `updateProjectSchema.parse(...)` on the server.
 *
 * The DB-level fix is migration 0012, which rewrites legacy literals
 * in-place; this is the runtime safety net for any future drift.
 */
function coerceDomain(value: string | null | undefined): ItDomain {
  return (IT_DOMAINS as readonly string[]).includes(value ?? '') ? (value as ItDomain) : 'Other'
}

export const Route = createFileRoute('/_authenticated/projects/$projectId')({
  component: ProjectDetailPage,
})

function ProjectDetailPage() {
  const { t, i18n } = useLingui()
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])
  const { projectId } = Route.useParams()
  const { user } = useAuth()
  const qc = useQueryClient()

  const [editOpen, setEditOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addedMemberIds, setAddedMemberIds] = useState<Set<string>>(new Set())
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ProjectMemberDto | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'members' | 'finance'>('overview')
  // ut-28: explicit Archive button in header replaces «Действия» dropdown + «Завершить» button.
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [cascadeEntities, setCascadeEntities] = useState<UnarchiveCascadeEntity[] | null>(null)
  // Drop attach/detach dialogs (feature/drop-attach-existing-project)
  const [dropPickerOpen, setDropPickerOpen] = useState(false)
  const [detachDropConfirmOpen, setDetachDropConfirmOpen] = useState(false)

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  const { data: project, isLoading } = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.get<ProjectDetailDto>(`/projects/${projectId}`).then((r) => r.data),
    enabled: !!user,
  })

  // RBAC/visibility flags (see use-project-permissions.ts). Called before the
  // `denied` early-return below, like every other hook on this page.
  const {
    isAdmin,
    canManage,
    canOpenEdit,
    canRemoveMembers,
    canSeeProjectFinance,
    canEditOverride,
    canAccessLegend,
    canManageCredentials,
  } = useProjectPermissions(user, project)

  const editForm = useForm({
    defaultValues: {
      name: project?.name ?? '',
      companyName: project?.companyName ?? '',
      domain: coerceDomain(project?.domain),
      logoDocumentId: project?.logoDocumentId ?? (null as string | null),
      logoExternalUrl: project?.logoExternalUrl ?? (null as string | null),
      rate: (project?.rate ?? '') as unknown as number,
      currency: (project?.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
      seniorSharePercentOverride: project?.seniorSharePercentOverride ?? null,
      // task-drop-share-override-and-receiver (Surface A). Same null-default
      // convention as seniorSharePercentOverride above.
      dropSharePercentOverride: project?.dropSharePercentOverride ?? null,
      techStack: project?.techStack ?? '',
      teamSize: project?.teamSize ?? '',
      benefits: project?.benefits ?? '',
      // task-drop-share-override-and-receiver (Surface C). paymentType is now a
      // 3-value enum Select — default to the backend's own default ('FOP') so a
      // legacy/never-set project still shows a valid, disabled-for-non-editors
      // selection instead of an empty Select.
      paymentType: project?.paymentType ?? 'FOP',
      salaryReview: project?.salaryReview ?? '',
      corpTech: project?.corpTech ?? '',
      notesGeneral: project?.notesGeneral ?? '',
    },
    onSubmit: async ({ value }) => {
      // Round-3 (PR #39 round 2): ShareSlider всегда виден (для не-HR), нет
      // toggle/Сбросить. Implicit reset: если слайдер === default — фронт всё
      // равно шлёт значение, а backend пишет null. Поэтому передаём поле
      // когда оно НА САМОМ ДЕЛЕ изменилось vs. серверный snapshot AND
      // пользователь может его редактировать. HR/SENIOR/JUNIOR ничего не
      // отправляют (canEditOverride=false).
      const overrideChanged =
        canEditOverride &&
        (value.seniorSharePercentOverride ?? null) !== (project?.seniorSharePercentOverride ?? null)
      // task-drop-share-override-and-receiver (Surface A). Same "only send when
      // actually changed AND caller is allowed to edit" convention as senior.
      const dropOverrideChanged =
        canEditOverride &&
        (value.dropSharePercentOverride ?? null) !== (project?.dropSharePercentOverride ?? null)
      editMutation.mutate({
        name: value.name.trim() || undefined,
        companyName: value.companyName.trim() || undefined,
        domain: value.domain || undefined,
        logoDocumentId: value.logoDocumentId ?? null,
        logoExternalUrl: value.logoExternalUrl ?? null,
        rate: Number(value.rate) || undefined,
        currency: value.currency || undefined,
        ...(overrideChanged
          ? { seniorSharePercentOverride: value.seniorSharePercentOverride ?? null }
          : {}),
        ...(dropOverrideChanged
          ? { dropSharePercentOverride: value.dropSharePercentOverride ?? null }
          : {}),
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        // task-drop-share-override-and-receiver (Surface C). Field-scoped RBAC —
        // backend throws ForbiddenException for non-ADMIN/ACCOUNTANT if this key
        // is present AT ALL (even unchanged/null), mirroring
        // seniorSharePercentOverride/dropSharePercentOverride above. Only ADMIN/
        // ACCOUNTANT (canEditOverride) ever include it; HR's disabled Select
        // never reaches the wire.
        ...(canEditOverride ? { paymentType: value.paymentType } : {}),
        salaryReview: value.salaryReview.trim() || null,
        corpTech: value.corpTech.trim() || null,
        notesGeneral: value.notesGeneral.trim() || null,
      })
    },
  })

  const editMutation = useMutation({
    mutationFn: (data: UpdateProjectDto) =>
      api.patch<ProjectDto>(`/projects/${projectId}`, data).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      setEditOpen(false)
    },
  })

  // Round 5: the CLOSED business contract state is gone — lifecycle is
  // binary (ACTIVE ↔ ARCHIVED) and the only way back to ACTIVE is via the
  // Archive unarchive flow (handled below). The legacy reopen mutation is
  // therefore removed.
  // Archive is triggered via the explicit Archive button → ArchiveConfirmDialog.

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserForAdd[]>('/users').then((r) => r.data),
    enabled: canManage,
  })

  function openEdit() {
    if (!project) return
    editForm.setFieldValue('name', project.name)
    editForm.setFieldValue('companyName', project.companyName)
    editForm.setFieldValue('domain', coerceDomain(project.domain))
    editForm.setFieldValue('logoDocumentId', project.logoDocumentId ?? null)
    editForm.setFieldValue('logoExternalUrl', project.logoExternalUrl ?? null)
    editForm.setFieldValue('rate', project.rate as unknown as number)
    editForm.setFieldValue('currency', project.currency as 'USDT' | 'USD' | 'EUR' | 'UAH')
    editForm.setFieldValue('seniorSharePercentOverride', project.seniorSharePercentOverride ?? null)
    editForm.setFieldValue('dropSharePercentOverride', project.dropSharePercentOverride ?? null)
    editForm.setFieldValue('techStack', project.techStack ?? '')
    editForm.setFieldValue('teamSize', project.teamSize ?? '')
    editForm.setFieldValue('benefits', project.benefits ?? '')
    editForm.setFieldValue('paymentType', project.paymentType ?? 'FOP')
    editForm.setFieldValue('salaryReview', project.salaryReview ?? '')
    editForm.setFieldValue('corpTech', project.corpTech ?? '')
    editForm.setFieldValue('notesGeneral', project.notesGeneral ?? '')
    setEditOpen(true)
  }

  // Rules of Hooks: moved here — after every hook above — instead of
  // between `useAuth` and the ~14 hooks that follow it (useState/useQuery/
  // useForm/useMutation). `denied` flips false→true mid-mount once
  // `useAuth`'s `isLoading` resolves to a disallowed role; a guard sitting
  // in the middle of the hook list made that transition change the hook
  // count between renders ("Rendered fewer hooks than expected"). This
  // route is also gated at the layout level (see use-role-guard.ts), so
  // this remains defense-in-depth, not the only guard.
  if (denied) return null

  if (isLoading || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    )
  }

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
  const hasActiveJunior = activeJuniors.length > 0
  const availableToAdd = (allUsers ?? []).filter((u) => {
    if (u.role === 'ADMIN' || u.role === 'SENIOR') return false
    if (u.role === 'DROP') return false // DROP goes through PATCH /projects/:id, not POST /members
    if (activeMembers.some((m) => m.userId === u.id)) return false
    if (u.role === 'JUNIOR') {
      if (hasActiveJunior) return false
      if (u.hasActiveProject) return false
    }
    return true
  })
  // DROP candidates for the attach-drop picker (only when no drop is assigned)
  const dropCandidates =
    project.dropId == null ? (allUsers ?? []).filter((u) => u.role === 'DROP') : []

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto pb-6">
      <div className="space-y-5">
        <ProjectHero
          project={project}
          viewerId={user?.id}
          viewerRole={user?.role}
          rates={rates}
          isAdmin={isAdmin}
          canOpenEdit={canOpenEdit}
          onEdit={openEdit}
          onArchive={() => setArchiveDialogOpen(true)}
          onCascadeRequired={(entities) => setCascadeEntities(entities)}
        />
        {/* task-pending-share (position 5): actionable banner, ONLY for the
            viewer the proposal is waiting on — everyone else sees the
            read-only badge via ProjectShareInfo instead. */}
        {/* task-648-fix-round-3 (COPY-H-8): the same reader question the
            profile half now asks, through the same helper — this half had it
            right, the other did not, and two spellings of one rule drift. */}
        {pendingShareAudience(user?.id, project.pendingSeniorShare) === 'approver' &&
          project.pendingSeniorShare && (
            <div className="px-4 sm:px-6">
              <PendingShareApprovalBanner
                projectId={project.id}
                currentPercent={
                  project.seniorSharePercentOverride ?? project.seniorSharePercentDefault ?? 26
                }
                pending={project.pendingSeniorShare}
              />
            </div>
          )}
        {/* ── Post-hero content — horizontal padding (px-0 removed from outer wrapper, Вариант Б) ── */}
        <div className="space-y-5 px-4 sm:px-6">
          {/* ut-29 + ut-33: project detail tabs — unified through SegmentedToggle
          variant="tabs" (same yellow page-level styling as projects list).
          ut-fix-round2: «Финансы» табу видят только не-HR (ADMIN/ACCOUNTANT/
          SENIOR). HR на ?tab=finance — fallback на «Обзор». */}
          {(() => {
            type ProjectTab = 'overview' | 'members' | 'finance'
            const tabOptions: ReadonlyArray<SegmentedToggleOption<ProjectTab>> = [
              { value: 'overview', label: t`Огляд`, testId: 'tab-overview' },
              { value: 'members', label: t`Склад`, testId: 'tab-members' },
              ...(canSeeProjectFinance
                ? [{ value: 'finance', label: t`Фінанси`, testId: 'tab-finance' } as const]
                : []),
            ]
            // Fallback: если HR оказался на «finance» табе — переключить на «overview».
            const safeActiveTab: ProjectTab =
              activeTab === 'finance' && !canSeeProjectFinance
                ? 'overview'
                : (activeTab as ProjectTab)
            return (
              <SegmentedToggle<ProjectTab>
                value={safeActiveTab}
                onChange={(v) => setActiveTab(v)}
                options={tabOptions}
                ariaLabel={t`Розділи проєкту`}
                variant="tabs"
                size="sm"
                layoutId={`project-detail-tabs-${projectId}`}
                className="w-fit"
                testId={`project-detail-tabs-${projectId}`}
              />
            )
          })()}

          {activeTab === 'members' && (
            <ProjectEffectiveTeamCard
              project={project}
              {...(user?.role !== undefined ? { viewerRole: user.role } : {})}
              canManageDrop={canManage && !project.archivedAt}
              dropCandidates={dropCandidates}
              onAttachDrop={() => setDropPickerOpen(true)}
              onDetachDrop={() => setDetachDropConfirmOpen(true)}
            />
          )}

          {activeTab === 'overview' && (
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
                  {user?.role !== 'JUNIOR' && (
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
                        viewerId={user?.id}
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
                              disabled={availableToAdd.length === 0}
                              onClick={() => {
                                setAddedMemberIds(new Set())
                                setAddMemberOpen(true)
                              }}
                            >
                              <UserPlus className="h-3 w-3" />
                              <Trans>Додати до складу</Trans>
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {availableToAdd.length === 0 && (
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
                        viewerRole={user?.role ?? 'JUNIOR'}
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
                    (user?.role === 'ADMIN' ||
                      user?.role === 'HR' ||
                      user?.role === 'ACCOUNTANT') && (
                      <div className="pb-3" data-testid="team-card-drop-row">
                        <ProfileNameLink
                          userId={dropMember.id}
                          viewerRole={user?.role ?? 'JUNIOR'}
                          className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
                        >
                          <Avatar className="h-8 w-8 shrink-0">
                            {dropMember.avatarUrl && (
                              <AvatarImage
                                src={dropMember.avatarUrl}
                                alt={dropMember.displayName}
                              />
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
                            onRemove={() => setRemoveMemberTarget(m)}
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
                            onRemove={() => setRemoveMemberTarget(m)}
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
                            onRemove={() => setRemoveMemberTarget(m)}
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
          )}

          {/* Legend section — subject (seniorId/dropId) excluded per RBAC contract */}
          {activeTab === 'overview' && (
            <ProjectLegendSection projectId={projectId} canAccess={canAccessLegend} />
          )}

          {/* Credentials section — ADMIN/HR managers (self-hides on 403) */}
          {activeTab === 'overview' && canManageCredentials && (
            <ProjectCredentialsSection projectId={projectId} canEdit />
          )}

          {activeTab === 'finance' && canSeeProjectFinance && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.16 }}
            >
              <ProjectTransactions projectId={projectId} project={project} />
            </motion.div>
          )}
        </div>{' '}
        {/* end post-hero px-4 sm:px-6 */}
        {/* ── Edit / Add member dialog ── */}
        <Dialog open={editOpen} onOpenChange={(v) => !v && setEditOpen(false)}>
          <CrmDialogContent maxWidth="max-w-lg">
            <CrmDialogHeader>
              <DialogTitle>
                <Trans>Редагувати — {project.companyName}</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>
                  Редагування параметрів проєкту: ставка, валюта, домен і налаштування частки.
                </Trans>
              </DialogDescription>
            </CrmDialogHeader>

            <CrmDialogBody>
              <div className="space-y-5">
                {canOpenEdit && editOpen && (
                  <ProjectEditFields
                    form={editForm}
                    mode="info"
                    canEditOverride={canEditOverride}
                    defaultSharePercent={project.seniorSharePercentDefault}
                    defaultDropSharePercent={project.dropSharePercentDefault ?? 5}
                    dropId={project.dropId}
                    viewerRole={user?.role}
                    projectId={projectId}
                    pendingShare={project.pendingSeniorShare}
                  />
                )}
              </div>
            </CrmDialogBody>
            {canOpenEdit && (
              <CrmDialogFooter>
                <Button variant="outline" onClick={() => setEditOpen(false)}>
                  <Trans>Скасувати</Trans>
                </Button>
                <Button
                  onClick={() => void editForm.handleSubmit()}
                  disabled={editMutation.isPending}
                >
                  {editMutation.isPending ? t`Збереження…` : t`Зберегти`}
                </Button>
              </CrmDialogFooter>
            )}
          </CrmDialogContent>
        </Dialog>
        <ProjectMemberDialogs
          projectId={projectId}
          removeMemberTarget={removeMemberTarget}
          onCloseRemoveMember={() => setRemoveMemberTarget(null)}
          addMemberOpen={addMemberOpen}
          onCloseAddMember={() => setAddMemberOpen(false)}
          availableToAdd={availableToAdd}
          addedMemberIds={addedMemberIds}
          onMemberAdded={(userId) => setAddedMemberIds((prev) => new Set(prev).add(userId))}
        />
        <ProjectDropDialogs
          projectId={projectId}
          currentDropDisplayName={project.effectiveTeam?.drop?.displayName}
          dropCandidates={dropCandidates}
          dropPickerOpen={dropPickerOpen}
          onCloseDropPicker={() => setDropPickerOpen(false)}
          detachDropConfirmOpen={detachDropConfirmOpen}
          onCloseDetachDropConfirm={() => setDetachDropConfirmOpen(false)}
        />
        {/* ut-28: Archive confirm dialog — triggered by explicit Archive button. */}
        {archiveDialogOpen && (
          <ArchiveConfirmDialog
            entityType="project"
            entityId={project.id}
            entityName={project.name}
            onClose={() => setArchiveDialogOpen(false)}
          />
        )}
        {/* Cascade unarchive modal — paired senior/team restore. */}
        {cascadeEntities && (
          <ProjectCascadeUnarchiveModal
            projectId={project.id}
            projectName={project.name}
            entities={cascadeEntities}
            onClose={() => setCascadeEntities(null)}
          />
        )}
      </div>
    </div>
  )
}
