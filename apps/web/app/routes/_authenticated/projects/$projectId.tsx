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
import { createProjectSchema, IT_DOMAINS, type ItDomain } from '@crm/shared'
import { financeApi } from '@/routes/_authenticated/finance/api'
import { TransactionDetailDialog } from '@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog'
import { TransactionRow } from '@/routes/_authenticated/finance/components/TransactionRow'
import { type ExchangeRates, fmtUsd } from '@/routes/_authenticated/finance/constants'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLegendSection } from '@/components/projects/ProjectLegendSection'
import { ProjectCredentialsSection } from '@/components/projects/ProjectCredentialsSection'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
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
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ImageUploadField } from '@/components/ui/image-upload-field'
import { ShareSlider } from '@/components/ui/share-slider'
import { PAYMENT_TYPE_LABELS } from './constants'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import {
  useUnarchiveEntity,
  type UnarchiveCascadeEntity,
  type UnarchiveError,
} from '@/hooks/use-archive'
import { CascadeUnarchiveModal } from '@/components/archive/CascadeUnarchiveModal'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { toast } from 'sonner'
import type { AxiosError } from 'axios'

/**
 * Defensive coercion: if a project row has a `domain` value that is not
 * a member of the current `IT_DOMAINS` enum (legacy seed data, or
 * external/manual writes that bypass the API validator), fall back to
 * `'Other'`. This prevents the edit dialog from silently submitting the
 * stale value and hitting a 400 «Invalid option: domain» from
 * `updateProjectSchema.parse(...)` on the server.
 *
 * The DB-level fix is migration 0012, which rewrites legacy literals
 * in-place; this is the runtime safety net for any future drift.
 */
function coerceDomain(value: string | null | undefined): ItDomain {
  return (IT_DOMAINS as readonly string[]).includes(value ?? '') ? (value as ItDomain) : 'Other'
}

