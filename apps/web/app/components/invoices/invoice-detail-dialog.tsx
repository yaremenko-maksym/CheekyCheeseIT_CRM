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
import { useState } from 'react'
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<InvoiceDto['type'], string> = {
  SENIOR_INCOME: 'Выплата сеньору',
  SALARY: 'Зарплата',
}

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

const SIG_METHOD_LABEL: Record<InvoiceSignatureDto['method'], string> = {
  AUTO_COMPANY: 'Авто (компания)',
  MANUAL_CLICK: 'Ручная (клик)',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAmount(amount: string, currency: string): string {
  const num = Number(amount)
  if (!Number.isFinite(num)) return `${amount} ${currency}`
  return `${num.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`
}

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
  const { data: invoice, isLoading, error } = useInvoice(transactionId, {
    enabled: open && Boolean(transactionId),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent
        maxWidth="sm:max-w-3xl"
        data-testid="invoice-detail-dialog"
      >
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
  const hasCounterpartySig = invoice.signatures.some(
    (s) => s.signerRole === 'COUNTERPARTY',
  )
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
              {TYPE_LABEL[invoice.type]}
            </DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-2 text-sm">
              <span className="font-semibold text-foreground">
                {fmtAmount(invoice.amount, invoice.currency)}
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
          <Badge
            variant="outline"
            className={cn('border self-start', TYPE_CLASS[invoice.type])}
          >
            {TYPE_LABEL[invoice.type]}
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

      <CrmDialogBody className="space-y-5 pb-6">
        {/* PDF preview */}
        <InvoicePdfPreview documentId={invoice.documentId} />

        {/* Signature table */}
        <section
          aria-label="Подписи"
          className="rounded-xl border border-border/70 bg-card/40"
        >
          <header className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
            <h3 className="text-sm font-semibold tracking-tight">Подписи</h3>
            <span className="text-xs text-muted-foreground">
              {invoice.signatures.length} из 2
            </span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Сторона</th>
                  <th className="px-4 py-2 font-medium">Подписант</th>
                  <th className="px-4 py-2 font-medium">Дата</th>
                  <th className="px-4 py-2 font-medium">Метод</th>
                  <th className="px-4 py-2 font-medium">Хэш</th>
                </tr>
              </thead>
              <tbody>
                <SignatureRow
                  role="COMPANY"
                  signature={invoice.signatures.find(
                    (s) => s.signerRole === 'COMPANY',
                  )}
                />
                <SignatureRow
                  role="COUNTERPARTY"
                  signature={invoice.signatures.find(
                    (s) => s.signerRole === 'COUNTERPARTY',
                  )}
                  counterpartyName={invoice.counterpartyName}
                />
              </tbody>
            </table>
          </div>
        </section>

        {/* Public verify info */}
        <section
          aria-label="Публичная верификация"
          className="rounded-xl border border-border/50 bg-muted/20 p-4 text-xs"
        >
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <div className="space-y-1">
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
          >
            <Lock className="mr-1 h-3 w-3" />
            Документ подписан
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300"
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

  if (!documentId) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
        Готовится PDF…
      </div>
    )
  }
  if (isLoading) {
    return <Skeleton className="h-96 w-full rounded-lg" />
  }
  if (!data?.url) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-destructive/10 text-sm text-destructive">
        Не удалось загрузить PDF
      </div>
    )
  }

  return (
    <div
      data-testid="invoice-pdf-preview"
      className="overflow-hidden rounded-lg border border-border bg-muted"
    >
      <iframe
        src={data.url}
        title="Инвойс PDF"
        className="h-[480px] w-full"
        // Sandbox keeps the embed defensive (no top-nav, no scripts). The
        // S3 presigned URL is a static GET on a PDF — same-origin scripts
        // aren't needed for rendering.
        sandbox="allow-same-origin"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// One row of the signature table
// ---------------------------------------------------------------------------

function SignatureRow({
  role,
  signature,
  counterpartyName,
}: {
  role: InvoiceSignatureDto['signerRole']
  signature: InvoiceSignatureDto | undefined
  counterpartyName?: string
}) {
  if (!signature) {
    return (
      <tr className="border-t border-border/40">
        <td className="px-4 py-2.5 font-medium">{SIG_ROLE_LABEL[role]}</td>
        <td className="px-4 py-2.5 text-muted-foreground">
          {counterpartyName ?? '—'}
        </td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" /> Ожидает
          </span>
        </td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
      </tr>
    )
  }
  return (
    <tr className="border-t border-border/40">
      <td className="px-4 py-2.5 font-medium">
        {SIG_ROLE_LABEL[signature.signerRole]}
      </td>
      <td className="px-4 py-2.5">{signature.signerName}</td>
      <td
        className="px-4 py-2.5 text-xs text-muted-foreground"
        title={fmtRelative(signature.signedAt)}
      >
        {fmtDateTime(signature.signedAt)}
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        {SIG_METHOD_LABEL[signature.method]}
      </td>
      <td className="px-4 py-2.5 text-xs">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {signature.pdfHashShort}
        </code>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// «Подписать инвойс» button + confirm AlertDialog
// ---------------------------------------------------------------------------

function SignButton({
  invoice,
  onSuccess,
}: {
  invoice: InvoiceDto
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
      <Button
        onClick={() => setConfirmOpen(true)}
        data-testid="invoice-detail-sign-button"
      >
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
              Подписывая этот документ, вы подтверждаете согласие с его
              содержимым. После подписи документ нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
            <strong>{TYPE_LABEL[invoice.type]}</strong>
            <br />
            Сумма: {fmtAmount(invoice.amount, invoice.currency)}
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
            <AlertDialogCancel disabled={signMutation.isPending}>
              Отмена
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
