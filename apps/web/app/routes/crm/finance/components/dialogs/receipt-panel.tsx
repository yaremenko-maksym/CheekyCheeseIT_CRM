/**
 * ReceiptPanel — shared inline receipt preview for finance dialogs.
 *
 * Renders image or PDF inline at a capped height (60vh / 520px) and offers
 * an «Открыть чек» external link below the preview. Used by both
 * ValidateDialog (AC6) and TransactionDetailDialog (split-view right column).
 *
 * URL resolution strategy:
 *   - receiptDocumentId → presigned S3 URL via useDocumentDownloadUrl
 *   - receiptExternalUrl → used directly (no presign needed)
 *   - neither → shows "Нет прикреплённого чека" placeholder
 */
import { ExternalLink, File as FileIcon, Receipt, XCircle } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { useDocumentDownloadUrl } from '@/hooks/use-documents'

// ── URL resolver ──────────────────────────────────────────────────────────────

export function useReceiptUrl(tx: TransactionDto): { url: string | null; isLoading: boolean } {
  const docQuery = useDocumentDownloadUrl(tx.receiptDocumentId ?? undefined, {
    enabled: !!tx.receiptDocumentId,
  })

  if (tx.receiptDocumentId) {
    if (docQuery.isLoading) return { url: null, isLoading: true }
    return { url: docQuery.data?.url ?? null, isLoading: false }
  }
  if (tx.receiptExternalUrl) {
    return { url: tx.receiptExternalUrl, isLoading: false }
  }
  return { url: null, isLoading: false }
}

// ── Preview frame class (shared constant) ────────────────────────────────────

export const RECEIPT_PREVIEW_FRAME =
  'h-[60vh] max-h-[520px] min-h-[320px] rounded-lg border border-border bg-muted/30 overflow-hidden'

// ── ReceiptPanel component ────────────────────────────────────────────────────

interface ReceiptPanelProps {
  tx: TransactionDto
  /**
   * Optional reduced height for compact contexts (e.g. ValidateDialog where
   * the panel sits below the metadata block, not beside it).
   * When true, caps the frame at 280px instead of 520px.
   */
  compact?: boolean
}

/**
 * Inline receipt preview.
 * - Image: rendered as <img object-contain> inside a linked wrapper.
 * - PDF: rendered via <object> (browser-native PDF viewer).
 * - Unknown type: shows "Предпросмотр недоступен" with an external link.
 * - No receipt: shows a dashed placeholder.
 */
export function ReceiptPanel({ tx, compact = false }: ReceiptPanelProps) {
  const { url, isLoading } = useReceiptUrl(tx)
  const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)

  const frameClass = compact
    ? 'h-[40vh] max-h-[280px] min-h-[180px] rounded-lg border border-border bg-muted/30 overflow-hidden'
    : RECEIPT_PREVIEW_FRAME

  if (!hasReceipt) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 ${frameClass} border-dashed border-border bg-muted/20 p-6 text-center`}
        data-testid="receipt-panel-empty"
      >
        <FileIcon className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Нет прикреплённого чека</p>
      </div>
    )
  }

  if (isLoading) {
    return <Skeleton className={`${frameClass} w-full`} />
  }

  if (!url) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 ${frameClass} border-dashed border-destructive/40 bg-destructive/5 p-6 text-center`}
      >
        <XCircle className="h-10 w-10 text-destructive/60" />
        <p className="text-sm text-destructive">Чек недоступен</p>
      </div>
    )
  }

  const isImage = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(url)
  const isPdf = /\.pdf(\?.*)?$/i.test(url)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Receipt className="h-3.5 w-3.5" />
        <span>Чек</span>
      </div>
      {isImage && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`block ${frameClass} p-2`}
        >
          <img
            src={url}
            alt="Чек"
            className="w-full h-full object-contain"
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        </a>
      )}
      {isPdf && (
        <div className={frameClass}>
          <object data={url} type="application/pdf" className="w-full h-full">
            <p className="p-3 text-xs text-muted-foreground">PDF не поддерживается браузером.</p>
          </object>
        </div>
      )}
      {!isImage && !isPdf && (
        <div
          className={`flex flex-col items-center justify-center gap-2 ${frameClass} border-dashed border-border bg-muted/20 p-6`}
        >
          <FileIcon className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Предпросмотр недоступен</p>
        </div>
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
      >
        <ExternalLink className="h-3 w-3" />
        Открыть чек
      </a>
    </div>
  )
}
