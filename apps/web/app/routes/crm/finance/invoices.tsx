/**
 * /crm/finance/invoices — Invoice Signing Epic UI page.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Header: «Инвойсы» + sub-title + counter                       │
 *   │ Tabs: Ожидает подписи (badge unread) / Подписано всеми / Все  │
 *   │ Filter row: type (Все / Выплата сеньору / Зарплата)           │
 *   ├──────────────────────────────────────────────────────────────│
 *   │ Grid of <InvoiceCard /> — responsive (sm:2 / lg:3 columns)    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * `?openInvoiceId=<uuid>` — deep link that pops InvoiceDetailDialog open
 * once the list query resolves. Used by the bell dropdown notifications
 * (`/crm/finance/invoices?openInvoiceId=…`).
 *
 * RBAC:
 *   - All five roles see the page (the backend filters the list).
 *   - ADMIN / ACCOUNTANT see everything; everyone else only their own (the
 *     `assertCanViewInvoice` server check enforces it for detail too).
 */
import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion, AnimatePresence } from 'framer-motion'
import { FileSignature, Inbox, Loader2 } from 'lucide-react'
import { z } from 'zod'
import type { InvoiceListItem, InvoiceStatus, InvoiceType, SessionUser } from '@crm/shared'
import { useAuth } from '@/context/auth'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useInvoices } from '@/hooks/use-invoices'
import { InvoiceCard } from '@/components/invoices/invoice-card'
import { InvoiceDetailDialog } from '@/components/invoices/invoice-detail-dialog'

