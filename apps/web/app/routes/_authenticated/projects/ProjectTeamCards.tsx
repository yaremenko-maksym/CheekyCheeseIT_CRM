import { Link } from '@tanstack/react-router'
import { Trans, useLingui } from '@lingui/react/macro'
import { UserMinus, UserPlus } from 'lucide-react'
import type { ProjectDetailDto, ProjectMemberDto } from '@crm/shared'
import { formatDate } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { ROLE_LABEL_MESSAGES, useRoleLabel } from '@/components/ui/role-select'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ROLE_VARIANT } from './constants'

/**
 * Drop role - phase 2 (AC3). Distribution breakdown panel for drop-projects.
 *
 * Renders the formula visualisation specified in §8.1 of
 * drop-role-and-finance-spec.md — example income $1000:
 *   Доля синьора 26%   $260
 *   Доля дропа 5%      $50
 *   Партнёрам 50/50    $345 / $345
 *
 * Senior share = `seniorSharePercentOverride ?? seniorSharePercentDefault`
 * (same rule as the existing «Override» badge widget). Drop share is read
 * from the snapshot on the project DTO. The remainder is split 50/50
 * between partners. Component is mounted only when the project is a
 * drop-project (`project.dropId != null`); the caller enforces the RBAC
 * (ADMIN/ACCOUNTANT/SENIOR/DROP — same audience that sees the Финансы tab).
 */
