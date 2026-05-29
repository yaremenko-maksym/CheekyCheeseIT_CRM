/**
 * Public invoice verification page — `/invoice/v/:transactionId`.
 *
 * Reachable without authentication (the QR code printed on the PDF resolves
 * here straight from a phone camera). The page calls the public verify
 * endpoint `/api/invoices/verify/:transactionId` and renders signatures +
 * minimal transaction metadata — NO private fields (no IP, no user-agent,
 * no full PDF hash).
 *
 * Implementation notes:
 *   - File path uses TanStack Router's flat-route dot notation:
 *       routes/invoice.v.$transactionId.tsx  →  /invoice/v/:transactionId
 *     This puts it outside the `/crm` layout (no AuthProvider), so there is
 *     no redirect-to-login wrapper.
 *   - Uses raw `fetch` instead of the shared `axios` instance — `api` carries
 *     credentials and a 401 interceptor that would push the user to /login.
 *     A public page must succeed for anonymous visitors.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  AlertCircle,
  CheckCircle2,
  FileSignature,
  ShieldCheck,
} from 'lucide-react'
import type { InvoiceVerifyResponse } from '@crm/shared'
import { BrandMark } from '@/components/brand-mark'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatAmount } from '@/lib/format-amount'

export const Route = createFileRoute('/invoice/v/$transactionId')({
  component: PublicVerifyPage,
})

// ---------------------------------------------------------------------------
// API base URL — same convention as `apps/web/app/lib/axios.ts`
// ---------------------------------------------------------------------------

const API_URL =
  (typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env['VITE_API_URL'] as string | undefined)
    : undefined) ?? 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Public verify page keeps the slightly more formal phrasing for printed
// QR-target context — these labels are surfaced on a stranger-facing page
// (QR scan from a printed PDF), not inside the authenticated CRM.
const TYPE_LABEL: Record<InvoiceVerifyResponse['type'], string> = {
  SENIOR_INCOME: 'Акт выполненных работ (выплата синьера)',
  SALARY: 'Выплата зарплаты',
}

const STATUS_LABEL: Record<InvoiceVerifyResponse['status'], string> = {
  PENDING: 'Ожидает подписи',
  SIGNED: 'Подписан полностью',
}

const STATUS_CLASS: Record<InvoiceVerifyResponse['status'], string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SIGNED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

const ROLE_LABEL: Record<InvoiceVerifyResponse['signatures'][number]['role'], string> = {
  COMPANY: 'Компания',
  COUNTERPARTY: 'Контрагент',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDateTime(iso: string): string {
  try {
    return format(new Date(iso), "d MMM yyyy, HH:mm:ss", { locale: ru })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function PublicVerifyPage() {
  const { transactionId } = Route.useParams()
  const { data, isLoading, error } = useQuery<InvoiceVerifyResponse, Error>({
    queryKey: ['invoice-verify', transactionId],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/invoices/verify/${transactionId}`, {
        method: 'GET',
        // Explicit `omit` — no credentials leak from a public endpoint.
        credentials: 'omit',
      })
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('Документ не найден')
        }
        throw new Error(`Ошибка ${res.status}`)
      }
      return res.json() as Promise<InvoiceVerifyResponse>
    },
    retry: 0,
    staleTime: 60_000,
  })

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4 sm:px-6">
          <BrandMark className="h-9 w-9 text-primary" />
          <div>
            <h1 className="text-base font-semibold tracking-tight">
              CheekyCheese IT
            </h1>
            <p className="text-xs text-muted-foreground">
              Публичная верификация инвойса
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error.message} />
        ) : data ? (
          <VerifiedState data={data} />
        ) : null}
      </main>

      <footer className="mx-auto max-w-3xl px-4 pb-8 pt-4 text-center text-xs text-muted-foreground sm:px-6">
        <p>
          Проверено системой CheekyCheese IT CRM ·{' '}
          {format(new Date(), 'd MMM yyyy, HH:mm', { locale: ru })}
        </p>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="space-y-4" data-testid="invoice-verify-loading">
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-44 w-full rounded-xl" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error state — 404 / network
// ---------------------------------------------------------------------------

function ErrorState({ message }: { message: string }) {
  return (
    <motion.div
      data-testid="invoice-verify-error"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <AlertCircle className="h-12 w-12 text-destructive" />
      <h2
        className="mt-4 text-lg font-semibold"
        data-testid="invoice-verify-error-message"
      >
        {message}
      </h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Проверьте корректность ссылки или QR-кода. Если документ существует —
        возможно, он ещё не сгенерирован.
      </p>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Verified state — main content
// ---------------------------------------------------------------------------

function VerifiedState({ data }: { data: InvoiceVerifyResponse }) {
  const isSigned = data.status === 'SIGNED'
  return (
    <motion.div
      data-testid="invoice-verify-success"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Hero — big green check */}
      <div
        className={cn(
          'flex flex-col items-center rounded-2xl border p-8 text-center sm:flex-row sm:gap-6 sm:text-left',
          isSigned
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-amber-500/40 bg-amber-500/10',
        )}
      >
        <div
          className={cn(
            'flex h-16 w-16 shrink-0 items-center justify-center rounded-full',
            isSigned
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'bg-amber-500/20 text-amber-300',
          )}
        >
          {isSigned ? (
            <ShieldCheck className="h-9 w-9" />
          ) : (
            <FileSignature className="h-9 w-9" />
          )}
        </div>
        <div className="mt-4 sm:mt-0">
          <h2
            className="text-2xl font-bold tracking-tight"
            data-testid="invoice-verify-status-heading"
          >
            {isSigned ? 'Документ верифицирован' : 'Документ ожидает подписи'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSigned
              ? 'Подписи всех сторон присутствуют. Содержимое PDF неизменно с момента подписи.'
              : 'Сторона компании подписала документ автоматически. Контрагент ещё не подтвердил подпись.'}
          </p>
        </div>
      </div>

      {/* Transaction details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Детали инвойса</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <DetailRow label="Тип" value={TYPE_LABEL[data.type]} />
          <DetailRow
            label="Сумма"
            value={
              <span className="text-base font-semibold">
                {formatAmount(data.amount, data.currency)}
              </span>
            }
          />
          <DetailRow
            label="Статус"
            value={
              <Badge
                variant="outline"
                className={cn('border', STATUS_CLASS[data.status])}
                data-testid="invoice-verify-status-badge"
              >
                {data.status === 'PENDING' ? (
                  <FileSignature className="mr-1 h-3 w-3" />
                ) : (
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                )}
                {STATUS_LABEL[data.status]}
              </Badge>
            }
          />
          <DetailRow
            label="ID транзакции"
            value={
              <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {data.transactionId}
              </code>
            }
          />
        </CardContent>
      </Card>

      {/* Signatures */}
      <Card>
        <CardHeader>
          <CardTitle
            className="text-base"
            data-testid="invoice-verify-signatures-count"
          >
            Подписи ({data.signatures.length} из 2)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.signatures.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              Подписи отсутствуют
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                data-testid="invoice-verify-signatures-table"
              >
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    <th className="px-6 py-2 font-medium">Сторона</th>
                    <th className="px-6 py-2 font-medium">Подписант</th>
                    <th className="px-6 py-2 font-medium">Дата подписи</th>
                    <th className="px-6 py-2 font-medium">Хэш PDF (8)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.signatures.map((s, i) => (
                    <tr
                      key={`${s.role}-${i}`}
                      className="border-b border-border/30 last:border-0"
                    >
                      <td className="px-6 py-3 font-medium">
                        {ROLE_LABEL[s.role]}
                      </td>
                      <td className="px-6 py-3">{s.signerName}</td>
                      <td className="px-6 py-3 text-xs text-muted-foreground">
                        {fmtDateTime(s.signedAt)}
                      </td>
                      <td className="px-6 py-3">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {s.pdfHashShort}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

function DetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  )
}
