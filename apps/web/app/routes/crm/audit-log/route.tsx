import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/context/auth'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/crm/audit-log')({
  component: AuditLogRoot,
})

/**
 * RBAC layout guard for /crm/audit-log.
 * Only ACCOUNTANT and ADMIN can access this section.
 * Other roles → redirect to /crm/dashboard with a toast.
 */
function AuditLogRoot() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (isLoading) return
    if (!user) {
      void navigate({ to: '/crm/login' })
      return
    }
    if (user.role !== 'ADMIN' && user.role !== 'ACCOUNTANT') {
      toast.error('Доступ только для ADMIN и ACCOUNTANT')
      void navigate({ to: '/crm/dashboard' })
    }
  }, [user, isLoading, navigate])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!user || (user.role !== 'ADMIN' && user.role !== 'ACCOUNTANT')) return null

  return <Outlet />
}