export function ProjectDropDistribution({ project }: { project: ProjectDetailDto }) {
  const { t } = useLingui()
  // Use $1000 as the canonical example. Numbers shown without currency
  // suffix to keep the formula abstract — actual amounts vary per income.
  const seniorPct = project.seniorSharePercentOverride ?? project.seniorSharePercentDefault ?? 26
  // task-drop-share-override-and-receiver (Surface A). Override-aware: prefer
  // the backend-resolved effective % (override → user default → 5) over the
  // legacy read-time snapshot so a project-level override is reflected here too.
  const dropPct = project.effectiveDropSharePercent ?? project.dropSharePercent ?? 5
  const exampleIncome = 1000
  const seniorShare = (exampleIncome * seniorPct) / 100
  const dropShare = (exampleIncome * dropPct) / 100
  const remainder = exampleIncome - seniorShare - dropShare
  const partnerEach = remainder / 2
  const fmt = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  return (
    <Card className="border-blue-500/20 bg-blue-500/[0.03]" data-testid="project-drop-distribution">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold text-blue-400 uppercase tracking-wider">
          {t`Розподіл доходу (приклад ${fmt(exampleIncome)})`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t`Частка сеньйора (${seniorPct}%)`}</span>
          <span className="font-semibold tabular-nums" data-testid="dist-senior-share">
            {fmt(seniorShare)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t`Частка дропа (${dropPct}%)`}</span>
          <span className="font-semibold tabular-nums" data-testid="dist-drop-share">
            {fmt(dropShare)}
          </span>
        </div>
        <div className="h-px bg-border/60 my-1" />
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t`Партнерам (50 / 50)`}</span>
          <span className="font-semibold tabular-nums" data-testid="dist-partner-share">
            {fmt(partnerEach)} / {fmt(partnerEach)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

export function MemberRow({
  member,
  canManage,
  onRemove,
}: {
  member: ProjectMemberDto
  canManage: boolean
  onRemove: () => void
}) {
  const locale = useLocale()
  const roleLabel = useRoleLabel(member.role)
  return (
    <div className={cn('flex items-center gap-2', member.leftAt && 'opacity-50')}>
      <Link
        to="/profile/$userId"
        params={{ userId: member.userId }}
        className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80 transition-opacity"
      >
        <Avatar className="h-6 w-6 shrink-0">
          {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={member.displayName} />}
          <AvatarFallback className="text-[9px]">
            {getInitialsBySpaceSplit(member.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-none text-blue-500 hover:underline">
            {member.displayName}
          </p>
          {member.leftAt && (
            <p className="text-[10px] text-muted-foreground">
              <Trans>дата виходу: {formatDate(member.leftAt, locale, 'short')}</Trans>
            </p>
          )}
        </div>
      </Link>
      <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="shrink-0 text-[9px]">
        {roleLabel}
      </Badge>
      {canManage && !member.leftAt && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <UserMinus className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

/**
 * Renders the project's *effective team* — a computed view (NOT snapshot at archive).
 * HR/Accountants come from the SENIOR's current team_members (dynamic).
 * Juniors come from THIS project's active project_members.
 *
 * If `project.effectiveTeam` is absent (e.g. response from older API or list endpoint),
 * falls back to the snapshot embedded in `project.members`.
 * See spec §5.2 and §8.
 */
export function ProjectEffectiveTeamCard({
  project,
  viewerRole,
  canManageDrop = false,
  dropCandidates = [],
  onAttachDrop,
  onDetachDrop,
}: {
  project: ProjectDetailDto
  viewerRole?: string | undefined
  canManageDrop?: boolean
  dropCandidates?: { id: string; displayName: string }[]
  onAttachDrop?: () => void
  onDetachDrop?: () => void
}) {
  const { t, i18n } = useLingui()
  const effective = project.effectiveTeam
  const senior = effective?.senior ?? null
  // Drop role - phase 2. Optional drop row in the «Эффективный состав»
  // card. Shown only when `effectiveTeam.drop` is set (the project has a
  // dropId). Regular senior-projects render exactly as before.
  const rawDrop = effective?.drop ?? null
  // RBAC rule: SENIOR viewers must not see DROP identity (same pattern as
  // junior-masking below). UI double-guard — backend computeEffectiveTeam
  // will also mask this server-side once patched, but the client guard
  // ensures drop identity never reaches the render tree regardless.
  const drop = viewerRole === 'SENIOR' || viewerRole === 'JUNIOR' ? null : rawDrop
  const hrs = effective?.hrs ?? []
  const accountants = effective?.accountants ?? []
  // RBAC rule #1: SENIOR viewers must not see JUNIOR identity.
  // Backend already filters juniors[] to [] for SENIOR; UI double-guard for safety.
  const rawJuniors =
    effective?.juniors ?? project.members.filter((m) => m.role === 'JUNIOR' && m.leftAt === null)
  const juniors = viewerRole === 'SENIOR' ? [] : rawJuniors

  // ut-30: flat list — single «Эффективный состав» heading; role-specific
  // section headings («СИНЬОР», «HR (N)», «БУХГАЛТЕРЫ (N)», «ДЖУНЫ (N)») removed.
  // Each row keeps its role badge for visual differentiation.
  // task-admin-as-senior: profileNavigable=false for admin-senior when viewer lacks
  // profile access — renders plain text instead of a navigable link.
  type FlatMember = {
    key: string
    profileId: string
    displayName: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    role: 'SENIOR' | 'DROP' | 'HR' | 'ACCOUNTANT' | 'JUNIOR'
    sectionTestId: string
    profileNavigable?: boolean
  }
  const flatMembers: FlatMember[] = []
  if (senior) {
    flatMembers.push({
      key: `senior-${senior.id}`,
      profileId: senior.id,
      displayName: senior.displayName,
      avatarUrl: senior.avatarUrl,
      avatarDocumentId: senior.avatarDocumentId,
      role: 'SENIOR',
      sectionTestId: 'effective-team-senior',
      // false when admin-senior and viewer lacks profile access (backend sets profileNavigable=false)
      profileNavigable: senior.profileNavigable !== false,
    })
  }
  // Drop role - phase 2. Insert drop directly after senior to keep the
  // financial chain visible at a glance (income → drop → senior → juniors).
  if (drop) {
    flatMembers.push({
      key: `drop-${drop.id}`,
      profileId: drop.id,
      displayName: drop.displayName,
      avatarUrl: drop.avatarUrl,
      avatarDocumentId: drop.avatarDocumentId,
      role: 'DROP',
      sectionTestId: 'effective-team-drop',
    })
  }
  for (const m of hrs) {
    flatMembers.push({
      key: `hr-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      avatarDocumentId: m.avatarDocumentId,
      role: 'HR',
      sectionTestId: 'effective-team-hrs',
    })
  }
  for (const m of accountants) {
    flatMembers.push({
      key: `acc-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      avatarDocumentId: m.avatarDocumentId,
      role: 'ACCOUNTANT',
      sectionTestId: 'effective-team-accountants',
    })
  }
  for (const m of juniors) {
    flatMembers.push({
      key: `jun-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      avatarDocumentId: m.avatarDocumentId,
      role: 'JUNIOR',
      sectionTestId: 'effective-team-juniors',
    })
  }

  return (
    <Card className="border-border/40" data-testid="effective-team-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            <Trans>
              Ефективний склад
              <span className="ml-2 text-[10px] font-normal normal-case text-muted-foreground/60">
                (HR/бухгалтер — з поточної команди сеньйора)
              </span>
            </Trans>
          </CardTitle>
          {/* Attach drop button — only when canManageDrop and no drop yet */}
          {canManageDrop && project.dropId == null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground min-h-[44px] sm:h-7 sm:min-h-0"
                    onClick={onAttachDrop}
                    disabled={dropCandidates.length === 0}
                    data-testid="attach-drop-btn"
                  >
                    <UserPlus className="h-3 w-3" />
                    <Trans>Прив’язати дропа</Trans>
                  </Button>
                </span>
              </TooltipTrigger>
              {dropCandidates.length === 0 && (
                <TooltipContent>
                  <Trans>Немає доступних дропів</Trans>
                </TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {!senior && (
          <p
            className="text-xs text-muted-foreground/60 italic px-2 py-1.5"
            data-testid="effective-team-senior"
          >
            {t`Сеньйор не призначений`}
          </p>
        )}
        {senior && juniors.length === 0 && (
          <p
            className="text-xs text-amber-500/80 font-medium px-2 py-1.5"
            data-testid="effective-team-juniors-empty"
          >
            {t`Джуніор не призначений`}
          </p>
        )}
        {flatMembers.map((m) => {
          // task-admin-as-senior: admin-senior with profileNavigable=false renders
          // as a non-navigable row (plain div) instead of a profile <Link>.
          const isNavigable = m.profileNavigable !== false && viewerRole !== 'DROP'
          const rowContent = (
            <>
              <Avatar className="h-7 w-7 shrink-0">
                {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={m.displayName} />}
                <AvatarFallback className="text-[10px] font-semibold">
                  {getInitialsBySpaceSplit(m.displayName)}
                </AvatarFallback>
              </Avatar>
              {/* MED1: hover:underline only when the row is navigable — a non-clickable
                  div (isNavigable=false) must not show pointer/underline hover style. */}
              <span
                className={`text-sm font-medium truncate flex-1 text-primary${isNavigable ? ' hover:underline' : ''}`}
              >
                {m.displayName}
              </span>
              {/* Drop role - phase 2. DROP gets a distinct blue/info badge so
                  it is visually separable from SENIOR/HR/ACCOUNTANT/JUNIOR. */}
              {m.role === 'DROP' ? (
                <Badge
                  variant="outline"
                  className="border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px]"
                >
                  {i18n._(ROLE_LABEL_MESSAGES.DROP)}
                </Badge>
              ) : (
                <Badge
                  variant={
                    m.role === 'SENIOR'
                      ? 'senior'
                      : m.role === 'HR'
                        ? 'hr'
                        : m.role === 'ACCOUNTANT'
                          ? 'accountant'
                          : 'junior'
                  }
                  className="shrink-0 text-[9px]"
                >
                  {i18n._(ROLE_LABEL_MESSAGES[m.role])}
                </Badge>
              )}
            </>
          )
          // Detach drop button — only for DROP rows when canManageDrop
          const detachBtn =
            m.role === 'DROP' && canManageDrop ? (
              <span className="flex items-center justify-center p-3 -m-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={t`Відв’язати дропа від проєкту`}
                  data-testid="detach-drop-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onDetachDrop?.()
                  }}
                >
                  <UserMinus className="h-3 w-3" />
                </Button>
              </span>
            ) : null

          return isNavigable ? (
            <Link
              key={m.key}
              to="/profile/$userId"
              params={{ userId: m.profileId }}
              data-testid={m.sectionTestId}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors"
            >
              {rowContent}
              {detachBtn}
            </Link>
          ) : (
            <div
              key={m.key}
              data-testid={m.sectionTestId}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
            >
              {rowContent}
              {detachBtn}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
