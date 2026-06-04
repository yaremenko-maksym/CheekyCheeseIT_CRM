import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Download, Filter, ShieldCheck, FileText, ScrollText } from 'lucide-react'
import { auditAllResponseSchema } from '@crm/shared'
import type { AuditEvent } from '@crm/shared'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/crm/audit-log/')({
  component: AuditLogPage,
})

// ---------------------------------------------------------------------------
// Filter state type
// ---------------------------------------------------------------------------

type Filters = {
  userId?: string
  from?: string
  to?: string
  type?: 'contract' | 'tos' | ''
}

const PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function eventDate(e: AuditEvent): string {
  return e.type === 'contract' ? e.signedAt : e.acceptedAt
}

function eventLabel(e: AuditEvent): string {
  if (e.type === 'contract') {
    return `Контракт ${e.contractNumber}`
  }
  return `Terms of Service · v${e.tosVersion}`
}

// ---------------------------------------------------------------------------
// CSV download (client-side generation)
// ---------------------------------------------------------------------------

function downloadCsv(items: AuditEvent[]) {
  const HEADER = 'Тип,Дата,Детали\n'
  const rows = items.map((e) => {
    const date = formatDate(eventDate(e))
    const label = eventLabel(e)
    // Escape commas and quotes in content
    const escapedLabel = `"${label.replace(/"/g, '""')}"`
    return `${e.type === 'contract' ? 'Контракт' : 'ToS'},${date},${escapedLabel}`
  })
  const csv = HEADER + rows.join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Event row
// ---------------------------------------------------------------------------

function EventRow({ event }: { event: AuditEvent }) {
  const date = eventDate(event)
  const isContract = event.type === 'contract'

  return (
    <div
      className="flex items-start gap-3 py-3 border-b border-border/40 last:border-0"
      data-testid="audit-event-row"
    >
      <div className="mt-0.5 rounded-md bg-muted p-1.5 shrink-0">
        {isContract ? (
          <FileText className="h-3.5 w-3.5 text-primary" />
        ) : (
          <ScrollText className="h-3.5 w-3.5 text-amber-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{eventLabel(event)}</span>
          <Badge
            variant={isContract ? 'default' : 'secondary'}
            className="text-xs shrink-0"
          >
            {isContract ? 'Контракт' : 'ToS'}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{formatDate(date)}</p>
        {isContract && event.signedIp && (
          <p className="text-xs text-muted-foreground">IP: {event.signedIp}</p>
        )}
        {!isContract && event.acceptedIp && (
          <p className="text-xs text-muted-foreground">IP: {event.acceptedIp}</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function AuditLogPage() {
  const [filters, setFilters] = useState<Filters>({})
  const [offset, setOffset] = useState(0)

  const queryParams = {
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    limit: PAGE_SIZE,
    offset,
  }

  const { data, isLoading } = useQuery({
    queryKey: ['audit', 'all', queryParams],
    queryFn: async () => {
      const res = await api.get<unknown>('/audit/all', { params: queryParams })
      return auditAllResponseSchema.parse(res.data)
    },
    staleTime: 30_000,
  })

  const total = data?.total ?? 0
  const items = data?.items ?? []
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  function applyFilter(key: keyof Filters, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }))
    setOffset(0)
  }

  function resetFilters() {
    setFilters({})
    setOffset(0)
  }

  return (
    <div className="space-y-6" data-testid="audit-log-page">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Аудит-журнал</h1>
            <p className="text-sm text-muted-foreground">
              Подписанные контракты и принятые ToS — все пользователи
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={items.length === 0}
          onClick={() => downloadCsv(items)}
          data-testid="audit-csv-download"
        >
          <Download className="h-3.5 w-3.5" />
          Скачать CSV
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium">
            <Filter className="h-3.5 w-3.5" />
            Фильтры
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* User ID filter */}
            <div className="space-y-1.5">
              <Label htmlFor="filter-user" className="text-xs">
                ID пользователя
              </Label>
              <Input
                id="filter-user"
                placeholder="UUID пользователя"
                value={filters.userId ?? ''}
                onChange={(e) => applyFilter('userId', e.target.value)}
                className="h-8 text-sm"
                data-testid="audit-filter-user"
              />
            </div>

            {/* From date */}
            <div className="space-y-1.5">
              <Label htmlFor="filter-from" className="text-xs">
                От
              </Label>
              <Input
                id="filter-from"
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => applyFilter('from', e.target.value)}
                className="h-8 text-sm"
                data-testid="audit-filter-from"
              />
            </div>

            {/* To date */}
            <div className="space-y-1.5">
              <Label htmlFor="filter-to" className="text-xs">
                До
              </Label>
              <Input
                id="filter-to"
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => applyFilter('to', e.target.value)}
                className="h-8 text-sm"
                data-testid="audit-filter-to"
              />
            </div>

            {/* Type filter */}
            <div className="space-y-1.5">
              <Label htmlFor="filter-type" className="text-xs">
                Тип события
              </Label>
              <select
                id="filter-type"
                value={filters.type ?? ''}
                onChange={(e) => applyFilter('type', e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm"
                data-testid="audit-filter-type"
              >
                <option value="">Все</option>
                <option value="contract">Контракты</option>
                <option value="tos">Terms of Service</option>
              </select>
            </div>
          </div>

          {/* Reset */}
          {Object.values(filters).some(Boolean) && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 text-xs h-7"
              onClick={resetFilters}
              data-testid="audit-filter-reset"
            >
              Сбросить фильтры
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {isLoading ? (
              'Загрузка...'
            ) : (
              <span>
                Всего записей:{' '}
                <span className="font-semibold text-foreground">{total}</span>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Нет событий по заданным фильтрам
            </div>
          ) : (
            <div>
              {items.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {!isLoading && total > PAGE_SIZE && (
        <div className="flex items-center justify-between" data-testid="audit-pagination">
          <span className="text-xs text-muted-foreground">
            Страница {currentPage} из {pages} · Всего: {total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
              data-testid="audit-page-prev"
            >
              Назад
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
              data-testid="audit-page-next"
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
