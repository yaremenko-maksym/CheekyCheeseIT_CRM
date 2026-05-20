import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { PhoneInput } from '@/components/ui/phone-input'
import type { UserProfileDto } from '@crm/shared'
import { useUpdateMe } from '@/hooks/use-user-profile'

export function ProfileEditFields({ user }: { user: UserProfileDto }) {
  const mutation = useUpdateMe()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [displayName, setDisplayName] = useState(user.displayName)
  const [telegram, setTelegram] = useState(user.telegram ?? '')
  const [phone, setPhone] = useState<PhoneValue>((user.phone as PhoneValue | undefined) ?? '' as PhoneValue)
  const [techStack, setTechStack] = useState<string[]>(user.techStack ?? [])
  const [techInput, setTechInput] = useState('')

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  function scheduleSave(patch: Record<string, unknown>) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => mutation.mutate(patch as never), 800)
  }

  function addTech() {
    const t = techInput.trim()
    if (!t || techStack.includes(t)) return
    const next = [...techStack, t]
    setTechStack(next)
    setTechInput('')
    scheduleSave({ techStack: next })
  }
  function removeTech(t: string) {
    const next = techStack.filter((x) => x !== t)
    setTechStack(next)
    scheduleSave({ techStack: next })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="displayName">Имя</Label>
        <Input id="displayName" value={displayName} onChange={(e) => { setDisplayName(e.target.value); scheduleSave({ displayName: e.target.value }) }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="telegram">Telegram</Label>
        <Input id="telegram" placeholder="@username" value={telegram} onChange={(e) => { setTelegram(e.target.value); scheduleSave({ telegram: e.target.value || null }) }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="phone">Телефон</Label>
        <PhoneInput value={phone} onChange={(v) => { const val = v ?? '' as PhoneValue; setPhone(val); scheduleSave({ phone: val || null }) }} />
      </div>
      <div className="space-y-1.5">
        <Label>Технологии</Label>
        <div className="flex flex-wrap gap-2 mb-2">
          {techStack.map((t) => (
            <Badge key={t} variant="outline" className="gap-1">
              {t}
              <button type="button" onClick={() => removeTech(t)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
            </Badge>
          ))}
        </div>
        <Input
          placeholder="Добавить технологию (Enter)"
          value={techInput}
          onChange={(e) => setTechInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTech() } }}
        />
      </div>
    </div>
  )
}
