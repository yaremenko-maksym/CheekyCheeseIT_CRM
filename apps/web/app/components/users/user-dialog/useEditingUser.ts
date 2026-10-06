import { useMemo } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { useUser } from '@/hooks/use-user-profile'

type UseEditingUserArgs = {
  isEdit: boolean
  open: boolean
  /** Slim list-item (`props.user` in edit mode); null/undefined otherwise. */
  listUser: UserProfileDto | null | undefined
}

/**
 * Resolves the full editing user.
 *
 * Slim list payload (GET /api/users) deliberately omits PII / finance fields
 * (bankUah*, wallet*, paymentMethod, monthlySalary, registrationAddress,
 * …). For the edit form to prefill those, fetch the full
 * single-resource profile (GET /api/users/:id → buildProfileView). The ADMIN
 * viewer sees every field unmasked there. Until it loads we fall back to the
 * list-item so identity (name/email/role) renders instantly.
 *
 * `fullProfileLoadedId` is a marker used to re-trigger `form.reset` once the
 * full /:id profile lands: null while only the slim list-item is available,
 * then the user id.
 */
export function useEditingUser({ isEdit, open, listUser }: UseEditingUserArgs) {
  const { data: fullProfile } = useUser(listUser?.id, isEdit && open && !!listUser?.id)
  const editingUser: UserProfileDto | null = useMemo(() => {
    if (!isEdit || !listUser) return null
    // buildProfileView returns `{ user, permissions, data }`; `.user` is the
    // full UserProfileDto for an ADMIN viewer. Merge over the list-item so the
    // form has every requisite / salary / PII field for prefill.
    if (fullProfile?.user && fullProfile.user.id === listUser.id) {
      return { ...listUser, ...(fullProfile.user as UserProfileDto) }
    }
    return listUser
  }, [isEdit, listUser, fullProfile])

  const fullProfileLoadedId =
    fullProfile?.user && fullProfile.user.id === listUser?.id ? fullProfile.user.id : null

  return { editingUser, fullProfileLoadedId }
}
