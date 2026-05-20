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
      <CardContent className="space-y-3 pt-6">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{ACTION_LABELS[entry.action]}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString('ru-RU')}
              </span>
            </div>
            <pre className="mt-2 overflow-auto text-xs text-muted-foreground">
              {JSON.stringify(entry.changes, null, 2)}
            </pre>
          </div>
        ))}

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
