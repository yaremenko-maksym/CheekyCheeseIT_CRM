import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '@/context/auth'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { PageHeader } from '@/components/crm/StickyPageHeader'

export const Route = createFileRoute('/crm/admin/templates')({
  component: AdminTemplatesRoot,
})

function AdminTemplatesRoot() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  // RBAC: non-ADMIN → redirect to dashboard (/crm) + toast
  useEffect(() => {
    if (isLoading) return
    if (!user) {
      void navigate({ to: '/crm/login' })
      return
    }
    if (user.role !== 'ADMIN') {
      toast.error('Доступ только для ADMIN')
      void navigate({ to: '/crm' })
    }
  }, [user, isLoading, navigate])

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Редактор шаблонов</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Управление шаблонами контрактов и Terms of Service
            </p>
          </div>
        </PageHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    )
  }

  if (!user || user.role !== 'ADMIN') return null

  return (
    <div className="flex flex-col h-full">
      <PageHeader>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Редактор шаблонов</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Управление шаблонами контрактов и Terms of Service
          </p>
        </div>

        {/* Tab navigation */}
        <nav
          className="mt-2 flex gap-1 rounded-lg border border-border/60 bg-muted/40 p-1 w-fit"
          aria-label="Разделы редактора"
        >
          <Link
            to="/crm/admin/templates/contracts"
            className="rounded-md px-4 py-1.5 text-sm font-medium transition-colors hover:bg-background hover:text-foreground text-muted-foreground [&.active]:bg-background [&.active]:text-foreground [&.active]:shadow-sm"
            data-testid="admin-templates-tab-contracts"
          >
            Контракты
          </Link>
          <Link
            to="/crm/admin/templates/tos"
            className="rounded-md px-4 py-1.5 text-sm font-medium transition-colors hover:bg-background hover:text-foreground text-muted-foreground [&.active]:bg-background [&.active]:text-foreground [&.active]:shadow-sm"
            data-testid="admin-templates-tab-tos"
          >
            Terms of Service
          </Link>
        </nav>
      </PageHeader>

      {/* Child route content scrolls here */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <Outlet />
      </div>
    </div>
  )
}
