import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { Archive, Plus, Search, Send, Users } from 'lucide-react'
import { useEffect, useMemo, useState, useTransition } from 'react'
import { z } from 'zod'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { compareNames } from '@crm/shared'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { useAuth } from '@/context/auth'
import { useLocale } from '@/lib/i18n'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { trackFeatureClick } from '@/lib/telemetry'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { HrCreateSeniorDialog } from './team-list/components/HrCreateSeniorDialog'

const teamSearchSchema = z.object({
  archived: z.boolean().optional(),
})

export const Route = createFileRoute('/_authenticated/team/')({
  validateSearch: (search) => teamSearchSchema.parse(search),
  component: TeamPage,
})

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

async function fetchTeams(archivedQuery: '' | 'true' | 'all' = ''): Promise<TeamDto[]> {
  const res = await api.get<TeamDto[]>(`/teams${archivedQuery ? `?archived=${archivedQuery}` : ''}`)
  return res.data
}

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await api.get<ProjectDto[]>('/projects')
  return res.data
}

// ── Main page ─────────────────────────────────────────────────────────────────

function TeamPage() {
  const { t, i18n } = useLingui()
  // SPEC-M-2 (fix-round A): resolved ONCE at component top-level, not per-row
  // inside the `filteredTeams.map()` badge below — `useRoleLabel` is a hook
  // and cannot be called from inside a `.map()` callback (Rules of Hooks).
  const dropRoleLabel = i18n._(ROLE_LABEL_MESSAGES.DROP)
  const locale = useLocale()
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])
  const { user } = useAuth()
  const navigate = useNavigate()
  const routeSearch = Route.useSearch()
  const isArchivedView = routeSearch.archived === true

  const isHr = user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'

  // ut-44: tri-state filter — local ALL/ACTIVE plus URL-driven ARCHIVED.
  const [teamFilter, setTeamFilter] = useState<'ALL' | 'ACTIVE'>('ACTIVE')

  // ut-32: keepPreviousData + useTransition keep the previous list visible
  // during the URL switch + refetch so the SegmentedToggle's gold-pill
  // layout animation isn't interrupted by a render that throws the list
  // into a skeleton state mid-flight.
  const archivedQuery: '' | 'true' | 'all' = isArchivedView
    ? 'true'
    : teamFilter === 'ALL'
      ? 'all'
      : ''
  const { data: teams, isLoading } = useQuery({
    queryKey: ['teams', { archived: archivedQuery || 'active' }],
    queryFn: () => fetchTeams(archivedQuery),
    enabled: !!user,
    placeholderData: keepPreviousData,
  })

  const [, startTransition] = useTransition()

  // Auto-redirect for SENIOR and JUNIOR users who have only one team
  useEffect(() => {
    if (!teams || isLoading || !user) return

    // task-drop-phase3-frontend: DROP added alongside SENIOR/JUNIOR — backend
    // already returns only the drop's own team (TeamsService.findAll isolates DROP).
    if (user.role === 'SENIOR' || user.role === 'JUNIOR' || user.role === 'DROP') {
      if (teams.length === 1 && teams[0]) {
        navigate({ to: '/team/$teamId', params: { teamId: teams[0].id } })
      }
    }
  }, [teams, isLoading, user, navigate])

  // ut-39a: top-level users query removed — `HrCreateSeniorDialog` fetches
  // its own list on demand, and the rest of the page doesn't need user data.

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: !!user,
  })

  // HR: create senior dialog
  const [showCreateSenior, setShowCreateSenior] = useState(false)

  // ut-39a: edit + add-member dialogs removed from list page — those flows
  // now live on the team detail page header.

  // Toolbar state
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'members' | 'projects'>('name')

  // Pre-compute active project count per team (one pass) to avoid O(N²) in sort comparator.
  const activeProjectCountByTeamSenior = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>()
    if (!projects) return map
    for (const p of projects) {
      if (p.archivedAt !== null || !p.seniorId) continue
      map.set(p.seniorId, (map.get(p.seniorId) ?? 0) + 1)
    }
    return map
  }, [projects])

  // Filtered and sorted teams
  const filteredTeams = useMemo(() => {
    if (!teams) return []
    let result = [...teams]

    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((t) => t.name.toLowerCase().includes(q))
    }

    result.sort((a, b) => {
      if (sortBy === 'name') return compareNames(locale)(a.name, b.name)
      if (sortBy === 'members') return b.members.length - a.members.length
      if (sortBy === 'projects') {
        const seniorA = a.members.find((m) => m.role === 'SENIOR')
        const seniorB = b.members.find((m) => m.role === 'SENIOR')
        const aCount = seniorA ? (activeProjectCountByTeamSenior.get(seniorA.userId) ?? 0) : 0
        const bCount = seniorB ? (activeProjectCountByTeamSenior.get(seniorB.userId) ?? 0) : 0
        return bCount - aCount
      }
      return 0
    })

    return result
  }, [teams, activeProjectCountByTeamSenior, search, sortBy, locale])

  // Rules of Hooks: moved here — after every hook above — instead of
  // between `useSearch` and the ~10 hooks that follow it (useState/
  // useQuery/useEffect/useMemo). `denied` flips false→true mid-mount once
  // `useAuth`'s `isLoading` resolves to a disallowed role; a guard sitting
  // in the middle of the hook list made that transition change the hook
  // count between renders ("Rendered fewer hooks than expected"). This
  // route is also gated at the layout level (see use-role-guard.ts), so
  // this remains defense-in-depth, not the only guard.
  if (denied) return null

  // ut-25 + ut-33 + ut-44: tabs for teams page — "All | Active | Archived"
  // for ADMIN, unified through SegmentedToggle so the gold-pill animation
  // lives in one place. The "All" tab fetches with `archived=all`; the
  // "Archived" tab keeps the legacy `archived=true` query param + URL state.
  type TeamTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'
  const teamTabs: ReadonlyArray<SegmentedToggleOption<TeamTab>> = [
    { value: 'ALL', label: t`Усі` },
    { value: 'ACTIVE', label: t`Активні` },
    { value: 'ARCHIVED', label: t`Архів`, testId: 'toggle-archived-teams', icon: Archive },
  ]
  const currentTeamTab: TeamTab = isArchivedView ? 'ARCHIVED' : teamFilter
  const handleTeamTabChange = (next: TeamTab) => {
    // task-telemetry-web: SegmentedToggle's onChange, not a DOM click on a
    // [data-track] element — fired manually.
    trackFeatureClick('team-filter-change')
    // ut-32: wrap navigation in startTransition so the gold-pill layout
    // animation isn't preempted by the query refetch render.
    startTransition(() => {
      if (next === 'ARCHIVED') {
        navigate({ to: '/team', search: { archived: true } })
        return
      }
      if (isArchivedView) {
        navigate({ to: '/team', search: {} })
      }
      setTeamFilter(next === 'ALL' ? 'ALL' : 'ACTIVE')
    })
  }

  return (
    <div className="flex flex-col h-full">
      <StickyPageHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isHr && (
              <Button onClick={() => setShowCreateSenior(true)} size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                <Trans>Створити сеньйора</Trans>
              </Button>
            )}
          </div>
        </div>

        {/* ut-25 + ut-26 + ut-33: Tabs row replacing the "show archived" button.
            Only ADMIN sees the Archive tab; for other roles tabs aren't needed
            since they don't have access to archived teams. */}
        {isAdmin && (
          <SegmentedToggle<TeamTab>
            value={currentTeamTab}
            onChange={handleTeamTabChange}
            options={teamTabs}
            ariaLabel={t`Фільтр команд`}
            variant="tabs"
            size="sm"
            layoutId="team-status-tabs"
            className="w-fit"
            testId="team-status-tabs"
          />
        )}

        {(isLoading || (teams && teams.length > 0)) && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                enterKeyHint="search"
                placeholder={t`Пошук за назвою…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={t`Сортування`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">{t`Назва А→Я`}</SelectItem>
                <SelectItem value="members">{t`Учасники ↓`}</SelectItem>
                <SelectItem value="projects">{t`Проєкти ↓`}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </StickyPageHeader>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div className="space-y-6">
          {!isLoading && teams && teams.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
              <Users className="h-10 w-10 text-muted-foreground/30" />
              <p className="mt-4 text-sm font-medium">
                <Trans>Команд поки немає</Trans>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isHr ? (
                  <Trans>Натисніть «Створити сеньйора», щоб сформувати першу команду</Trans>
                ) : (
                  <Trans>Команда з’являється автоматично, коли в систему додають сеньйора</Trans>
                )}
              </p>
            </div>
          )}

          <motion.div
            className="flex flex-col gap-1.5"
            variants={container}
            initial="hidden"
            animate="show"
          >
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            {!isLoading && filteredTeams.length === 0 && (teams?.length ?? 0) > 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                <Trans>Нічого не знайдено — скиньте фільтри</Trans>
              </p>
            )}
            {filteredTeams.map((team) => {
              // ut-39a: per-card management controls removed — all team CRUD is
              // performed from the detail page header. No need for per-team
              // RBAC computation here.
              const hrMembers = team.members.filter((m) => m.role === 'HR')
              const seniorMember = team.members.find((m) => m.role === 'SENIOR')
              const activeProjects = seniorMember
                ? (activeProjectCountByTeamSenior.get(seniorMember.userId) ?? 0)
                : 0
              const isArchived = !!team.archivedAt

              return (
                <motion.div
                  key={team.id}
                  variants={item}
                  layout="position"
                  transition={{ duration: 0.08, ease: 'easeOut' }}
                >
                  <div
                    data-testid={`team-card-${team.id}`}
                    data-archived={isArchived ? 'true' : 'false'}
                    className={cn(
                      'group relative flex h-14 items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 transition-all duration-200 hover:border-primary/30 hover:bg-card cursor-pointer',
                      isArchived && 'opacity-60',
                    )}
                    onClick={() => navigate({ to: '/team/$teamId', params: { teamId: team.id } })}
                  >
                    <Link
                      to="/team/$teamId"
                      params={{ teamId: team.id }}
                      className="absolute inset-0 z-10"
                      title={t`Відкрити «${team.name}»`}
                    />

                    {/* Avatars */}
                    <div className="flex shrink-0 -space-x-2 relative z-20">
                      {team.members.slice(0, 4).map((member, index) => (
                        <Avatar
                          key={member.id}
                          className="h-7 w-7 ring-2 ring-background bg-muted"
                          style={{ zIndex: 4 - index }}
                        >
                          {member.avatarUrl && (
                            <AvatarImage src={member.avatarUrl} alt={member.displayName} />
                          )}
                          <AvatarFallback className="bg-muted text-[10px]">
                            {getInitialsBySpaceSplit(member.displayName)}
                          </AvatarFallback>
                        </Avatar>
                      ))}
                      {team.members.length > 4 && (
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted ring-2 ring-background">
                          <span className="text-[9px] font-medium text-muted-foreground">
                            +{team.members.length - 4}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Name + HRs */}
                    <div className="relative z-20 min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className="truncate text-sm font-semibold group-hover:text-primary transition-colors">
                          {team.name}
                        </p>
                        {/* Drop role - phase 1 (AC4): badge surfaces drop-teams
                        on the team list. Senior-teams render no badge so
                        existing visuals are unchanged. */}
                        {team.type === 'DROP' && (
                          <Badge variant="drop" className="text-[10px] shrink-0">
                            {dropRoleLabel}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground overflow-hidden whitespace-nowrap">
                        {hrMembers.length > 0 ? (
                          <Trans>HR: {hrMembers.map((m) => m.displayName).join(', ')}</Trans>
                        ) : (
                          <Trans>HR: немає</Trans>
                        )}
                      </p>
                    </div>

                    {/* Pills */}
                    <div className="relative z-20 flex shrink-0 items-center gap-2">
                      {isArchived && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/10 text-amber-500 text-[11px]"
                        >
                          <Trans>В архіві</Trans>
                        </Badge>
                      )}
                      {team.telegram && (
                        <a
                          href={team.telegram}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 px-2.5 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/10 transition-colors"
                        >
                          <Send className="h-3 w-3" />
                          Telegram
                        </a>
                      )}
                      <Badge variant="outline" className="text-[11px] tabular-nums">
                        <Plural
                          value={team.members.length}
                          one="# учасник"
                          few="# учасники"
                          many="# учасників"
                          other="# учасника"
                        />
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[11px] tabular-nums',
                          activeProjects > 0
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'text-muted-foreground',
                        )}
                      >
                        <Plural
                          value={activeProjects}
                          one="# проєкт"
                          few="# проєкти"
                          many="# проєктів"
                          other="# проєкту"
                        />
                      </Badge>
                    </div>

                    {/* ut-39a: rename / unarchive / admin actions removed from
                    list cards (matches ut-38 project pattern). All team
                    management lives on the detail page header. */}
                  </div>
                </motion.div>
              )
            })}
          </motion.div>

          {/* HR: Create senior dialog */}
          {isHr && user && (
            <HrCreateSeniorDialog
              open={showCreateSenior}
              onClose={() => setShowCreateSenior(false)}
              hrUserId={user.id}
            />
          )}

          {/* ut-39a: Edit + Add member + Unarchive flows live on the team detail
            page header — list page is purely navigational. */}
        </div>
      </div>
    </div>
  )
}
