import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm, type FieldApi, type ReactFormExtendedApi } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Calendar,
  CreditCard,
  DollarSign,
  Globe,
  Laptop,
  Pencil,
  RefreshCw,
  StickyNote,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import type { ProjectDto, ProjectMemberDto, UpdateProjectDto, TransactionDto } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { financeApi } from '@/routes/crm/finance/api'
import { TransactionDetailDialog } from '@/routes/crm/finance/components/dialogs/TransactionDetailDialog'
import { TransactionRow } from '@/routes/crm/finance/components/TransactionRow'
import { type ExchangeRates, fmtUsd } from '@/routes/crm/finance/constants'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ReceiptField } from '@/components/ui/receipt-field'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const Route = createFileRoute('/crm/projects/$projectId')({
  component: ProjectDetailPage,
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


// TanStack Form field/form render props require many generics — suppress with eslint
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyField = FieldApi<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

function ProjectEditFields({ form, mode }: { form: AnyForm; mode: 'info' | 'members' }) {
  if (mode === 'info') {
    return (
      <div className="space-y-3">
        <form.Field name="logoUrl">
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>Логотип компании</Label>
              <ReceiptField
                value={field.state.value ?? ''}
                onChange={(v) => field.handleChange(v || null)}
                accept="image/*"
                urlPlaceholder="https://example.com/logo.png"
                urlHint="Вставьте ссылку на логотип или нажмите кнопку вставить"
                fileHint="PNG, JPG, SVG — логотип компании"
              />
            </div>
          )}
        </form.Field>

        <form.Field
          name="name"
          validators={{
            onBlur: ({ value }: { value: string }) => {
              const r = createProjectSchema.shape.name.safeParse(value.trim())
              return r.success ? undefined : r.error.issues[0]?.message
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn(err && 'text-destructive')}>Название проекта</Label>
                <Input
                  value={field.state.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(e.target.value)
                  }
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
            onBlur: ({ value }: { value: string }) => {
              const r = createProjectSchema.shape.companyName.safeParse(value.trim())
              return r.success ? undefined : r.error.issues[0]?.message
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            return (
              <div className="space-y-1.5">
                <Label className={cn(err && 'text-destructive')}>Компания</Label>
                <Input
                  value={field.state.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    field.handleChange(e.target.value)
                  }
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
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>Домен</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                value={field.state.value}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  field.handleChange(e.target.value)
                }
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

        <div className="border-t border-border pt-3 space-y-3">
          {(
            [
              'techStack',
              'teamSize',
              'benefits',
              'paymentType',
              'salaryReview',
              'corpTech',
            ] as const
          ).map((fieldName) => {
            const labels: Record<string, string> = {
              techStack: 'Стек технологий',
              teamSize: 'Состав команды',
              benefits: 'Бенефиты',
              paymentType: 'Тип оплаты',
              salaryReview: 'Пересмотр ЗП',
              corpTech: 'Корп. технологии',
            }
            return (
              <form.Field key={fieldName} name={fieldName}>
                {(field: AnyField) => (
                  <div className="space-y-1.5">
                    <Label>{labels[fieldName]}</Label>
                    <Input
                      value={field.state.value as string}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        field.handleChange(e.target.value)
                      }
                      placeholder=""
                    />
                  </div>
                )}
              </form.Field>
            )
          })}
          <form.Field name="notesGeneral">
            {(field: AnyField) => (
              <div className="space-y-1.5">
                <Label>Общие заметки</Label>
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring min-h-20 resize-y"
                  value={field.state.value as string}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    field.handleChange(e.target.value)
                  }
                  placeholder=""
                />
              </div>
            )}
          </form.Field>
        </div>

        <form.Subscribe selector={(s: { values: { rate: number; currency: string } }) => ({ rate: s.values.rate, currency: s.values.currency })}>
          {({ rate, currency }: { rate: number; currency: string }) => (
            <AmountCurrencyInput
              amount={String(rate ?? '')}
              currency={currency as Currency}
              onAmountChange={(v) => form.setFieldValue('rate', Number(v) as unknown as number)}
              onCurrencyChange={(v) => form.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')}
              label="Ставка"
              placeholder="5000"
            />
          )}
        </form.Subscribe>
      </div>
    )
  }
  return null
}

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
      <span className="text-muted-foreground shrink-0 min-w-[80px]">{label}:</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

function ProjectDetailPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'])
  const { projectId } = Route.useParams()
  const { user } = useAuth()
  if (denied) return null
  const navigate = useNavigate()
  const qc = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const canRemoveMembers = isAdmin

  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addedMemberIds, setAddedMemberIds] = useState<Set<string>>(new Set())
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(new Set())
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ProjectMemberDto | null>(null)

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  const { data: project, isLoading } = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.get<ProjectDto>(`/projects/${projectId}`).then((r) => r.data),
    enabled: !!user,
  })



  const editForm = useForm({
    defaultValues: {
      name: project?.name ?? '',
      companyName: project?.companyName ?? '',
      domain: project?.domain ?? 'Other',
      logoUrl: project?.logoUrl ?? (null as string | null),
      rate: (project?.rate ?? '') as unknown as number,
      currency: (project?.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
      techStack: project?.techStack ?? '',
      teamSize: project?.teamSize ?? '',
      benefits: project?.benefits ?? '',
      paymentType: project?.paymentType ?? '',
      salaryReview: project?.salaryReview ?? '',
      corpTech: project?.corpTech ?? '',
      notesGeneral: project?.notesGeneral ?? '',
    },
    onSubmit: async ({ value }) => {
      editMutation.mutate({
        name: value.name.trim() || undefined,
        companyName: value.companyName.trim() || undefined,
        domain: value.domain || undefined,
        logoUrl: value.logoUrl || null,
        rate: Number(value.rate) || undefined,
        currency: value.currency || undefined,
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        paymentType: value.paymentType.trim() || null,
        salaryReview: value.salaryReview.trim() || null,
        corpTech: value.corpTech.trim() || null,
        notesGeneral: value.notesGeneral.trim() || null,
      })
    },
  })

  const editMutation = useMutation({
    mutationFn: (data: UpdateProjectDto) =>
      api.patch<ProjectDto>(`/projects/${projectId}`, data).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      setEditOpen(false)
    },
  })

  const closeMutation = useMutation({
    mutationFn: () => api.patch(`/projects/${projectId}`, { status: 'CLOSED' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      setCloseOpen(false)
    },
  })

  const reopenMutation = useMutation({
    mutationFn: () => api.patch(`/projects/${projectId}`, { status: 'ACTIVE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void navigate({ to: '/crm/projects' })
    },
  })

const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      setRemoveMemberTarget(null)
    },
  })

  type UserForAdd = { id: string; displayName: string; email: string; role: string; avatar: string | null; hasActiveProject: boolean }

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserForAdd[]>('/users').then((r) => r.data),
    enabled: canManage,
  })

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/projects/${projectId}/members`, { userId }),
    onSuccess: (_, userId) => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      setAddedMemberIds((prev) => new Set(prev).add(userId))
      setPendingMemberIds((prev) => { const next = new Set(prev); next.delete(userId); return next })
    },
    onError: (_, userId) => {
      setPendingMemberIds((prev) => { const next = new Set(prev); next.delete(userId); return next })
    },
  })

  function openEdit() {
    if (!project) return
    editForm.setFieldValue('name', project.name)
    editForm.setFieldValue('companyName', project.companyName)
    editForm.setFieldValue('domain', project.domain)
    editForm.setFieldValue('logoUrl', project.logoUrl ?? null)
    editForm.setFieldValue('rate', project.rate as unknown as number)
    editForm.setFieldValue('currency', project.currency as 'USDT' | 'USD' | 'EUR' | 'UAH')
    editForm.setFieldValue('techStack', project.techStack ?? '')
    editForm.setFieldValue('teamSize', project.teamSize ?? '')
    editForm.setFieldValue('benefits', project.benefits ?? '')
    editForm.setFieldValue('paymentType', project.paymentType ?? '')
    editForm.setFieldValue('salaryReview', project.salaryReview ?? '')
    editForm.setFieldValue('corpTech', project.corpTech ?? '')
    editForm.setFieldValue('notesGeneral', project.notesGeneral ?? '')
    setEditOpen(true)
  }

  if (isLoading || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    )
  }

  const activeMembers = project.members.filter((m) => m.leftAt === null)
  const pastMembers = project.members.filter((m) => m.leftAt !== null)
  const senior = {
    userId: project.seniorId,
    displayName: project.seniorName,
    role: 'SENIOR',
    avatar: null as string | null,
  }
  const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
  const activeHRs = activeMembers.filter((m) => m.role === 'HR')
  const activeAccountants = activeMembers.filter((m) => m.role === 'ACCOUNTANT')
  const hasActiveJunior = activeJuniors.length > 0
  const availableToAdd = (allUsers ?? []).filter((u) => {
    if (u.role === 'ADMIN' || u.role === 'SENIOR') return false
    if (activeMembers.some((m) => m.userId === u.id)) return false
    if (u.role === 'JUNIOR') {
      if (hasActiveJunior) return false
      if (u.hasActiveProject) return false
    }
    return true
  })

return (
    <div className="space-y-5">

      {/* ── Hero banner ── */}
      <motion.div
        className="relative overflow-hidden rounded-2xl border border-border/40 bg-card"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        {/* Ambient glow blob */}
        <div
          className="pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full opacity-[0.07] blur-3xl"
          style={{ background: '#f5c542' }}
        />
        <div className="relative flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          {/* Left: back + logo + title */}
          <div className="flex items-center gap-4 min-w-0">
            <Link to="/crm/projects" className="shrink-0">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="relative shrink-0">
              <div
                className="absolute inset-0 rounded-xl opacity-30 blur-md"
                style={{ background: '#f5c542' }}
              />
              <Avatar className="relative h-14 w-14 rounded-xl border border-border/60 shadow-lg">
                {project.logoUrl && (
                  <AvatarImage src={project.logoUrl} alt={project.companyName} className="object-contain" />
                )}
                <AvatarFallback className="rounded-xl text-lg font-bold">
                  {getInitials(project.companyName)}
                </AvatarFallback>
              </Avatar>
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight truncate leading-tight">
                {project.companyName}
              </h1>
              <p className="text-sm text-muted-foreground truncate mt-0.5">{project.name}</p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <Badge
                  variant={project.status === 'ACTIVE' ? 'default' : 'secondary'}
                  className="text-xs"
                >
                  {project.status === 'ACTIVE' ? 'Активный' : 'Завершён'}
                </Badge>
                <Badge variant="outline" className="text-xs">{project.domain}</Badge>
              </div>
            </div>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
            {canManage && project.status === 'ACTIVE' && (
              <Button size="sm" variant="outline" onClick={openEdit} className="gap-1.5">
                <Pencil className="h-3.5 w-3.5" />
                Редактировать
              </Button>
            )}
            {canManage && project.status === 'ACTIVE' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setCloseOpen(true)}
              >
                Завершить
              </Button>
            )}
            {canManage && project.status === 'CLOSED' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => reopenMutation.mutate()}
                disabled={reopenMutation.isPending}
              >
                Переоткрыть
              </Button>
            )}
            {isAdmin && (
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Stat chips row */}
        <div className="flex gap-3 px-6 pb-5 flex-wrap">
          <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
            <DollarSign className="h-4 w-4 text-emerald-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Ставка</p>
              <p className="text-sm font-semibold tabular-nums">{project.rate.toLocaleString()} {project.currency}</p>
              {rates && project.currency !== 'USD' && project.currency !== 'USDT' && (
                <p className="text-[10px] text-muted-foreground tabular-nums">≈ {fmtUsd(project.rate, project.currency, rates)}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
            <Calendar className="h-4 w-4 text-blue-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Старт</p>
              <p className="text-sm font-semibold">
                {new Date(project.startDate).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </p>
            </div>
          </div>
          {project.endDate && (
            <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
              <Calendar className="h-4 w-4 text-amber-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Завершён</p>
                <p className="text-sm font-semibold">
                  {new Date(project.endDate).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
            <Globe className="h-4 w-4 text-violet-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Домен</p>
              <p className="text-sm font-semibold">{project.domain}</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── Main grid ── */}
      <motion.div
        className="grid gap-4 lg:grid-cols-2"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.08 }}
      >
        {/* Details card */}
        <Card className="border-border/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Детали проекта
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 divide-y divide-border/40">
            <InfoRow icon={<Briefcase className="h-3.5 w-3.5" />} label="Стек">
              {project.techStack
                ? <span className="font-medium">{project.techStack}</span>
                : <span className="text-muted-foreground/40 italic">—</span>}
            </InfoRow>
            <InfoRow icon={<Users className="h-3.5 w-3.5" />} label="Команда">
              {project.teamSize
                ? <span className="font-medium">{project.teamSize}</span>
                : <span className="text-muted-foreground/40 italic">—</span>}
            </InfoRow>
            <InfoRow icon={<Building2 className="h-3.5 w-3.5" />} label="Бенефиты">
              {project.benefits
                ? <span className="font-medium">{project.benefits}</span>
                : <span className="text-muted-foreground/40 italic">—</span>}
            </InfoRow>
            <InfoRow icon={<CreditCard className="h-3.5 w-3.5" />} label="Тип оплаты">
              {project.paymentType
                ? <span className="font-medium">{project.paymentType}</span>
                : <span className="text-muted-foreground/40 italic">—</span>}
            </InfoRow>
            <InfoRow icon={<RefreshCw className="h-3.5 w-3.5" />} label="Пересмотр ЗП">
              {project.salaryReview
                ? <span className="font-medium">{project.salaryReview}</span>
                : <span className="text-muted-foreground/40 italic">—</span>}
            </InfoRow>
            <InfoRow icon={<Laptop className="h-3.5 w-3.5" />} label="Корп. техника">
              {project.corpTech
                ? <span className="font-medium">{project.corpTech}</span>
                : <span className="text-muted-foreground/40 italic">—</span>}
            </InfoRow>
            <div className="flex items-start gap-2 py-3 text-sm">
              <StickyNote className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground mb-1">Общие заметки</p>
                {project.notesGeneral
                  ? <p className="text-sm whitespace-pre-wrap leading-relaxed">{project.notesGeneral}</p>
                  : <span className="text-muted-foreground/40 italic">—</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Team card */}
        <Card className="border-border/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Команда
              </CardTitle>
              {canManage && project.status === 'ACTIVE' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                        disabled={availableToAdd.length === 0}
                        onClick={() => { setAddedMemberIds(new Set()); setAddMemberOpen(true) }}
                      >
                        <UserPlus className="h-3 w-3" />
                        Добавить
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {availableToAdd.length === 0 && (
                    <TooltipContent>Некого добавлять</TooltipContent>
                  )}
                </Tooltip>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-1 divide-y divide-border/30">
            {/* Senior — always shown */}
            <div className="pb-3">
              <Link
                to="/crm/users/$userId"
                params={{ userId: senior.userId }}
                className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
              >
                <Avatar className="h-8 w-8 shrink-0 ring-2 ring-[#6366f1]/30">
                  <AvatarFallback className="text-[11px] font-semibold">
                    {getInitials(senior.displayName)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium truncate text-primary hover:underline underline-offset-2">
                  {senior.displayName}
                </span>
                <Badge variant="senior" className="shrink-0 text-[9px] ml-auto">Синьор</Badge>
              </Link>
            </div>

            {/* HR */}
            <div className="pt-3 pb-3">
              {activeHRs.length === 0 ? (
                <p className="text-xs text-muted-foreground/50 italic">Не назначен</p>
              ) : (
                <div className="space-y-1.5">
                  {activeHRs.map((m) => (
                    <MemberRow key={m.id} member={m} canManage={canRemoveMembers} onRemove={() => setRemoveMemberTarget(m)} />
                  ))}
                </div>
              )}
            </div>

            {/* Accountants */}
            <div className="pt-3 pb-3">
              {activeAccountants.length === 0 ? (
                <p className="text-xs text-muted-foreground/50 italic">Не назначен</p>
              ) : (
                <div className="space-y-1.5">
                  {activeAccountants.map((m) => (
                    <MemberRow key={m.id} member={m} canManage={canRemoveMembers} onRemove={() => setRemoveMemberTarget(m)} />
                  ))}
                </div>
              )}
            </div>

            {/* Junior */}
            <div className="pt-3">
              {activeJuniors.length === 0 ? (
                <p className="text-xs text-amber-500/80 font-medium">Джун не назначен</p>
              ) : (
                <div className="space-y-1.5">
                  {activeJuniors.map((m) => (
                    <MemberRow key={m.id} member={m} canManage={canRemoveMembers} onRemove={() => setRemoveMemberTarget(m)} />
                  ))}
                </div>
              )}
            </div>

            {/* Past members */}
            {pastMembers.length > 0 && (
              <div className="pt-3">
                <p className="text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider mb-2">Покинули проект</p>
                <div className="space-y-1.5 opacity-50">
                  {pastMembers.map((m) => (
                    <MemberRow key={m.id} member={m} canManage={false} onRemove={() => {}} />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Transactions ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.16 }}
      >
        <ProjectTransactions projectId={projectId} />
      </motion.div>

      {/* ── Edit / Add member dialog ── */}
      <Dialog open={editOpen} onOpenChange={(v) => !v && setEditOpen(false)}>
        <CrmDialogContent maxWidth="max-w-lg">
          <CrmDialogHeader>
            <DialogTitle>Редактировать — {project.companyName}</DialogTitle>
          </CrmDialogHeader>

          <CrmDialogBody>
            <div className="space-y-5">
              {canManage && editOpen && <ProjectEditFields form={editForm} mode="info" />}
            </div>
          </CrmDialogBody>
          {canManage && (
            <CrmDialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)}>
                Отмена
              </Button>
              <Button
                onClick={() => void editForm.handleSubmit()}
                disabled={editMutation.isPending}
              >
                {editMutation.isPending ? 'Сохранение...' : 'Сохранить'}
              </Button>
            </CrmDialogFooter>
          )}
        </CrmDialogContent>
      </Dialog>

      {/* ── Remove member confirm ── */}
      <Dialog open={!!removeMemberTarget} onOpenChange={(v) => !v && setRemoveMemberTarget(null)}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Убрать участника?</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{removeMemberTarget?.displayName}</span>{' '}
              будет убран из проекта.
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => setRemoveMemberTarget(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                removeMemberTarget && removeMemberMutation.mutate(removeMemberTarget.userId)
              }
              disabled={removeMemberMutation.isPending}
            >
              Убрать
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* ── Add member ── */}
      <Dialog open={addMemberOpen} onOpenChange={(v) => { if (!v) setAddMemberOpen(false) }}>
        <CrmDialogContent maxWidth="max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Добавить участника</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {availableToAdd.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">Некого добавлять</p>
              )}
              {availableToAdd.map((u) => {
                const isAdded = addedMemberIds.has(u.id)
                const isPending = pendingMemberIds.has(u.id)
                return (
                  <div
                    key={u.id}
                    className="flex items-center gap-2.5 rounded-md px-3 py-2"
                  >
                    <Avatar className="h-7 w-7 shrink-0">
                      {u.avatar && <AvatarImage src={u.avatar} />}
                      <AvatarFallback className="text-[10px]">{getInitials(u.displayName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{u.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <Badge variant={ROLE_VARIANT[u.role] ?? 'junior'} className="shrink-0 text-[9px]">
                      {ROLE_LABELS[u.role] ?? u.role}
                    </Badge>
                    <Button
                      size="sm"
                      variant={isAdded ? 'outline' : 'default'}
                      className={cn('shrink-0 h-7 text-xs px-2.5', isAdded && 'text-emerald-500 border-emerald-500/40')}
                      disabled={isAdded || isPending}
                      onClick={() => {
                        setPendingMemberIds((prev) => new Set(prev).add(u.id))
                        addMemberMutation.mutate(u.id)
                      }}
                    >
                      {isAdded ? 'Добавлено' : isPending ? '...' : 'Добавить'}
                    </Button>
                  </div>
                )
              })}
            </div>
          </CrmDialogBody>
        </CrmDialogContent>
      </Dialog>

      {/* ── Close confirm ── */}
      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Завершить проект «{project.name}»?</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <p className="text-sm text-muted-foreground">
              Проект перейдёт в статус «Завершён». Можно будет переоткрыть позже.
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => setCloseOpen(false)}>
              Отмена
            </Button>
            <Button onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending}>
              Завершить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* ── Delete confirm ── */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Удалить проект «{project.name}»?</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <p className="text-sm text-muted-foreground">
              Все данные участников будут удалены. Это нельзя отменить.
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              Удалить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </div>
  )
}

function ProjectTransactions({ projectId }: { projectId: string }) {
  const { user } = useAuth()
  const [selected, setSelected] = useState<TransactionDto | null>(null)

  const { data: transactions, isLoading } = useQuery({
    queryKey: ['transactions', { projectId }],
    queryFn: () => financeApi.getTransactions({ projectId }),
    enabled: !!user,
    staleTime: 30_000,
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  if (!user) return null

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Финансы по проекту
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !transactions?.length ? (
            <p className="text-sm text-muted-foreground px-4 pb-4">Транзакций по проекту пока нет</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="py-2 px-4 text-left font-medium">Тип</th>
                    <th className="py-2 px-4 text-left font-medium">Стороны</th>
                    <th className="py-2 px-4 text-left font-medium">Сумма</th>
                    <th className="py-2 px-4 text-left font-medium">Дата</th>
                    <th className="py-2 px-4 text-left font-medium">Статус</th>
                    <th className="py-2 px-4" />
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      role={user.role}
                      rates={rates}
                      onClick={setSelected}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <TransactionDetailDialog tx={selected} onClose={() => setSelected(null)} />
    </>
  )
}

function MemberRow({
  member,
  canManage,
  onRemove,
}: {
  member: ProjectMemberDto
  canManage: boolean
  onRemove: () => void
}) {
  return (
    <div className={cn('flex items-center gap-2', member.leftAt && 'opacity-50')}>
      <Link
        to="/crm/users/$userId"
        params={{ userId: member.userId }}
        className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80 transition-opacity"
      >
        <Avatar className="h-6 w-6 shrink-0">
          {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
          <AvatarFallback className="text-[9px]">{getInitials(member.displayName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-none text-blue-500 hover:underline">
            {member.displayName}
          </p>
          {member.leftAt && (
            <p className="text-[10px] text-muted-foreground">
              вышел {new Date(member.leftAt).toLocaleDateString('uk-UA')}
            </p>
          )}
        </div>
      </Link>
      <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="shrink-0 text-[9px]">
        {ROLE_LABELS[member.role] ?? member.role}
      </Badge>
      {canManage && !member.leftAt && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <UserMinus className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}
