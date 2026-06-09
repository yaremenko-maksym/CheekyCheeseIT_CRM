import { useState } from 'react'
import { Pencil, Plus, ShieldCheck, StickyNote } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { UserProfileDto, ViewPermissions } from '@crm/shared'
import { ProfileEditFields } from '../self-edit/ProfileEditFields'
import { AdminNoteDialog } from '../admin-actions/AdminNoteDialog'
import { LegendSection } from '../LegendSection'

export interface OverviewTabProps {
  user: UserProfileDto
  data: Record<string, unknown>
  permissions: ViewPermissions
  mode: 'self' | 'view'
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

export function OverviewTab({ user, mode, data, permissions }: OverviewTabProps) {
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

  return (
    <div className="space-y-6">
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
              <CardContent>
                <div className="text-2xl font-bold">{user.seniorSharePercent ?? 0}%</div>
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

      {/* Легенда SENIOR/DROP — персона для клиентской компании.
          RBAC (2026-06-09 reversal — subject excluded, view==edit):
          - mode === 'self': субъект свою легенду НЕ видит (subject excluded).
          - mode === 'view': показывать если target — SENIOR/DROP
            AND permissions.fields.legend === true (зритель допущен).
            canEdit = true для всех допущенных (view==edit: ADMIN, HR, JUNIOR).
          - ACCOUNTANT / другой SENIOR / несвязанные → fields.legend отсутствует → скрыто. */}
      {mode === 'view' &&
        (user.role === 'SENIOR' || user.role === 'DROP') &&
        permissions.fields.legend === true && (
          <LegendSection userId={user.id} canEdit={true} enabled={true} />
        )}

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
