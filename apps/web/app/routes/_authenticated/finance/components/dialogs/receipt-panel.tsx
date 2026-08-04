/**
 * ReceiptPanel — shared inline receipt preview for finance dialogs.
 *
 * Renders image or PDF inline at a capped height (60vh / 520px) and offers
 * an «Открыть чек» external link below the preview. Used by both
 * ValidateDialog (AC6) and TransactionDetailDialog (split-view right column).
 *
 * URL resolution strategy:
 *   - receiptDocumentId → presigned S3 URL via useDocumentDownloadUrl
 *   - receiptExternalUrl → used directly, but ONLY if it passes SAFE_RECEIPT_SCHEME
 *     (defence-in-depth — see MED-1 below); otherwise treated as unavailable
 *   - neither → shows "Нет прикреплённого чека" placeholder
 *
 * fix/external-receipt-rendering, round 2 (security-review PR #470 MED-3):
 * the site's CSP is NOT a blanket "no external embeds" policy —
 * `nginx/conf.d/csp-map.conf`:
 *   img-src 'self' data: blob: https:;
 *   object-src 'self' blob: https://*.r2.cloudflarestorage.com;
 * `img-src` allow-lists ANY https host, so an external **https image** was
 * never blocked and keeps its inline `<img>` preview. Only two cases are
 * actually unrenderable:
 *   - a **PDF on an external host** — `object-src` has no wildcard for
 *     arbitrary hosts, only our own domain + `blob:` + R2;
 *   - **any `http://` value** — browser mixed-content, not a CSP rule at all
 *     (the page itself is served over https).
 * Both get the honest "external" card (data-testid="receipt-panel-external")
 * with a working link instead of a guaranteed-broken embed. Own (presigned,
 * `receiptDocumentId`) receipts are unaffected either way — the site's own
 * storage IS allow-listed for both directives.
 *
 * MED-1 (defence-in-depth): `receiptExternalUrl` reaches this component via
 * `financeApi.getTransactions` (`api.get<TransactionDto>(...)`), a
 * compile-time cast with NO runtime Zod parse on this path — the write-side
 * `.refine(^https://)` schema is the only thing standing between an
 * SENIOR/DROP-authored string and this component's `href`/`src`. A single
 * layer guarding a cross-role sink is fragile (this project has shipped
 * direct data-fix SQL that bypasses Zod before, #382/#383), so
 * `useReceiptUrl` re-validates the scheme before ever handing the URL to the
 * renderer — an unsafe scheme (`javascript:`, `data:`, anything not
 * http(s)) falls back to the existing "Чек недоступен" state instead of
 * reaching `href`/`src`. `^https?://` (not https-only) so legacy `http://`
 * rows keep opening via link, per AC4.
 */
import { ExternalLink, File as FileIcon, Receipt, XCircle } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { useDocumentDownloadUrl } from '@/hooks/use-documents'

// ── URL resolver ──────────────────────────────────────────────────────────────

// MED-1 (security-review PR #470): the only scheme this component will ever
// hand to `href`/`src`. Read-DTO parsing does not run on the finance list/
// detail fetch path (see file header), so this is re-validated here rather
// than trusted from the API response.
const SAFE_RECEIPT_SCHEME = /^https?:\/\//i

export function useReceiptUrl(tx: TransactionDto): { url: string | null; isLoading: boolean } {
  const docQuery = useDocumentDownloadUrl(tx.receiptDocumentId ?? undefined, {
    enabled: !!tx.receiptDocumentId,
  })

  if (tx.receiptDocumentId) {
    if (docQuery.isLoading) return { url: null, isLoading: true }
    return { url: docQuery.data?.url ?? null, isLoading: false }
  }
  if (tx.receiptExternalUrl) {
    return SAFE_RECEIPT_SCHEME.test(tx.receiptExternalUrl)
      ? { url: tx.receiptExternalUrl, isLoading: false }
      : { url: null, isLoading: false }
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
 * - Own file (receiptDocumentId): image rendered as <img object-contain>
 *   inside a linked wrapper; PDF rendered via <object> (browser-native PDF
 *   viewer); unknown type shows "Предпросмотр недоступен" with a link.
 * - External URL (receiptExternalUrl): an https image renders inline exactly
 *   like an own image (CSP allows it). A PDF on any external host, or ANY
 *   http:// value, renders the honest "external" card instead — the embed
 *   would be blocked either by object-src or by mixed-content (see file
 *   header). An unsafe scheme (javascript:/data:/…) never reaches this far —
 *   `useReceiptUrl` already nulled it out to the "Чек недоступен" state.
 * - No receipt: shows a dashed placeholder.
 */
export function ReceiptPanel({ tx, compact = false }: ReceiptPanelProps) {
  const { url, isLoading } = useReceiptUrl(tx)
  const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
  const isExternal = !tx.receiptDocumentId && !!tx.receiptExternalUrl

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
  const isHttps = /^https:\/\//i.test(url)
  // MED-3: only a PDF (object-src) or a non-https URL (mixed content) is
  // actually unrenderable on an external host — an https external IMAGE
  // renders normally below, same as an own image.
  const showExternalCard = isExternal && (isPdf || !isHttps)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Receipt className="h-3.5 w-3.5" />
        <span>Чек</span>
      </div>
      {showExternalCard && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex flex-col items-center justify-center gap-2 ${frameClass} border-dashed border-border bg-muted/20 p-6 text-center transition-colors hover:border-primary/40 hover:bg-primary/5`}
          data-testid="receipt-panel-external"
        >
          <ExternalLink className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Чек хранится по внешней ссылке — откроется в новой вкладке
          </p>
        </a>
      )}
      {!showExternalCard && isImage && (
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
      {!showExternalCard && isPdf && (
        <div className={frameClass}>
          <object data={url} type="application/pdf" className="w-full h-full">
            <p className="p-3 text-xs text-muted-foreground">PDF не поддерживается браузером.</p>
          </object>
        </div>
      )}
      {!showExternalCard && !isImage && !isPdf && (
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
