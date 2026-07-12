import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, FileText, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { api } from '@/lib/axios'
import { getAxiosStatus } from '@/lib/axios-utils'

export interface TosPdfPreviewProps {
  /** Raw markdown to render as PDF. */
  bodyMarkdown: string
  className?: string
}

/**
 * Live PDF preview for the ToS admin editor.
 *
 * POSTs `bodyMarkdown` to `POST /api/tos/preview-pdf` (ADMIN-only) and
 * renders the returned PDF bytes in an iframe. Pattern mirrors
 * `ContractPdfPreview` but uses a POST (live body) instead of a GET by ID.
 *
 * Debounces re-renders: waits 600 ms after the last `bodyMarkdown` change
 * before firing the request so rapid keystrokes don't spam the API.
 */
export function TosPdfPreview({ bodyMarkdown, className }: TosPdfPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(false)

  const revokeRef = useRef<(() => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadPdf = useCallback(async (markdown: string) => {
    // Cancel any in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setHasError(false)
    setIframeLoading(true)

    // Revoke previous blob URL to free memory
    revokeRef.current?.()
    revokeRef.current = null

    try {
      const response = await api.post<ArrayBuffer>(
        '/tos/preview-pdf',
        { bodyMarkdown: markdown },
        {
          responseType: 'arraybuffer',
          signal: controller.signal,
        },
      )

      if (controller.signal.aborted) return

      const blob = new Blob([response.data], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const revoke = () => URL.revokeObjectURL(url)
      revokeRef.current = revoke
      setBlobUrl(url)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (err instanceof Error && err.name === 'CanceledError') return
      if (controller.signal.aborted) return

      setIsLoading(false)
      setIframeLoading(false)
      setHasError(true)

      if (getAxiosStatus(err) === 429) {
        toast.error('Слишком часто. Подождите минуту.')
      } else {
        toast.error('Не удалось загрузить PDF предпросмотра.')
      }
      return
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false)
      }
    }
  }, [])

  // Debounced re-render on bodyMarkdown change
  useEffect(() => {
    if (!bodyMarkdown.trim()) {
      setBlobUrl(null)
      setHasError(false)
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void loadPdf(bodyMarkdown)
    }, 600)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [bodyMarkdown, loadPdf])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      revokeRef.current?.()
    }
  }, [])

  const handleRefresh = () => {
    if (bodyMarkdown.trim()) void loadPdf(bodyMarkdown)
  }

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="tos-pdf-preview">
      {/* Toolbar */}
      <div className="flex items-center justify-between rounded-t-lg border-x border-t border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">PDF предпросмотр</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          disabled={isLoading || !bodyMarkdown.trim()}
          onClick={handleRefresh}
          data-testid="tos-pdf-refresh-btn"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          Обновить
        </Button>
      </div>

      {/* PDF viewer */}
      <div
        className="relative w-full flex-1 rounded-b-lg border border-border/60 bg-muted/20"
        style={{ minHeight: '480px' }}
        data-testid="tos-pdf-viewer"
      >
        {/* Loading overlay */}
        {(isLoading || iframeLoading) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-b-lg bg-muted/30">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Загрузка PDF…</p>
          </div>
        )}

        {/* PDF iframe */}
        {blobUrl && !hasError && (
          <iframe
            src={blobUrl}
            title="Предпросмотр Terms of Service"
            aria-label="Предпросмотр Terms of Service"
            tabIndex={0}
            className={cn('h-full w-full rounded-b-lg border-0', iframeLoading && 'invisible')}
            style={{ minHeight: '480px' }}
            onLoad={() => setIframeLoading(false)}
            onError={() => {
              setIframeLoading(false)
              setHasError(true)
            }}
          >
            <object data={blobUrl} type="application/pdf" className="h-full w-full">
              <p className="p-4 text-sm text-muted-foreground">
                Встроенный просмотр PDF недоступен.{' '}
                <a
                  href={blobUrl}
                  download="tos-preview.pdf"
                  className="underline hover:text-foreground"
                >
                  Скачать ToS
                </a>
              </p>
            </object>
          </iframe>
        )}

        {/* Empty placeholder */}
        {!blobUrl && !isLoading && !hasError && (
          <div className="flex h-full min-h-[480px] items-center justify-center">
            <FileText className="h-10 w-10 text-muted-foreground/40" />
          </div>
        )}

        {/* Error state */}
        {hasError && (
          <div
            className="flex h-full min-h-[480px] flex-col items-center justify-center gap-3 p-6"
            data-testid="tos-pdf-error"
          >
            <AlertTriangle className="h-8 w-8 text-destructive/60" />
            <p className="text-center text-sm text-muted-foreground">Не удалось загрузить PDF.</p>
            <Button size="sm" variant="outline" onClick={handleRefresh}>
              Повторить
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
