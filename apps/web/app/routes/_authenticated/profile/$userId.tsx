import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { useAuth } from '@/context/auth'
import { UserProfileShell } from '@/components/user-profile/UserProfileShell'
// Security note: the synchronous guard below (before <UserProfileShell>) is a
// client-side defence-in-depth layer. The backend MUST enforce its own RBAC:
// any GET /api/users/:id or profile data endpoint must return 403 for JUNIOR
// accessing another user's data — the frontend guard is UX-only, not the real
// security boundary.

const searchSchema = z.object({
  tab: z
    .enum([
      'overview',
      'finance',
      'projects',
      'team',
      'interviews',
      'requisites',
      'documents',
      'contract',
    ])
    .default('overview'),
})

export const Route = createFileRoute('/_authenticated/profile/$userId')({
  validateSearch: searchSchema,
  component: UserDetailPage,
})

function UserDetailPage() {
  const { userId } = Route.useParams()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { user } = useAuth()

  // JUNIOR may only view their own profile. Any attempt to navigate to a
  // foreign profile (e.g. via a link in ProjectRow or TeamTab) silently
  // redirects back to /profile (own data).
  useEffect(() => {
    if (user?.role === 'JUNIOR' && userId !== user.id) {
      void navigate({ to: '/profile', replace: true })
    }
  }, [user, userId, navigate])

  // While the redirect fires (or if user is not loaded yet) render nothing
  // to avoid a flash of foreign profile data.
  if (user?.role === 'JUNIOR' && userId !== user.id) return null

  return (
    <UserProfileShell
      mode="view"
      userId={userId}
      tab={tab}
      onTabChange={(t) => navigate({ search: { tab: t as typeof tab } })}
    />
  )
}
