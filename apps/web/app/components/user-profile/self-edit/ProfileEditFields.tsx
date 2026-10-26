import { useEffect, useId, useRef, useState } from 'react'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PhoneInput } from '@/components/ui/phone-input'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import type { UserProfileDto } from '@crm/shared'
import { useUpdateMe } from '@/hooks/use-user-profile'
import { seniorTechStackError } from '@/components/users/user-dialog/validation'

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
  const [techError, setTechError] = useState<string | undefined>(undefined)
  const techErrorId = useId()

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  const pendingPatchRef = useRef<Record<string, unknown> | null>(null)

  function scheduleSave(patch: Record<string, unknown>) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    pendingPatchRef.current = patch
    debounceRef.current = setTimeout(() => {
      pendingPatchRef.current = null
      mutation.mutate(patch as never)
    }, 800)
  }

  /** Drops a pending save of an earlier stack, so the server never gets a stack the chips no longer show. */
  function cancelPendingTechStackSave() {
    // A pending patch of another field (name, phone…) is left alone and still saves.
    if (pendingPatchRef.current && 'techStack' in pendingPatchRef.current) {
      // A pending patch always has its timer, so no null check is needed here.
      clearTimeout(debounceRef.current ?? undefined)
      pendingPatchRef.current = null
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

      <div className="space-y-1.5">
        <Label className={techError ? 'text-destructive' : undefined}>
          <Trans>Технології</Trans>
        </Label>
        <TechAutocompleteInput
          value={techStack}
          onChange={(next) => {
            setTechStack(next)
            // A SENIOR below the shared floor is not saved — the API would refuse it — and
            // the message says so (CR-M-1).
            const invalid = seniorTechStackError(user.role, next, user) !== undefined
            setTechError(
              invalid
                ? t`Не збережено: сеньйору потрібно щонайменше 3 різні технології`
                : undefined,
            )
            if (invalid) cancelPendingTechStackSave()
            else scheduleSave({ techStack: next })
          }}
          placeholder={t`Почніть вводити: React, Node.js…`}
          errorId={techError ? techErrorId : undefined}
        />
        {techError && (
          // role="status" (polite): it appears while the user is still editing, so it must not interrupt.
          <p id={techErrorId} role="status" className="text-xs text-destructive">
            {techError}
          </p>
        )}
      </div>
    </div>
  )
}
