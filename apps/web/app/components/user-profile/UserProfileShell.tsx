import { useCallback, useRef, useState } from 'react'
import { ShieldOff, UsersRound } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { useMe, useUser } from '@/hooks/use-user-profile'
import { useActiveTeam } from '@/hooks/use-active-team'
import { RejoinTeamDialog } from '@/components/users/RejoinTeamDialog'
import { AdminActionsMenu } from './admin-actions/AdminActionsMenu'
import { AvatarUploadDialog } from './AvatarUploadDialog'
import { UserProfileHeader } from './UserProfileHeader'
import { DocumentsTab } from './tabs/DocumentsTab'
import { FinanceTab } from './tabs/FinanceTab'
import { InterviewsTab } from './tabs/InterviewsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { ProjectsTab } from './tabs/ProjectsTab'
import { RequisitesTab } from './tabs/RequisitesTab'
import { TeamTab } from './tabs/TeamTab'
import { ContractTab } from './contract/ContractTab'

const TAB_LABELS: Record<string, string> = {
  overview: 'Обзор',
  finance: 'Финансы',
  projects: 'Проекты',
  team: 'Команда',
  interviews: 'Собеседования',
  requisites: 'Реквизиты',
  documents: 'Документы',
  contract: 'Контракт',
}

export interface UserProfileShellProps {
  mode: 'self' | 'view'
  userId: string
  tab: string
  onTabChange: (tab: string) => void
}

