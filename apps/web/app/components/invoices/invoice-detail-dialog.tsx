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
 *   │   Підписи                                                   │
 *   │   Сторона | Підписант | Дата | Метод | Хеш                  │
 *   │   …                                                         │
 *   │                                                             │
 *   │   Public verify URL: /invoice/v/<id>  (copyable)            │
 *   │ ───────────────────────────────────────────────────────────│
 *   │ FOOTER:  «Закрити»     [Підписати рахунок]                  │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * `Підписати` button is rendered (enabled) only when:
 *   - viewer.id === invoice.counterpartyId, AND
 *   - no existing COUNTERPARTY signature, AND
 *   - the session is not impersonated (backlog 212 / task-680 SR-M-4) — an
 *     ADMIN under «зайти як» sees the same button, disabled, with an
 *     explanation banner instead of an active sign action.
 *
 * Clicking opens a nested AlertDialog with an "Я ознайомлений і згоден"
 * checkbox; submit calls `useSignInvoice` mutation and on success closes
 * both dialogs + invalidates the invoice queries via the mutation hook.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileSignature,
  Loader2,
  Lock,
  ShieldCheck,
} from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import {
  INVOICE_SIGN_IMPERSONATION_MESSAGE,
  formatDate,
  formatRelativeTime,
  type InvoiceDto,
  type InvoiceSignatureDto,
  type SessionUser,
} from '@crm/shared'
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
import { useLocale } from '@/lib/i18n'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { useInvoice, useSignInvoice } from '@/hooks/use-invoices'
import { useDocumentPreviewUrl } from '@/hooks/use-documents'
import { formatAmount } from '@/lib/format-amount'
import { useInvoiceTypeLabel } from '@/lib/invoice-labels'

// ---------------------------------------------------------------------------
// Constants — type label lives in shared invoice-labels helper
// ---------------------------------------------------------------------------

/**
 * Fix-раунд 3 (task-680, SR-M-4). Той самий літерал, що віддає сервер у 403
 * на `POST /invoices/:transactionId/sign` (`INVOICE_SIGN_IMPERSONATION_MESSAGE`,
 * `packages/shared/src/schemas/invoices.ts`) — крапка в кінці додана так
 * само, як `IMPERSONATION_EXPLANATION` у `SignContractStep.tsx` /
 * `AcceptTosStep.tsx`.
 *
 * task-i18n-stage3d-pr4 (known limitation, see task file / plan «Опасность»):
 * `INVOICE_SIGN_IMPERSONATION_MESSAGE` itself is a raw `@crm/shared` string
 * constant (not a catalog `MessageDescriptor`) shared verbatim with the
 * server's own 403 body — out of THIS wave's ownership (same class as
 * `CASCADE_LEDGER_FACT_MESSAGES`). It stays Russian until that constant
 * migrates; only this file's OWN static text is translated here.
 */
const IMPERSONATION_EXPLANATION = `${INVOICE_SIGN_IMPERSONATION_MESSAGE}.`
const IMPERSONATION_EXPLANATION_ID = 'invoice-sign-explain-impersonating'

