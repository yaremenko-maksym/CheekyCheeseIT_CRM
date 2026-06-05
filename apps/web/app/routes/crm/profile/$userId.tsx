import { createFileRoute, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { z } from 'zod'
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

export const Route = createFileRoute('/crm/profile/$userId')({
  validateSearch: searchSchema,
  component: UserDetailPage,
})

function UserDetailPage() {
  const { userId } = useParams({ from: '/crm/profile/$userId' })
  const { tab } = useSearch({ from: '/crm/profile/$userId' })
  const navigate = useNavigate({ from: '/crm/profile/$userId' })

  return (
    <UserProfileShell
      mode="view"
      userId={userId}
      tab={tab}
      onTabChange={(t) => navigate({ search: { tab: t as typeof tab } })}
    />
  )
}
