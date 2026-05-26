import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useEntityAuditLog, type EntityType } from '@/hooks/use-archive'
import type {
  AuditAction,
  AuditLogEntry,
  ProjectAuditAction,
  ProjectAuditLogEntry,
  TeamAuditAction,
  TeamAuditLogEntry,
} from '@crm/shared'

// Russian labels — covers ALL three audit-action enums (users/teams/projects).
const ACTION_LABELS: Record<string, string> = {
  // users
  profile_created: 'Профиль создан',
  profile_edit: 'Профиль изменён',
  requisites_edit: 'Реквизиты изменены',
  role_change: 'Роль изменена',
  salary_change: 'Зарплата изменена',
  note_set: 'Заметка обновлена',
  team_membership: 'Изменение команды',
  project_reassignment: 'Переназначение проекта',
  user_archived: 'Профиль архивирован',
  user_unarchived: 'Профиль восстановлен',
  // teams
  team_created: 'Команда создана',
  team_renamed: 'Команда переименована',
  team_archived: 'Команда архивирована',
  team_unarchived: 'Команда восстановлена',
  team_member_added: 'Участник добавлен',
  team_member_removed: 'Участник удалён',
  // projects
  project_created: 'Проект создан',
  project_edited: 'Проект изменён',
  project_status_changed: 'Статус изменён',
  project_archived: 'Проект архивирован',
  project_unarchived: 'Проект восстановлен',
  project_member_added: 'Участник добавлен',
  project_member_removed: 'Участник удалён',
}

const FIELD_LABELS: Record<string, string> = {
  // user fields
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
  // team fields
  name: 'Название',
  notes: 'Заметки',
  // team-member fields
  userId: 'Пользователь',
  // project fields
  companyName: 'Компания',
  domain: 'Домен',
  rate: 'Ставка',
  currency: 'Валюта',
  startDate: 'Старт',
  logoDocumentId: 'Логотип (файл)',
  logoExternalUrl: 'Логотип (ссылка)',
  teamSize: 'Состав команды',
  benefits: 'Бенефиты',
  paymentType: 'Тип оплаты',
  salaryReview: 'Пересмотр ЗП',
  corpTech: 'Корп. технологии',
  notesGeneral: 'Общие заметки',
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (Array.isArray(v)) return v.length === 0 ? '[ ]' : `[${v.join(', ')}]`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

type AnyAuditEntry = AuditLogEntry | TeamAuditLogEntry | ProjectAuditLogEntry
type AnyAuditAction = AuditAction | TeamAuditAction | ProjectAuditAction

export function AuditLogTab({
  entityType,
  entityId,
}: {
  entityType: EntityType
  entityId: string
}) {
  const [page, setPage] = useState(1)
  const limit = 20
  const { data, isLoading } = useEntityAuditLog(entityType, entityId, page, limit, true)

  if (isLoading) return <Skeleton className="h-64 w-full" />

  const entries = (data?.entries ?? []) as AnyAuditEntry[]
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
          const action = entry.action as AnyAuditAction
          return (
            <div key={entry.id} className="overflow-hidden rounded border">
              <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
                <span className="text-sm font-medium">
                  {ACTION_LABELS[action] ?? action}
                </span>
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