export function UserProfileShell({ mode, userId, tab, onTabChange }: UserProfileShellProps) {
  const meQuery = useMe(mode === 'self')
  const userQuery = useUser(userId, mode === 'view')
  const query = mode === 'self' ? meQuery : userQuery
  const { data, isLoading, isError, error } = query
  const [avatarOpen, setAvatarOpen] = useState(false)
  // Dirty guard: ContractTab registers its isDirty state here via onDirtyChange.
  // When the user tries to switch tabs away from contract with unsaved changes,
  // we show an AlertDialog (consistent with ContractActionBar UX, no event-loop block).
  const contractDirtyRef = useRef(false)
  const [dirtyGuardOpen, setDirtyGuardOpen] = useState(false)
  const pendingTabRef = useRef<string | null>(null)
  const handleContractDirtyChange = useCallback((dirty: boolean) => {
    contractDirtyRef.current = dirty
  }, [])
  const handleTabChange = useCallback(
    (nextTab: string) => {
      if (tab === 'contract' && contractDirtyRef.current) {
        pendingTabRef.current = nextTab
        setDirtyGuardOpen(true)
        return
      }
      onTabChange(nextTab)
    },
    [tab, onTabChange],
  )
  const handleDirtyGuardConfirm = useCallback(() => {
    const next = pendingTabRef.current
    pendingTabRef.current = null
    setDirtyGuardOpen(false)
    if (next) onTabChange(next)
  }, [onTabChange])
  const handleDirtyGuardCancel = useCallback(() => {
    pendingTabRef.current = null
    setDirtyGuardOpen(false)
  }, [])
  // Drop role - phase 1 (AC7): track teamless SENIOR state. Banner is
  // shown only on the self-profile of a teamless SENIOR.
  const { isTeamless: isTeamlessSenior } = useActiveTeam()
  const [rejoinOpen, setRejoinOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    const is403 =
      error != null &&
      typeof error === 'object' &&
      'response' in error &&
      (error as { response?: { status?: number } }).response?.status === 403
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-xl font-semibold">{is403 ? 'Нет доступа' : 'Профиль не найден'}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {is403
            ? 'У вас нет прав для просмотра этого профиля.'
            : 'Пользователь не найден или был удалён.'}
        </p>
      </div>
    )
  }

  const { user, permissions, data: viewData } = data
  const activeTab = permissions.tabs.includes(tab as never)
    ? tab
    : (permissions.tabs[0] ?? 'overview')

  // ADMIN looking at own profile: hide "registration date" line (matches hidden KPI cards)
  const showCreatedAt =
    permissions.fields.registrationDate !== false && !(mode === 'self' && user.role === 'ADMIN')
  // Any SENIOR profile (self or viewed by ADMIN) surfaces the kanban board
  // link in the header — the dedicated 'interviews' tab was removed.
  const showInterviewsLink = user.role === 'SENIOR'

  // JUNIOR sees a single project, not a portfolio — relabel tab
  const tabLabel = (t: string): string => {
    if (t === 'projects' && user.role === 'JUNIOR') return 'Проект'
    return TAB_LABELS[t] ?? t
  }

  return (
    <div className="space-y-6">
      <UserProfileHeader
        user={user}
        showCreatedAt={showCreatedAt}
        showInterviewsLink={showInterviewsLink}
        onAvatarClick={mode === 'self' ? () => setAvatarOpen(true) : undefined}
        actionsSlot={
          permissions.actions.length > 0 ? (
            <AdminActionsMenu
              userId={userId}
              user={user}
              actions={permissions.actions as import('@crm/shared').ActionKey[]}
            />
          ) : null
        }
      />
      {mode === 'self' && (
        <AvatarUploadDialog
          open={avatarOpen}
          onClose={() => setAvatarOpen(false)}
          userId={user.id}
          avatarDocumentId={user.avatarDocumentId ?? null}
          avatarUrl={user.avatarUrl}
        />
      )}

      {/* Drop role - phase 1 (AC7): teamless SENIOR banner. Surfaces
          the rejoin-team CTA on self-profile only — view-mode profile
          for other users intentionally hides it. */}
      {mode === 'self' && user.role === 'SENIOR' && isTeamlessSenior && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
          data-testid="profile-teamless-banner"
        >
          <div className="flex items-start gap-3">
            <UsersRound className="h-5 w-5 text-amber-500/80 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="text-sm font-medium">У вас нет активной команды</p>
              <p className="text-xs text-muted-foreground">
                Создайте свою команду или присоединитесь к команде дропа, чтобы вернуть доступ к
                проектам и собеседованиям.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setRejoinOpen(true)} data-testid="profile-rejoin-button">
            Создать или выбрать команду
          </Button>
        </div>
      )}
      {mode === 'self' && (
        <RejoinTeamDialog open={rejoinOpen} onClose={() => setRejoinOpen(false)} />
      )}

      {/* Dirty guard — replaces window.confirm for consistent non-blocking UX */}
      <AlertDialog open={dirtyGuardOpen} onOpenChange={setDirtyGuardOpen}>
        <AlertDialogContent data-testid="contract-dirty-guard-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Покинуть вкладку «Контракт»?</AlertDialogTitle>
            <AlertDialogDescription>
              Есть несохранённые изменения. При переходе они будут потеряны.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDirtyGuardCancel}>Остаться</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDirtyGuardConfirm}
              data-testid="contract-dirty-guard-confirm"
            >
              Покинуть
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {permissions.tabs.length === 0 && mode === 'view' && (
        <div
          className="rounded-lg border border-border bg-muted/40 px-6 py-10 text-center"
          data-testid="profile-no-access"
        >
          <p className="text-sm text-muted-foreground">Нет доступа к этому профилю</p>
        </div>
      )}

      {permissions.tabs.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* Tab bar: horizontal scroll for many tabs on narrow viewports; pb-1
              keeps the pill's shadow from being clipped by overflow-x-auto. */}
          <div className="relative overflow-x-auto pb-1">
            <AnimatedTabs
              tabs={permissions.tabs.map((t) => ({ value: t, label: tabLabel(t) }))}
              value={activeTab}
              onChange={handleTabChange}
            />
          </div>

          {/* Content area scrolls naturally via the parent `<main>` (overflow-y-auto in /crm route).
              No overflow-hidden here — that was blocking the scroll for long tabs. */}
          <div className="min-w-0 flex-1">
            {activeTab === 'overview' && permissions.tabs.includes('overview') && (
              <OverviewTab
                user={user}
                data={viewData as Record<string, unknown>}
                permissions={permissions}
                mode={mode}
              />
            )}
            {activeTab === 'finance' && permissions.tabs.includes('finance') && (
              <FinanceTab userId={user.id} />
            )}
            {activeTab === 'projects' && permissions.tabs.includes('projects') && (
              <ProjectsTab userId={user.id} role={user.role} />
            )}
            {activeTab === 'team' && permissions.tabs.includes('team') && (
              <TeamTab userId={user.id} />
            )}
            {activeTab === 'interviews' && permissions.tabs.includes('interviews') && (
              <InterviewsTab seniorId={user.id} />
            )}
            {activeTab === 'requisites' && permissions.tabs.includes('requisites') && (
              <RequisitesTab user={user} mode={mode} />
            )}
            {activeTab === 'documents' && permissions.tabs.includes('documents') && (
              <DocumentsTab />
            )}
            {activeTab === 'contract' && permissions.tabs.includes('contract') && (
              <ContractTab
                userId={user.id}
                targetRole={user.role}
                onDirtyChange={handleContractDirtyChange}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
