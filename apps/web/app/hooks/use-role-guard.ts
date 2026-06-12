import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionUser } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { resolveRoleHome } from '@/lib/route-access'

/**
 * Per-page role guard. Redirects a denied viewer to THEIR role home (not a
 * hardcoded dashboard — JUNIOR/DROP have no dashboard access, see task §4).
 * Complements the global layout guard in crm/route.tsx (defense-in-depth):
 * both resolve the redirect target via the same lib/route-access source.
 */
export function useRoleGuard(allowedRoles: SessionUser['role'][]) {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  const denied = !isLoading && !!user && !allowedRoles.includes(user.role)

  useEffect(() => {
    if (denied && user) {
      void navigate({ to: resolveRoleHome(user.role), replace: true })
    }
  }, [denied, user, navigate])

  return { isLoading, denied }
}
