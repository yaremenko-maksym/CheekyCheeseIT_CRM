import type { UserProfileDto } from '@crm/shared'
import { useUnarchiveUser } from '@/hooks/use-user-profile'
import { UserRow, type UserRowProps } from './UserRow'

type Props = Omit<UserRowProps, 'onUnarchive'> & {
  user: UserProfileDto
}

/**
 * Per-row wrapper that binds `useUnarchiveUser(userId, { isSenior })` to the
 * row's Restore button. This keeps the parent table free of per-row hook
 * instantiation while sharing the same unarchive mutation logic as
 * `AdminActionsMenu` (toast messages, query invalidations, senior pair handling).
 */
export function UnarchiveButton(props: Props) {
  const { user } = props
  const unarchive = useUnarchiveUser(user.id, { isSenior: user.role === 'SENIOR' })
  return <UserRow {...props} onUnarchive={() => unarchive.mutate()} />
}
