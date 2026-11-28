import { useEffect, useRef, useState } from 'react'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PhoneInput } from '@/components/ui/phone-input'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import type { SeniorSelectableRole, UserProfileDto } from '@crm/shared'
import { useUpdateMe } from '@/hooks/use-user-profile'
import { RolesSection } from '@/components/users/user-dialog/RolesSection'

export function ProfileEditFields({ user }: { user: UserProfileDto }) {
  const { t } = useLingui()
  const mutation = useUpdateMe()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [displayName, setDisplayName] = useState(user.displayName)
  const [telegram, setTelegram] = useState(user.telegram ?? '')
  const [phone, setPhone] = useState<PhoneValue>(
    (user.phone as PhoneValue | undefined) ?? ('' as PhoneValue),
  )
  const [techStack, setTechStack] = useState<string[]>(user.techStack ?? [])
  const [technicalRoles, setTechnicalRoles] = useState<SeniorSelectableRole[]>(
    user.technicalRoles as SeniorSelectableRole[],
  )
  const [rolesError, setRolesError] = useState<string | undefined>(undefined)

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  const pendingPatchRef = useRef<Record<string, unknown> | null>(null)

  function scheduleSave(patch: Record<string, unknown>) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    // One slot, merged: an edit of another field within the debounce is kept, not overwritten (QA-L-3).
    const merged = { ...pendingPatchRef.current, ...patch }
    pendingPatchRef.current = merged
    debounceRef.current = setTimeout(() => {
      pendingPatchRef.current = null
      mutation.mutate(merged as never)
    }, 800)
  }

  /** Drops a pending save of earlier roles, so the server never gets roles the chips no longer show. */
  function cancelPendingRolesSave() {
    const pending = pendingPatchRef.current
    if (pending && 'technicalRoles' in pending) {
      // A pending patch always has its timer, so no null check is needed here.
      clearTimeout(debounceRef.current ?? undefined)
      pendingPatchRef.current = null
      // Other fields in the same pending save (name, phone…) still go out.
      const { technicalRoles: _dropped, ...rest } = pending
      if (Object.keys(rest).length > 0) scheduleSave(rest)
    }
  }

  return (
    <div className="space-y-4">
      {/* Email read-only — auth-controlled, can't be edited from CRM */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="displayName">
            <Trans>Ім’я та прізвище</Trans>
          </Label>
          <Input
            id="displayName"
            value={displayName}
            autoCapitalize="words"
            autoComplete="name"
            onChange={(e) => {
              setDisplayName(e.target.value)
              scheduleSave({ displayName: e.target.value })
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={user.email}
            disabled
            readOnly
            aria-describedby="email-help"
            className="cursor-not-allowed"
          />
          <p id="email-help" className="text-xs text-muted-foreground">
            <Trans>Email прив’язано до облікового запису Google і не можна змінити</Trans>
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="telegram">Telegram</Label>
          <Input
            id="telegram"
            placeholder="@username"
            value={telegram}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setTelegram(e.target.value)
              scheduleSave({ telegram: e.target.value || null })
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">
            <Trans>Телефон</Trans>
          </Label>
          <PhoneInput
            value={phone}
            onChange={(v) => {
              const val = v ?? ('' as PhoneValue)
              setPhone(val)
              scheduleSave({ phone: val || null })
            }}
          />
        </div>
      </div>

      {user.role === 'SENIOR' ? (
        <RolesSection
          value={technicalRoles}
          announce="status"
          error={rolesError}
          onChange={(next) => {
            setTechnicalRoles(next)
            // A SENIOR with no roles is not saved — the API would refuse it — and the message says
            // so (CR-M-1). The roles are canonically sorted, never `[]` on the wire.
            if (next.length === 0) {
              setRolesError(t`Не збережено: сеньйору потрібна щонайменше одна технічна роль`)
              cancelPendingRolesSave()
            } else {
              setRolesError(undefined)
              scheduleSave({ technicalRoles: next })
            }
          }}
        />
      ) : (
        <div className="space-y-1.5">
          <Label>
            <Trans>Технології</Trans>
          </Label>
          <TechAutocompleteInput
            value={techStack}
            onChange={(next) => {
              setTechStack(next)
              scheduleSave({ techStack: next })
            }}
            placeholder={t`Почніть вводити: React, Node.js…`}
          />
        </div>
      )}
    </div>
  )
}
