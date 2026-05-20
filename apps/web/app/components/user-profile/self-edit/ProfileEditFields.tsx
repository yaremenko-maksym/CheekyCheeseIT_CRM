import { useEffect, useRef, useState } from 'react'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PhoneInput } from '@/components/ui/phone-input'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import type { UserProfileDto } from '@crm/shared'
import { useUpdateMe } from '@/hooks/use-user-profile'

export function ProfileEditFields({ user }: { user: UserProfileDto }) {
  const mutation = useUpdateMe()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [displayName, setDisplayName] = useState(user.displayName)
  const [telegram, setTelegram] = useState(user.telegram ?? '')
  const [phone, setPhone] = useState<PhoneValue>((user.phone as PhoneValue | undefined) ?? '' as PhoneValue)
  const [techStack, setTechStack] = useState<string[]>(user.techStack ?? [])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  function scheduleSave(patch: Record<string, unknown>) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => mutation.mutate(patch as never), 800)
  }

  return (
    <div className="space-y-4">
      {/* Email read-only — auth-controlled, can't be edited from CRM */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="displayName">Имя</Label>
          <Input
            id="displayName"
            value={displayName}
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
            value={user.email}
            disabled
            readOnly
            aria-describedby="email-help"
            className="cursor-not-allowed"
          />
          <p id="email-help" className="text-xs text-muted-foreground">
            Email привязан к Google-аккаунту и не может быть изменён
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="telegram">Telegram</Label>
          <Input
            id="telegram"
            placeholder="@username"
            value={telegram}
            onChange={(e) => {
              setTelegram(e.target.value)
              scheduleSave({ telegram: e.target.value || null })
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Телефон</Label>
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
        <Label>Технологии</Label>
        <TechAutocompleteInput
          value={techStack}
          onChange={(next) => {
            setTechStack(next)
            scheduleSave({ techStack: next })
          }}
          placeholder="Начните вводить, например: Re..."
        />
      </div>
    </div>
  )
}
