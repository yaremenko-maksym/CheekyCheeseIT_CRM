import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useUserAuditLog } from '@/hooks/use-user-profile'
import type { AuditAction } from '@crm/shared'

const ACTION_LABELS: Record<AuditAction, string> = {
  profile_created: 'Профиль создан',
  profile_edit: 'Профиль изменён',
  requisites_edit: 'Реквизиты изменены',
  role_change: 'Роль изменена',
  salary_change: 'Зарплата изменена',
  note_set: 'Заметка обновлена',
  team_membership: 'Изменение команды',
  project_reassignment: 'Переназначение проекта',
  user_archived: 'Профиль архивирован',
}

const FIELD_LABELS: Record<string, string> = {
  displayName: 'Имя',
  email: 'Email',
  role: 'Роль',
  telegram: 'Telegram',
  phone: 'Телефон',
  avatar: 'Аватар',
  techStack: 'Технологии',
  monthlySalary: 'Зарплата',
  salaryCurrency: 'Валюта',
  seniorSharePercent: 'Доля, %',
  paymentMethod: 'Способ выплаты',
  walletUsdtErc20: 'USDT кошелёк',
  walletUsdtLabel: 'Метка USDT',
  bankUahRecipient: 'Получатель',
  bankUahIban: 'IBAN',
  bankUahRnokpp: 'РНОКПП',
  bankUahBankName: 'Банк',
  adminNote: 'Заметка админа',
  archivedAt: 'Архив',
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (Array.isArray(v)) return v.length === 0 ? '[ ]' : `[${v.join(', ')}]`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function AuditLogTab({ userId }: { userId: string }) {
  const [page, setPage] = useState(1)
  const limit = 20
  const { data, isLoading } = useUserAuditLog(userId, page, limit, true)

  if (isLoading) return <Skeleton className="h-64 w-full" />

  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / limit))

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          История пуста
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {entries.map((entry) => {
          const changeEntries = Object.entries(entry.changes ?? {})
          return (
            <div key={entry.id} className="overflow-hidden rounded border">
              <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
                <span className="text-sm font-medium">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString('ru-RU', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {changeEntries.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Без деталей</div>
              ) : (
                <div className="divide-y font-mono text-xs">
                  {changeEntries.map(([key, change]) => {
                    const before = formatValue((change as { before: unknown }).before)
                    const after = formatValue((change as { after: unknown }).after)
                    const label = FIELD_LABELS[key] ?? key
                    return (
                      <div key={key} className="px-3 py-2">
                        <div className="mb-1 font-sans text-xs font-medium text-muted-foreground">
                          {label}
                        </div>
                        <div className="grid gap-0.5">
                          <div className="flex items-start gap-2 rounded bg-red-500/10 px-2 py-1 text-red-700 dark:text-red-300">
                            <span className="select-none font-bold">−</span>
                            <span className="break-all">{before}</span>
                          </div>
                          <div className="flex items-start gap-2 rounded bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
                            <span className="select-none font-bold">+</span>
                            <span className="break-all">{after}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Стр. {page} из {pages}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Назад
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
