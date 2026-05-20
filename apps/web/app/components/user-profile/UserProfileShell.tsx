import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useMe, useUser } from '@/hooks/use-user-profile'
import { AdminActionsMenu } from './admin-actions/AdminActionsMenu'
import { UserProfileHeader } from './UserProfileHeader'
import { AuditLogTab } from './tabs/AuditLogTab'
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
  audit: 'История',
}

export interface UserProfileShellProps {
  mode: 'self' | 'view'
  userId: string
  tab: string
  onTabChange: (tab: string) => void
  onBack?: () => void
}

export function UserProfileShell({
  mode,
  userId,
  tab,
  onTabChange,
  onBack,
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
        {...(onBack ? { onBack } : {})}
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
        <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-4">
          <TabsList className="sticky top-0 z-10 bg-background">
            {permissions.tabs.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t] ?? t}
              </TabsTrigger>
            ))}
          </TabsList>

          {permissions.tabs.includes('overview') && (
            <TabsContent value="overview">
              <OverviewTab user={user} data={viewData as Record<string, unknown>} mode={mode} />
            </TabsContent>
          )}
          {permissions.tabs.includes('finance') && (
            <TabsContent value="finance">
              <FinanceTab userId={user.id} />
            </TabsContent>
          )}
          {permissions.tabs.includes('projects') && (
            <TabsContent value="projects">
              <ProjectsTab userId={user.id} role={user.role} />
            </TabsContent>
          )}
          {permissions.tabs.includes('team') && (
            <TabsContent value="team">
              <TeamTab userId={user.id} />
            </TabsContent>
          )}
          {permissions.tabs.includes('interviews') && (
            <TabsContent value="interviews">
              <InterviewsTab seniorId={user.id} />
            </TabsContent>
          )}
          {permissions.tabs.includes('requisites') && (
            <TabsContent value="requisites">
              <RequisitesTab user={user} mode={mode} />
            </TabsContent>
          )}
          {permissions.tabs.includes('audit') && (
            <TabsContent value="audit">
              <AuditLogTab userId={user.id} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  )
}
