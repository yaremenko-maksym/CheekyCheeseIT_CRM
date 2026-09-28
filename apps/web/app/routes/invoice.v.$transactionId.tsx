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
 *     This puts it outside the `/` layout (no AuthProvider), so there is
 *     no redirect-to-login wrapper. It IS still under the root `<I18nProvider>`
 *     (`routes/__root.tsx` wraps the whole tree, not just `/_authenticated`),
 *     so `useLingui()`/`<Trans>` work here exactly as anywhere else in the app.
 *   - Uses raw `fetch` instead of the shared `axios` instance — `api` carries
 *     credentials and a 401 interceptor that would push the user to /login.
 *     A public page must succeed for anonymous visitors.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, FileSignature, ShieldCheck } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { InvoiceVerifyResponse } from '@crm/shared'
import { formatDate } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
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

// Dot access — hotfix (task-telemetry-env-gate): bracket access to
// `import.meta.env.VITE_*` is NOT statically foldable by Vite, so this was
// silently falling back to the localhost dev URL in every prod build.
const API_URL =
  (typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_API_URL as string | undefined)
    : undefined) ?? 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * task-i18n-stage3d-pr4 (template G-fin, COPY-L-fin-16 + COPY-H-fin-1).
 * Public verify page keeps the slightly more formal phrasing for printed
 * QR-target context — these labels are surfaced on a stranger-facing page
 * (QR scan from a printed PDF), not inside the authenticated CRM. «Рахунок»,
 * not «інвойс» (canon); «дохід сеньйора», not «виплата синьйора»
 * (`PAYOUT`-family term is reserved — the senior receiving project income
 * is the opposite direction from the senior paying the company).
 * `satisfies` without `as const` (урок #707).
 */
const TYPE_LABEL_MESSAGES = {
  SENIOR_INCOME: msg`Акт виконаних робіт (дохід сеньйора)`, // en: Work completion act (senior income)
  SALARY: msg`Виплата зарплати`, // en: Salary payout
} satisfies Record<InvoiceVerifyResponse['type'], MessageDescriptor>

const STATUS_LABEL_MESSAGES = {
  PENDING: msg`Очікує підпису`, // en: Awaiting signature
  SIGNED: msg`Підписано повністю`, // en: Fully signed
} satisfies Record<InvoiceVerifyResponse['status'], MessageDescriptor>

const STATUS_CLASS: Record<InvoiceVerifyResponse['status'], string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SIGNED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

/**
 * task-i18n-stage3d-pr4 (template G-fin). Own enum (COMPANY/COUNTERPARTY) —
 * the same two roles as `invoice-detail-dialog.tsx`'s local
 * `SIG_ROLE_LABEL_MESSAGES`, kept separate per this file's pre-existing
 * convention (a public unauthenticated page owns its own copy, not shared
 * with the authenticated dialog).
 */
const ROLE_LABEL_MESSAGES = {
  COMPANY: msg`Компанія`, // en: Company
  COUNTERPARTY: msg`Контрагент`, // en: Counterparty
} satisfies Record<InvoiceVerifyResponse['signatures'][number]['role'], MessageDescriptor>

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function PublicVerifyPage() {
  const { t } = useLingui()
  const locale = useLocale()
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
          throw new Error(t`Документ не знайдено`)
        }
        throw new Error(t`Помилка ${res.status}`)
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
            <h1 className="text-base font-semibold tracking-tight">CheekyCheese IT</h1>
            <p className="text-xs text-muted-foreground">
              <Trans>Публічна верифікація рахунку</Trans>
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
          <Trans>
            Перевірено системою CheekyCheese IT CRM ·{' '}
            {formatDate(new Date(), locale, 'dateTimeWithYear')}
          </Trans>
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
      <h2 className="mt-4 text-lg font-semibold" data-testid="invoice-verify-error-message">
        {message}
      </h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        <Trans>
          Перевірте правильність посилання або QR-коду. Якщо документ існує — можливо, він ще не
          згенерований.
        </Trans>
      </p>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Verified state — main content
// ---------------------------------------------------------------------------

function VerifiedState({ data }: { data: InvoiceVerifyResponse }) {
  const isSigned = data.status === 'SIGNED'
  const locale = useLocale()
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
            isSigned ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300',
          )}
        >
          {isSigned ? <ShieldCheck className="h-9 w-9" /> : <FileSignature className="h-9 w-9" />}
        </div>
        <div className="mt-4 sm:mt-0">
          <h2
            className="text-2xl font-bold tracking-tight"
            data-testid="invoice-verify-status-heading"
          >
            {isSigned ? (
              <Trans>Документ верифіковано</Trans>
            ) : (
              <Trans>Документ очікує підпису</Trans>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSigned ? (
              <Trans>Підписи всіх сторін присутні. Вміст PDF незмінний з моменту підпису.</Trans>
            ) : (
              <Trans>
                Сторона компанії підписала документ автоматично. Контрагент ще не підтвердив підпис.
              </Trans>
            )}
          </p>
        </div>
      </div>

      {/* Transaction details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Trans>Деталі рахунку</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <DetailRow label={<Trans>Тип</Trans>} value={i18n._(TYPE_LABEL_MESSAGES[data.type])} />
          <DetailRow
            label={<Trans>Сума</Trans>}
            value={
              <span className="text-base font-semibold">
                {formatAmount(data.amount, data.currency)}
              </span>
            }
          />
          <DetailRow
            label={<Trans>Статус</Trans>}
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
                {i18n._(STATUS_LABEL_MESSAGES[data.status])}
              </Badge>
            }
          />
          <DetailRow
            label={<Trans>ID транзакції</Trans>}
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
          <CardTitle className="text-base" data-testid="invoice-verify-signatures-count">
            <Trans>Підписи ({data.signatures.length} з 2)</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.signatures.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              <Trans>Підписів немає</Trans>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="invoice-verify-signatures-table">
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    <th className="px-6 py-2 font-medium">
                      <Trans>Сторона</Trans>
                    </th>
                    <th className="px-6 py-2 font-medium">
                      <Trans>Підписант</Trans>
                    </th>
                    <th className="px-6 py-2 font-medium">
                      <Trans>Дата підпису</Trans>
                    </th>
                    <th className="px-6 py-2 font-medium">
                      <Trans>Хеш PDF (8)</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.signatures.map((s, i) => (
                    <tr key={`${s.role}-${i}`} className="border-b border-border/30 last:border-0">
                      <td className="px-6 py-3 font-medium">
                        {i18n._(ROLE_LABEL_MESSAGES[s.role])}
                      </td>
                      <td className="px-6 py-3">{s.signerName}</td>
                      <td className="px-6 py-3 text-xs text-muted-foreground">
                        {formatDate(s.signedAt, locale, 'dateTimeWithYear')}
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

function DetailRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  )
}
