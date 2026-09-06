import { useState } from 'react'
import {
  Bitcoin,
  Building2,
  Hash,
  IdCard,
  Landmark,
  Pencil,
  Plus,
  ShieldCheck,
  StickyNote,
  User as UserIcon,
  Wallet,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Textarea } from '@/components/ui/textarea'
import { useApproveSeniorShareChange, useRejectSeniorShareChange } from '@/hooks/use-user-profile'
import type { UserProfileDto, ViewPermissions } from '@crm/shared'
import { ProfileEditFields } from '../self-edit/ProfileEditFields'
import { AdminNoteDialog } from '../admin-actions/AdminNoteDialog'
import { ProfileCredentialsSection } from '../ProfileCredentialsSection'

export interface OverviewTabProps {
  user: UserProfileDto
  data: Record<string, unknown>
  permissions: ViewPermissions
  mode: 'self' | 'view'
  onGoToTab?: (tab: string) => void
}

// ── DROP-specific overview components ─────────────────────────────────────────

/** Shown on overview when DROP has no payment method set. */
function RequisitesMissingBanner({ onGoToRequisites }: { onGoToRequisites: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid="drop-requisites-missing-banner"
    >
      <div className="flex items-start gap-3">
        <Wallet className="h-5 w-5 shrink-0 mt-0.5 text-destructive" aria-hidden="true" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Реквизиты не заполнены</p>
          <p className="text-xs text-muted-foreground">
            Без реквизитов невозможен роутинг платежей. Укажите USDT кошелёк или банковский счёт.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        onClick={onGoToRequisites}
        data-testid="drop-requisites-missing-cta"
        className="shrink-0"
      >
        Заполнить реквизиты
      </Button>
    </div>
  )
}

/**
 * task-pending-share (position 5, design spec §4.3/§8.3). Self-view ONLY —
 * a SENIOR looking at their OWN profile sees this when their BASE share
 * percent has a pending proposal awaiting their confirmation. Mirrors
 * `PendingShareApprovalBanner` in the project detail page (same texts,
 * same two-action shape) — deliberately not a shared component: the two
 * post to different endpoints (`/users/:id/senior-share/*` vs
 * `/projects/:id/senior-share/*`) and a shared abstraction over "which id,
 * which URL" would buy less than it costs here.
 */
function PendingBaseShareBanner({
  userId,
  currentPercent,
  pending,
}: {
  userId: string
  /** task-648-fix-round-1 (COPY-M-6): the ACTIVE value, shown alongside the
   * proposed one so the reader can compare — the resolver still returns
   * this (AC2), unchanged, for as long as this banner is visible. */
  currentPercent: number
  pending: NonNullable<UserProfileDto['pendingSeniorShare']>
}) {
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')
  const approveMutation = useApproveSeniorShareChange(userId)
  const rejectMutation = useRejectSeniorShareChange(userId)

  const handleReject = () => {
    rejectMutation.mutate(reason, {
      onSuccess: () => {
        setRejectOpen(false)
        setReason('')
      },
    })
  }

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-3"
      data-testid="pending-base-share-approval-banner"
    >
      {/* task-648-fix-round-1 (COPY-M-5/COPY-M-6): "доля по умолчанию" — same
          term CONTEXT.md's "Доля синьора" entry uses, no "базов*" (that word
          appears nowhere else in apps/web). Shows BOTH numbers — the reader
          decides by comparing "сейчас" against "предлагают", and until now
          only one of the two was on screen. */}
      <p className="text-sm">
        Вашу долю по умолчанию предлагают изменить: сейчас{' '}
        <span className="font-medium tabular-nums">{currentPercent}%</span>, предлагают{' '}
        <span className="font-medium tabular-nums">{pending.percent}%</span>. Пока вы не
        подтвердите, действует {currentPercent}%.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-11 sm:h-8"
          onClick={() => approveMutation.mutate()}
          disabled={approveMutation.isPending}
          data-testid="pending-base-share-approve-button"
        >
          {/* task-648-fix-round-1 (COPY-M-9): in-flight state names itself,
              same convention as the other 8 process-labels in the repo
              («Сохранение…», «Публикация…», …). */}
          {approveMutation.isPending ? 'Подтверждение…' : 'Подтвердить'}
        </Button>
        <Button
          size="sm"
          className="h-11 sm:h-8"
          variant="outline"
          onClick={() => setRejectOpen(true)}
          disabled={approveMutation.isPending}
          data-testid="pending-base-share-reject-button"
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
            {/* task-648-fix-round-1 (COPY-M-8): a placeholder disappears on
                the first keystroke and never reads as a field name —
                mirrors ProjectApprovalActions.tsx's (#646) identical fix. */}
            <Label htmlFor="pending-base-share-reject-reason" className="text-xs">
              Причина отказа *
            </Label>
            <Textarea
              id="pending-base-share-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: договаривались на 30%"
              maxLength={500}
              rows={3}
              data-testid="pending-base-share-reject-reason"
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
              onClick={handleReject}
              disabled={!reason.trim() || rejectMutation.isPending}
              data-testid="pending-base-share-reject-confirm"
            >
              {/* task-648-fix-round-1 (COPY-M-9): same in-flight convention
                  as the approve button above. */}
              {rejectMutation.isPending ? 'Отклонение…' : 'Отклонить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </div>
  )
}

