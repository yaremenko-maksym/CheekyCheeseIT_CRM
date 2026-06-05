import { useState } from 'react'
import { UsersRound } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { useMe, useUser } from '@/hooks/use-user-profile'
import { useActiveTeam } from '@/hooks/use-active-team'
import { RejoinTeamDialog } from '@/components/users/RejoinTeamDialog'
import { AdminActionsMenu } from './admin-actions/AdminActionsMenu'
import { AvatarUploadDialog } from './AvatarUploadDialog'
import { UserProfileHeader } from './UserProfileHeader'
import { AuditLogTab } from './tabs/AuditLogTab'
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
  audit: 'История',
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
  const { data, isLoading } = query
  const [avatarOpen, setAvatarOpen] = useState(false)
  // Drop role - phase 1 (AC7): track teamless SENIOR state. Banner is
  // shown only on the self-profile of a teamless SENIOR.
  const { isTeamless: isTeamlessSenior } = useActiveTeam()
  const [rejoinOpen, setRejoinOpen] = useState(false)

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
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

      {permissions.tabs.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* Tab bar: horizontal scroll for many tabs on narrow viewports; pb-1
              keeps the pill's shadow from being clipped by overflow-x-auto. */}
          <div className="relative overflow-x-auto pb-1">
            <AnimatedTabs
              tabs={permissions.tabs.map((t) => ({ value: t, label: tabLabel(t) }))}
              value={activeTab}
              onChange={onTabChange}
            />
          </div>

          {/* Content area scrolls naturally via the parent `<main>` (overflow-y-auto in /crm route).
              No overflow-hidden here — that was blocking the scroll for long tabs (e.g. Audit). */}
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
            {activeTab === 'audit' && permissions.tabs.includes('audit') && (
              <AuditLogTab userId={user.id} />
            )}
            {activeTab === 'contract' && permissions.tabs.includes('contract') && (
              <ContractTab userId={user.id} targetRole={user.role} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