export const Route = createFileRoute('/_authenticated/projects/$projectId')({
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

// Exported (in addition to the default route `Route`) so
// task-drop-share-override-and-receiver unit tests can mount this subcomponent
// directly (Surface A/C interaction tests) without rendering the entire
// 2000-line route page. Purely additive — no behavior change.
export function ProjectEditFields({
  form,
  mode,
  canEditOverride,
  defaultSharePercent,
  defaultDropSharePercent,
  dropId,
  viewerRole,
  projectId,
}: {
  form: AnyForm
  mode: 'info' | 'members'
  canEditOverride: boolean
  defaultSharePercent: number
  // task-drop-share-override-and-receiver (Surface A). Analog of
  // defaultSharePercent for the DROP share slider — the drop's global default
  // (`project.dropSharePercentDefault ?? 5`), shown as the "reset" hint.
  defaultDropSharePercent: number
  // Surface A visibility gate — the drop-share section only renders for
  // drop-projects (`project.dropId != null`).
  dropId: string | null
  // ut-fix-round2: HR теряет видимость секции с долей синьора целиком (не disabled).
  viewerRole: string | undefined
  projectId?: string | undefined
}) {
  if (mode === 'info') {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>Логотип компании</Label>
          <ImageUploadField
            value={{
              documentId: (form.state.values as { logoDocumentId: string | null }).logoDocumentId,
              externalUrl: (form.state.values as { logoExternalUrl: string | null })
                .logoExternalUrl,
            }}
            onChange={(v) => {
              form.setFieldValue('logoDocumentId', v.documentId)
              form.setFieldValue('logoExternalUrl', v.externalUrl)
            }}
            category="LOGO"
            {...(projectId !== undefined ? { projectId } : {})}
            urlPlaceholder="https://example.com/logo.png"
            testId="edit-project-logo"
          />
        </div>

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
            // task-drop-share-override-and-receiver (Surface C). paymentType
            // moves from free-text Input to a 3-value Select. Field-scoped RBAC
            // reuses `canEditOverride` (ADMIN/ACCOUNTANT edit; everyone else who
            // can reach this dialog — i.e. HR — sees it disabled/read).
            if (fieldName === 'paymentType') {
              return (
                <form.Field key="paymentType" name="paymentType">
                  {(field: AnyField) => (
                    <div className="space-y-1.5">
                      <Label>Тип оплаты</Label>
                      <Select
                        value={field.state.value as string}
                        onValueChange={(v) => field.handleChange(v)}
                        disabled={!canEditOverride}
                      >
                        <SelectTrigger
                          className="h-9 text-sm"
                          data-testid="project-payment-type-trigger"
                        >
                          <SelectValue placeholder="Выберите тип оплаты" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="FOP" className="text-sm">
                            {PAYMENT_TYPE_LABELS.FOP}
                          </SelectItem>
                          <SelectItem value="GIG_CONTRACT" className="text-sm">
                            {PAYMENT_TYPE_LABELS.GIG_CONTRACT}
                          </SelectItem>
                          <SelectItem value="USDT" className="text-sm">
                            {PAYMENT_TYPE_LABELS.USDT}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {!canEditOverride && (
                        <p className="text-xs text-muted-foreground italic">
                          Менять может только ADMIN или ACCOUNTANT.
                        </p>
                      )}
                    </div>
                  )}
                </form.Field>
              )
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

        <form.Subscribe
          selector={(s: { values: { rate: number; currency: string } }) => ({
            rate: s.values.rate,
            currency: s.values.currency,
          })}
        >
          {({ rate, currency }: { rate: number; currency: string }) => (
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

        {/* Per-project SENIOR share — round-3 UI (PR #39 round 2):
            ShareSlider всегда виден; implicit reset (когда value === default —
            backend пишет null). Toggle/Сбросить упразднены.
            RBAC: HR и JUNIOR не видят секцию вообще (фильтрация через viewerRole);
            у не-ADMIN/ACCOUNTANT слайдер disabled. */}
        {viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && (
          <form.Field
            name="seniorSharePercentOverride"
            validators={{
              onBlur: ({ value }: { value: number | null }) => {
                if (value === null || value === undefined || (value as unknown as string) === '')
                  return undefined
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
              const hasOverride = raw !== null && raw !== undefined
              // Initial / current slider value — effective % (override OR default).
              const sliderValue = hasOverride ? (raw as number) : defaultSharePercent
              return (
                <div className="space-y-2" data-testid="project-edit-senior-share-section">
                  <Label className={cn(err && 'text-destructive')}>Доля синьора (%)</Label>
                  <ShareSlider
                    value={sliderValue}
                    min={0}
                    max={100}
                    disabled={!canEditOverride}
                    onChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    error={!!err}
                    inputTestId="project-edit-senior-share-override"
                  />
                  <p className="text-xs text-muted-foreground">
                    По умолчанию: {defaultSharePercent}%. Установите то же значение, чтобы сбросить
                    переопределение.
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
        )}

        {/* Per-project DROP share — task-drop-share-override-and-receiver
            (Surface A). Full analog of seniorSharePercentOverride above:
            differs only in field name / label / role / visibility gate
            (drop-projects only, `project.dropId != null`). Same RBAC —
            HR/JUNIOR never see the section; non-ADMIN/ACCOUNTANT see it
            disabled. */}
        {viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && dropId != null && (
          <form.Field
            name="dropSharePercentOverride"
            validators={{
              onBlur: ({ value }: { value: number | null }) => {
                if (value === null || value === undefined || (value as unknown as string) === '')
                  return undefined
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
              const hasOverride = raw !== null && raw !== undefined
              // Initial / current slider value — effective % (override OR default).
              const sliderValue = hasOverride ? (raw as number) : defaultDropSharePercent
              return (
                <div className="space-y-2" data-testid="project-edit-drop-share-section">
                  <Label className={cn(err && 'text-destructive')}>Доля дропа (%)</Label>
                  <ShareSlider
                    value={sliderValue}
                    min={0}
                    max={100}
                    disabled={!canEditOverride}
                    onChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    error={!!err}
                    inputTestId="project-edit-drop-share-override"
                    role="DROP"
                  />
                  <p className="text-xs text-muted-foreground">
                    По умолчанию: {defaultDropSharePercent}%. Установите то же значение, чтобы
                    сбросить переопределение.
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
        )}
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
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
      <span className="text-muted-foreground shrink-0 min-w-[80px]">{label}:</span>
      <div className="min-w-0 flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 break-words">
        {children}
      </div>
    </div>
  )
}

/**
 * Single source of truth for "effective SENIOR share %" display logic —
 * shows the per-project override (with the «Override» badge + tooltip)
 * or falls back to the senior's global default (with the «по умолчанию»
 * marker). Used in both the read-only Project info card and the
 * Финансы по проекту section so the two stay in lockstep.
 *
 * Set `variant="inline"` for a compact one-line look (the Финансы header)
 * — the wider variant is the default and matches the existing InfoRow.
 */
function ProjectShareInfo({
  project,
  variant = 'block',
  testId = 'project-senior-share',
  badgeTestId = 'project-senior-share-override-badge',
}: {
  project: Pick<
    ProjectDetailDto,
    'seniorSharePercentOverride' | 'seniorSharePercentDefault' | 'pendingSeniorShare'
  >
  variant?: 'block' | 'inline'
  /** Override the default `data-testid` so multiple instances can coexist on the same page. */
  testId?: string
  badgeTestId?: string
}) {
  const overrideRaw = project.seniorSharePercentOverride
  const hasOverride = overrideRaw !== null && overrideRaw !== undefined
  const fallback = project.seniorSharePercentDefault ?? 26
  const effective = hasOverride ? overrideRaw : fallback
  const pending = project.pendingSeniorShare ?? null
  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-2', variant === 'inline' && 'text-sm')}
      data-testid={testId}
    >
      {variant === 'inline' && <span className="text-muted-foreground">Доля синьора:</span>}
      <span className="font-medium tabular-nums">{effective}%</span>
      {hasOverride ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="text-[10px]" data-testid={badgeTestId}>
              Override
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Установлено для этого проекта; глобальная доля синьора: {fallback}%
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">(по умолчанию)</span>
      )}
      {/* task-pending-share (position 5): значение выше — ДЕЙСТВУЮЩЕЕ, не
          меняется пока согласование открыто (AC2). Индикатор — отдельная
          пометка рядом, а не подмена цифры. */}
      {pending && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400"
              data-testid="project-senior-share-pending-badge"
            >
              {pending.percent === null ? (
                <>
                  будет действовать базовый/командный процент:{' '}
                  <span className="tabular-nums">{pending.effectivePercentAfterApproval}</span>%
                  (ожидает подтверждения, {pending.approverName})
                </>
              ) : (
                <>
                  новый <span className="tabular-nums">{pending.percent}</span>% ожидает
                  подтверждения ({pending.approverName})
                </>
              )}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Действует прежний процент, пока {pending.approverName} не подтвердит новый.
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

/**
 * task-pending-share (position 5, design spec §4.3/§8.3). Shown ONLY to the
 * person the pending proposal is actually waiting on (the affected SENIOR —
 * `pendingSeniorShare.approverId === viewerId`). Everyone else who can see
 * the share (ADMIN/ACCOUNTANT/the senior's own view) already gets the
 * informational badge from `ProjectShareInfo` above; this banner is the
 * ACTIONABLE surface, deliberately separate from that read-only indicator.
 */
function PendingShareApprovalBanner({
  projectId,
  pending,
}: {
  projectId: string
  pending: NonNullable<ProjectDetailDto['pendingSeniorShare']>
}) {
  const qc = useQueryClient()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['projects', projectId] })
    void qc.invalidateQueries({ queryKey: ['projects'] })
  }

  const approveMutation = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/senior-share/approve`),
    onSuccess: () => {
      toast.success('Новый процент подтверждён')
      invalidate()
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err as AxiosError, 'Не удалось подтвердить'))
    },
  })

  const rejectMutation = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/senior-share/reject`, { reason }),
    onSuccess: () => {
      toast.success('Предложение отклонено')
      setRejectOpen(false)
      setReason('')
      invalidate()
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err as AxiosError, 'Не удалось отклонить'))
    },
  })

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-3"
      data-testid="pending-share-approval-banner"
    >
      <p className="text-sm">
        {pending.percent === null ? (
          <>
            Будет действовать базовый/командный процент:{' '}
            <span className="font-medium tabular-nums">
              {pending.effectivePercentAfterApproval}%
            </span>
            .{' '}
          </>
        ) : (
          <>
            Новый процент по вашей доле:{' '}
            <span className="font-medium tabular-nums">{pending.percent}%</span>.{' '}
          </>
        )}
        Действующий процент применяется, пока вы не подтвердите.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-11 sm:h-8"
          onClick={() => approveMutation.mutate()}
          disabled={approveMutation.isPending}
          data-testid="pending-share-approve-button"
        >
          Подтвердить
        </Button>
        <Button
          size="sm"
          className="h-11 sm:h-8"
          variant="outline"
          onClick={() => setRejectOpen(true)}
          disabled={approveMutation.isPending}
          data-testid="pending-share-reject-button"
        >
          Отклонить
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <CrmDialogContent>
          <CrmDialogHeader>
            <DialogTitle>Отклонить новый процент</DialogTitle>
            <DialogDescription>Причина обязательна и будет видна администратору.</DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: процент не согласован устно"
              maxLength={500}
              data-testid="pending-share-reject-reason"
            />
            <p className="text-xs text-muted-foreground text-right tabular-nums">
              {reason.length}/500
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setRejectOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              onClick={() => rejectMutation.mutate()}
              disabled={!reason.trim() || rejectMutation.isPending}
              data-testid="pending-share-reject-confirm"
            >
              Отклонить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </div>
  )
}

/**
 * task-drop-share-override-and-receiver (Surface A). Read-only "Доля дропа"
 * widget — twin of `ProjectShareInfo` above for the drop's per-project share.
 * Shows the backend-resolved effective % (override → user default → 5) and an
 * «Override» badge when a project-level override is set.
 */
function ProjectDropShareInfo({
  project,
}: {
  project: Pick<
    ProjectDetailDto,
    'dropSharePercentOverride' | 'dropSharePercentDefault' | 'effectiveDropSharePercent'
  >
}) {
  const overrideRaw = project.dropSharePercentOverride
  const hasOverride = overrideRaw !== null && overrideRaw !== undefined
  const fallback = project.dropSharePercentDefault ?? 5
  const effective = project.effectiveDropSharePercent ?? (hasOverride ? overrideRaw : fallback)
  return (
    <span className="inline-flex items-center gap-2" data-testid="project-drop-share">
      <span className="font-medium tabular-nums">{effective}%</span>
      {hasOverride ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="text-[10px]"
              data-testid="project-drop-share-override-badge"
            >
              Override
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Установлено для этого проекта; глобальная доля дропа: {fallback}%
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">(по умолчанию)</span>
      )}
    </span>
  )
}

function ProjectDetailPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])
  const { projectId } = Route.useParams()
  const { user } = useAuth()
  const qc = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  // ACCOUNTANT can also open the edit dialog so they can change
  // `seniorSharePercentOverride` (backend enforces field-scoped RBAC).
  const canOpenEdit = canManage || user?.role === 'ACCOUNTANT'
  const canRemoveMembers = isAdmin
  // ut-fix-round2 (PR #39 round 2): HR не видит финансовую информацию по
  // проекту — табу «Финансы», info-row «Доля синьора» в Обзоре и секцию
  // ShareSlider в edit-форме.
  // Junior finance-masking: JUNIOR тоже не видит финансы — backend уже
  // эмитит rate/currency/share-поля как null, UI не должен пытаться их рендерить.
  // ADMIN/ACCOUNTANT/SENIOR видят всё (SENIOR — read-only).
  const canSeeProjectFinance = user?.role !== 'HR' && user?.role !== 'JUNIOR'

  const [editOpen, setEditOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addedMemberIds, setAddedMemberIds] = useState<Set<string>>(new Set())
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(new Set())
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ProjectMemberDto | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'members' | 'finance'>('overview')
  // ut-28: explicit Archive button in header replaces «Действия» dropdown + «Завершить» button.
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [cascadeEntities, setCascadeEntities] = useState<UnarchiveCascadeEntity[] | null>(null)
  // Drop attach/detach dialogs (feature/drop-attach-existing-project)
  const [dropPickerOpen, setDropPickerOpen] = useState(false)
  const [detachDropConfirmOpen, setDetachDropConfirmOpen] = useState(false)

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

  // Legend access: RBAC enforced server-side. Client-side guard:
  // subject (seniorId / dropId) excluded; ADMIN/HR/JUNIOR get access.
  // The hook silently returns null on 403/404 for all other roles.
  const isSubject =
    user?.id === project?.seniorId || (project?.dropId != null && user?.id === project?.dropId)
  const canAccessLegend =
    !!project &&
    !isSubject &&
    (user?.role === 'ADMIN' || user?.role === 'HR' || user?.role === 'JUNIOR')

  // Credentials section on the project-detail page is for ADMIN/HR managers.
  // (JUNIOR manages credentials from their «Мой проект» hub, not here.)
  // The component self-hides on a 403 from the backend (e.g. an HR with no
  // shared team), so the client guard only needs the role gate.
  const canManageCredentials = !!project && (user?.role === 'ADMIN' || user?.role === 'HR')

  const editForm = useForm({
    defaultValues: {
      name: project?.name ?? '',
      companyName: project?.companyName ?? '',
      domain: coerceDomain(project?.domain),
      logoDocumentId: project?.logoDocumentId ?? (null as string | null),
      logoExternalUrl: project?.logoExternalUrl ?? (null as string | null),
      rate: (project?.rate ?? '') as unknown as number,
      currency: (project?.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
      seniorSharePercentOverride: project?.seniorSharePercentOverride ?? null,
      // task-drop-share-override-and-receiver (Surface A). Same null-default
      // convention as seniorSharePercentOverride above.
      dropSharePercentOverride: project?.dropSharePercentOverride ?? null,
      techStack: project?.techStack ?? '',
      teamSize: project?.teamSize ?? '',
      benefits: project?.benefits ?? '',
      // task-drop-share-override-and-receiver (Surface C). paymentType is now a
      // 3-value enum Select — default to the backend's own default ('FOP') so a
      // legacy/never-set project still shows a valid, disabled-for-non-editors
      // selection instead of an empty Select.
      paymentType: project?.paymentType ?? 'FOP',
      salaryReview: project?.salaryReview ?? '',
      corpTech: project?.corpTech ?? '',
      notesGeneral: project?.notesGeneral ?? '',
    },
    onSubmit: async ({ value }) => {
      // Round-3 (PR #39 round 2): ShareSlider всегда виден (для не-HR), нет
      // toggle/Сбросить. Implicit reset: если слайдер === default — фронт всё
      // равно шлёт значение, а backend пишет null. Поэтому передаём поле
      // когда оно НА САМОМ ДЕЛЕ изменилось vs. серверный snapshot AND
      // пользователь может его редактировать. HR/SENIOR/JUNIOR ничего не
      // отправляют (canEditOverride=false).
      const overrideChanged =
        canEditOverride &&
        (value.seniorSharePercentOverride ?? null) !== (project?.seniorSharePercentOverride ?? null)
      // task-drop-share-override-and-receiver (Surface A). Same "only send when
      // actually changed AND caller is allowed to edit" convention as senior.
      const dropOverrideChanged =
        canEditOverride &&
        (value.dropSharePercentOverride ?? null) !== (project?.dropSharePercentOverride ?? null)
      editMutation.mutate({
        name: value.name.trim() || undefined,
        companyName: value.companyName.trim() || undefined,
        domain: value.domain || undefined,
        logoDocumentId: value.logoDocumentId ?? null,
        logoExternalUrl: value.logoExternalUrl ?? null,
        rate: Number(value.rate) || undefined,
        currency: value.currency || undefined,
        ...(overrideChanged
          ? { seniorSharePercentOverride: value.seniorSharePercentOverride ?? null }
          : {}),
        ...(dropOverrideChanged
          ? { dropSharePercentOverride: value.dropSharePercentOverride ?? null }
          : {}),
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        // task-drop-share-override-and-receiver (Surface C). Field-scoped RBAC —
        // backend throws ForbiddenException for non-ADMIN/ACCOUNTANT if this key
        // is present AT ALL (even unchanged/null), mirroring
        // seniorSharePercentOverride/dropSharePercentOverride above. Only ADMIN/
        // ACCOUNTANT (canEditOverride) ever include it; HR's disabled Select
        // never reaches the wire.
        ...(canEditOverride ? { paymentType: value.paymentType } : {}),
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

  type UserForAdd = {
    id: string
    displayName: string
    email: string
    role: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    hasActiveProject: boolean
  }

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
      setPendingMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    },
    onError: (_, userId) => {
      setPendingMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    },
  })

  // Drop mutation: PATCH /projects/:id { dropId } for attach (string) and detach (null)
  const dropMutation = useMutation({
    mutationFn: (dropId: string | null) =>
      api.patch<ProjectDto>(`/projects/${projectId}`, { dropId }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      setDropPickerOpen(false)
      setDetachDropConfirmOpen(false)
    },
    onError: (err) => {
      toast.error(getApiErrorMessage(err, 'Не удалось изменить дропа'))
    },
  })

  function openEdit() {
    if (!project) return
    editForm.setFieldValue('name', project.name)
    editForm.setFieldValue('companyName', project.companyName)
    editForm.setFieldValue('domain', coerceDomain(project.domain))
    editForm.setFieldValue('logoDocumentId', project.logoDocumentId ?? null)
    editForm.setFieldValue('logoExternalUrl', project.logoExternalUrl ?? null)
    editForm.setFieldValue('rate', project.rate as unknown as number)
    editForm.setFieldValue('currency', project.currency as 'USDT' | 'USD' | 'EUR' | 'UAH')
    editForm.setFieldValue('seniorSharePercentOverride', project.seniorSharePercentOverride ?? null)
    editForm.setFieldValue('dropSharePercentOverride', project.dropSharePercentOverride ?? null)
    editForm.setFieldValue('techStack', project.techStack ?? '')
    editForm.setFieldValue('teamSize', project.teamSize ?? '')
    editForm.setFieldValue('benefits', project.benefits ?? '')
    editForm.setFieldValue('paymentType', project.paymentType ?? 'FOP')
    editForm.setFieldValue('salaryReview', project.salaryReview ?? '')
    editForm.setFieldValue('corpTech', project.corpTech ?? '')
    editForm.setFieldValue('notesGeneral', project.notesGeneral ?? '')
    setEditOpen(true)
  }

  // Rules of Hooks: moved here — after every hook above — instead of
  // between `useAuth` and the ~14 hooks that follow it (useState/useQuery/
  // useForm/useMutation). `denied` flips false→true mid-mount once
  // `useAuth`'s `isLoading` resolves to a disallowed role; a guard sitting
  // in the middle of the hook list made that transition change the hook
  // count between renders ("Rendered fewer hooks than expected"). This
  // route is also gated at the layout level (see use-role-guard.ts), so
  // this remains defense-in-depth, not the only guard.
  if (denied) return null

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
  // seniorId/seniorName are null for JUNIOR viewers (identity masking by backend allowlist).
  // task-admin-as-senior: for non-privileged viewers of admin-projects, seniorId is null
  // but seniorName is still set (displayName is safe to show). We show the row without a link
  // by setting userId=null (ProfileNameLink nonNavigable prop handles the plain-text render).
  const senior =
    project.seniorId != null || project.seniorName != null
      ? {
          // null when backend masks it (admin-project + non-privileged viewer)
          userId: project.seniorId ?? null,
          displayName: project.seniorName ?? '',
          role: 'SENIOR',
          avatarUrl: null as string | null,
          avatarDocumentId: null as string | null,
        }
      : null
  // Drop member for display in Team card (Обзор tab). API masks drop=null for
  // SENIOR/JUNIOR viewers (PR #363), so the UI condition simply checks for null.
  const dropMember = project.effectiveTeam?.drop ?? null
  const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
  const activeHRs = activeMembers.filter((m) => m.role === 'HR')
  const activeAccountants = activeMembers.filter((m) => m.role === 'ACCOUNTANT')
  const hasActiveJunior = activeJuniors.length > 0
  const availableToAdd = (allUsers ?? []).filter((u) => {
    if (u.role === 'ADMIN' || u.role === 'SENIOR') return false
    if (u.role === 'DROP') return false // DROP goes through PATCH /projects/:id, not POST /members
    if (activeMembers.some((m) => m.userId === u.id)) return false
    if (u.role === 'JUNIOR') {
      if (hasActiveJunior) return false
      if (u.hasActiveProject) return false
    }
    return true
  })
  // DROP candidates for the attach-drop picker (only when no drop is assigned)
  const dropCandidates =
    project.dropId == null ? (allUsers ?? []).filter((u) => u.role === 'DROP') : []

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto pb-6">
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
              <Link to="/projects" className="shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div className="relative shrink-0">
                <div
                  className="absolute inset-0 rounded-xl opacity-30 blur-md"
                  style={{ background: '#f5c542' }}
                />
                <ProjectLogo
                  documentId={project.logoDocumentId}
                  externalUrl={project.logoExternalUrl}
                  companyName={project.companyName}
                  fallback={getInitials(project.companyName)}
                  avatarClassName="relative h-14 w-14 rounded-xl shadow-lg"
                />
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
                  {/* Drop role - phase 2. Distinct blue/info badge for drop-
                    projects so it's obvious at a glance that money flows
                    through a DROP user. Hidden for regular senior-projects.
                    RBAC: only ADMIN/HR/ACCOUNTANT see this badge — JUNIOR
                    must not know the identity behind the legend is a DROP. */}
                  {project.dropId &&
                    (user?.role === 'ADMIN' ||
                      user?.role === 'HR' ||
                      user?.role === 'ACCOUNTANT') && (
                      <Badge
                        variant="outline"
                        className="border-blue-500/30 bg-blue-500/10 text-blue-400 text-xs"
                        data-testid="project-drop-badge"
                      >
                        Drop-проект
                      </Badge>
                    )}
                  <Badge variant="outline" className="text-xs">
                    {project.domain}
                  </Badge>
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
            {/* rate / currency are null for JUNIOR (finance masking, RBAC A01).
              Only render the stat chip when finance data is available. */}
            {project.rate != null && project.currency != null && (
              <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
                <DollarSign className="h-4 w-4 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Ставка
                  </p>
                  <p className="text-sm font-semibold tabular-nums">
                    {project.rate.toLocaleString()} {project.currency}
                  </p>
                  {rates && project.currency !== 'USD' && project.currency !== 'USDT' && (
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      ≈ {fmtUsd(project.rate, project.currency, rates)}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
              <Calendar className="h-4 w-4 text-blue-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Старт</p>
                <p className="text-sm font-semibold">
                  {new Date(project.startDate).toLocaleDateString('ru-RU', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })}
                </p>
              </div>
            </div>
            {project.archivedAt && (
              <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
                <Calendar className="h-4 w-4 text-amber-400 shrink-0" />
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Завершён
                  </p>
                  <p className="text-sm font-semibold">
                    {new Date(project.archivedAt).toLocaleDateString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    })}
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
        {/* task-pending-share (position 5): actionable banner, ONLY for the
            viewer the proposal is waiting on — everyone else sees the
            read-only badge via ProjectShareInfo instead. */}
        {project.pendingSeniorShare && user?.id === project.pendingSeniorShare.approverId && (
          <div className="px-4 sm:px-6">
            <PendingShareApprovalBanner
              projectId={project.id}
              pending={project.pendingSeniorShare}
            />
          </div>
        )}
        {/* ── Post-hero content — horizontal padding (px-0 removed from outer wrapper, Вариант Б) ── */}
        <div className="space-y-5 px-4 sm:px-6">
          {/* ut-29 + ut-33: project detail tabs — unified through SegmentedToggle
          variant="tabs" (same yellow page-level styling as projects list).
          ut-fix-round2: «Финансы» табу видят только не-HR (ADMIN/ACCOUNTANT/
          SENIOR). HR на ?tab=finance — fallback на «Обзор». */}
          {(() => {
            type ProjectTab = 'overview' | 'members' | 'finance'
            const tabOptions: ReadonlyArray<SegmentedToggleOption<ProjectTab>> = [
              { value: 'overview', label: 'Обзор', testId: 'tab-overview' },
              { value: 'members', label: 'Состав', testId: 'tab-members' },
              ...(canSeeProjectFinance
                ? ([{ value: 'finance', label: 'Финансы', testId: 'tab-finance' }] as const)
                : []),
            ]
            // Fallback: если HR оказался на «finance» табе — переключить на «overview».
            const safeActiveTab: ProjectTab =
              activeTab === 'finance' && !canSeeProjectFinance
                ? 'overview'
                : (activeTab as ProjectTab)
            return (
              <SegmentedToggle<ProjectTab>
                value={safeActiveTab}
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
            <ProjectEffectiveTeamCard
              project={project}
              {...(user?.role !== undefined ? { viewerRole: user.role } : {})}
              canManageDrop={canManage && !project.archivedAt}
              dropCandidates={dropCandidates}
              onAttachDrop={() => setDropPickerOpen(true)}
              onDetachDrop={() => setDetachDropConfirmOpen(true)}
            />
          )}

          {activeTab === 'overview' && (
            <motion.div
              className="grid grid-cols-1 gap-4 lg:grid-cols-2"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.08 }}
            >
              {/* Details card */}
              <Card className="min-w-0 border-border/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Детали проекта
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-0 divide-y divide-border/40">
                  <InfoRow icon={<Briefcase className="h-3.5 w-3.5" />} label="Стек">
                    {project.techStack ? (
                      <span className="font-medium">{project.techStack}</span>
                    ) : (
                      <span className="text-muted-foreground/40 italic">—</span>
                    )}
                  </InfoRow>
                  <InfoRow icon={<Users className="h-3.5 w-3.5" />} label="Команда">
                    {project.teamSize ? (
                      <span className="font-medium">{project.teamSize}</span>
                    ) : (
                      <span className="text-muted-foreground/40 italic">—</span>
                    )}
                  </InfoRow>
                  <InfoRow icon={<Building2 className="h-3.5 w-3.5" />} label="Бенефиты">
                    {project.benefits ? (
                      <span className="font-medium">{project.benefits}</span>
                    ) : (
                      <span className="text-muted-foreground/40 italic">—</span>
                    )}
                  </InfoRow>
                  {/* task-drop-share-override-and-receiver (Surface C, Q5). Backend
                  masks paymentType to `null` for JUNIOR — the row is ALSO
                  explicitly hidden client-side (defense-in-depth per the design
                  spec, not relying solely on the null value). HR still sees it
                  (read value), only JUNIOR loses the row entirely. */}
                  {user?.role !== 'JUNIOR' && (
                    <InfoRow icon={<CreditCard className="h-3.5 w-3.5" />} label="Тип оплаты">
                      {project.paymentType ? (
                        <span className="font-medium">
                          {PAYMENT_TYPE_LABELS[project.paymentType]}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40 italic">—</span>
                      )}
                    </InfoRow>
                  )}
                  <InfoRow icon={<RefreshCw className="h-3.5 w-3.5" />} label="Пересмотр ЗП">
                    {project.salaryReview ? (
                      <span className="font-medium">{project.salaryReview}</span>
                    ) : (
                      <span className="text-muted-foreground/40 italic">—</span>
                    )}
                  </InfoRow>
                  <InfoRow icon={<Laptop className="h-3.5 w-3.5" />} label="Корп. техника">
                    {project.corpTech ? (
                      <span className="font-medium">{project.corpTech}</span>
                    ) : (
                      <span className="text-muted-foreground/40 italic">—</span>
                    )}
                  </InfoRow>
                  <div className="flex items-start gap-2 py-3 text-sm">
                    <StickyNote className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground mb-1">Общие заметки</p>
                      {project.notesGeneral ? (
                        <p className="text-sm whitespace-pre-wrap leading-relaxed">
                          {project.notesGeneral}
                        </p>
                      ) : (
                        <span className="text-muted-foreground/40 italic">—</span>
                      )}
                    </div>
                  </div>
                  {/* Per-project SENIOR share — read-only view. Renders the same
                ProjectShareInfo widget used in the Финансы по проекту section
                below so the two stay in sync. RBAC enforcement lives at the
                API layer; UI ut-fix-round2 also hides this row for HR. */}
                  {canSeeProjectFinance && (
                    <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label="Доля синьора">
                      <ProjectShareInfo project={project} />
                    </InfoRow>
                  )}
                  {/* task-drop-share-override-and-receiver (Surface A). Same
                  read-only pattern as «Доля синьора» above, drop-projects only. */}
                  {canSeeProjectFinance && project.dropId != null && (
                    <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label="Доля дропа">
                      <ProjectDropShareInfo project={project} />
                    </InfoRow>
                  )}
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
                              onClick={() => {
                                setAddedMemberIds(new Set())
                                setAddMemberOpen(true)
                              }}
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
                  {/* Senior row — hidden for JUNIOR viewers (seniorId masked by backend allowlist).
                  task-admin-as-senior: when seniorId is null but seniorName is set, the senior
                  is an ADMIN and this viewer lacks profile access — render name without link. */}
                  {senior != null && (
                    <div className="pb-3">
                      {/* senior.userId is null when backend masks it (admin-project + non-privileged viewer).
                      In that case we render a non-navigable span via ProfileNameLink nonNavigable prop. */}
                      {/* LOW fix: when nonNavigable=true (seniorId=null → admin-project without access),
                      userId is not consumed by ProfileNameLink (renders span). Pass it only when
                      navigation is possible (exactOptionalPropertyTypes: conditional spread). */}
                      <ProfileNameLink
                        {...(senior.userId != null ? { userId: senior.userId } : {})}
                        viewerRole={user?.role ?? 'JUNIOR'}
                        nonNavigable={senior.userId == null}
                        className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
                      >
                        <Avatar className="h-8 w-8 shrink-0 ring-2 ring-[#6366f1]/30">
                          <AvatarFallback className="text-[11px] font-semibold">
                            {getInitials(senior.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        {/* MED1: no hover:underline — element may be non-navigable (nonNavigable=true)
                        when viewer cannot access the admin's profile. A non-clickable span
                        must not show pointer/underline hover styles. */}
                        <span className="text-sm font-medium truncate text-primary">
                          {senior.displayName}
                        </span>
                        <Badge variant="senior" className="shrink-0 text-[9px] ml-auto">
                          Синьор
                        </Badge>
                      </ProfileNameLink>
                    </div>
                  )}

                  {/* Drop row — display-only; after senior, before HR.
                  RBAC: ADMIN/HR/ACCOUNTANT only (API masks drop=null for SENIOR/JUNIOR, PR #363).
                  No manage buttons here — drop management is on the «Состав» tab. */}
                  {dropMember != null &&
                    (user?.role === 'ADMIN' ||
                      user?.role === 'HR' ||
                      user?.role === 'ACCOUNTANT') && (
                      <div className="pb-3" data-testid="team-card-drop-row">
                        <ProfileNameLink
                          userId={dropMember.id}
                          viewerRole={user?.role ?? 'JUNIOR'}
                          className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
                        >
                          <Avatar className="h-8 w-8 shrink-0">
                            {dropMember.avatarUrl && (
                              <AvatarImage
                                src={dropMember.avatarUrl}
                                alt={dropMember.displayName}
                              />
                            )}
                            <AvatarFallback className="text-[11px] font-semibold">
                              {getInitials(dropMember.displayName)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm font-medium truncate text-primary">
                            {dropMember.displayName}
                          </span>
                          <Badge
                            variant="outline"
                            className="border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px] ml-auto"
                          >
                            Дроп
                          </Badge>
                        </ProfileNameLink>
                      </div>
                    )}

                  {/* HR */}
                  <div className="pt-3 pb-3">
                    {activeHRs.length === 0 ? (
                      <p className="text-xs text-muted-foreground/50 italic">Не назначен</p>
                    ) : (
                      <div className="space-y-1.5">
                        {activeHRs.map((m) => (
                          <MemberRow
                            key={m.id}
                            member={m}
                            canManage={canRemoveMembers}
                            onRemove={() => setRemoveMemberTarget(m)}
                          />
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
                          <MemberRow
                            key={m.id}
                            member={m}
                            canManage={canRemoveMembers}
                            onRemove={() => setRemoveMemberTarget(m)}
                          />
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
                          <MemberRow
                            key={m.id}
                            member={m}
                            canManage={canRemoveMembers}
                            onRemove={() => setRemoveMemberTarget(m)}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Past members */}
                  {pastMembers.length > 0 && (
                    <div className="pt-3">
                      <p className="text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider mb-2">
                        Покинули проект
                      </p>
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

          {/* Legend section — subject (seniorId/dropId) excluded per RBAC contract */}
          {activeTab === 'overview' && (
            <ProjectLegendSection projectId={projectId} canAccess={canAccessLegend} />
          )}

          {/* Credentials section — ADMIN/HR managers (self-hides on 403) */}
          {activeTab === 'overview' && canManageCredentials && (
            <ProjectCredentialsSection projectId={projectId} canEdit />
          )}

          {activeTab === 'finance' && canSeeProjectFinance && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.16 }}
            >
              <ProjectTransactions projectId={projectId} project={project} />
            </motion.div>
          )}
        </div>{' '}
        {/* end post-hero px-4 sm:px-6 */}
        {/* ── Edit / Add member dialog ── */}
        <Dialog open={editOpen} onOpenChange={(v) => !v && setEditOpen(false)}>
          <CrmDialogContent maxWidth="max-w-lg">
            <CrmDialogHeader>
              <DialogTitle>Редактировать — {project.companyName}</DialogTitle>
              <DialogDescription className="sr-only">
                Редактирование параметров проекта: ставка, валюта, домен и настройки доли.
              </DialogDescription>
            </CrmDialogHeader>

            <CrmDialogBody>
              <div className="space-y-5">
                {canOpenEdit && editOpen && (
                  <ProjectEditFields
                    form={editForm}
                    mode="info"
                    canEditOverride={canEditOverride}
                    defaultSharePercent={project.seniorSharePercentDefault}
                    defaultDropSharePercent={project.dropSharePercentDefault ?? 5}
                    dropId={project.dropId}
                    viewerRole={user?.role}
                    projectId={projectId}
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
              <DialogDescription className="sr-only">
                Подтверждение удаления участника из проекта.
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody className="pb-2">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {removeMemberTarget?.displayName}
                </span>{' '}
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
        <Dialog
          open={addMemberOpen}
          onOpenChange={(v) => {
            if (!v) setAddMemberOpen(false)
          }}
        >
          <CrmDialogContent maxWidth="max-w-sm">
            <CrmDialogHeader>
              <DialogTitle>Добавить участника</DialogTitle>
              <DialogDescription className="sr-only">
                Выбор участников для добавления в проект.
              </DialogDescription>
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
                    <div key={u.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
                      <Avatar className="h-7 w-7 shrink-0">
                        {u.avatarUrl && <AvatarImage src={u.avatarUrl} />}
                        <AvatarFallback className="text-[10px]">
                          {getInitials(u.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                      </div>
                      <Badge
                        variant={ROLE_VARIANT[u.role] ?? 'junior'}
                        className="shrink-0 text-[9px]"
                      >
                        {ROLE_LABELS[u.role] ?? u.role}
                      </Badge>
                      <Button
                        size="sm"
                        variant={isAdded ? 'outline' : 'default'}
                        className={cn(
                          'shrink-0 h-7 text-xs px-2.5',
                          isAdded && 'text-emerald-500 border-emerald-500/40',
                        )}
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
        {/* ── Drop picker dialog (attach drop) ── */}
        <Dialog open={dropPickerOpen} onOpenChange={(v) => !v && setDropPickerOpen(false)}>
          <CrmDialogContent maxWidth="max-w-sm" data-testid="attach-drop-dialog">
            <CrmDialogHeader>
              <DialogTitle>Привязать дропа</DialogTitle>
              <DialogDescription className="sr-only">Выбор дропа для проекта</DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody>
              <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                {dropCandidates.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">Нет доступных дропов</p>
                )}
                {dropCandidates.map((u) => (
                  <li key={u.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
                    <Avatar className="h-7 w-7 shrink-0">
                      {u.avatarUrl && <AvatarImage src={u.avatarUrl} />}
                      <AvatarFallback className="text-[10px]">
                        {getInitials(u.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{u.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className="shrink-0 border-blue-500/30 bg-blue-500/10 text-[9px] text-blue-400"
                    >
                      Дроп
                    </Badge>
                    <Button
                      size="sm"
                      className="h-7 min-h-[44px] min-w-[72px] shrink-0 px-2.5 text-xs sm:min-h-0"
                      disabled={dropMutation.isPending}
                      onClick={() => dropMutation.mutate(u.id)}
                      aria-label={`Назначить ${u.displayName} дропом`}
                      data-testid={`assign-drop-btn-${u.id}`}
                    >
                      {dropMutation.isPending ? '...' : 'Назначить'}
                    </Button>
                  </li>
                ))}
              </ul>
            </CrmDialogBody>
          </CrmDialogContent>
        </Dialog>
        {/* ── Detach drop confirm dialog ── */}
        <Dialog
          open={detachDropConfirmOpen}
          onOpenChange={(v) => !v && setDetachDropConfirmOpen(false)}
        >
          <CrmDialogContent maxWidth="sm:max-w-sm" data-testid="detach-drop-dialog">
            <CrmDialogHeader>
              <DialogTitle>Снять дропа?</DialogTitle>
              <DialogDescription className="sr-only">
                Подтверждение снятия дропа с проекта
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody className="pb-2">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {project.effectiveTeam?.drop?.displayName ?? 'Дроп'}
                </span>{' '}
                будет снят с проекта. Приходы больше не будут проходить через него.
              </p>
            </CrmDialogBody>
            <CrmDialogFooter>
              <Button variant="outline" onClick={() => setDetachDropConfirmOpen(false)}>
                Отмена
              </Button>
              <Button
                variant="destructive"
                onClick={() => dropMutation.mutate(null)}
                disabled={dropMutation.isPending}
                data-testid="detach-drop-confirm-btn"
              >
                Снять
              </Button>
            </CrmDialogFooter>
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

/**
 * Drop role - phase 2 (AC3). Distribution breakdown panel for drop-projects.
 *
 * Renders the formula visualisation specified in §8.1 of
 * drop-role-and-finance-spec.md — example income $1000:
 *   Доля синьора 26%   $260
 *   Доля дропа 5%      $50
 *   Партнёрам 50/50    $345 / $345
 *
 * Senior share = `seniorSharePercentOverride ?? seniorSharePercentDefault`
 * (same rule as the existing «Override» badge widget). Drop share is read
 * from the snapshot on the project DTO. The remainder is split 50/50
 * between partners. Component is mounted only when the project is a
 * drop-project (`project.dropId != null`); the caller enforces the RBAC
 * (ADMIN/ACCOUNTANT/SENIOR/DROP — same audience that sees the Финансы tab).
 */
function ProjectDropDistribution({ project }: { project: ProjectDetailDto }) {
  // Use $1000 as the canonical example. Numbers shown without currency
  // suffix to keep the formula abstract — actual amounts vary per income.
  const seniorPct = project.seniorSharePercentOverride ?? project.seniorSharePercentDefault ?? 26
  // task-drop-share-override-and-receiver (Surface A). Override-aware: prefer
  // the backend-resolved effective % (override → user default → 5) over the
  // legacy read-time snapshot so a project-level override is reflected here too.
  const dropPct = project.effectiveDropSharePercent ?? project.dropSharePercent ?? 5
  const exampleIncome = 1000
  const seniorShare = (exampleIncome * seniorPct) / 100
  const dropShare = (exampleIncome * dropPct) / 100
  const remainder = exampleIncome - seniorShare - dropShare
  const partnerEach = remainder / 2
  const fmt = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  return (
    <Card className="border-blue-500/20 bg-blue-500/[0.03]" data-testid="project-drop-distribution">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold text-blue-400 uppercase tracking-wider">
          Распределение прихода (пример {fmt(exampleIncome)})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Доля синьора ({seniorPct}%)</span>
          <span className="font-semibold tabular-nums" data-testid="dist-senior-share">
            {fmt(seniorShare)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Доля дропа ({dropPct}%)</span>
          <span className="font-semibold tabular-nums" data-testid="dist-drop-share">
            {fmt(dropShare)}
          </span>
        </div>
        <div className="h-px bg-border/60 my-1" />
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Партнёрам (50 / 50)</span>
          <span className="font-semibold tabular-nums" data-testid="dist-partner-share">
            {fmt(partnerEach)} / {fmt(partnerEach)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectTransactions({
  projectId,
  project,
}: {
  projectId: string
  project: ProjectDetailDto
}) {
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

  // Drop role - phase 2 (AC3). Distribution panel visible to ADMIN /
  // ACCOUNTANT / SENIOR (the project's) / DROP (the project's). Other
  // roles never reach this tab (gated upstream by `canSeeProjectFinance`).
  const role = user.role
  const isProjectSenior = role === 'SENIOR' && project.seniorId === user.id
  const isProjectDrop = role === 'DROP' && project.dropId === user.id
  const canSeeDistribution =
    !!project.dropId &&
    (role === 'ADMIN' || role === 'ACCOUNTANT' || isProjectSenior || isProjectDrop)

  return (
    <>
      {canSeeDistribution && (
        <div className="mb-4">
          <ProjectDropDistribution project={project} />
        </div>
      )}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Финансы по проекту
            </CardTitle>
            {/* Effective senior share — applies to every SENIOR_INCOME
                row in the table below. Mirrors the read-only marker in
                the Project info card so it's obvious which split was
                used at the moment each transaction was created. */}
            <div className="flex items-center" data-testid="project-transactions-share-row">
              <ProjectShareInfo
                project={project}
                variant="inline"
                testId="project-transactions-senior-share"
                badgeTestId="project-transactions-senior-share-override-badge"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !transactions?.length ? (
            <p className="text-sm text-muted-foreground px-4 pb-4">
              Транзакций по проекту пока нет
            </p>
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
        to="/profile/$userId"
        params={{ userId: member.userId }}
        className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80 transition-opacity"
      >
        <Avatar className="h-6 w-6 shrink-0">
          {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={member.displayName} />}
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
function ProjectEffectiveTeamCard({
  project,
  viewerRole,
  canManageDrop = false,
  dropCandidates = [],
  onAttachDrop,
  onDetachDrop,
}: {
  project: ProjectDetailDto
  viewerRole?: string | undefined
  canManageDrop?: boolean
  dropCandidates?: { id: string; displayName: string }[]
  onAttachDrop?: () => void
  onDetachDrop?: () => void
}) {
  const effective = project.effectiveTeam
  const senior = effective?.senior ?? null
  // Drop role - phase 2. Optional drop row in the «Эффективный состав»
  // card. Shown only when `effectiveTeam.drop` is set (the project has a
  // dropId). Regular senior-projects render exactly as before.
  const rawDrop = effective?.drop ?? null
  // RBAC rule: SENIOR viewers must not see DROP identity (same pattern as
  // junior-masking below). UI double-guard — backend computeEffectiveTeam
  // will also mask this server-side once patched, but the client guard
  // ensures drop identity never reaches the render tree regardless.
  const drop = viewerRole === 'SENIOR' || viewerRole === 'JUNIOR' ? null : rawDrop
  const hrs = effective?.hrs ?? []
  const accountants = effective?.accountants ?? []
  // RBAC rule #1: SENIOR viewers must not see JUNIOR identity.
  // Backend already filters juniors[] to [] for SENIOR; UI double-guard for safety.
  const rawJuniors =
    effective?.juniors ?? project.members.filter((m) => m.role === 'JUNIOR' && m.leftAt === null)
  const juniors = viewerRole === 'SENIOR' ? [] : rawJuniors

  // ut-30: flat list — single «Эффективный состав» heading; role-specific
  // section headings («СИНЬОР», «HR (N)», «БУХГАЛТЕРЫ (N)», «ДЖУНЫ (N)») removed.
  // Each row keeps its role badge for visual differentiation.
  // task-admin-as-senior: profileNavigable=false for admin-senior when viewer lacks
  // profile access — renders plain text instead of a navigable link.
  type FlatMember = {
    key: string
    profileId: string
    displayName: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    role: 'SENIOR' | 'DROP' | 'HR' | 'ACCOUNTANT' | 'JUNIOR'
    sectionTestId: string
    profileNavigable?: boolean
  }
  const flatMembers: FlatMember[] = []
  if (senior) {
    flatMembers.push({
      key: `senior-${senior.id}`,
      profileId: senior.id,
      displayName: senior.displayName,
      avatarUrl: senior.avatarUrl,
      avatarDocumentId: senior.avatarDocumentId,
      role: 'SENIOR',
      sectionTestId: 'effective-team-senior',
      // false when admin-senior and viewer lacks profile access (backend sets profileNavigable=false)
      profileNavigable: effective?.senior?.profileNavigable ?? true,
    })
  }
  // Drop role - phase 2. Insert drop directly after senior to keep the
  // financial chain visible at a glance (income → drop → senior → juniors).
  if (drop) {
    flatMembers.push({
      key: `drop-${drop.id}`,
      profileId: drop.id,
      displayName: drop.displayName,
      avatarUrl: drop.avatarUrl,
      avatarDocumentId: drop.avatarDocumentId,
      role: 'DROP',
      sectionTestId: 'effective-team-drop',
    })
  }
  for (const m of hrs) {
    flatMembers.push({
      key: `hr-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      avatarDocumentId: m.avatarDocumentId,
      role: 'HR',
      sectionTestId: 'effective-team-hrs',
    })
  }
  for (const m of accountants) {
    flatMembers.push({
      key: `acc-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      avatarDocumentId: m.avatarDocumentId,
      role: 'ACCOUNTANT',
      sectionTestId: 'effective-team-accountants',
    })
  }
  for (const m of juniors) {
    flatMembers.push({
      key: `jun-${m.id}`,
      profileId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      avatarDocumentId: m.avatarDocumentId,
      role: 'JUNIOR',
      sectionTestId: 'effective-team-juniors',
    })
  }

  return (
    <Card className="border-border/40" data-testid="effective-team-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Эффективный состав
            <span className="ml-2 text-[10px] font-normal normal-case text-muted-foreground/60">
              (HR/бухгалтер — из текущей команды синьора)
            </span>
          </CardTitle>
          {/* Attach drop button — only when canManageDrop and no drop yet */}
          {canManageDrop && project.dropId == null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground min-h-[44px] sm:h-7 sm:min-h-0"
                    onClick={onAttachDrop}
                    disabled={dropCandidates.length === 0}
                    data-testid="attach-drop-btn"
                  >
                    <UserPlus className="h-3 w-3" />
                    Привязать дропа
                  </Button>
                </span>
              </TooltipTrigger>
              {dropCandidates.length === 0 && <TooltipContent>Нет доступных дропов</TooltipContent>}
            </Tooltip>
          )}
        </div>
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
        {flatMembers.map((m) => {
          // task-admin-as-senior: admin-senior with profileNavigable=false renders
          // as a non-navigable row (plain div) instead of a profile <Link>.
          const isNavigable = m.profileNavigable !== false && viewerRole !== 'DROP'
          const rowContent = (
            <>
              <Avatar className="h-7 w-7 shrink-0">
                {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={m.displayName} />}
                <AvatarFallback className="text-[10px] font-semibold">
                  {getInitials(m.displayName)}
                </AvatarFallback>
              </Avatar>
              {/* MED1: hover:underline only when the row is navigable — a non-clickable
                  div (isNavigable=false) must not show pointer/underline hover style. */}
              <span
                className={`text-sm font-medium truncate flex-1 text-primary${isNavigable ? ' hover:underline' : ''}`}
              >
                {m.displayName}
              </span>
              {/* Drop role - phase 2. DROP gets a distinct blue/info badge so
                  it is visually separable from SENIOR/HR/ACCOUNTANT/JUNIOR. */}
              {m.role === 'DROP' ? (
                <Badge
                  variant="outline"
                  className="border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px]"
                >
                  Дроп
                </Badge>
              ) : (
                <Badge
                  variant={
                    m.role === 'SENIOR'
                      ? 'senior'
                      : m.role === 'HR'
                        ? 'hr'
                        : m.role === 'ACCOUNTANT'
                          ? 'accountant'
                          : 'junior'
                  }
                  className="shrink-0 text-[9px]"
                >
                  {m.role === 'SENIOR'
                    ? 'Синьор'
                    : m.role === 'HR'
                      ? 'HR'
                      : m.role === 'ACCOUNTANT'
                        ? 'Бухгалтер'
                        : 'Джун'}
                </Badge>
              )}
            </>
          )
          // Detach drop button — only for DROP rows when canManageDrop
          const detachBtn =
            m.role === 'DROP' && canManageDrop ? (
              <span className="flex items-center justify-center p-3 -m-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label="Снять дропа с проекта"
                  data-testid="detach-drop-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onDetachDrop?.()
                  }}
                >
                  <UserMinus className="h-3 w-3" />
                </Button>
              </span>
            ) : null

          return isNavigable ? (
            <Link
              key={m.key}
              to="/profile/$userId"
              params={{ userId: m.profileId }}
              data-testid={m.sectionTestId}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors"
            >
              {rowContent}
              {detachBtn}
            </Link>
          ) : (
            <div
              key={m.key}
              data-testid={m.sectionTestId}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
            >
              {rowContent}
              {detachBtn}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