const searchSchema = z.object({
  openInvoiceId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/crm/finance/invoices')({
  validateSearch: searchSchema,
  component: InvoicesPage,
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type StatusTab = 'PENDING' | 'SIGNED' | 'ALL'
type TypeFilter = InvoiceType | 'ALL'

const TYPE_LABEL: Record<InvoiceType, string> = {
  SENIOR_INCOME: 'Выплата сеньору',
  SALARY: 'Зарплата',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function InvoicesPage() {
  const { user } = useAuth()
  if (!user) return null
  return <InvoicesPageContent viewer={user} />
}

function InvoicesPageContent({ viewer }: { viewer: SessionUser }) {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/crm/finance/invoices' })
  const [statusTab, setStatusTab] = useState<StatusTab>('ALL')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL')

  // ---- Detail dialog wiring ----
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | undefined>(undefined)

  function openDetail(id: string) {
    setDetailId(id)
    setDetailOpen(true)
    void navigate({
      search: (prev) => ({ ...prev, openInvoiceId: id }),
      replace: true,
    })
  }

  function closeDetail(open: boolean) {
    setDetailOpen(open)
    if (!open) {
      void navigate({
        search: (prev) => {
          const next = { ...prev }
          delete (next as Record<string, unknown>)['openInvoiceId']
          return next
        },
        replace: true,
      })
    }
  }

  // ---- Data ----
  // We always fetch ALL invoices (no status/type filter on the network) so the
  // tab + dropdown switches stay snappy. Pending-count badge is computed
  // client-side from the same list.
  const { data: allInvoices, isLoading } = useInvoices({})

  const visible = useMemo<InvoiceListItem[]>(() => {
    if (!allInvoices) return []
    return allInvoices.filter((i) => {
      if (statusTab !== 'ALL' && i.status !== (statusTab as InvoiceStatus)) return false
      if (typeFilter !== 'ALL' && i.type !== typeFilter) return false
      return true
    })
  }, [allInvoices, statusTab, typeFilter])

  // Pending count — drives the "Ожидает подписи (N)" tab badge.
  const pendingCount = useMemo<number>(() => {
    if (!allInvoices) return 0
    return allInvoices.filter((i) => i.status === 'PENDING').length
  }, [allInvoices])

  // Deep-link: open the dialog for `?openInvoiceId=<uuid>` after first render.
  useEffect(() => {
    if (!search.openInvoiceId) return
    setDetailId(search.openInvoiceId)
    setDetailOpen(true)
  }, [search.openInvoiceId])

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
      >
        <h1 className="text-2xl font-bold tracking-tight">Инвойсы</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Акты выполненных работ и подтверждения выплат
        </p>
      </motion.div>

      {/* Tabs */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: 0.05 }}
        className="flex flex-wrap items-center gap-3"
      >
        <Tabs
          value={statusTab}
          onValueChange={(v) => setStatusTab(v as StatusTab)}
        >
          <TabsList data-testid="invoices-status-tabs">
            <TabsTrigger value="ALL" data-testid="invoices-tab-all">
              Все
              {allInvoices && allInvoices.length > 0 ? (
                <Badge
                  variant="secondary"
                  className="ml-2 h-5 min-w-[1.25rem] px-1.5 text-[10px]"
                >
                  {allInvoices.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="PENDING" data-testid="invoices-tab-pending">
              Ожидает подписи
              {pendingCount > 0 ? (
                <Badge
                  variant="outline"
                  className="ml-2 h-5 min-w-[1.25rem] border-amber-500/40 bg-amber-500/15 px-1.5 text-[10px] text-amber-300"
                  data-testid="invoices-pending-badge"
                >
                  {pendingCount}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="SIGNED" data-testid="invoices-tab-signed">
              Подписано всеми
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="ml-auto">
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
            <SelectTrigger
              className="h-9 w-44 text-sm"
              data-testid="invoices-type-filter"
            >
              <SelectValue placeholder="Все типы" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Все типы</SelectItem>
              <SelectItem value="SENIOR_INCOME">{TYPE_LABEL.SENIOR_INCOME}</SelectItem>
              <SelectItem value="SALARY">{TYPE_LABEL.SALARY}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </motion.div>

      {/* Counter */}
      <div
        className="text-xs text-muted-foreground"
        data-testid="invoices-counter"
      >
        {isLoading
          ? 'Загрузка…'
          : `${visible.length} ${pluralizeInvoices(visible.length)}`}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState statusTab={statusTab} />
      ) : (
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="invoices-grid"
        >
          <AnimatePresence mode="popLayout">
            {visible.map((inv) => (
              <InvoiceCard
                key={inv.transactionId}
                invoice={inv}
                onOpen={openDetail}
                awaitingViewerSignature={
                  inv.status === 'PENDING' &&
                  // The list endpoint does not return counterparty id, but
                  // SENIOR_INCOME + SALARY counterparty is always
                  // `transactions.receiverId`. For non-admin/non-accountant
                  // viewers the backend already filters to their rows, so any
                  // PENDING row visible to them is one they need to sign.
                  viewer.role !== 'ADMIN' &&
                  viewer.role !== 'ACCOUNTANT'
                }
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Detail dialog */}
      <InvoiceDetailDialog
        open={detailOpen}
        onOpenChange={closeDetail}
        transactionId={detailId}
        viewer={viewer}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ statusTab }: { statusTab: StatusTab }) {
  const message =
    statusTab === 'PENDING'
      ? 'Нет инвойсов, ожидающих подписи'
      : statusTab === 'SIGNED'
        ? 'Нет подписанных инвойсов'
        : 'Инвойсов пока нет'
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
      {statusTab === 'PENDING' ? (
        <Loader2 className="h-10 w-10 text-muted-foreground/30" />
      ) : statusTab === 'SIGNED' ? (
        <FileSignature className="h-10 w-10 text-muted-foreground/30" />
      ) : (
        <Inbox className="h-10 w-10 text-muted-foreground/30" />
      )}
      <p className="mt-4 text-sm font-medium">{message}</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">
        Инвойсы создаются автоматически: после оплаты выплаты по проекту или
        при выплате зарплаты.
      </p>
    </div>
  )
}

// ru-RU plural helper for the counter ("1 инвойс", "2 инвойса", "5 инвойсов").
function pluralizeInvoices(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'инвойс'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'инвойса'
  return 'инвойсов'
}
