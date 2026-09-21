import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useAuth } from '@/context/auth'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { PageHeader } from '@/components/crm/StickyPageHeader'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { useRoleLabel } from '@/components/ui/role-select'

export const Route = createFileRoute('/_authenticated/admin')({
  component: AdminTemplatesRoot,
})

function AdminTemplatesRoot() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()
  const location = useRouterState({ select: (s) => s.location })
  const { t } = useLingui()
  const roleLabel = useRoleLabel('ADMIN')

  // `AnimatedTabs`' `label`/`ariaLabel` are plain `string` props (not
  // `MessageDescriptor`) — resolved here, at render time, instead of as a
  // module-level constant (Global Constraints: `t` cannot run at module
  // load).
  const ADMIN_TABS = [
    { value: 'contracts', label: t`Контракти`, ariaLabel: t`Контракти` },
    { value: 'tos', label: t`Умови використання`, ariaLabel: t`Умови використання` },
    // Route key stays `wallet` (avoids route churn); the tab now covers the whole
    // company config — wallet + requisites — so its label is «Компанія».
    { value: 'wallet', label: t`Компанія`, ariaLabel: t`Компанія` },
    { value: 'login-as', label: t`Увійти як`, ariaLabel: t`Увійти як` },
  ]

  // Derive active tab from pathname: /admin/contracts → 'contracts'
  const activeTab =
    ADMIN_TABS.find((tab) => location.pathname.startsWith(`/admin/${tab.value}`))?.value ??
    'contracts'

  // RBAC: non-ADMIN → redirect to dashboard (/) + toast
  useEffect(() => {
    if (isLoading) return
    if (!user) {
      void navigate({ to: '/login' })
      return
    }
    if (user.role !== 'ADMIN') {
      toast.error(t`Розділ доступний лише для ролі «${roleLabel}»`)
      void navigate({ to: '/' })
    }
    // `t`/`roleLabel` deliberately omitted from deps — both read the CURRENT
    // locale on every call (see `i18n._()` singleton note in
    // TosPdfPreview.tsx); including them would just re-run this redirect
    // check on every locale switch for no behavioral difference.
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
          className="mt-2 overflow-x-auto"
          role="navigation"
          aria-label={t`Розділи адміністратора`}
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
              {t`Контракти`}
            </a>
            <a data-testid="admin-templates-tab-tos" href="/admin/tos">
              {t`Умови використання`}
            </a>
            <a data-testid="admin-templates-tab-wallet" href="/admin/wallet">
              {t`Компанія`}
            </a>
            <a data-testid="admin-templates-tab-login-as" href="/admin/login-as">
              {t`Увійти як`}
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