/** Readonly preview of current requisites on overview, with «Изменить» nav button. */
function DropRequisitesSnippet({
  user,
  onGoToRequisites,
}: {
  user: UserProfileDto
  onGoToRequisites: () => void
}) {
  const isUsdt = user.paymentMethod === 'USDT_ERC20'
  const isBank = user.paymentMethod === 'BANK_UAH_FOP'

  const methodLabel = isUsdt ? 'USDT ERC-20' : isBank ? 'Банк UAH (ФОП)' : null
  if (!methodLabel) return null

  const walletValue = isUsdt ? user.walletUsdtErc20 : user.bankUahIban

  return (
    <Card data-testid="drop-requisites-snippet">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4 px-5">
        <div className="flex items-center gap-2">
          {isUsdt ? (
            <Bitcoin className="h-4 w-4 text-primary" aria-hidden="true" />
          ) : (
            <Landmark className="h-4 w-4 text-primary" aria-hidden="true" />
          )}
          <span className="text-sm font-semibold">Реквизиты для выплат</span>
          <Badge variant="outline" className="text-xs">
            {methodLabel}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onGoToRequisites}
          data-testid="drop-requisites-snippet-edit-btn"
          className="h-8 gap-1.5"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Изменить
        </Button>
      </CardHeader>
      <CardContent className="px-5 pb-4 space-y-2">
        {isUsdt && (
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
              <Wallet className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">USDT кошелёк</p>
              <p className="truncate text-sm font-mono">
                {walletValue ?? <span className="italic text-muted-foreground">не указано</span>}
              </p>
            </div>
          </div>
        )}
        {isBank && (
          <>
            <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                <UserIcon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Получатель</p>
                <p className="truncate text-sm">
                  {user.bankUahRecipient ?? (
                    <span className="italic text-muted-foreground">не указано</span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                <Hash className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">IBAN</p>
                <p className="truncate text-sm font-mono">
                  {user.bankUahIban ?? (
                    <span className="italic text-muted-foreground">не указано</span>
                  )}
                </p>
              </div>
            </div>
            {user.bankUahRnokpp && (
              <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                  <IdCard className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">РНОКПП</p>
                  <p className="truncate text-sm font-mono">{user.bankUahRnokpp}</p>
                </div>
              </div>
            )}
            {user.bankUahBankName && (
              <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3.5 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                  <Building2 className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Банк</p>
                  <p className="truncate text-sm">{user.bankUahBankName}</p>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

const CURRENCY_LABEL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  UAH: '₴',
  USDT: 'USDT',
}

function formatSalary(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  const cur = currency ?? 'USD'
  const sign = CURRENCY_LABEL[cur] ?? ''
  if (cur === 'USDT') return `${amount} USDT`
  return `${sign}${amount}`
}

interface OverviewData {
  techStack?: string[] | null
  adminNote?: string | null
  tosAcceptedAt?: string | null
  tosVersion?: number | null
}

export function OverviewTab({ user, mode, data, permissions, onGoToTab }: OverviewTabProps) {
  const overview = (data.overview ?? {}) as OverviewData
  const techStack = user.techStack ?? []
  const showSalary = permissions.fields.salary === true
  const showShare = permissions.fields.share === true
  const showPaymentMethod = permissions.fields.paymentMethodKpi === true
  const kpiCards = [showSalary, showShare, showPaymentMethod].filter(Boolean).length

  // ADMIN viewer ↔ admin note card. The `set-note` action key implies the
  // viewer is ADMIN looking at a non-self user (see UsersAccessService).
  // For self-view (admin looking at own profile) the action isn't present
  // anyway, so the card hides as intended.
  const canSeeAdminNote = permissions.actions.includes('set-note')
  const [noteOpen, setNoteOpen] = useState(false)
  const adminNote = overview.adminNote ?? null

  // ToS acceptance marker — present when backend includes tosAcceptedAt in
  // data.overview (ADMIN viewer or self). Undefined means no permission to see.
  const tosAcceptedAt = overview.tosAcceptedAt
  const tosVersion = overview.tosVersion
  const canSeeTos = tosAcceptedAt !== undefined

  // DROP self-view: show requisites banner/snippet on overview.
  // Banner: only when paymentMethod is null (not set yet).
  // Snippet: only when paymentMethod is set (read-only preview with «Изменить»).
  const isDropSelfView = mode === 'self' && user.role === 'DROP'
  const goToRequisites = () => onGoToTab?.('requisites')

  return (
    <div className="space-y-6">
      {/* task-drop-phase3-frontend: requisites section for DROP self-view (Q3 owner decision).
          Banner is rendered before all other content so it reads first in DOM order (A11y §5.2). */}
      {isDropSelfView && user.paymentMethod === null && (
        <RequisitesMissingBanner onGoToRequisites={goToRequisites} />
      )}
      {isDropSelfView && user.paymentMethod !== null && (
        <DropRequisitesSnippet user={user} onGoToRequisites={goToRequisites} />
      )}

      {/* task-pending-share (position 5): the affected SENIOR, on their OWN
          profile, sees the actionable banner. Everyone else who can see the
          share (ADMIN, or the senior viewed by ACCOUNTANT/HR-with-access)
          only gets the informational badge inside the "Доля" card below. */}
      {mode === 'self' && user.role === 'SENIOR' && user.pendingSeniorShare && (
        <PendingBaseShareBanner
          userId={user.id}
          currentPercent={user.seniorSharePercent ?? 0}
          pending={user.pendingSeniorShare}
        />
      )}

      {kpiCards > 0 && (
        <div
          className={`grid grid-cols-1 gap-4 ${
            kpiCards === 1 ? 'md:grid-cols-1' : kpiCards === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3'
          }`}
        >
          {showSalary && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs uppercase text-muted-foreground">Зарплата</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatSalary(user.monthlySalary, user.salaryCurrency)}
                </div>
              </CardContent>
            </Card>
          )}
          {showShare && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs uppercase text-muted-foreground">Доля</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                <div className="text-2xl font-bold">
                  {(user.role === 'DROP' ? user.dropSharePercent : user.seniorSharePercent) ?? 0}%
                </div>
                {/* task-pending-share: informational for every viewer who can
                    see this card (admin / accountant / the senior's own
                    view) — the actionable version is the banner above,
                    self-view only. */}
                {user.pendingSeniorShare && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className="text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400"
                        data-testid="user-senior-share-pending-badge"
                      >
                        {/* task-648-fix-round-1 (COPY-M-7): this badge, unlike
                            the actionable banner above (mode==='self' only),
                            has no mode gate — a self-viewing SENIOR saw their
                            OWN name in the third person here right below a
                            banner addressing them as "вы". First person for
                            the affected senior's own view; third person only
                            when someone ELSE is looking — and even then,
                            without the name (COPY-M-10: a 55-character pill
                            wraps awkwardly next to shorter neighbors; the
                            name is still one hover away, in the tooltip
                            below). */}
                        {mode === 'self' ? (
                          <>
                            новый{' '}
                            <span className="tabular-nums">{user.pendingSeniorShare.percent}</span>%
                            ждёт вашего подтверждения
                          </>
                        ) : (
                          <>
                            Ждёт подтверждения:{' '}
                            <span className="tabular-nums">{user.pendingSeniorShare.percent}</span>%
                          </>
                        )}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      {mode === 'self'
                        ? 'Действует прежний процент, пока вы не подтвердите новый.'
                        : `Действует прежний процент, пока ${user.pendingSeniorShare.approverName} не подтвердит новый.`}
                    </TooltipContent>
                  </Tooltip>
                )}
              </CardContent>
            </Card>
          )}
          {showPaymentMethod && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs uppercase text-muted-foreground">
                  Способ выплат
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {user.paymentMethod === 'USDT_ERC20'
                    ? 'USDT ERC-20'
                    : user.paymentMethod === 'BANK_UAH_FOP'
                      ? 'UAH ФОП'
                      : '—'}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* task-junior-ut-round2 §6: a JUNIOR's project credentials, visible to
          ADMIN / HR (in the junior's profile) only. The backend flag gates it;
          the section also hides itself on a 403 from the user-scoped endpoint. */}
      {user.role === 'JUNIOR' && permissions.fields.projectCredentials === true && (
        <ProfileCredentialsSection userId={user.id} />
      )}

      {permissions.fields.techStack !== false && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Технологии</CardTitle>
          </CardHeader>
          <CardContent>
            {techStack.length === 0 ? (
              <p className="text-sm text-muted-foreground">Не указано</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {techStack.map((t) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canSeeAdminNote && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                <StickyNote className="h-4 w-4" />
                Заметка администратора
              </span>
              {adminNote ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setNoteOpen(true)}
                  className="h-8 gap-1.5"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Изменить
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setNoteOpen(true)}
                  className="h-8 gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Добавить
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {adminNote ? (
              <p className="whitespace-pre-wrap text-sm text-foreground">{adminNote}</p>
            ) : (
              <p className="text-sm italic text-muted-foreground">Заметок нет</p>
            )}
          </CardContent>
        </Card>
      )}

      {mode === 'self' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Личные данные</CardTitle>
          </CardHeader>
          <CardContent>
            <ProfileEditFields user={user} />
          </CardContent>
        </Card>
      )}

      {/* Legend moved to project detail page (per-project, subject excluded).
          See apps/web/app/components/projects/ProjectLegendSection.tsx */}

      {canSeeTos && (
        <Card data-testid="tos-acceptance-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-green-500" />
              Пользовательское соглашение
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tosAcceptedAt ? (
              <p className="text-sm text-foreground" data-testid="tos-accepted-text">
                Принято:{' '}
                {new Date(tosAcceptedAt).toLocaleDateString('ru-RU', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}
                {tosVersion != null ? `, v${tosVersion}` : ''}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="tos-not-accepted-text">
                Не принято
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {canSeeAdminNote && noteOpen && (
        <AdminNoteDialog
          userId={user.id}
          currentNote={adminNote}
          onClose={() => setNoteOpen(false)}
        />
      )}
    </div>
  )
}
