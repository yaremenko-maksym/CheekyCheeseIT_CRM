/**
 * InvoiceDetailDialog — modal viewer + click-signing surface.
 *
 * Layout (CrmDialog max-w-3xl):
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ HEADER:  тип + сумма + currency + status badge              │
 *   │ ───────────────────────────────────────────────────────────│
 *   │ BODY:                                                       │
 *   │   [PDF iframe]                                              │
 *   │                                                             │
 *   │   Подписи                                                   │
 *   │   Сторона | Подписант | Дата | Метод | Хэш                  │
 *   │   …                                                         │
 *   │                                                             │
 *   │   Public verify URL: /invoice/v/<id>  (copyable)            │
 *   │ ───────────────────────────────────────────────────────────│
 *   │ FOOTER:  «Закрыть»     [Подписать инвойс]                   │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * `Подписать` button is rendered only when:
 *   - viewer.id === invoice.counterpartyId, AND
 *   - no existing COUNTERPARTY signature.
 *
 * Clicking opens a nested AlertDialog with an "Я ознакомлен и согласен"
 * checkbox; submit calls `useSignInvoice` mutation and on success closes
 * both dialogs + invalidates the invoice queries via the mutation hook.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { format, formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileSignature,
  Loader2,
  Lock,
  ShieldCheck,
} from 'lucide-react'
import type { InvoiceDto, InvoiceSignatureDto, SessionUser } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useInvoice, useSignInvoice } from '@/hooks/use-invoices'
import { useDocumentDownloadUrl } from '@/hooks/use-documents'
import { formatAmount } from '@/lib/format-amount'
import { getInvoiceTypeLabel } from '@/lib/invoice-labels'

// ---------------------------------------------------------------------------
// Constants — type label lives in shared invoice-labels helper
// ---------------------------------------------------------------------------

const TYPE_CLASS: Record<InvoiceDto['type'], string> = {
  SENIOR_INCOME: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  SALARY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

const STATUS_LABEL: Record<InvoiceDto['status'], string> = {
  PENDING: 'Ожидает подписи',
  SIGNED: 'Подписано всеми',
}

const STATUS_CLASS: Record<InvoiceDto['status'], string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SIGNED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

const SIG_ROLE_LABEL: Record<InvoiceSignatureDto['signerRole'], string> = {
  COMPANY: 'Компания',
  COUNTERPARTY: 'Контрагент',
}

// Short, user-readable labels — full audit copy (e.g. «Click + audit», PDF
// hash short) is exposed via the `title=` tooltip on the row so technical
// reviewers can still inspect the chain without cluttering the main view.
const SIG_METHOD_LABEL: Record<InvoiceSignatureDto['method'], string> = {
  AUTO_COMPANY: 'Авто',
  MANUAL_CLICK: 'Ручная',
}

const SIG_METHOD_TOOLTIP: Record<InvoiceSignatureDto['method'], string> = {
  AUTO_COMPANY: 'Автоматическая электронная подпись компании при выпуске инвойса',
  MANUAL_CLICK: 'Подписано вручную (click + audit) контрагентом',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDateTime(iso: string): string {
  try {
    return format(new Date(iso), 'd MMM yyyy, HH:mm', { locale: ru })
  } catch {
    return iso
  }
}

function fmtRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface InvoiceDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The transaction id whose invoice we are viewing. When undefined the
   * dialog renders nothing (parent uses this to bridge between selected
   * card and the controlled dialog).
   */
  transactionId: string | undefined
  viewer: SessionUser
}