const TYPE_CLASS: Record<InvoiceDto['type'], string> = {
  SENIOR_INCOME: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  SALARY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

/**
 * task-i18n-stage3d-pr4 (template G-fin, COPY-L-fin-16). «Рахунок», not
 * «інвойс» — `satisfies` without `as const` (урок #707).
 */
const STATUS_LABEL_MESSAGES = {
  PENDING: msg`Очікує підпису`, // en: Awaiting signature
  SIGNED: msg`Підписано всіма`, // en: Signed by everyone
} satisfies Record<InvoiceDto['status'], MessageDescriptor>

const STATUS_CLASS: Record<InvoiceDto['status'], string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SIGNED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

/**
 * task-i18n-stage3d-pr4 (template G-fin). `invoice.v.$transactionId.tsx`'s
 * own `ROLE_LABEL` (COMPANY/COUNTERPARTY) carries the SAME two roles for
 * the public verify page — kept as a SEPARATE local map here rather than
 * shared, matching this file's pre-existing convention (its own
 * `TYPE_CLASS`/`STATUS_CLASS` are local too, not imported).
 */
const SIG_ROLE_LABEL_MESSAGES = {
  COMPANY: msg`Компанія`, // en: Company
  COUNTERPARTY: msg`Контрагент`, // en: Counterparty
} satisfies Record<InvoiceSignatureDto['signerRole'], MessageDescriptor>

// Short, user-readable labels — full audit copy is exposed via the `title=`
// tooltip on the row so technical reviewers can still inspect the chain
// without cluttering the main view.
const SIG_METHOD_LABEL_MESSAGES = {
  AUTO_COMPANY: msg`Автоматично`, // en: Automatic
  MANUAL_CLICK: msg`Вручну`, // en: Manual
} satisfies Record<InvoiceSignatureDto['method'], MessageDescriptor>

/**
 * task-i18n-stage3d-pr4 (COPY-M-fin-10, canon `CONTEXT.md` → «Волна d»
 * `SIG_METHOD_LABEL.MANUAL_CLICK`). The old tooltip said «Подписано вручную
 * (click + audit) контрагентом» — «click + audit» is internal
 * implementation jargon (the mechanism name), not something the reader
 * needs to know to trust the signature.
 */
const SIG_METHOD_TOOLTIP_MESSAGES = {
  AUTO_COMPANY: msg`Автоматичний електронний підпис компанії під час випуску рахунку`, // en: Automatic electronic signature by the company when the invoice is issued
  MANUAL_CLICK: msg`Підписано контрагентом вручну`, // en: Signed manually by the counterparty
} satisfies Record<InvoiceSignatureDto['method'], MessageDescriptor>

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
        <DialogDescription className="sr-only">
          <Trans>Рахунок</Trans>
        </DialogDescription>
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
    // COPY-M-fin-15: a status-driven tail instead of the raw error's own
    // (often technical/English) message — the same resolver the rest of the
    // app already uses for API failures.
    const reason = getApiErrorMessage(error)
    return (
      <>
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Рахунок</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Не вдалося завантажити документ</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{reason}</span>
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
  const { t } = useLingui()
  const typeLabel = useInvoiceTypeLabel(invoice.type)
  const hasCounterpartySig = invoice.signatures.some((s) => s.signerRole === 'COUNTERPARTY')
  const isCounterparty = viewer.id === invoice.counterpartyId
  /**
   * Бэклог 212 — під «зайти як» підпис рахунку повинен поставити сам
   * співробітник.
   */
  const impersonating = Boolean(viewer.impersonating)
  const canSign = isCounterparty && !hasCounterpartySig && !impersonating
  const blockedByImpersonation = isCounterparty && !hasCounterpartySig && impersonating

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
              {typeLabel}
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
                  <span>
                    <Trans>Місяць {invoice.salaryMonth}</Trans>
                  </span>
                </>
              ) : null}
            </DialogDescription>
          </div>
          <Badge variant="outline" className={cn('border self-start', TYPE_CLASS[invoice.type])}>
            {typeLabel}
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
            {i18n._(STATUS_LABEL_MESSAGES[invoice.status])}
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
                table. The previous 5-column table ("side / signer / date /
                method / hash") didn't fit the 40% column without a
                horizontal scrollbar even on a desktop dialog. Hash column
                was a tech-only audit detail the SENIOR/HR never need —
                removed from the main view; for forensic verification the
                public verify URL below already exposes the canonical hash. */}
            <section
              aria-label={t`Підписи`}
              className="rounded-xl border border-border/70 bg-card/40"
            >
              <header className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
                <h3 className="text-sm font-semibold tracking-tight">
                  <Trans>Підписи</Trans>
                </h3>
                <span className="text-xs text-muted-foreground">
                  <Trans>{invoice.signatures.length} з 2</Trans>
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
              aria-label={t`Публічна верифікація`}
              className="rounded-xl border border-border/50 bg-muted/20 p-4 text-xs"
            >
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <div className="space-y-1 min-w-0">
                  <p className="font-medium text-foreground">
                    <Trans>Публічне посилання для верифікації</Trans>
                  </p>
                  <p className="text-muted-foreground">
                    <Trans>
                      Це посилання відкривається без авторизації — використовується для перевірки
                      PDF сторонніми особами за QR-кодом на роздруківці.
                    </Trans>
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

        {/* Бэклог 212 — під «зайти як» підпис недоступний; той самий
            літерал, що віддає сервер у 403 на POST /invoices/:transactionId/sign. */}
        {blockedByImpersonation && (
          <div
            id={IMPERSONATION_EXPLANATION_ID}
            role="alert"
            aria-live="assertive"
            data-testid="invoice-sign-impersonating-banner"
            className="mt-4 rounded-md border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-300"
          >
            <AlertTriangle className="inline h-4 w-4 mr-2" />
            {IMPERSONATION_EXPLANATION}
          </div>
        )}
      </CrmDialogBody>

      <CrmDialogFooter>
        <Button variant="outline" onClick={onClose} data-testid="invoice-detail-close">
          <Trans>Закрити</Trans>
        </Button>
        {canSign ? (
          <SignButton invoice={invoice} typeLabel={typeLabel} onSuccess={onClose} />
        ) : blockedByImpersonation ? (
          <Button
            disabled
            aria-disabled="true"
            aria-describedby={IMPERSONATION_EXPLANATION_ID}
            data-testid="invoice-detail-sign-button"
          >
            <FileSignature className="mr-2 h-4 w-4" />
            <Trans>Підписати рахунок</Trans>
          </Button>
        ) : hasCounterpartySig ? (
          <Badge
            variant="outline"
            className="border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300"
            data-testid="invoice-detail-signed-badge"
          >
            <Lock className="mr-1 h-3 w-3" />
            <Trans>Документ підписано</Trans>
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300"
            data-testid="invoice-detail-counterparty-only-badge"
          >
            <Trans>Підпис доступний лише контрагенту</Trans>
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
  const { t } = useLingui()
  // documentId is nullable in the schema for the brief generation race window
  // — fall back to a "Готується…" placeholder rather than a broken iframe.
  // useDocumentPreviewUrl fetches a presigned URL with Content-Disposition:
  // inline so the browser renders the PDF inside the iframe instead of
  // triggering a Save dialog (which useDocumentDownloadUrl's attachment
  // disposition would cause).
  const { data, isLoading, isError, refetch, isRefetching } = useDocumentPreviewUrl(
    documentId ?? undefined,
    { enabled: Boolean(documentId) },
  )
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
        <Trans>Готується PDF…</Trans>
      </div>
    )
  }
  if (isLoading) {
    return <Skeleton className="min-h-[500px] h-full w-full rounded-lg" />
  }
  // COPY-M-fin-15: a genuine load failure (not just "no url yet") gets a
  // reason + a retry, same pattern as the dialog's own error state above.
  if (isError || !data?.url) {
    return (
      <div className="flex min-h-[500px] h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive">
        <span>
          <Trans>Не вдалося завантажити PDF</Trans>
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refetch()}
          disabled={isRefetching}
          data-testid="invoice-pdf-retry"
        >
          {t`Повторити`}
        </Button>
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
          <Trans>
            Браузер заблокував вбудований перегляд PDF. Завантажте файл, щоб відкрити його локально.
          </Trans>
        </p>
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
          data-testid="invoice-pdf-fallback-download"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <Trans>Відкрити PDF</Trans>
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
        title={t`PDF рахунку`}
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
// an amber «Очікує підпису» chip in place of the metadata footer.
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
  const locale = useLocale()
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
          {i18n._(SIG_ROLE_LABEL_MESSAGES[role])}
        </p>
        <p className="text-sm font-medium text-foreground/90">{counterpartyName ?? '—'}</p>
        <p className="text-xs text-amber-300/90 inline-flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          <Trans>Очікує підпису</Trans>
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
        {i18n._(SIG_ROLE_LABEL_MESSAGES[signature.signerRole])}
      </p>
      <p className="text-sm font-medium text-foreground">{signature.signerName}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span title={formatRelativeTime(signature.signedAt, locale)}>
          {formatDate(signature.signedAt, locale, 'dateTimeWithYear')}
        </span>
        <span
          className="inline-flex items-center gap-1"
          title={i18n._(SIG_METHOD_TOOLTIP_MESSAGES[signature.method])}
        >
          <span aria-hidden>·</span>
          {i18n._(SIG_METHOD_LABEL_MESSAGES[signature.method])}
        </span>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// «Підписати рахунок» button + confirm AlertDialog
// ---------------------------------------------------------------------------

function SignButton({
  invoice,
  typeLabel,
  onSuccess,
}: {
  invoice: InvoiceDto
  typeLabel: string
  onSuccess: () => void
}) {
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
        <Trans>Підписати рахунок</Trans>
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
            <AlertDialogTitle>
              <Trans>Підписати рахунок?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Підписуючи цей документ, ви підтверджуєте згоду з його змістом. Після підпису
                документ не можна скасувати.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
            <strong>{typeLabel}</strong>
            <br />
            <Trans>Сума: {formatAmount(invoice.amount, invoice.currency)}</Trans>
            {invoice.projectName ? (
              <>
                <br />
                <Trans>Проєкт: {invoice.projectName}</Trans>
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
            <span>
              <Trans>Я ознайомлений і згоден зі змістом рахунку</Trans>
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signMutation.isPending}>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
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
                  <Trans>Підписуємо…</Trans>
                </>
              ) : (
                <Trans>Підписати</Trans>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
