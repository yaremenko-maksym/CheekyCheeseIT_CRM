import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ExternalLink, Mail, Save, Send } from 'lucide-react'
import { useEffect } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { toast } from 'sonner'
import { z } from 'zod'
import type { UserProfileDto } from '@crm/shared'
import { updateProfileSchema } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PhoneInput } from '@/components/ui/phone-input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/crm/profile')({
  component: ProfilePage,
})

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
}

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function normalizeTelegram(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

function ProfilePage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const { data: profile, isLoading } = useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => api.get<UserProfileDto>('/users/me').then((r) => r.data),
    enabled: !!user,
  })

  const updateMutation = useMutation({
    mutationFn: (data: { telegram: string | null; phone: string | null }) =>
      api.patch('/users/me', data).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'me'] })
      toast.success('Профиль обновлён')
    },
    onError: () => toast.error('Ошибка при сохранении'),
  })

  const form = useForm({
    defaultValues: {
      telegram: '',
      phone: '' as PhoneValue | '',
    },
    onSubmit: async ({ value }) => {
      const tg = value.telegram.trim()
      const normalized = tg ? normalizeTelegram(tg) : null
      const phone = (value.phone as string) || null
      updateMutation.mutate({ telegram: normalized, phone })
    },
  })

  useEffect(() => {
    if (profile) {
      form.setFieldValue('telegram', profile.telegram ?? '')
      form.setFieldValue('phone', (profile.phone as PhoneValue | undefined) ?? '')
    }
  }, [profile])

  if (isLoading || !profile) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
      className="space-y-6"
    >
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Мой профиль</h1>
        <p className="text-sm text-muted-foreground">Личные данные и контакты</p>
      </div>

      {/* Identity card */}
      <Card>
        <CardContent className="flex items-center gap-6 pt-6">
          <Avatar className="h-20 w-20 shrink-0">
            {profile.avatar && <AvatarImage src={profile.avatar} alt={profile.displayName} />}
            <AvatarFallback className="text-xl">{getInitials(profile.displayName)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-semibold">{profile.displayName}</p>
            <Badge variant={ROLE_VARIANT[profile.role] ?? 'outline'} className="mt-1">
              {ROLE_LABELS[profile.role] ?? profile.role}
            </Badge>
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Mail className="h-4 w-4 shrink-0" />
              <span className="truncate">{profile.email}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Contacts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Контакты</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Telegram */}
          <form.Field
            name="telegram"
            validators={{
              onBlur: ({ value }) => {
                if (!value.trim()) return undefined
                const r = telegramFieldSchema.safeParse(value.trim())
                return r.success ? undefined : r.error.issues[0]?.message
              },
            }}
          >
            {(field) => {
              const hasError = field.state.meta.isTouched && field.state.meta.errors.length > 0
              const telegramHandle = field.state.value.trim().replace(/^@/, '')
              const telegramUrl = telegramHandle.length >= 5 ? `https://t.me/${telegramHandle}` : null
              return (
                <div className="space-y-1.5">
                  <Label
                    htmlFor="telegram"
                    className={cn('flex items-center gap-2', hasError && 'text-destructive')}
                  >
                    <Send className="h-4 w-4" />
                    Telegram
                  </Label>
                  <div className="flex items-center gap-3">
                    <Input
                      id="telegram"
                      placeholder="@username"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      className={cn('flex-1', hasError && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                    {telegramUrl && (
                      <a
                        href={telegramUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex shrink-0 items-center gap-1 text-xs text-blue-500 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Открыть
                      </a>
                    )}
                  </div>
                  {hasError && field.state.meta.errors[0] && (
                    <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                  )}
                </div>
              )
            }}
          </form.Field>

          {/* Phone */}
          <form.Field
            name="phone"
            validators={{
              onBlur: ({ value }) => {
                const v = value as string
                if (!v) return undefined
                const r = phoneFieldSchema.safeParse(v)
                if (!r.success) return r.error.issues[0]?.message
                if (!isValidPhoneNumber(v)) return 'Некорректный номер телефона'
                return undefined
              },
            }}
          >
            {(field) => {
              const hasError = field.state.meta.isTouched && field.state.meta.errors.length > 0
              return (
                <div className="space-y-1.5">
                  <Label className={cn(hasError && 'text-destructive')}>Телефон</Label>
                  <PhoneInput
                    value={field.state.value as PhoneValue | undefined}
                    onChange={(v) => field.handleChange((v ?? '') as PhoneValue | '')}
                    onBlur={field.handleBlur}
                    className={cn(hasError && '[&_input]:border-destructive')}
                  />
                  {hasError && field.state.meta.errors[0] && (
                    <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                  )}
                </div>
              )
            }}
          </form.Field>

          <div className="flex justify-end">
            <Button
              onClick={() => void form.handleSubmit()}
              disabled={updateMutation.isPending}
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              {updateMutation.isPending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* System info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Системная информация</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div className="flex justify-between">
            <span>Дата регистрации</span>
            <span className="font-medium text-foreground">
              {new Date(profile.createdAt).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'long',
                year: 'numeric',
              })}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Аватар</span>
            <span className="font-medium text-foreground">Из Google аккаунта</span>
          </div>
          <div className="flex justify-between">
            <span>Имя</span>
            <span className="font-medium text-foreground">Из Google аккаунта</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
