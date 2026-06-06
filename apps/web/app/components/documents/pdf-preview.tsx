/**
 * PdfPreview — общий inline-превью PDF через blobURL.
 *
 * Используется:
 *   - DocumentDetailDialog (загруженные PDF через presigned S3 URL)
 *   - (потенциально) ContractPdfPreview (та уже реализована отдельно)
 *
 * Архитектура:
 *   - Принимает готовый `blobUrl` (загруженный вызывающей стороной).
 *   - <iframe src={blobUrl}> с <object> progressive fallback для iOS Safari.
 *   - При onLoad iframe → скрывает лоадер.
 *   - Если iframe не загрузился за 3 секунды — показывает кнопку «Открыть PDF».
 *   - hasError → показывает состояние ошибки.
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface PdfPreviewProps {
  /** ObjectURL от URL.createObjectURL(blob). Null = показывает лоадер. */
  blobUrl: string | null
  /** True пока blob ещё грузится (fetch в процессе). */
  isLoading: boolean
  /** True если fetch завершился ошибкой. */
  hasError: boolean
  /** Имя файла для download-атрибута кнопки «Открыть PDF». */
  filename?: string
  className?: string
  /** data-testid для Playwright E2E. */
  testId?: string
}

export function PdfPreview({
  blobUrl,
  isLoading,
  hasError,
  filename = 'document.pdf',
  className,
  testId = 'document-pdf-preview',
}: PdfPreviewProps) {
  const [iframeReady, setIframeReady] = useState(false)
  const [iframeFallback, setIframeFallback] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Сброс iframe-состояния при смене blobUrl (новый документ)
  useEffect(() => {
    setIframeReady(false)
    setIframeFallback(false)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [blobUrl])

  // 3-секундный timeout для iframe load — Chrome иногда блокирует blob PDF
  useEffect(() => {
    if (!blobUrl || iframeReady || iframeFallback) return
    timeoutRef.current = setTimeout(() => {
      if (!iframeReady) {
        setIframeFallback(true)
      }
    }, 3000)
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [blobUrl, iframeReady, iframeFallback])

  // Cleanup timeout при размонтировании
  const timeoutRefStable = timeoutRef
  useEffect(() => {
    return () => {
      if (timeoutRefStable.current) clearTimeout(timeoutRefStable.current)
    }
  }, [timeoutRefStable])

  const showLoader = isLoading || (blobUrl !== null && !iframeReady && !iframeFallback && !hasError)
  const showIframe = blobUrl !== null && !hasError && !iframeFallback

  return (
    <div
      data-testid={testId}
      className={cn(
        'relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-xl bg-muted',
        className,
      )}
    >
      {/* Loading overlay */}
      {showLoader && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-muted/80">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Загрузка PDF…</p>
        </div>
      )}

      {/* PDF iframe — прозрачный пока не загружен */}
      {showIframe && (
        <iframe
          src={blobUrl}
          title={`Предпросмотр: ${filename}`}
          aria-label={`Предпросмотр: ${filename}`}
          tabIndex={0}
          className={cn(
            'h-full w-full rounded-xl border-0',
            !iframeReady && 'invisible',
          )}
          onLoad={() => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setIframeReady(true)
          }}
          onError={() => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setIframeFallback(true)
          }}
        >
          {/* <object> progressive fallback (iOS Safari) */}
          <object data={blobUrl} type="application/pdf" className="h-full w-full">
            <p className="p-4 text-sm text-muted-foreground">
              Встроенный просмотр PDF недоступен.{' '}
              <a
                href={blobUrl}
                download={filename}
                className="underline hover:text-foreground"
              >
                Скачать PDF
              </a>
            </p>
          </object>
        </iframe>
      )}

      {/* Fallback: iframe заблокирован Chrome — кнопка «Открыть PDF» */}
      {iframeFallback && blobUrl && !hasError && (
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <FileText className="h-12 w-12 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">
            Браузер заблокировал встроенный просмотр.
          </p>
          <Button
            size="sm"
            variant="outline"
            asChild
          >
            <a href={blobUrl} download={filename} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-4 w-4" />
              Открыть PDF
            </a>
          </Button>
        </div>
      )}

      {/* Нет blob и не грузим — пустое состояние */}
      {!blobUrl && !isLoading && !hasError && (
        <div className="flex flex-col items-center gap-3 text-muted-foreground/40">
          <FileText className="h-16 w-16" />
        </div>
      )}

      {/* Ошибка загрузки */}
      {hasError && (
        <div
          className="flex flex-col items-center gap-3 p-6 text-center"
          data-testid={`${testId}-error`}
        >
          <AlertTriangle className="h-8 w-8 text-destructive/60" />
          <p className="text-sm text-muted-foreground">Не удалось загрузить PDF.</p>
        </div>
      )}
    </div>
  )
}