export function InvoiceDetailDialog({
  open,
  onOpenChange,
  transactionId,
  viewer,
}: InvoiceDetailDialogProps) {
  const {
    data: invoice,
    isLoading,
    error,
  } = useInvoice(transactionId, {
    enabled: open && Boolean(transactionId),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent maxWidth="sm:max-w-6xl" data-testid="invoice-detail-dialog">
        <DialogDescription className="sr-only">Инвойс</DialogDescription>
        {isLoading || !invoice ? (
          <DialogLoadingState error={error} />
        ) : (
          <InvoiceDetailContent
            invoice={invoice}
            viewer={viewer}
            onClose={() => onOpenChange(false)}
          />
        )}
      </CrmDialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

function DialogLoadingState({ error }: { error: Error | null }) {
  if (error) {
    return (
      <>
        <CrmDialogHeader>
          <DialogTitle>Инвойс</DialogTitle>
          <DialogDescription>Не удалось загрузить документ</DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error.message}</span>
          </div>
        </CrmDialogBody>
      </>
    )
  }
  return (
    <>
      <CrmDialogHeader>
        <DialogTitle>
          <Skeleton className="h-6 w-44" />
        </DialogTitle>
      </CrmDialogHeader>
      <CrmDialogBody className="space-y-4 pb-6">
        <Skeleton className="h-96 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </CrmDialogBody>
    </>
  )
}

// ---------------------------------------------------------------------------
// Loaded content
// ---------------------------------------------------------------------------

function InvoiceDetailContent({
  invoice,
  viewer,
  onClose,
}: {
  invoice: InvoiceDto
  viewer: SessionUser
  onClose: () => void
}) {
  const hasCounterpartySig = invoice.signatures.some((s) => s.signerRole === 'COUNTERPARTY')
  const isCounterparty = viewer.id === invoice.counterpartyId
  const canSign = isCounterparty && !hasCounterpartySig

  // Public verification URL — shown as a copyable link in the body. Same
  // origin as the SPA (TanStack Router root). When the SPA is served from
  // a custom domain, `window.location.origin` resolves the right host.
  const verifyUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/invoice/v/${invoice.transactionId}`
      : `/invoice/v/${invoice.transactionId}`

  return (
    <>
      <CrmDialogHeader>
        <div className="flex items-start justify-between gap-3 pr-8">
          <div>
            <DialogTitle
              className="flex items-center gap-2 text-lg"
              data-testid="invoice-detail-title"
            >
              <FileSignature className="h-5 w-5 text-primary" />
              {getInvoiceTypeLabel(invoice.type)}
            </DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-2 text-sm">
              <span className="font-semibold text-foreground">
                {formatAmount(invoice.amount, invoice.currency)}
              </span>
              {invoice.projectName ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{invoice.projectName}</span>
                </>
              ) : null}
              {invoice.salaryMonth ? (
                <>
                  <span aria-hidden>·</span>
                  <span>Месяц {invoice.salaryMonth}</span>
                </>
              ) : null}
            </DialogDescription>
          </div>
          <Badge variant="outline" className={cn('border self-start', TYPE_CLASS[invoice.type])}>
            {getInvoiceTypeLabel(invoice.type)}
          </Badge>
        </div>
        <div className="mt-2">
          <Badge
            variant="outline"
            className={cn('border', STATUS_CLASS[invoice.status])}
            data-testid="invoice-detail-status"
          >
            {invoice.status === 'PENDING' ? (
              <Clock className="mr-1 h-3 w-3" />
            ) : (
              <CheckCircle2 className="mr-1 h-3 w-3" />
            )}
            {STATUS_LABEL[invoice.status]}
          </Badge>
        </div>
      </CrmDialogHeader>

      <CrmDialogBody className="pb-6">
        {/* Split layout: signature table + verify info (≈40%) left, large
            PDF preview (≈60%) right. On mobile (< md) the grid collapses to
            a single column with info on top, PDF below — preserving the
            form-like reading order on narrow screens. */}
        <div className="grid grid-cols-1 md:grid-cols-[40%_1fr] gap-6">
          <div className="min-w-0 space-y-5">
            {/* Signature list — card-per-signature instead of a horizontal
                table. The previous 5-column table («Сторона / Подписант /
                Дата / Метод / Хэш») didn't fit the 40% column without a
                horizontal scrollbar even on a desktop dialog. Hash column
                was a tech-only audit detail the SENIOR/HR never need —
                removed from the main view; for forensic verification the
                public verify URL below already exposes the canonical hash. */}
            <section aria-label="Подписи" className="rounded-xl border border-border/70 bg-card/40">
              <header className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
                <h3 className="text-sm font-semibold tracking-tight">Подписи</h3>
                <span className="text-xs text-muted-foreground">
                  {invoice.signatures.length} из 2
                </span>
              </header>
              <ul className="divide-y divide-border/40">
                <SignatureCard
                  role="COMPANY"
                  signature={invoice.signatures.find((s) => s.signerRole === 'COMPANY')}
                />
                <SignatureCard
                  role="COUNTERPARTY"
                  signature={invoice.signatures.find((s) => s.signerRole === 'COUNTERPARTY')}
                  counterpartyName={invoice.counterpartyName}
                />
              </ul>
            </section>

            {/* Public verify info */}
            <section
              aria-label="Публичная верификация"
              className="rounded-xl border border-border/50 bg-muted/20 p-4 text-xs"
            >
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <div className="space-y-1 min-w-0">
                  <p className="font-medium text-foreground">Публичная ссылка верификации</p>
                  <p className="text-muted-foreground">
                    Эта ссылка открывается без авторизации — используется для проверки PDF
                    сторонними лицами по QR-коду на распечатке.
                  </p>
                  <Link
                    to="/invoice/v/$transactionId"
                    params={{ transactionId: invoice.transactionId }}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 break-all font-mono text-primary hover:underline"
                    data-testid="invoice-detail-verify-link"
                  >
                    {verifyUrl}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            </section>
          </div>

          {/* PDF preview — large right column */}
          <div className="min-w-0">
            <InvoicePdfPreview documentId={invoice.documentId} />
          </div>
        </div>
      </CrmDialogBody>

      <CrmDialogFooter>
        <Button variant="outline" onClick={onClose} data-testid="invoice-detail-close">
          Закрыть
        </Button>
        {canSign ? (
          <SignButton invoice={invoice} onSuccess={onClose} />
        ) : hasCounterpartySig ? (
          <Badge
            variant="outline"
            className="border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300"
            data-testid="invoice-detail-signed-badge"
          >
            <Lock className="mr-1 h-3 w-3" />
            Документ подписан
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300"
            data-testid="invoice-detail-counterparty-only-badge"
          >
            Подпись доступна только контрагенту
          </Badge>
        )}
      </CrmDialogFooter>
    </>
  )
}

// ---------------------------------------------------------------------------
// PDF preview — iframe driven by `useDocumentDownloadUrl`
// ---------------------------------------------------------------------------

function InvoicePdfPreview({ documentId }: { documentId: string | null }) {
  // documentId is nullable in the schema for the brief generation race window
  // — fall back to a "Готовится…" placeholder rather than a broken iframe.
  const { data, isLoading } = useDocumentDownloadUrl(documentId ?? undefined, {
    enabled: Boolean(documentId),
  })
  // Track whether the iframe actually rendered. Chrome blocks cross-origin
  // PDF iframes in some configurations (the «This page has been blocked by
  // Chrome» error juzer saw on the screenshot), and the `sandbox` attribute
  // makes the breakage silent — no `onError` fires. We use the `onLoad`
  // callback as a positive signal and a 3s timeout to flip the UI to the
  // download fallback if no load event arrives, so the SENIOR isn't stuck
  // looking at a blank panel.
  //
  // `iframeLoadedRef` mirrors the iframe load state for the timeout callback
  // to read at fire time. Using a state variable here introduced a stale-
  // closure race: the timeout captured `iframeLoaded=false` from the render
  // that scheduled it, so the fallback flipped on every invoice even when
  // the PDF had already rendered. A ref always sees the current value, so
  // we read the live load status when the timer actually fires.
  const [iframeBlocked, setIframeBlocked] = useState(false)
  const iframeLoadedRef = useRef(false)

  useEffect(() => {
    // Reset on URL change so reopening with a different invoice retries.
    setIframeBlocked(false)
    iframeLoadedRef.current = false
    if (!data?.url) return
    const timer = setTimeout(() => {
      if (!iframeLoadedRef.current) setIframeBlocked(true)
    }, 3000)
    return () => clearTimeout(timer)
  }, [data?.url])

  const handleIframeLoad = () => {
    iframeLoadedRef.current = true
    setIframeBlocked(false)
  }

  if (!documentId) {
    return (
      <div className="flex min-h-[500px] h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
        Готовится PDF…
      </div>
    )
  }
  if (isLoading) {
    return <Skeleton className="min-h-[500px] h-full w-full rounded-lg" />
  }
  if (!data?.url) {
    return (
      <div className="flex min-h-[500px] h-full items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-destructive/10 text-sm text-destructive">
        Не удалось загрузить PDF
      </div>
    )
  }

  if (iframeBlocked) {
    return (
      <div
        data-testid="invoice-pdf-fallback"
        className="flex min-h-[500px] h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm"
      >
        <p className="text-muted-foreground">
          Браузер заблокировал встроенный просмотр PDF. Скачайте файл, чтобы открыть его локально.
        </p>
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
          data-testid="invoice-pdf-fallback-download"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Открыть PDF
        </a>
      </div>
    )
  }

  return (
    <div
      data-testid="invoice-pdf-preview"
      className="overflow-hidden rounded-lg border border-border bg-muted h-full"
    >
      {/* Remove sandbox — Chrome's PDF viewer needs scripts to render the
          controls (toolbar, zoom). With `sandbox="allow-same-origin"` only,
          the cross-origin S3 URL gets blocked with the «This page has been
          blocked by Chrome» panel. We rely on the same-origin-policy of the
          presigned URL + the PDF being a static GET for security. */}
      <iframe
        src={data.url}
        title="Инвойс PDF"
        className="w-full min-h-[500px] h-full"
        onLoad={handleIframeLoad}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// One card per signature — replaces the legacy 5-column table that needed
// horizontal scroll. Layout: role label as the eyebrow, signer name as the
// main line, date + method as muted metadata footer. Pending state shows
// an amber «Ожидает подписи» chip in place of the metadata footer.
// ---------------------------------------------------------------------------

function SignatureCard({
  role,
  signature,
  counterpartyName,
}: {
  role: InvoiceSignatureDto['signerRole']
  signature: InvoiceSignatureDto | undefined
  counterpartyName?: string
}) {
  if (!signature) {
    // Empty state — COMPANY card is never empty (auto-signed at invoice
    // creation), so this only renders for the COUNTERPARTY card when the
    // recipient has not yet signed.
    return (
      <li
        className="px-4 py-3 space-y-1"
        data-testid={`signature-row-${role.toLowerCase()}-pending`}
      >
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {SIG_ROLE_LABEL[role]}
        </p>
        <p className="text-sm font-medium text-foreground/90">{counterpartyName ?? '—'}</p>
        <p className="text-xs text-amber-300/90 inline-flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          Ожидает подписи
        </p>
      </li>
    )
  }
  return (
    <li
      className="px-4 py-3 space-y-1"
      data-testid={`signature-row-${signature.signerRole.toLowerCase()}`}
    >
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {SIG_ROLE_LABEL[signature.signerRole]}
      </p>
      <p className="text-sm font-medium text-foreground">{signature.signerName}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span title={fmtRelative(signature.signedAt)}>{fmtDateTime(signature.signedAt)}</span>
        <span
          className="inline-flex items-center gap-1"
          title={SIG_METHOD_TOOLTIP[signature.method]}
        >
          <span aria-hidden>·</span>
          {SIG_METHOD_LABEL[signature.method]}
        </span>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// «Подписать инвойс» button + confirm AlertDialog
// ---------------------------------------------------------------------------

function SignButton({ invoice, onSuccess }: { invoice: InvoiceDto; onSuccess: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const signMutation = useSignInvoice()

  const handleSign = () => {
    signMutation.mutate(invoice.transactionId, {
      onSuccess: () => {
        setAgreed(false)
        setConfirmOpen(false)
        onSuccess()
      },
    })
  }

  return (
    <>
      <Button onClick={() => setConfirmOpen(true)} data-testid="invoice-detail-sign-button">
        <FileSignature className="mr-2 h-4 w-4" />
        Подписать инвойс
      </Button>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o && !signMutation.isPending) {
            setAgreed(false)
            setConfirmOpen(false)
          }
        }}
      >
        <AlertDialogContent data-testid="invoice-sign-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Подписать инвойс?</AlertDialogTitle>
            <AlertDialogDescription>
              Подписывая этот документ, вы подтверждаете согласие с его содержимым. После подписи
              документ нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
            <strong>{getInvoiceTypeLabel(invoice.type)}</strong>
            <br />
            Сумма: {formatAmount(invoice.amount, invoice.currency)}
            {invoice.projectName ? (
              <>
                <br />
                Проект: {invoice.projectName}
              </>
            ) : null}
          </div>
          <label className="flex items-start gap-2 px-1 text-sm">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
              data-testid="invoice-sign-agree-checkbox"
            />
            <span>Я ознакомлен и согласен с содержимым инвойса</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signMutation.isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Prevent radix from closing the dialog before the mutation
                // resolves — the close happens in `onSuccess`.
                e.preventDefault()
                handleSign()
              }}
              disabled={!agreed || signMutation.isPending}
              data-testid="invoice-sign-submit-button"
            >
              {signMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Подписываем…
                </>
              ) : (
                'Подписать'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
