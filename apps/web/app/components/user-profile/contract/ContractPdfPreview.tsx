import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, FileText, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
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
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const revokeRef = useRef<(() => void) | null>(null)

  // AbortController ref — cancelled on unmount or when a new load supersedes the current one.
  const abortRef = useRef<AbortController | null>(null)

  const downloadPdf = useCallback(async () => {
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
      const status =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined
      if (status === 429) {
        toast.error('Слишком часто. Подождите минуту.')
      } else {
        toast.error('Не удалось скачать PDF.')
      }
    } finally {
      setIsDownloading(false)
    }
  }, [userId])

  const loadPdf = useCallback(async () => {
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
      const status =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined
      if (status === 429) {
        toast.error('Слишком часто. Подождите минуту.')
      } else {
        toast.error('Не удалось загрузить PDF предпросмотра.')
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false)
      }
    }
  }, [userId])

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
        <span className="text-xs font-medium text-muted-foreground">PDF предпросмотр</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={isDownloading}
            onClick={() => void downloadPdf()}
            data-testid="contract-pdf-download-btn"
          >
            <Download className={cn('h-3.5 w-3.5', isDownloading && 'animate-pulse')} />
            Скачать PDF
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={!canRefresh || isLoading}
                  onClick={() => void loadPdf()}
                  data-testid="contract-pdf-refresh-btn"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
                  Обновить превью
                </Button>
              </span>
            </TooltipTrigger>
            {isDirty && <TooltipContent>Сначала сохраните, чтобы обновить превью</TooltipContent>}
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
            <p className="text-sm text-muted-foreground">Загрузка PDF…</p>
          </div>
        )}

        {/* PDF iframe with <object> progressive fallback (iOS Safari) */}
        {blobUrl && !hasError && (
          <iframe
            src={blobUrl}
            title="Предварительный просмотр контракта"
            aria-label="Предварительный просмотр контракта"
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
                Встроенный просмотр PDF недоступен.{' '}
                <a
                  href={blobUrl}
                  download="contract-preview.pdf"
                  className="underline hover:text-foreground"
                >
                  Скачать контракт
                </a>
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
            <p className="text-center text-sm text-muted-foreground">Не удалось загрузить PDF.</p>
            <Button size="sm" variant="outline" onClick={() => void loadPdf()} disabled={isDirty}>
              Повторить
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
