import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { useMe, useUser } from '@/hooks/use-user-profile'
import { AdminActionsMenu } from './admin-actions/AdminActionsMenu'
import { UserProfileHeader } from './UserProfileHeader'
import { AuditLogTab } from './tabs/AuditLogTab'
import { DocumentsTab } from './tabs/DocumentsTab'
import { FinanceTab } from './tabs/FinanceTab'
import { InterviewsTab } from './tabs/InterviewsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { ProjectsTab } from './tabs/ProjectsTab'
import { RequisitesTab } from './tabs/RequisitesTab'
import { TeamTab } from './tabs/TeamTab'

const TAB_LABELS: Record<string, string> = {
  overview: 'Обзор',
  finance: 'Финансы',
  projects: 'Проекты',
  team: 'Команда',
  interviews: 'Собеседования',
  requisites: 'Реквизиты',
  documents: 'Документы',
  audit: 'История',
}

export interface UserProfileShellProps {
  mode: 'self' | 'view'
  userId: string
  tab: string
  onTabChange: (tab: string) => void
}

export function UserProfileShell({
  mode,
  userId,
  tab,
  onTabChange,
}: UserProfileShellProps) {
  const meQuery = useMe(mode === 'self')
  const userQuery = useUser(userId, mode === 'view')
  const query = mode === 'self' ? meQuery : userQuery
  const { data, isLoading } = query

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
  const activeTab =
    permissions.tabs.includes(tab as never) ? tab : (permissions.tabs[0] ?? 'overview')

  return (
    <div className="space-y-6">
      <UserProfileHeader
        user={user}
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

      {permissions.tabs.length > 0 && (
        <div className="space-y-4">
          <div className="sticky top-0 z-10 -mx-1 bg-background py-2">
            <AnimatedTabs
              tabs={permissions.tabs.map((t) => ({ value: t, label: TAB_LABELS[t] ?? t }))}
              value={activeTab}
              onChange={onTabChange}
            />
          </div>

          {activeTab === 'overview' && permissions.tabs.includes('overview') && (
            <OverviewTab user={user} data={viewData as Record<string, unknown>} mode={mode} />
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
        </div>
      )}
    </div>
  )
}
