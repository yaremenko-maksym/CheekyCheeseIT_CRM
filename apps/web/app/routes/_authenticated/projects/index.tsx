import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useForm, type FieldApi } from '@tanstack/react-form'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Briefcase,
  Clock,
  Plus,
  Search,
  UsersRound,
  XCircle,
} from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'
import { z } from 'zod'
import type { CreateProjectDto, ProjectDto, ProjectMemberDto, ItDomain } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ImageUploadField } from '@/components/ui/image-upload-field'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectRow } from '@/components/projects/ProjectRow'
import { RejoinTeamDialog } from '@/components/users/RejoinTeamDialog'
import {
  PAYMENT_TYPE_LABELS,
  PROJECT_STATUS_FILTERS,
  STATUS_FILTER_LABELS,
  STATUS_FILTER_LABELS_MOBILE,
  type ProjectStatusFilter,
} from './constants'
import { useActiveTeam } from '@/hooks/use-active-team'

/**
 * Drop role - phase 1 (AC7): wraps `useActiveTeam` and short-circuits for
 * non-SENIOR viewers so the page never accidentally hides cards for
 * ADMIN/HR/ACCOUNTANT/JUNIOR. The underlying query always runs (same hook
 * order across renders).
 */
function useTeamlessSeniorGate(isSenior: boolean) {
  const { isTeamless, isLoading } = useActiveTeam()
  if (!isSenior) return { isTeamless: false, isLoading: false }
  return { isTeamless, isLoading }
}

// task-project-status-filter-ui (design spec §2). `status` is the new,
// canonical filter — deep-linkable so ADMIN can send a colleague a direct
// link to the «На подтверждении» queue. `archived=true` is kept
// working (NOT removed) for old bookmarks/links — `?archived=true` resolves
// to `status: 'ARCHIVED'` below, same behaviour as before this task shipped.
// `z.coerce.boolean()` on `archived` accepts both `boolean` and string
// query-string forms safely, matching the pre-existing contract.
const projectsSearchSchema = z.object({
  status: z.enum(PROJECT_STATUS_FILTERS).optional(),
  archived: z.coerce.boolean().optional(),
})

export const Route = createFileRoute('/_authenticated/projects/')({
  validateSearch: (search) => projectsSearchSchema.parse(search),
  component: ProjectsPage,
})

// task-project-status-filter-ui (design spec §2). The «Все» tab is REMOVED
// (design spec §2: mixing confirmed/draft/rejected/archived into one bucket
// is exactly the "не смешивать факты о проекте" business spec §4.2 forbids
// extending to this new axis) — `ProjectStatusFilter` from constants.ts
// (`ACTIVE | PENDING | REJECTED | ARCHIVED`) replaces the old
// `'ALL' | 'ACTIVE' | 'ARCHIVED'` local type outright, not alongside it.
type StatusTab = ProjectStatusFilter

type ProjectSortKey = 'companyName' | 'rate' | 'startDate'
type SortDir = 'asc' | 'desc'

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}

// TanStack Form field render props require all 23 FieldApi generics — use unknown to avoid any
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyField = FieldApi<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>
/* eslint-enable @typescript-eslint/no-explicit-any */

function ProjectsPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])
  const { user } = useAuth()
  const search = Route.useSearch()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // Drop role - phase 1 (AC7): teamless SENIOR sees an empty-state with a
  // CTA to create or join a team. Page is otherwise locked out — backend
  // returns an empty list anyway, this is just a kinder surface.
  const { isTeamless: isTeamlessSenior, isLoading: isActiveTeamLoading } = useTeamlessSeniorGate(
    user?.role === 'SENIOR',
  )
  const [rejoinDialogOpen, setRejoinDialogOpen] = useState(false)

  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const canCreate = user?.role === 'ADMIN' || user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'
  const isAccountant = user?.role === 'ACCOUNTANT'
  // task-drop-share-override-and-receiver (Surface C). Field-scoped RBAC for
  // the "Тип оплаты" Select — same rule as the edit form's `canEditOverride`.
  // ACCOUNTANT never actually reaches this create form (canCreate excludes
  // them), kept symmetric with the edit-form gate per the design spec so the
  // two forms read identically.
  const canEditPaymentType = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'
  const isSenior = user?.role === 'SENIOR'

  // task-project-status-filter-ui (design spec §2 table). ADMIN gets all
  // four tabs; SENIOR gets the two that can ever apply to their own
  // projects; every other role sees no tab bar at all (their list is always
  // ACTIVE-only, same as today — the backend already only ever returns
  // ACTIVE projects to them, see ProjectsService.findAll's invited-approver
  // gate).
  const allowedTabs: readonly StatusTab[] = isAdmin
    ? PROJECT_STATUS_FILTERS
    : isSenior
      ? (['ACTIVE', 'PENDING'] as const)
      : (['ACTIVE'] as const)

  const [showCreate, setShowCreate] = useState(false)
  // ut-27 + ut-38: archive and unarchive actions removed from list cards;
  // both flows (including cascade restore for paired senior/team) live on the
  // project detail page header.

  // ut-43: unified toolbar state — search + senior filter + sort.
  const [searchQuery, setSearchQuery] = useState('')
  const [seniorFilter, setSeniorFilter] = useState<string>('ALL')
  const [sortKey, setSortKey] = useState<ProjectSortKey>('companyName')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // task-project-status-filter-ui (design spec §2). `status` is now the ONE
  // URL-driven source for all four tabs (ADMIN can deep-link «На
  // подтверждении» too, not just «Архив») — `archived=true` (the old
  // link shape) resolves to the same ARCHIVED tab for back-compat. A role
  // that can't see the resolved tab (a stale/crafted URL) silently falls
  // back to ACTIVE, same defense-in-depth `effectiveIsArchivedView` used to
  // provide.
  const urlStatus: StatusTab | undefined =
    search.status ?? (search.archived === true ? 'ARCHIVED' : undefined)
  const currentTab: StatusTab = urlStatus && allowedTabs.includes(urlStatus) ? urlStatus : 'ACTIVE'

  // ut-32 / ut-44: keepPreviousData + useTransition keep the previous list
  // visible during the tab switch + refetch so the SegmentedToggle's
  // gold-pill layout animation isn't interrupted by a render that throws the
  // list into a skeleton/empty state mid-flight.
  //
  // ONE fetch backs THREE tabs (ACTIVE/PENDING/REJECTED): all three are
  // "not archived" server-side (`archivedAt IS NULL` — a DRAFT/REJECTED
  // project can never be archived, business spec §4.2), so they share the
  // exact SAME `archived=false` (default) response and are bucketed by
  // `project.status` client-side below — switching between them is instant,
  // no new request. Only ARCHIVED needs its own `archived=true` fetch. This
  // is the "техническое решение Coder'а" design spec §2 explicitly
  // delegates (no new `?status=` backend query param was added — see PR
  // «Допущения»).
  const needsArchivedFetch = currentTab === 'ARCHIVED'
  const {
    data: rawProjects,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['projects', { archived: needsArchivedFetch ? 'true' : 'active' }],
    queryFn: () =>
      api
        .get<ProjectDto[]>(`/projects${needsArchivedFetch ? '?archived=true' : ''}`)
        .then((r) => r.data),
    enabled: !!user,
    placeholderData: keepPreviousData,
  })

  // AC1: the default (ACTIVE, status param absent) bucket must equal
  // today's list exactly — `status === 'ACTIVE' && archivedAt === null` is
  // the same set the backend already sent unfiltered before this task (a
  // non-ADMIN/non-invited-approver caller never receives a DRAFT/REJECTED
  // row at all); the filter is defensive/self-documenting, not new
  // narrowing. ARCHIVED needs no client-side filter — `archived=true`
  // already returns exactly that set server-side.
  const projects = useMemo(() => {
    if (!rawProjects) return undefined
    switch (currentTab) {
      case 'PENDING':
        return rawProjects.filter((p) => p.status === 'DRAFT')
      case 'REJECTED':
        return rawProjects.filter((p) => p.status === 'REJECTED')
      case 'ARCHIVED':
        return rawProjects
      case 'ACTIVE':
      default:
        return rawProjects.filter((p) => p.status === 'ACTIVE' && !p.archivedAt)
    }
  }, [rawProjects, currentTab])

  const [, startTransition] = useTransition()

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: canManage || isAccountant,
  })

  const seniorUsers = allUsers?.filter((u) => u.role === 'SENIOR') ?? []

  // ut-accountant-filter: build owner list for the senior/admin filter dropdown.
  // Includes SENIOR users + ADMIN users who own at least one visible project.
  // This ensures admins-as-seniors (e.g. Maksym on NeuroEdge AI / EduFlow) appear.
  const ownerUsers = useMemo(() => {
    if (!allUsers) return []
    const projectSeniorIds = new Set((projects ?? []).map((p) => p.seniorId).filter(Boolean))
    return allUsers
      .filter((u) => u.role === 'SENIOR' || (u.role === 'ADMIN' && projectSeniorIds.has(u.id)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'uk'))
  }, [allUsers, projects])
  // Drop role - phase 2: list of DROP users for the optional Select in the
  // create-project form. The list is hidden entirely when empty so the form
  // looks identical to pre-phase-2 for companies that don't use drops.
  const dropUsers = allUsers?.filter((u) => u.role === 'DROP') ?? []

  const createMutation = useMutation({
    mutationFn: (data: CreateProjectDto) => api.post<ProjectDto>('/projects', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowCreate(false)
      createForm.reset()
    },
  })

  const createForm = useForm({
    defaultValues: {
      name: '',
      companyName: '',
      domain: 'Other' as ItDomain,
      logoDocumentId: null as string | null,
      logoExternalUrl: null as string | null,
      seniorId: '',
      // Drop role - phase 2. Empty string = «не выбран» (regular senior-project).
      // Non-empty uuid string = drop-project routed through the selected DROP user.
      dropId: '',
      rate: '' as unknown as number,
      currency: 'USDT' as 'USDT' | 'USD' | 'EUR' | 'UAH',
      startDate: new Date().toISOString().slice(0, 10),
      techStack: '',
      teamSize: '',
      benefits: '',
      // task-drop-share-override-and-receiver (Surface C). Default to the
      // backend's own default ('FOP') — matches the enum Select's initial
      // selection (mirrors $projectId.tsx edit-form convention).
      paymentType: 'FOP',
      salaryReview: '',
      corpTech: '',
      notesGeneral: '',
    },
    onSubmit: async ({ value }) => {
      // Drop role - phase 2. Only include `dropId` when the user picked one.
      // Empty string → regression: regular senior-project, body matches pre-
      // phase-2 shape exactly (no `dropId` key).
      const trimmedDropId = value.dropId.trim()
      createMutation.mutate({
        name: value.name.trim(),
        companyName: value.companyName.trim(),
        domain: value.domain,
        logoDocumentId: value.logoDocumentId,
        logoExternalUrl: value.logoExternalUrl,
        seniorId: value.seniorId,
        ...(trimmedDropId ? { dropId: trimmedDropId } : {}),
        rate: Number(value.rate),
        currency: value.currency,
        startDate: new Date(value.startDate).toISOString(),
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        // task-drop-share-override-and-receiver (Surface C). Field-scoped RBAC —
        // backend throws ForbiddenException for non-ADMIN/ACCOUNTANT if this key
        // is present at all. HR (who CAN reach this create form via `canCreate`)
        // never sends it — the Select stays disabled at the backend default.
        ...(canEditPaymentType ? { paymentType: value.paymentType } : {}),
        salaryReview: value.salaryReview.trim() || null,
        corpTech: value.corpTech.trim() || null,
        notesGeneral: value.notesGeneral.trim() || null,
      })
    },
  })

  // Archive is performed via `ArchiveConfirmDialog` (name-confirmation + impact warning)
  // — same UX as team / user archive, no inline mutation needed here.

  // ut-43: client-side filter pipeline — search → senior → sort.
  const filtered = useMemo(() => {
    if (!projects) return []
    let list = [...projects]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (p) =>
          p.companyName.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          // seniorName is null for JUNIOR viewers (identity masking) — null-safe
          (p.seniorName ?? '').toLowerCase().includes(q) ||
          (p.techStack ?? '').toLowerCase().includes(q),
      )
    }
    if ((isAdmin || isAccountant) && seniorFilter !== 'ALL') {
      list = list.filter((p) => p.seniorId === seniorFilter)
    }
    list.sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      if (sortKey === 'companyName') {
        av = a.companyName
        bv = b.companyName
      } else if (sortKey === 'rate') {
        // rate is null for JUNIOR viewers; treat null as 0 for sort stability
        av = a.rate ?? 0
        bv = b.rate ?? 0
      } else if (sortKey === 'startDate') {
        av = new Date(a.startDate).getTime()
        bv = new Date(b.startDate).getTime()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [projects, searchQuery, seniorFilter, isAdmin, isAccountant, sortKey, sortDir])

  // Rules of Hooks: moved here — after every hook above — instead of
  // between `useSearch` and the ~14 hooks that follow it (useState/
  // useQuery/useForm/useMutation/useMemo). `denied` flips false→true
  // mid-mount once `useAuth`'s `isLoading` resolves to a disallowed role; a
  // guard sitting in the middle of the hook list made that transition
  // change the hook count between renders ("Rendered fewer hooks than
  // expected"). This route is also gated at the layout level (see
  // use-role-guard.ts), so this remains defense-in-depth, not the only guard.
  if (denied) return null

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-19 rounded-md" />
          ))}
        </div>
      </div>
    )
  }

  // Drop role - phase 1 (AC7): teamless SENIOR — full-page empty state
  // with the rejoin CTA. Other roles fall through to the regular UI.
  if (user?.role === 'SENIOR' && !isActiveTeamLoading && isTeamlessSenior) {
    return (
      <div className="space-y-6">
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
          data-testid="projects-teamless-empty-state"
        >
          <UsersRound className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">У вас нет активной команды</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-md">
            Создайте свою команду или присоединитесь к команде дропа, чтобы получить доступ к
            проектам.
          </p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={() => setRejoinDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Создать или выбрать команду
          </Button>
        </div>
        <RejoinTeamDialog open={rejoinDialogOpen} onClose={() => setRejoinDialogOpen(false)} />
      </div>
    )
  }

  const handleTabChange = (next: StatusTab) => {
    // ut-32: wrap the URL/state change in startTransition so React can keep
    // the previous page rendered while the new query resolves — otherwise
    // the toggle's layoutId pill animation gets cancelled by the suspended
    // render and the user sees a hard pop instead of a smooth slide.
    //
    // task-project-status-filter-ui: every tab is now URL-driven via
    // `status` (ACTIVE omits the param — same "default tab, clean URL"
    // convention the page already had for its old ACTIVE state).
    startTransition(() => {
      navigate({ to: '/projects', search: next === 'ACTIVE' ? {} : { status: next } })
    })
  }

  // task-project-status-filter-ui (design spec §2/§3/§4). «Архив» keeps its
  // `toggle-archived-projects` testId for existing E2E specs. «Отклонённые»
  // gets `activeVariant: 'destructive'` (design spec §3 token-map — same
  // pattern as CandidateCard's REJECTED tab) so its active pill reads as a
  // warning, not just another neutral choice.
  const tabOptions: ReadonlyArray<SegmentedToggleOption<StatusTab>> = allowedTabs.map((value) => ({
    value,
    label: STATUS_FILTER_LABELS[value],
    ...(value === 'ARCHIVED' ? { testId: 'toggle-archived-projects', icon: Archive } : {}),
    ...(value === 'REJECTED' ? { activeVariant: 'destructive' as const } : {}),
  }))
  // COPY-M-10 (PR #646 fix-round 3): the mobile ARCHIVED option does NOT
  // carry `icon: Archive` (unlike the desktop one two lines up) — measured
  // budget at 320px with 4 ADMIN tabs is ~47px per button; "Архив" alone is
  // 36.4px, but + the icon's 14px + 8px gap (`SegmentedToggle` renders icon
  // inline before the label) is 58.4px, an ~11px overflow with no
  // `truncate` or its own `overflow` to catch it (the row's `overflow-hidden`
  // is on the strip, not the button) — it would spill into the next tab's
  // track. The word alone is unambiguous; the icon adds nothing on mobile
  // that the label doesn't already say.
  const tabOptionsMobile: ReadonlyArray<SegmentedToggleOption<StatusTab>> = allowedTabs.map(
    (value) => ({
      value,
      label: STATUS_FILTER_LABELS_MOBILE[value],
      ...(value === 'ARCHIVED' ? { testId: 'toggle-archived-projects-mobile' } : {}),
      ...(value === 'REJECTED' ? { activeVariant: 'destructive' as const } : {}),
    }),
  )

  // task-project-status-filter-ui §6/§10. Per-tab (and, for PENDING/
  // REJECTED — which only ADMIN/SENIOR ever see per `allowedTabs` — per
  // role) empty-state copy + icon, design spec §6 table. `filtered.length`
  // already excludes search/senior-filter/sort from ever mattering here —
  // this only fires when the TAB itself is empty, matching every existing
  // empty-state's semantics unchanged for ACTIVE/ARCHIVED.
  const emptyState: { text: string; icon: typeof Briefcase } =
    currentTab === 'ARCHIVED'
      ? { text: 'Архив пуст', icon: Briefcase }
      : currentTab === 'PENDING'
        ? {
            // COPY-M-5 (PR #646 fix-round 2): "черновик" is already the
            // name of a DIFFERENT concept in this CRM — contract drafts
            // ("Вернуть в черновик", "Сохранить как черновик", "Контракт
            // сохранён как черновик"). This tab and its badge both say
            // "подтверждение"; the empty state used to be the one place on
            // this exact screen using a third, already-taken word for the
            // same object.
            text: isAdmin
              ? 'Проектов на подтверждении нет'
              : 'Нет проектов, ожидающих вашего решения',
            icon: Clock,
          }
        : currentTab === 'REJECTED'
          ? { text: 'Отклонённых проектов нет', icon: XCircle }
          : { text: 'Проектов пока нет', icon: Briefcase }
  const EmptyStateIcon = emptyState.icon

  return (
    <div className="flex flex-col h-full">
      <StickyPageHeader>
        {/* Header — buttons row */}
        <div className="flex items-center justify-between">
          <div />
          <div className="flex items-center gap-2">
            {canCreate && (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Новый проект
              </Button>
            )}
          </div>
        </div>

        {/* task-project-status-filter-ui (design spec §2/§5): status tabs —
            ADMIN (4 values) or SENIOR (2 values); hidden for every other
            role (unchanged from the old ADMIN-only gate for THEM, ut-25 +
            ut-26 + ut-33 + ut-44's original AC1-AC2). Two instances, swapped
            by breakpoint (not just width) — same convention as
            vacancies/index.tsx's status filter: the mobile instance uses
            shortened labels (STATUS_FILTER_LABELS_MOBILE), not a different
            control, and adds `[&>button]:min-h-11` so each tab button meets
            the 44px mobile touch-target minimum (§5/§8/§10 a11y — the
            desktop instance is unaffected). */}
        {(isAdmin || isSenior) && (
          <>
            <SegmentedToggle<StatusTab>
              value={currentTab}
              onChange={handleTabChange}
              options={tabOptionsMobile}
              ariaLabel="Фильтр проектов по статусу"
              variant="tabs"
              size="sm"
              layoutId="projects-status-tabs-mobile"
              className="w-full sm:hidden [&>button]:min-h-11"
              testId="projects-status-tabs-mobile"
            />
            <SegmentedToggle<StatusTab>
              value={currentTab}
              onChange={handleTabChange}
              options={tabOptions}
              ariaLabel="Фильтр проектов по статусу"
              variant="tabs"
              size="sm"
              layoutId="projects-status-tabs"
              className="hidden w-fit sm:grid"
              testId="projects-status-tabs"
            />
            {/* §10 (SC 4.1.3): the tab switch itself is announced natively
                via aria-selected on the focused/clicked button — this extra
                region announces the RESULT (list re-rendered outside the
                user's focus), which is not otherwise observable to a
                screen-reader user. */}
            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {STATUS_FILTER_LABELS[currentTab]}. Показано проектов: {filtered.length}.
            </p>
          </>
        )}

        {/* ut-43: unified toolbar — search + senior filter (ADMIN) + sort key + direction */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-50">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              enterKeyHint="search"
              placeholder="Поиск по компании, проекту, синьору…"
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="projects-search-input"
            />
          </div>

          {(isAdmin || isAccountant) && ownerUsers.length > 0 && (
            <Select value={seniorFilter} onValueChange={setSeniorFilter}>
              <SelectTrigger className="w-44" data-testid="projects-senior-filter">
                <SelectValue placeholder="Все ответственные" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все ответственные</SelectItem>
                {ownerUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName}
                    {u.role === 'ADMIN' ? ' (админ)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="hidden h-6 w-px bg-border sm:block" aria-hidden />

          <Select value={sortKey} onValueChange={(v) => setSortKey(v as ProjectSortKey)}>
            <SelectTrigger className="w-52" data-testid="projects-sort-key">
              <SelectValue placeholder="Сортировка" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="companyName">По компании</SelectItem>
              <SelectItem value="rate">По ставке</SelectItem>
              <SelectItem value="startDate">По дате начала</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            aria-label={`Направление сортировки: ${sortDir === 'asc' ? 'По возрастанию' : 'По убыванию'}`}
            data-testid="projects-sort-direction"
            data-dir={sortDir}
            className="h-9 w-9"
          >
            {sortDir === 'asc' ? (
              <ArrowUp className="h-4 w-4" />
            ) : (
              <ArrowDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </StickyPageHeader>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div className="space-y-6">
          {/* task-project-status-filter-ui §6 "Ошибка": same admin-KPI-block
              pattern as routes/_authenticated/index.tsx's AdminDashboard
              (`admin-kpi-error`) — placed after isError, before the empty-
              state check, so it wins over "Проектов пока нет" when the
              fetch itself failed (an empty list is a fact, a failed fetch
              is not one). */}
          {isError && (
            <Card data-testid="projects-fetch-error">
              <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
                <p className="text-sm text-destructive">Не удалось загрузить проекты</p>
                <p className="text-xs text-muted-foreground">
                  Обновите страницу или попробуйте позже
                </p>
              </CardContent>
            </Card>
          )}

          {/* Empty state — task-project-status-filter-ui §6: per-tab (and,
              for PENDING, per-role) copy/icon, see `emptyState` above. */}
          {!isError && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
              <EmptyStateIcon className="h-10 w-10 text-muted-foreground/30" />
              <p className="mt-4 text-sm font-medium">{emptyState.text}</p>
              {canManage && currentTab === 'ACTIVE' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setShowCreate(true)}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  Создать проект
                </Button>
              )}
            </div>
          )}

          {/* ut-41 + ut-42: row-list layout (was grid cards). Legacy
          `project-card-${id}` testid is preserved on the outer wrapper so
          existing E2E specs keep working; new `project-row-${id}` lives on
          the inner ProjectRow. */}
          {!isError && filtered.length > 0 && (
            <Card>
              <CardContent className="p-3">
                <motion.div className="space-y-1" data-testid="projects-list">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {filtered.map((project) => {
                      const isArchived = !!project.archivedAt
                      return (
                        <motion.div
                          key={project.id}
                          variants={item}
                          layout="position"
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.08, ease: 'easeOut' }}
                          data-testid={`project-card-${project.id}`}
                          data-archived={isArchived ? 'true' : 'false'}
                        >
                          <ProjectRow
                            project={project}
                            viewerRole={user?.role}
                            viewerId={user?.id}
                          />
                        </motion.div>
                      )
                    })}
                  </AnimatePresence>
                </motion.div>
              </CardContent>
            </Card>
          )}

          {/* ── Create project dialog ── */}
          <Dialog
            open={showCreate}
            onOpenChange={(open) => {
              if (!open) {
                setShowCreate(false)
                createForm.reset()
              }
            }}
          >
            <CrmDialogContent maxWidth="max-w-md">
              <CrmDialogHeader>
                <DialogTitle>Новый проект</DialogTitle>
                <DialogDescription className="sr-only">Создание проекта</DialogDescription>
              </CrmDialogHeader>
              <CrmDialogBody>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Логотип компании</Label>
                    <ImageUploadField
                      value={{
                        documentId: (createForm.state.values as { logoDocumentId: string | null })
                          .logoDocumentId,
                        externalUrl: (createForm.state.values as { logoExternalUrl: string | null })
                          .logoExternalUrl,
                      }}
                      onChange={(v) => {
                        createForm.setFieldValue('logoDocumentId', v.documentId)
                        createForm.setFieldValue('logoExternalUrl', v.externalUrl)
                      }}
                      category="LOGO"
                      urlPlaceholder="https://example.com/logo.png"
                      testId="create-project-logo"
                    />
                  </div>

                  <createForm.Field
                    name="name"
                    validators={{
                      onBlur: ({ value }: { value: string }) => {
                        const r = createProjectSchema.shape.name.safeParse(value.trim())
                        return r.success ? undefined : r.error.issues[0]?.message
                      },
                    }}
                  >
                    {(field: AnyField) => {
                      const err = field.state.meta.isTouched
                        ? field.state.meta.errors[0]
                        : undefined
                      return (
                        <div className="space-y-1.5">
                          <Label className={cn(err && 'text-destructive')}>Название проекта</Label>
                          <Input
                            value={field.state.value}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              field.handleChange(e.target.value)
                            }
                            onBlur={field.handleBlur}
                            placeholder="AI Platform v2"
                            className={cn(
                              err && 'border-destructive focus-visible:ring-destructive/30',
                            )}
                          />
                          {err && <p className="text-xs text-destructive">{err}</p>}
                        </div>
                      )
                    }}
                  </createForm.Field>

                  <createForm.Field
                    name="companyName"
                    validators={{
                      onBlur: ({ value }: { value: string }) => {
                        const r = createProjectSchema.shape.companyName.safeParse(value.trim())
                        return r.success ? undefined : r.error.issues[0]?.message
                      },
                    }}
                  >
                    {(field: AnyField) => {
                      const err = field.state.meta.isTouched
                        ? field.state.meta.errors[0]
                        : undefined
                      return (
                        <div className="space-y-1.5">
                          <Label className={cn(err && 'text-destructive')}>Компания</Label>
                          <Input
                            value={field.state.value}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              field.handleChange(e.target.value)
                            }
                            onBlur={field.handleBlur}
                            placeholder="TechCorp AI"
                            className={cn(
                              err && 'border-destructive focus-visible:ring-destructive/30',
                            )}
                          />
                          {err && <p className="text-xs text-destructive">{err}</p>}
                        </div>
                      )
                    }}
                  </createForm.Field>

                  <createForm.Field name="domain">
                    {(field: AnyField) => (
                      <div className="space-y-1.5">
                        <Label>Домен</Label>
                        <select
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                          value={field.state.value}
                          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                            field.handleChange(e.target.value as ItDomain)
                          }
                        >
                          {IT_DOMAINS.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </createForm.Field>

                  <createForm.Field
                    name="seniorId"
                    validators={{
                      onBlur: ({ value }: { value: string }) => {
                        const r = createProjectSchema.shape.seniorId.safeParse(value)
                        return r.success ? undefined : 'Выберите синьора'
                      },
                    }}
                  >
                    {(field: AnyField) => {
                      const err = field.state.meta.isTouched
                        ? field.state.meta.errors[0]
                        : undefined
                      return (
                        <div className="space-y-1.5">
                          <Label className={cn(err && 'text-destructive')}>Синьор</Label>
                          <select
                            className={cn(
                              'w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring',
                              err ? 'border-destructive' : 'border-input',
                            )}
                            value={field.state.value}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                              field.handleChange(e.target.value)
                            }
                            onBlur={field.handleBlur}
                          >
                            <option value="">— выберите синьора —</option>
                            {seniorUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.displayName}
                              </option>
                            ))}
                          </select>
                          {err && <p className="text-xs text-destructive">{err}</p>}
                        </div>
                      )
                    }}
                  </createForm.Field>

                  {/* Drop role - phase 2. Optional Select shown only when at least
                one DROP user exists. Empty = «не выбран» — regular senior-
                project (legacy regression path). Otherwise — drop-project. */}
                  {dropUsers.length > 0 && (
                    <createForm.Field name="dropId">
                      {(field: AnyField) => (
                        <div className="space-y-1.5">
                          <Label>Дроп (опционально)</Label>
                          <select
                            data-testid="create-project-drop-select"
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                            value={field.state.value}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                              field.handleChange(e.target.value)
                            }
                            onBlur={field.handleBlur}
                          >
                            <option value="">— не выбран —</option>
                            {dropUsers.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.displayName}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-muted-foreground">
                            Если выбран — приходы по проекту пойдут через дропа (доля 5% по
                            умолчанию).
                          </p>
                        </div>
                      )}
                    </createForm.Field>
                  )}

                  <createForm.Subscribe
                    selector={(s: { values: { rate: number; currency: string } }) => ({
                      rate: s.values.rate,
                      currency: s.values.currency,
                    })}
                  >
                    {({ rate, currency }: { rate: number; currency: string }) => (
                      <AmountCurrencyInput
                        amount={String(rate ?? '')}
                        currency={currency as Currency}
                        onAmountChange={(v) =>
                          createForm.setFieldValue('rate', Number(v) as unknown as number)
                        }
                        onCurrencyChange={(v) =>
                          createForm.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')
                        }
                        label="Ставка"
                        placeholder="5000"
                      />
                    )}
                  </createForm.Subscribe>

                  <createForm.Field name="startDate">
                    {(field: AnyField) => (
                      <div className="space-y-1.5">
                        <Label>Дата начала</Label>
                        <Input
                          type="date"
                          value={field.state.value}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            field.handleChange(e.target.value)
                          }
                        />
                      </div>
                    )}
                  </createForm.Field>

                  <div className="border-t border-border pt-3 space-y-3">
                    {(
                      [
                        'techStack',
                        'teamSize',
                        'benefits',
                        'paymentType',
                        'salaryReview',
                        'corpTech',
                      ] as const
                    ).map((fieldName) => {
                      const labels: Record<string, string> = {
                        techStack: 'Стек технологий',
                        teamSize: 'Состав команды',
                        benefits: 'Бенефиты',
                        paymentType: 'Тип оплаты',
                        salaryReview: 'Пересмотр ЗП',
                        corpTech: 'Корп. технологии',
                      }
                      // task-drop-share-override-and-receiver (Surface C).
                      // paymentType moves from free-text Input to a 3-value
                      // Select — same field-scoped RBAC pattern as the edit form.
                      if (fieldName === 'paymentType') {
                        return (
                          <createForm.Field key="paymentType" name="paymentType">
                            {(field: AnyField) => (
                              <div className="space-y-1.5">
                                <Label>Тип оплаты</Label>
                                <Select
                                  value={field.state.value as string}
                                  onValueChange={(v) => field.handleChange(v)}
                                  disabled={!canEditPaymentType}
                                >
                                  <SelectTrigger
                                    className="h-9 text-sm"
                                    data-testid="project-payment-type-trigger"
                                  >
                                    <SelectValue placeholder="Выберите тип оплаты" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="FOP" className="text-sm">
                                      {PAYMENT_TYPE_LABELS.FOP}
                                    </SelectItem>
                                    <SelectItem value="GIG_CONTRACT" className="text-sm">
                                      {PAYMENT_TYPE_LABELS.GIG_CONTRACT}
                                    </SelectItem>
                                    <SelectItem value="USDT" className="text-sm">
                                      {PAYMENT_TYPE_LABELS.USDT}
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                                {!canEditPaymentType && (
                                  <p className="text-xs text-muted-foreground italic">
                                    Менять может только ADMIN или ACCOUNTANT.
                                  </p>
                                )}
                              </div>
                            )}
                          </createForm.Field>
                        )
                      }
                      return (
                        <createForm.Field key={fieldName} name={fieldName}>
                          {(field: AnyField) => (
                            <div className="space-y-1.5">
                              <Label>{labels[fieldName]}</Label>
                              <Input
                                value={field.state.value as string}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                  field.handleChange(e.target.value)
                                }
                                placeholder=""
                              />
                            </div>
                          )}
                        </createForm.Field>
                      )
                    })}
                    <createForm.Field name="notesGeneral">
                      {(field: AnyField) => (
                        <div className="space-y-1.5">
                          <Label>Общие заметки</Label>
                          <textarea
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring min-h-20 resize-y"
                            value={field.state.value as string}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                              field.handleChange(e.target.value)
                            }
                            placeholder=""
                          />
                        </div>
                      )}
                    </createForm.Field>
                  </div>
                </div>
              </CrmDialogBody>
              <CrmDialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowCreate(false)
                    createForm.reset()
                  }}
                >
                  Отмена
                </Button>
                <Button
                  onClick={() => void createForm.handleSubmit()}
                  disabled={createMutation.isPending}
                  data-track="project-create"
                >
                  {createMutation.isPending ? 'Создание...' : 'Создать'}
                </Button>
              </CrmDialogFooter>
            </CrmDialogContent>
          </Dialog>

          {/* ut-27 + ut-38: Archive + Unarchive (including cascade modal) live on
            the project detail page header — list cards have no inline actions. */}
        </div>
      </div>
    </div>
  )
}

// unused but kept for type safety
export type { ProjectMemberDto }
