import { useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type { CreateProjectDto, ProjectDto, ItDomain } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ImageUploadField } from '@/components/ui/image-upload-field'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'

type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const _ROLE_LABELS: Record<string, string> = {
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

function UserChip({ user, onRemove }: { user: UserOption; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 pl-1 pr-1.5 py-0.5">
      <Avatar className="h-5 w-5 shrink-0">
        {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.displayName} />}
        <AvatarFallback className="text-[9px]">{getInitials(user.displayName)}</AvatarFallback>
      </Avatar>
      <span className="text-xs font-medium">{user.displayName}</span>
      <button onClick={onRemove} className="text-muted-foreground hover:text-foreground ml-0.5">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

function MemberPicker({
  label,
  roles,
  allUsers,
  selected,
  onAdd,
  onRemove,
  single = false,
}: {
  label: string
  roles: string[]
  allUsers: UserOption[]
  selected: UserOption[]
  onAdd: (u: UserOption) => void
  onRemove: (id: string) => void
  single?: boolean
}) {
  const available = allUsers.filter(
    (u) => roles.includes(u.role) && !selected.some((s) => s.id === u.id),
  )

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5 min-h-8">
        {selected.map((u) => (
          <UserChip key={u.id} user={u} onRemove={() => onRemove(u.id)} />
        ))}
      </div>
      {(!single || selected.length === 0) && available.length > 0 && (
        <select
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          value=""
          onChange={(e) => {
            const u = allUsers.find((u) => u.id === e.target.value)
            if (u) onAdd(u)
          }}
        >
          <option value="">— добавить —</option>
          {available.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

export function CreateProjectFromHiredDialog({
  open,
  onClose,
  seniorId,
  seniorName,
  companyName,
}: {
  open: boolean
  onClose: () => void
  seniorId: string
  seniorName: string
  companyName: string
}) {
  const queryClient = useQueryClient()

  const [hrMembers, setHrMembers] = useState<UserOption[]>([])
  const [accountants, setAccountants] = useState<UserOption[]>([])
  const [juniors, setJuniors] = useState<UserOption[]>([])

  const { data: allUsers = [] } = useQuery<UserOption[]>({
    queryKey: ['users'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  const createMutation = useMutation({
    mutationFn: (data: CreateProjectDto) =>
      api.post<ProjectDto>('/projects', data).then((r) => r.data),
    onSuccess: () => {
      // Инвалидируем список проектов — новый проект должен появиться сразу
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const form = useForm({
    defaultValues: {
      name: companyName,
      companyName,
      domain: 'Other' as ItDomain,
      logoDocumentId: null as string | null,
      logoExternalUrl: null as string | null,
      rate: '' as unknown as number,
      currency: 'USDT' as 'USDT' | 'USD' | 'EUR' | 'UAH',
      startDate: new Date().toISOString().slice(0, 10),
    },
    onSubmit: async ({ value }) => {
      const project = await createMutation.mutateAsync({
        name: value.name.trim(),
        companyName: value.companyName.trim(),
        domain: value.domain,
        logoDocumentId: value.logoDocumentId,
        logoExternalUrl: value.logoExternalUrl,
        seniorId,
        rate: Number(value.rate),
        currency: value.currency,
        startDate: new Date(value.startDate).toISOString(),
      })

      const membersToAdd = [...hrMembers, ...accountants, ...juniors]
      for (const member of membersToAdd) {
        await api.post(`/projects/${project.id}/members`, { userId: member.id })
      }

      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
  })

  const isPending = createMutation.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>Создать проект — {seniorName}</DialogTitle>
          <DialogDescription className="sr-only">Создание проекта</DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Логотип компании</Label>
              <ImageUploadField
                value={{
                  documentId: (form.state.values as { logoDocumentId: string | null })
                    .logoDocumentId,
                  externalUrl: (form.state.values as { logoExternalUrl: string | null })
                    .logoExternalUrl,
                }}
                onChange={(v) => {
                  form.setFieldValue('logoDocumentId', v.documentId)
                  form.setFieldValue('logoExternalUrl', v.externalUrl)
                }}
                category="LOGO"
                urlPlaceholder="https://example.com/logo.png"
                testId="hired-create-project-logo"
              />
            </div>

            <form.Field
              name="name"
              validators={{
                onBlur: ({ value }) => {
                  const r = createProjectSchema.shape.name.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <div className="space-y-1.5">
                    <Label className={cn(err && 'text-destructive')}>Название проекта</Label>
                    <Input
                      value={field.state.value as string}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="AI Platform v2"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </form.Field>

            <form.Field
              name="companyName"
              validators={{
                onBlur: ({ value }) => {
                  const r = createProjectSchema.shape.companyName.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <div className="space-y-1.5">
                    <Label className={cn(err && 'text-destructive')}>Компания</Label>
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="TechCorp AI"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </form.Field>

            <form.Field name="domain">
              {(field) => (
                <div className="space-y-1.5">
                  <Label>Домен</Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value as ItDomain)}
                  >
                    {IT_DOMAINS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </form.Field>

            <form.Subscribe
              selector={(s) => ({ rate: s.values.rate, currency: s.values.currency })}
            >
              {({ rate, currency }) => (
                <AmountCurrencyInput
                  amount={String(rate ?? '')}
                  currency={currency as Currency}
                  onAmountChange={(v) => form.setFieldValue('rate', Number(v) as unknown as number)}
                  onCurrencyChange={(v) =>
                    form.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')
                  }
                  label="Ставка"
                  placeholder="5000"
                />
              )}
            </form.Subscribe>

            <form.Field name="startDate">
              {(field) => (
                <div className="space-y-1.5">
                  <Label>Дата начала</Label>
                  <Input
                    type="date"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </div>
              )}
            </form.Field>

            <div className="border-t border-border pt-3 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Участники
              </p>

              <MemberPicker
                label="HR"
                roles={['HR']}
                allUsers={allUsers}
                selected={hrMembers}
                onAdd={(u) => setHrMembers((prev) => [...prev, u])}
                onRemove={(id) => setHrMembers((prev) => prev.filter((u) => u.id !== id))}
              />

              <MemberPicker
                label="Бухгалтер"
                roles={['ACCOUNTANT']}
                allUsers={allUsers}
                selected={accountants}
                onAdd={(u) => setAccountants([u])}
                onRemove={(id) => setAccountants((prev) => prev.filter((u) => u.id !== id))}
                single
              />

              <MemberPicker
                label="Джун"
                roles={['JUNIOR']}
                allUsers={allUsers}
                selected={juniors}
                onAdd={(u) => setJuniors((prev) => [...prev, u])}
                onRemove={(id) => setJuniors((prev) => prev.filter((u) => u.id !== id))}
              />
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <span className="text-xs text-muted-foreground">Синьор:</span>
              <Badge variant="senior" className="text-xs">
                {seniorName}
              </Badge>
            </div>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={isPending}>
            {isPending ? 'Создание...' : 'Создать проект'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
