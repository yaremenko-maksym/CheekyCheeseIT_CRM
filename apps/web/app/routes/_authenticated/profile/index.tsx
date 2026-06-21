import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { z } from 'zod'
import { useAuth } from '@/context/auth'
import { UserProfileShell } from '@/components/user-profile/UserProfileShell'

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

export const Route = createFileRoute('/_authenticated/profile/')({
  validateSearch: searchSchema,
  component: ProfilePage,
})

function ProfilePage() {
  const { user } = useAuth()
  const { tab } = useSearch({ from: '/_authenticated/profile/' })
  const navigate = useNavigate()
  if (!user) return null
  return (
    <UserProfileShell
      mode="self"
      userId={user.id}
      tab={tab}
      onTabChange={(t) => navigate({ to: '/profile', search: { tab: t as typeof tab } })}
    />
  )
}
