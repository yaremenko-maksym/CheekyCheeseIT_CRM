import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionUser } from '@crm/shared'
import { useAuth } from '@/context/auth'

export function useRoleGuard(allowedRoles: SessionUser['role'][]) {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  const denied = !isLoading && !!user && !allowedRoles.includes(user.role)

  useEffect(() => {
    if (denied) {
      void navigate({ to: '/crm/dashboard', replace: true })
    }
  }, [denied, navigate])

  return { isLoading, denied }
}
