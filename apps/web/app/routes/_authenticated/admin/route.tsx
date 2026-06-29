import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '@/context/auth'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { PageHeader } from '@/components/crm/StickyPageHeader'
import { AnimatedTabs } from '@/components/ui/animated-tabs'

export const Route = createFileRoute('/_authenticated/admin')({
  component: AdminTemplatesRoot,
})

const ADMIN_TABS = [
  { value: 'contracts', label: 'Контракты', ariaLabel: 'Контракты' },
  { value: 'tos', label: 'Terms of Service', ariaLabel: 'Terms of Service' },
  // Route key stays `wallet` (avoids route churn); the tab now covers the whole
  // company config — wallet + requisites — so its label is «Компания».
  { value: 'wallet', label: 'Компания', ariaLabel: 'Компания' },
]

function AdminTemplatesRoot() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()
  const location = useRouterState({ select: (s) => s.location })

  // Derive active tab from pathname: /admin/contracts → 'contracts'
  const activeTab =
    ADMIN_TABS.find((t) => location.pathname.startsWith(`/admin/${t.value}`))?.value ?? 'contracts'

  // RBAC: non-ADMIN → redirect to dashboard (/) + toast
  useEffect(() => {
    if (isLoading) return
    if (!user) {
      void navigate({ to: '/login' })
      return
    }
    if (user.role !== 'ADMIN') {
      toast.error('Доступ только для ADMIN')
      void navigate({ to: '/' })
    }
  }, [user, isLoading, navigate])

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
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
        {/* Animated tab navigation — pill animation via framer-motion */}
        <div
          className="mt-2"
          role="navigation"
          aria-label="Разделы администратора"
          data-testid="admin-tabs-nav"
        >
          <AnimatedTabs
            tabs={ADMIN_TABS}
            value={activeTab}
            onChange={(value) => {
              void navigate({ to: `/admin/${value}` as '/admin/contracts' })
            }}
          />
          {/* Hidden links preserve data-testid compatibility for any E2E that targets tabs */}
          <span className="sr-only">
            <a data-testid="admin-templates-tab-contracts" href="/admin/contracts">
              Контракты
            </a>
            <a data-testid="admin-templates-tab-tos" href="/admin/tos">
              Terms of Service
            </a>
            <a data-testid="admin-templates-tab-wallet" href="/admin/wallet">
              Компания
            </a>
          </span>
        </div>
      </PageHeader>

      {/* Child route content scrolls here */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <Outlet />
      </div>
    </div>
  )
}
