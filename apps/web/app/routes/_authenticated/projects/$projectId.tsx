import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Trans, useLingui } from '@lingui/react/macro'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import {
  Archive,
  ArrowLeft,
  Briefcase,
  Building2,
  Calendar,
  CreditCard,
  DollarSign,
  Globe,
  Laptop,
  Pencil,
  Percent,
  RefreshCw,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import type {
  ProjectDto,
  ProjectDetailDto,
  ProjectMemberDto,
  UpdateProjectDto,
  Role,
} from '@crm/shared'
import { IT_DOMAINS, type ItDomain, formatDate, formatNumber } from '@crm/shared'
import { type ExchangeRates, fmtUsd } from '@/routes/_authenticated/finance/constants'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLegendSection } from '@/components/projects/ProjectLegendSection'
import { ProjectStatusBadge } from '@/components/projects/ProjectStatusBadge'
import { ProjectCredentialsSection } from '@/components/projects/ProjectCredentialsSection'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
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
import { EDIT_FIELD_LABEL_MESSAGES, PAYMENT_TYPE_MESSAGES, ROLE_VARIANT } from './constants'
import { ProjectEditFields } from './ProjectEditFields'
import { InfoRow, ProjectShareInfo, ProjectDropShareInfo } from './ProjectInfoRows'
import { PendingShareApprovalBanner, ProjectHeaderApprovalNote } from './ProjectApprovalBanners'
import { ProjectEffectiveTeamCard, MemberRow } from './ProjectTeamCards'
import { ProjectTransactions } from './ProjectTransactions'
import { useProjectPermissions } from './use-project-permissions'
import { useProjectDropMutations } from './use-project-drop-mutations'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { type UnarchiveCascadeEntity } from '@/hooks/use-archive'
import { ProjectUnarchiveHeaderButton, ProjectCascadeUnarchiveModal } from './ProjectUnarchive'
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
  const locale = useLocale()
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])
  const { projectId } = Route.useParams()
  const { user } = useAuth()
  const qc = useQueryClient()

  const [editOpen, setEditOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addedMemberIds, setAddedMemberIds] = useState<Set<string>>(new Set())
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(new Set())
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

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      setRemoveMemberTarget(null)
    },
  })

  type UserForAdd = {
    id: string
    displayName: string
    email: string
    role: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    hasActiveProject: boolean
  }

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserForAdd[]>('/users').then((r) => r.data),
    enabled: canManage,
  })

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/projects/${projectId}/members`, { userId }),
    onSuccess: (_, userId) => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      setAddedMemberIds((prev) => new Set(prev).add(userId))
      setPendingMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    },
    onError: (_, userId) => {
      setPendingMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    },
  })

  const { dropMutation } = useProjectDropMutations(projectId, () => {
    setDropPickerOpen(false)
    setDetachDropConfirmOpen(false)
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
        {/* ── Hero banner ── */}
        <motion.div
          className="relative overflow-hidden rounded-2xl border border-border/40 bg-card"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {/* Ambient glow blob */}
          <div
            className="pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full opacity-[0.07] blur-3xl"
            style={{ background: '#f5c542' }}
          />
          {/* UX-H-1 / COPY-M-5 (fix-round 3): the row flip used to happen at
            `sm:` (640px) — on a 768px tablet the title column had only
            ~95px to work with, wrapping the "Ждёт решения" pill's own text
            and breaking a long rejection reason into 7-20 narrow lines.
            `scrollWidth <= clientWidth` never caught it because nothing
            actually overflowed the viewport. Pushed to `lg:` (1024px) so
            640-1023 stacks the header like 320 does — full-width badge row,
            buttons on their own line below the title. */}
          <div className="relative flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
            {/* Left: back + logo + title */}
            <div className="flex items-center gap-4 min-w-0">
              <Link to="/projects" className="shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div className="relative shrink-0">
                <div
                  className="absolute inset-0 rounded-xl opacity-30 blur-md"
                  style={{ background: '#f5c542' }}
                />
                <ProjectLogo
                  documentId={project.logoDocumentId}
                  externalUrl={project.logoExternalUrl}
                  companyName={project.companyName}
                  fallback={getInitialsBySpaceSplit(project.companyName)}
                  avatarClassName="relative h-14 w-14 rounded-xl shadow-lg"
                />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight truncate leading-tight">
                  {project.companyName}
                </h1>
                <p className="text-sm text-muted-foreground truncate mt-0.5">{project.name}</p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {/* task-project-page-status-badge (backlog 188). Single
                    source of truth for the label — was `!archivedAt`-only
                    before, which called a DRAFT/REJECTED project
                    "Активный" (see ProjectStatusBadge.tsx doc). */}
                  <ProjectStatusBadge project={project} />
                  {/* task-projects-followups-web (backlog 201, fix-round 2,
                    COPY-M-1): mounted immediately after the status badge, not
                    below the whole badge row — "от <синьор>" / the quoted
                    rejection reason is a grammatical continuation of "Ждёт
                    решения" / "Отклонён", not a standalone sentence, and
                    reads as attached to the wrong neighbor (the domain badge)
                    once the drop/domain badges sit between it and the status
                    badge it explains. */}
                  <ProjectHeaderApprovalNote project={project} viewerId={user?.id} />
                  {/* Drop role - phase 2. Distinct blue/info badge for drop-
                    projects so it's obvious at a glance that money flows
                    through a DROP user. Hidden for regular senior-projects.
                    RBAC: only ADMIN/HR/ACCOUNTANT see this badge — JUNIOR
                    must not know the identity behind the legend is a DROP. */}
                  {project.dropId &&
                    (user?.role === 'ADMIN' ||
                      user?.role === 'HR' ||
                      user?.role === 'ACCOUNTANT') && (
                      <Badge
                        variant="outline"
                        className="border-blue-500/30 bg-blue-500/10 text-blue-400 text-xs"
                        data-testid="project-drop-badge"
                      >
                        <Trans>Проєкт з дропом</Trans>
                      </Badge>
                    )}
                  <Badge variant="outline" className="text-xs">
                    {project.domain}
                  </Badge>
                </div>
              </div>
            </div>

            {/* ut-28: Explicit Edit + Archive buttons (replaces «Действия» dropdown
              and former «Завершить» button). Visible to ADMIN/HR (full edit)
              and ACCOUNTANT (override-only edit). */}
            <div className="flex items-center gap-2 shrink-0 self-start lg:self-center">
              {canOpenEdit && !project.archivedAt && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openEdit}
                  className="gap-1.5"
                  data-testid="project-edit-button"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <Trans>Редагувати</Trans>
                </Button>
              )}
              {isAdmin && !project.archivedAt && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setArchiveDialogOpen(true)}
                  className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  data-testid="project-archive-button"
                >
                  <Archive className="h-3.5 w-3.5" />
                  <Trans>Архівувати</Trans>
                </Button>
              )}
              {isAdmin && project.archivedAt && (
                <ProjectUnarchiveHeaderButton
                  projectId={project.id}
                  projectName={project.name}
                  onCascadeRequired={(entities) => setCascadeEntities(entities)}
                />
              )}
            </div>
          </div>

          {/* Stat chips row */}
          <div className="flex gap-3 px-6 pb-5 flex-wrap">
            {/* rate / currency are null for JUNIOR (finance masking, RBAC A01).
              Only render the stat chip when finance data is available. */}
            {project.rate != null && project.currency != null && (
              <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
                <DollarSign className="h-4 w-4 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    {t`Ставка`}
                  </p>
                  <p className="text-sm font-semibold tabular-nums">
                    {formatNumber(project.rate, locale)} {project.currency}
                  </p>
                  {rates && project.currency !== 'USD' && project.currency !== 'USDT' && (
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      ≈ {fmtUsd(project.rate, project.currency, rates)}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
              <Calendar className="h-4 w-4 text-blue-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t`Старт`}</p>
                <p className="text-sm font-semibold">
                  {formatDate(project.startDate, locale, 'short')}
                </p>
              </div>
            </div>
            {project.archivedAt && (
              <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
                <Calendar className="h-4 w-4 text-amber-400 shrink-0" />
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    {t`В архіві з`}
                  </p>
                  <p className="text-sm font-semibold">
                    {formatDate(project.archivedAt, locale, 'short')}
                  </p>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
              <Globe className="h-4 w-4 text-violet-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t`Домен`}</p>
                <p className="text-sm font-semibold">{project.domain}</p>
              </div>
            </div>
          </div>
        </motion.div>
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
        {/* ── Remove member confirm ── */}
        <Dialog open={!!removeMemberTarget} onOpenChange={(v) => !v && setRemoveMemberTarget(null)}>
          <CrmDialogContent maxWidth="sm:max-w-sm">
            <CrmDialogHeader>
              <DialogTitle>
                <Trans>Прибрати зі складу?</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Підтвердження видалення учасника зі складу проєкту.</Trans>
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody className="pb-2">
              <p className="text-sm text-muted-foreground">
                <Trans>
                  <span className="font-medium text-foreground">
                    {removeMemberTarget?.displayName}
                  </span>{' '}
                  більше не буде у складі проєкту.
                </Trans>
              </p>
            </CrmDialogBody>
            <CrmDialogFooter>
              <Button variant="outline" onClick={() => setRemoveMemberTarget(null)}>
                <Trans>Скасувати</Trans>
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  removeMemberTarget && removeMemberMutation.mutate(removeMemberTarget.userId)
                }
                disabled={removeMemberMutation.isPending}
              >
                <Trans>Прибрати</Trans>
              </Button>
            </CrmDialogFooter>
          </CrmDialogContent>
        </Dialog>
        {/* ── Add member ── */}
        <Dialog
          open={addMemberOpen}
          onOpenChange={(v) => {
            if (!v) setAddMemberOpen(false)
          }}
        >
          <CrmDialogContent maxWidth="max-w-sm">
            <CrmDialogHeader>
              <DialogTitle>
                <Trans>Додати до складу</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Вибір учасників для додавання до складу проєкту.</Trans>
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody>
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {availableToAdd.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">
                    <Trans>Немає кого додати</Trans>
                  </p>
                )}
                {availableToAdd.map((u) => {
                  const isAdded = addedMemberIds.has(u.id)
                  const isPending = pendingMemberIds.has(u.id)
                  return (
                    <div key={u.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
                      <Avatar className="h-7 w-7 shrink-0">
                        {u.avatarUrl && <AvatarImage src={u.avatarUrl} />}
                        <AvatarFallback className="text-[10px]">
                          {getInitialsBySpaceSplit(u.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                      </div>
                      <Badge
                        variant={ROLE_VARIANT[u.role] ?? 'junior'}
                        className="shrink-0 text-[9px]"
                      >
                        {i18n._(ROLE_LABEL_MESSAGES[u.role as Role])}
                      </Badge>
                      <Button
                        size="sm"
                        variant={isAdded ? 'outline' : 'default'}
                        className={cn(
                          'shrink-0 h-7 text-xs px-2.5',
                          isAdded && 'text-emerald-500 border-emerald-500/40',
                        )}
                        disabled={isAdded || isPending}
                        onClick={() => {
                          setPendingMemberIds((prev) => new Set(prev).add(u.id))
                          addMemberMutation.mutate(u.id)
                        }}
                      >
                        {isAdded ? t`Додано` : isPending ? t`Додаємо…` : t`Додати`}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </CrmDialogBody>
          </CrmDialogContent>
        </Dialog>
        {/* ── Drop picker dialog (attach drop) ── */}
        <Dialog open={dropPickerOpen} onOpenChange={(v) => !v && setDropPickerOpen(false)}>
          <CrmDialogContent maxWidth="max-w-sm" data-testid="attach-drop-dialog">
            <CrmDialogHeader>
              <DialogTitle>
                <Trans>Прив’язати дропа</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Вибір дропа для проєкту</Trans>
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody>
              <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                {dropCandidates.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">
                    <Trans>Немає доступних дропів</Trans>
                  </p>
                )}
                {dropCandidates.map((u) => (
                  <li key={u.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
                    <Avatar className="h-7 w-7 shrink-0">
                      {u.avatarUrl && <AvatarImage src={u.avatarUrl} />}
                      <AvatarFallback className="text-[10px]">
                        {getInitialsBySpaceSplit(u.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{u.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className="shrink-0 border-blue-500/30 bg-blue-500/10 text-[9px] text-blue-400"
                    >
                      {i18n._(ROLE_LABEL_MESSAGES.DROP)}
                    </Badge>
                    <Button
                      size="sm"
                      className="h-7 min-h-[44px] min-w-[72px] shrink-0 px-2.5 text-xs sm:min-h-0"
                      disabled={dropMutation.isPending}
                      onClick={() => dropMutation.mutate(u.id)}
                      aria-label={t`Призначити ${u.displayName} дропом`}
                      data-testid={`assign-drop-btn-${u.id}`}
                    >
                      {dropMutation.isPending ? t`Призначаємо…` : t`Призначити`}
                    </Button>
                  </li>
                ))}
              </ul>
            </CrmDialogBody>
          </CrmDialogContent>
        </Dialog>
        {/* ── Detach drop confirm dialog ── */}
        <Dialog
          open={detachDropConfirmOpen}
          onOpenChange={(v) => !v && setDetachDropConfirmOpen(false)}
        >
          <CrmDialogContent maxWidth="sm:max-w-sm" data-testid="detach-drop-dialog">
            <CrmDialogHeader>
              <DialogTitle>
                <Trans>Відв’язати дропа?</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Підтвердження відв’язання дропа від проєкту</Trans>
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody className="pb-2">
              <p className="text-sm text-muted-foreground">
                <Trans>
                  <span className="font-medium text-foreground">
                    {project.effectiveTeam?.drop?.displayName ?? i18n._(ROLE_LABEL_MESSAGES.DROP)}
                  </span>
                  : доступ до проєкту буде припинено. Гроші за проєктом більше не йтимуть через ці
                  реквізити.
                </Trans>
              </p>
            </CrmDialogBody>
            <CrmDialogFooter>
              <Button variant="outline" onClick={() => setDetachDropConfirmOpen(false)}>
                <Trans>Скасувати</Trans>
              </Button>
              <Button
                variant="destructive"
                onClick={() => dropMutation.mutate(null)}
                disabled={dropMutation.isPending}
                data-testid="detach-drop-confirm-btn"
              >
                <Trans>Відв’язати</Trans>
              </Button>
            </CrmDialogFooter>
          </CrmDialogContent>
        </Dialog>
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
