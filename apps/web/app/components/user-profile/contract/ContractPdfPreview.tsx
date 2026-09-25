import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, FileText, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getAxiosStatus } from '@/lib/axios-utils'
import { fetchContractPdfBlob } from './useEmployeeContract'

export interface ContractPdfPreviewProps {
  userId: string
  /** When true, the refresh button is disabled (unsaved editor changes). */
  isDirty: boolean
  className?: string
}

/**
 * Displays the backend-rendered PDF for an employee contract.
 * Reuses the iframe + <object> progressive enhancement pattern from
 * apps/web/app/components/onboarding/SignContractStep.tsx (A2a).
 *
 * The «Обновить превью» button is disabled while the editor has unsaved
 * changes (spec §5: "preview reflects the saved contract").
 */
export function ContractPdfPreview({ userId, isDirty, className }: ContractPdfPreviewProps) {
  const { t } = useLingui()
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const revokeRef = useRef<(() => void) | null>(null)

  // AbortController ref — cancelled on unmount or when a new load supersedes the current one.
  const abortRef = useRef<AbortController | null>(null)

  const downloadPdf = useCallback(
    async () => {
      setIsDownloading(true)
      try {
        const { blobUrl: url, revoke } = await fetchContractPdfBlob(userId)
        const a = document.createElement('a')
        a.href = url
        a.download = `contract-${userId}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        // Revoke after a short delay to allow browser to start download
        setTimeout(revoke, 1000)
      } catch (err: unknown) {
        if (getAxiosStatus(err) === 429) {
          toast.error(t`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз`)
        } else {
          toast.error(t`Не вдалося завантажити PDF`)
        }
      } finally {
        setIsDownloading(false)
      }
    },
    // MUT-1 (fix-round B, PR #717 CR-M-1) — same reasoning as
    // `TosPdfPreview.tsx`'s `[i18n]` comment: `t` (from `useLingui()`)
    // resolves through the SAME `i18n` singleton (`@/lib/i18n`'s `i18n`,
    // mutated in place by `activateLocale`, never reconstructed) — a
    // locale switch changes what `t` PRODUCES, not the closure's own
    // reference identity in any way this callback observes. Kept for
    // correctness/lint-intent (exhaustive-deps) rather than removed.
    // Stryker disable next-line ArrayDeclaration: t resolves through the stable i18n singleton, see comment above
    [userId, t],
  )

  const loadPdf = useCallback(
    async () => {
      // Cancel any in-flight request before starting a new one.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsLoading(true)
      setHasError(false)
      setIframeLoading(true)
      revokeRef.current?.()
      revokeRef.current = null

      try {
        const { blobUrl: url, revoke } = await fetchContractPdfBlob(userId, controller.signal)
        // Guard: if aborted while awaiting, do not call setState on unmounted component.
        if (controller.signal.aborted) return
        revokeRef.current = revoke
        setBlobUrl(url)
      } catch (err: unknown) {
        // Ignore AbortError — triggered by cleanup or superseding load, not a real failure.
        if (err instanceof Error && err.name === 'AbortError') return
        if (controller.signal.aborted) return
        setIsLoading(false)
        setIframeLoading(false)
        setHasError(true)
        // 429 Throttle check
        if (getAxiosStatus(err) === 429) {
          toast.error(t`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз`)
        } else {
          toast.error(t`Не вдалося завантажити PDF попереднього перегляду`)
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    },
    // MUT-1 (fix-round B, PR #717 CR-M-1) — same reasoning as the comment on
    // `downloadPdf`'s deps above (and `TosPdfPreview.tsx`'s `[i18n]`
    // comment): `t` resolves through the stable `i18n` singleton, so a
    // locale switch changes what `t` PRODUCES, not this closure's own
    // reference identity.
    // Stryker disable next-line ArrayDeclaration: t resolves through the stable i18n singleton, see comment above
    [userId, t],
  )

  // Load PDF on mount and when userId changes; cancel on unmount.
  useEffect(() => {
    void loadPdf()
    return () => {
      abortRef.current?.abort()
      revokeRef.current?.()
    }
  }, [userId, loadPdf])

  const canRefresh = !isDirty

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between rounded-t-lg border-x border-t border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          <Trans>Попередній перегляд PDF</Trans>
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-11 gap-1 px-2 text-xs sm:h-7"
            disabled={isDownloading}
            onClick={() => void downloadPdf()}
            data-testid="contract-pdf-download-btn"
          >
            <Download className={cn('h-3.5 w-3.5', isDownloading && 'animate-pulse')} />
            <Trans>Завантажити PDF</Trans>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-11 gap-1 px-2 text-xs sm:h-7"
                  disabled={!canRefresh || isLoading}
                  onClick={() => void loadPdf()}
                  data-testid="contract-pdf-refresh-btn"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
                  <Trans>Оновити перегляд</Trans>
                </Button>
              </span>
            </TooltipTrigger>
            {isDirty && (
              <TooltipContent>
                <Trans>Спочатку збережіть, щоб оновити перегляд</Trans>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </div>

      <div
        className="relative w-full rounded-b-lg border border-border/60 bg-muted/20"
        style={{ height: '480px' }}
        data-testid="contract-pdf-viewer"
      >
        {/* Loading overlay */}
        {(isLoading || iframeLoading) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-b-lg bg-muted/30 z-10">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              <Trans>Завантаження PDF…</Trans>
            </p>
          </div>
        )}

        {/* PDF iframe with <object> progressive fallback (iOS Safari) */}
        {blobUrl && !hasError && (
          <iframe
            src={blobUrl}
            title={t`Попередній перегляд контракту`}
            aria-label={t`Попередній перегляд контракту`}
            tabIndex={0}
            className={cn('w-full h-full rounded-b-lg border-0', iframeLoading && 'invisible')}
            onLoad={() => setIframeLoading(false)}
            onError={() => {
              setIframeLoading(false)
              setHasError(true)
            }}
          >
            <object data={blobUrl} type="application/pdf" className="w-full h-full">
              <p className="p-4 text-sm text-muted-foreground">
                <Trans>
                  Вбудований перегляд PDF недоступний.{' '}
                  <a
                    href={blobUrl}
                    download={t`Контракт — попередній перегляд.pdf`}
                    className="underline hover:text-foreground"
                  >
                    Завантажити контракт
                  </a>
                </Trans>
              </p>
            </object>
          </iframe>
        )}

        {/* Empty placeholder before first load */}
        {!blobUrl && !isLoading && !hasError && (
          <div className="flex h-full items-center justify-center">
            <FileText className="h-10 w-10 text-muted-foreground/40" />
          </div>
        )}

        {/* Error state */}
        {hasError && (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 p-6"
            data-testid="contract-pdf-error"
          >
            <AlertTriangle className="h-8 w-8 text-destructive/60" />
            <p className="text-center text-sm text-muted-foreground">
              <Trans>Не вдалося завантажити PDF</Trans>
            </p>
            <Button size="sm" variant="outline" onClick={() => void loadPdf()} disabled={isDirty}>
              <Trans>Повторити</Trans>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
