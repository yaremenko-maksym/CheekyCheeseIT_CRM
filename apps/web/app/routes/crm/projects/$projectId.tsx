import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm, type FieldApi, type ReactFormExtendedApi } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Briefcase,
  Building2,
  Calendar,
  CreditCard,
  DollarSign,
  Globe,
  Laptop,
  Pencil,
  Percent,
  RefreshCw,
  RotateCcw,
  StickyNote,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import type {
  ProjectDto,
  ProjectDetailDto,
  ProjectMemberDto,
  UpdateProjectDto,
  TransactionDto,
} from '@crm/shared'
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
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { AuditLogTab } from '@/components/audit-log/AuditLogTab'
import { useUnarchiveEntity, type UnarchiveCascadeEntity, type UnarchiveError } from '@/hooks/use-archive'
import { CascadeUnarchiveModal } from '@/components/archive/CascadeUnarchiveModal'
import type { AxiosError } from 'axios'

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

function ProjectEditFields({
  form,
  mode,
  canEditOverride,
  defaultSharePercent,
}: {
  form: AnyForm
  mode: 'info' | 'members'
  canEditOverride: boolean
  defaultSharePercent: number
}) {
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

        {/* Per-project SENIOR share override — editable only by ADMIN and
            ACCOUNTANT. Visible to all roles that see the form (HR sees it
            disabled). Null clears the override and falls back to the senior's
            global default (`defaultSharePercent`). */}
        <form.Field
          name="seniorSharePercentOverride"
          validators={{
            onBlur: ({ value }: { value: number | null }) => {
              if (value === null || value === undefined || (value as unknown as string) === '') return undefined
              const num = Number(value)
              if (!Number.isInteger(num) || num < 0 || num > 100) {
                return 'Введите целое число от 0 до 100'
              }
              return undefined
            },
          }}
        >
          {(field: AnyField) => {
            const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
            const raw = field.state.value as number | null
            const inputValue = raw === null || raw === undefined ? '' : String(raw)
            return (
              <div className="space-y-1.5">
                <Label className={cn(err && 'text-destructive')}>
                  Доля синьора на проекте, %
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    step={1}
                    value={inputValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const v = e.target.value
                      if (v === '') {
                        field.handleChange(null)
                      } else {
                        const num = Number(v)
                        field.handleChange(Number.isNaN(num) ? null : num)
                      }
                    }}
                    onBlur={field.handleBlur}
                    placeholder={String(defaultSharePercent)}
                    disabled={!canEditOverride}
                    aria-disabled={!canEditOverride}
                    data-testid="project-edit-senior-share-override"
                    className={cn('flex-1', err && 'border-destructive focus-visible:ring-destructive/30')}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => field.handleChange(null)}
                    disabled={!canEditOverride || raw === null || raw === undefined}
                    data-testid="project-edit-senior-share-reset"
                    className="gap-1.5"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Сбросить
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Если оставить пустым — используется доля синьера по умолчанию ({defaultSharePercent}%).
                </p>
                {!canEditOverride && (
                  <p className="text-xs text-muted-foreground italic">
                    Менять может только ADMIN или ACCOUNTANT.
                  </p>
                )}
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            )
          }}
        </form.Field>
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
  const qc = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  // ACCOUNTANT can also open the edit dialog so they can change
  // `seniorSharePercentOverride` (backend enforces field-scoped RBAC).
  const canOpenEdit = canManage || user?.role === 'ACCOUNTANT'
  const canRemoveMembers = isAdmin

  const [editOpen, setEditOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addedMemberIds, setAddedMemberIds] = useState<Set<string>>(new Set())
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(new Set())
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ProjectMemberDto | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'members' | 'audit' | 'finance'>('overview')
  // ut-28: explicit Archive button in header replaces «Действия» dropdown + «Завершить» button.
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [cascadeEntities, setCascadeEntities] = useState<UnarchiveCascadeEntity[] | null>(null)

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  const { data: project, isLoading } = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.get<ProjectDetailDto>(`/projects/${projectId}`).then((r) => r.data),
    enabled: !!user,
  })



  const canEditOverride = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'

  const editForm = useForm({
    defaultValues: {
      name: project?.name ?? '',
      companyName: project?.companyName ?? '',
      domain: project?.domain ?? 'Other',
      logoUrl: project?.logoUrl ?? (null as string | null),
      rate: (project?.rate ?? '') as unknown as number,
      currency: (project?.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
      seniorSharePercentOverride: project?.seniorSharePercentOverride ?? null,
      techStack: project?.techStack ?? '',
      teamSize: project?.teamSize ?? '',
      benefits: project?.benefits ?? '',
      paymentType: project?.paymentType ?? '',
      salaryReview: project?.salaryReview ?? '',
      corpTech: project?.corpTech ?? '',
      notesGeneral: project?.notesGeneral ?? '',
    },
    onSubmit: async ({ value }) => {
      // Only include `seniorSharePercentOverride` in the PATCH payload when
      // the caller is allowed to change it AND it actually differs from the
      // server snapshot. This keeps HR/SENIOR/JUNIOR PATCHes from triggering
      // the field-RBAC check on the backend.
      const overrideChanged =
        canEditOverride &&
        (value.seniorSharePercentOverride ?? null) !== (project?.seniorSharePercentOverride ?? null)
      editMutation.mutate({
        name: value.name.trim() || undefined,
        companyName: value.companyName.trim() || undefined,
        domain: value.domain || undefined,
        logoUrl: value.logoUrl || null,
        rate: Number(value.rate) || undefined,
        currency: value.currency || undefined,
        ...(overrideChanged
          ? { seniorSharePercentOverride: value.seniorSharePercentOverride ?? null }
          : {}),
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

  // Round 5: the CLOSED business contract state is gone — lifecycle is
  // binary (ACTIVE ↔ ARCHIVED) and the only way back to ACTIVE is via the
  // Archive unarchive flow (handled below). The legacy reopen mutation is
  // therefore removed.
  // Archive is triggered via the explicit Archive button → ArchiveConfirmDialog.

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
    editForm.setFieldValue('seniorSharePercentOverride', project.seniorSharePercentOverride ?? null)
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
                {!project.archivedAt && (
                  <Badge variant="default" className="text-xs">
                    Активный
                  </Badge>
                )}
                {project.archivedAt && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-amber-500 text-xs"
                    data-testid="project-archived-badge"
                  >
                    В архиве
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">{project.domain}</Badge>
              </div>
            </div>
          </div>

          {/* ut-28: Explicit Edit + Archive buttons (replaces «Действия» dropdown
              and former «Завершить» button). Visible to ADMIN/HR (full edit)
              and ACCOUNTANT (override-only edit). */}
          <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
            {canOpenEdit && !project.archivedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={openEdit}
                className="gap-1.5"
                data-testid="project-edit-button"
              >
                <Pencil className="h-3.5 w-3.5" />
                Редактировать
              </Button>
            )}
            {isAdmin && !project.archivedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setArchiveDialogOpen(true)}
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                data-testid="project-archive-button"
              >
                <Archive className="h-3.5 w-3.5" />
                Архивировать
              </Button>
            )}
            {isAdmin && project.archivedAt && (
              <ProjectUnarchiveHeaderButton
                projectId={project.id}
                projectName={project.name}
                onCascadeRequired={(entities) => setCascadeEntities(entities)}
              />
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
          {project.archivedAt && (
            <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
              <Calendar className="h-4 w-4 text-amber-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Завершён</p>
                <p className="text-sm font-semibold">
                  {new Date(project.archivedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
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

      {/* ut-29 + ut-33: project detail tabs — unified through SegmentedToggle
          variant="tabs" (same yellow page-level styling as projects list). */}
      {(() => {
        type ProjectTab = 'overview' | 'members' | 'audit' | 'finance'
        const tabOptions: ReadonlyArray<SegmentedToggleOption<ProjectTab>> = [
          { value: 'overview', label: 'Обзор', testId: 'tab-overview' },
          { value: 'members', label: 'Состав', testId: 'tab-members' },
          ...(isAdmin
            ? ([{ value: 'audit', label: 'История изменений', testId: 'tab-audit' }] as const)
            : []),
          { value: 'finance', label: 'Финансы', testId: 'tab-finance' },
        ]
        return (
          <SegmentedToggle<ProjectTab>
            value={activeTab as ProjectTab}
            onChange={(v) => setActiveTab(v)}
            options={tabOptions}
            ariaLabel="Разделы проекта"
            variant="tabs"
            size="sm"
            layoutId={`project-detail-tabs-${projectId}`}
            className="w-fit"
            testId={`project-detail-tabs-${projectId}`}
          />
        )
      })()}

      {activeTab === 'members' && (
        <ProjectEffectiveTeamCard project={project} />
      )}

      {activeTab === 'audit' && isAdmin && (
        <AuditLogTab entityType="project" entityId={project.id} />
      )}

      {activeTab !== 'overview' && activeTab !== 'finance' && null}

      {activeTab === 'overview' && (
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
            {/* Per-project SENIOR share — read-only view. Badge "Override" shown
                when project-level value is set; otherwise mark as default. Visible
                to everyone who can see the project (RBAC handled at API layer). */}
            <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label="Доля синьора">
              {(() => {
                const effective =
                  project.seniorSharePercentOverride ?? project.seniorSharePercentDefault
                const hasOverride = project.seniorSharePercentOverride !== null
                return (
                  <span
                    className="inline-flex items-center gap-2"
                    data-testid="project-senior-share"
                  >
                    <span className="font-medium tabular-nums">{effective}%</span>
                    {hasOverride ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="secondary"
                            className="text-[10px]"
                            data-testid="project-senior-share-override-badge"
                          >
                            Override
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          Установлено для этого проекта; глобальная доля синьора:{' '}
                          {project.seniorSharePercentDefault}%
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-xs text-muted-foreground">(по умолчанию)</span>
                    )}
                  </span>
                )
              })()}
            </InfoRow>
          </CardContent>
        </Card>

        {/* Team card */}
        <Card className="border-border/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Команда
              </CardTitle>
              {canManage && !project.archivedAt && (
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
                to="/crm/profile/$userId"
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
      )}

      {activeTab === 'finance' && (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.16 }}
      >
        <ProjectTransactions projectId={projectId} />
      </motion.div>
      )}

      {/* ── Edit / Add member dialog ── */}
      <Dialog open={editOpen} onOpenChange={(v) => !v && setEditOpen(false)}>
        <CrmDialogContent maxWidth="max-w-lg">
          <CrmDialogHeader>
            <DialogTitle>Редактировать — {project.companyName}</DialogTitle>
          </CrmDialogHeader>

          <CrmDialogBody>
            <div className="space-y-5">
              {canOpenEdit && editOpen && (
                <ProjectEditFields
                  form={editForm}
                  mode="info"
                  canEditOverride={canEditOverride}
                  defaultSharePercent={project.seniorSharePercentDefault}
                />
              )}
            </div>
          </CrmDialogBody>
          {canOpenEdit && (
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

      {/* ut-28: Archive confirm dialog — triggered by explicit Archive button. */}
      {archiveDialogOpen && (
        <ArchiveConfirmDialog
          entityType="project"
          entityId={project.id}
          entityName={project.name}
          onClose={() => setArchiveDialogOpen(false)}
        />
      )}

      {/* Cascade unarchive modal — paired senior/team restore. */}
      {cascadeEntities && (
        <ProjectCascadeUnarchiveModal
          projectId={project.id}
          projectName={project.name}
          entities={cascadeEntities}
          onClose={() => setCascadeEntities(null)}
        />
      )}
    </div>
  )
}

/**
 * Header-level Unarchive button replacing AdminActionsMenu's unarchive flow.
 * Handles the 409-cascade response by lifting the entities to the parent.
 */
function ProjectUnarchiveHeaderButton({
  projectId,
  projectName: _projectName,
  onCascadeRequired,
}: {
  projectId: string
  projectName: string
  onCascadeRequired: (entities: UnarchiveCascadeEntity[]) => void
}) {
  const unarchive = useUnarchiveEntity('project', projectId)
  const handleClick = async () => {
    try {
      await unarchive.mutateAsync({})
    } catch (err) {
      const ax = err as AxiosError<UnarchiveError>
      if (ax.response?.status === 409 && ax.response.data?.requiresCascade) {
        onCascadeRequired(ax.response.data.entities)
      }
    }
  }
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void handleClick()}
      disabled={unarchive.isPending}
      className="gap-1.5"
      data-testid="project-unarchive-button"
    >
      <ArchiveRestore className="h-3.5 w-3.5" />
      Восстановить
    </Button>
  )
}

function ProjectCascadeUnarchiveModal({
  projectId,
  projectName,
  entities,
  onClose,
}: {
  projectId: string
  projectName: string
  entities: UnarchiveCascadeEntity[]
  onClose: () => void
}) {
  const unarchive = useUnarchiveEntity('project', projectId)
  return (
    <CascadeUnarchiveModal
      projectName={projectName}
      entities={entities}
      isPending={unarchive.isPending}
      onConfirm={async () => {
        await unarchive.mutateAsync({ cascade: true })
        onClose()
      }}
      onCancel={onClose}
    />
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
                      currentUserId={user.id}
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
        to="/crm/profile/$userId"
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

/**
 * Renders the project's *effective team* — a computed view (NOT snapshot at archive).
 * HR/Accountants come from the SENIOR's current team_members (dynamic).
 * Juniors come from THIS project's active project_members.
 *
 * If `project.effectiveTeam` is absent (e.g. response from older API or list endpoint),
 * falls back to the snapshot embedded in `project.members`.
 * See spec §5.2 and §8.
 */
function ProjectEffectiveTeamCard({ project }: { project: ProjectDetailDto }) {
  const effective = project.effectiveTeam
  const senior = effective?.senior ?? null
  const hrs = effective?.hrs ?? []
  const accountants = effective?.accountants ?? []
  const juniors = effective?.juniors ?? project.members.filter((m) => m.role === 'JUNIOR' && m.leftAt === null)

  // ut-30: flat list — single «Эффективный состав» heading; role-specific
  // section headings («СИНЬОР», «HR (N)», «БУХГАЛТЕРЫ (N)», «ДЖУНЫ (N)») removed.
  // Each row keeps its role badge for visual differentiation.
  type FlatMember = {
    key: string
    profileId: string
    displayName: string
    avatar: string | null
    role: 'SENIOR' | 'HR' | 'ACCOUNTANT' | 'JUNIOR'
    sectionTestId: string
  }
  const flatMembers: FlatMember[] = []
  if (senior) {
    flatMembers.push({
      key: `senior-${senior.id}`,
      profileId: senior.id,
      displayName: senior.displayName,
      avatar: senior.avatar,
      role: 'SENIOR',
      sectionTestId: 'effective-team-senior',
    })
  }
  for (const m of hrs) {
    flatMembers.push({
      key: `hr-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatar: m.avatar,
      role: 'HR',
      sectionTestId: 'effective-team-hrs',
    })
  }
  for (const m of accountants) {
    flatMembers.push({
      key: `acc-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatar: m.avatar,
      role: 'ACCOUNTANT',
      sectionTestId: 'effective-team-accountants',
    })
  }
  for (const m of juniors) {
    flatMembers.push({
      key: `jun-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatar: m.avatar,
      role: 'JUNIOR',
      sectionTestId: 'effective-team-juniors',
    })
  }

  return (
    <Card className="border-border/40" data-testid="effective-team-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Эффективный состав
          <span className="ml-2 text-[10px] font-normal normal-case text-muted-foreground/60">
            (HR/бухгалтер — из текущей команды синьора)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {!senior && (
          <p
            className="text-xs text-muted-foreground/60 italic px-2 py-1.5"
            data-testid="effective-team-senior"
          >
            Синьор не назначен
          </p>
        )}
        {senior && juniors.length === 0 && (
          <p
            className="text-xs text-amber-500/80 font-medium px-2 py-1.5"
            data-testid="effective-team-juniors-empty"
          >
            Джун не назначен
          </p>
        )}
        {flatMembers.map((m) => (
          <Link
            key={m.key}
            to="/crm/profile/$userId"
            params={{ userId: m.profileId }}
            data-testid={m.sectionTestId}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors"
          >
            <Avatar className="h-7 w-7 shrink-0">
              {m.avatar && <AvatarImage src={m.avatar} alt={m.displayName} />}
              <AvatarFallback className="text-[10px] font-semibold">{getInitials(m.displayName)}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium truncate flex-1 text-primary hover:underline">
              {m.displayName}
            </span>
            <Badge variant={m.role === 'SENIOR' ? 'senior' : m.role === 'HR' ? 'hr' : m.role === 'ACCOUNTANT' ? 'accountant' : 'junior'} className="shrink-0 text-[9px]">
              {m.role === 'SENIOR' ? 'Синьор' : m.role === 'HR' ? 'HR' : m.role === 'ACCOUNTANT' ? 'Бухгалтер' : 'Джун'}
            </Badge>
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
