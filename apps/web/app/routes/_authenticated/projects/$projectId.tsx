import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Trans, useLingui } from '@lingui/react/macro'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { useState } from 'react'
import type { ProjectDto, ProjectDetailDto, ProjectMemberDto, UpdateProjectDto } from '@crm/shared'
import { IT_DOMAINS, type ItDomain } from '@crm/shared'
import { type ExchangeRates } from '@/routes/_authenticated/finance/constants'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { pendingShareAudience } from '@/components/pending-share/cancel-pending-share'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { ProjectEditFields } from './ProjectEditFields'
import { PendingShareApprovalBanner } from './ProjectApprovalBanners'
import { ProjectEffectiveTeamCard } from './ProjectTeamCards'
import { ProjectOverviewTab } from './ProjectOverviewTab'
import { ProjectTransactions } from './ProjectTransactions'
import { useProjectPermissions } from './use-project-permissions'
import { ProjectDropDialogs } from './ProjectDropDialogs'
import { ProjectMemberDialogs, type UserForAdd } from './ProjectMemberDialogs'
import { ProjectHero } from './ProjectHero'
import { Skeleton } from '@/components/ui/skeleton'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { type UnarchiveCascadeEntity } from '@/hooks/use-archive'
import { ProjectCascadeUnarchiveModal } from './ProjectUnarchive'

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
  const { t } = useLingui()
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
  const hasActiveJunior = activeMembers.some((m) => m.role === 'JUNIOR')
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
            <ProjectOverviewTab
              project={project}
              projectId={projectId}
              viewerId={user?.id}
              viewerRole={user?.role}
              canManage={canManage}
              canRemoveMembers={canRemoveMembers}
              canSeeProjectFinance={canSeeProjectFinance}
              canEditOverride={canEditOverride}
              canAccessLegend={canAccessLegend}
              canManageCredentials={canManageCredentials}
              availableToAddCount={availableToAdd.length}
              onAddMember={() => {
                setAddedMemberIds(new Set())
                setAddMemberOpen(true)
              }}
              onRemoveMember={(m) => setRemoveMemberTarget(m)}
            />
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
