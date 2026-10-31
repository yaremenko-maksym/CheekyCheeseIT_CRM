/**
 * PdfPreview — общий inline-превью PDF через blobURL.
 *
 * Используется:
 *   - DocumentDetailDialog (загруженные PDF через presigned S3 URL)
 *   - (потенциально) ContractPdfPreview (та уже реализована отдельно)
 *
 * Архитектура:
 *   - Принимает готовый `blobUrl` (загруженный вызывающей стороной).
 *   - <iframe src={blobUrl}> (без дочернего контента: HTML5 его не рендерит).
 *   - При onLoad iframe → скрывает лоадер.
 *   - Если iframe не загрузился за 3 секунды — показывает кнопку «Завантажити PDF» (ссылка с `download`).
 *   - hasError → показывает состояние ошибки.
 */
import { useEffect, useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Download, ExternalLink, FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { detectIos } from '@/lib/is-ios'
import { cn } from '@/lib/utils'

export interface PdfPreviewProps {
  /** ObjectURL from URL.createObjectURL(blob). Null = shows the loader. */
  blobUrl: string | null
  /** True while the blob is still loading (fetch in flight). */
  isLoading: boolean
  /** True if the fetch failed. */
  hasError: boolean
  /** Имя файла для download-атрибута кнопки «Завантажити PDF». */
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
  const { t } = useLingui()
  // iOS WebKit fires iframe onLoad for blob PDFs but paints nothing → skip the iframe.
  const [isIos] = useState(detectIos)
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

  const showLoader =
    isLoading || (blobUrl !== null && !iframeReady && !iframeFallback && !hasError && !isIos)
  const showIframe = blobUrl !== null && !hasError && !iframeFallback && !isIos
  const showFallback = blobUrl !== null && !hasError && (iframeFallback || isIos)

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
          <p className="text-sm text-muted-foreground">
            <Trans>Завантаження PDF…</Trans>
          </p>
        </div>
      )}

      {/* PDF iframe — прозрачный пока не загружен */}
      {showIframe && (
        <iframe
          src={blobUrl}
          title={t`Попередній перегляд: ${filename}`}
          aria-label={t`Попередній перегляд: ${filename}`}
          tabIndex={0}
          className={cn('h-full w-full rounded-xl border-0', !iframeReady && 'invisible')}
          onLoad={() => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setIframeReady(true)
          }}
          onError={() => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setIframeFallback(true)
          }}
        />
      )}

      {/* Fallback: iframe заблокирован Chrome — кнопка «Завантажити PDF» */}
      {showFallback && blobUrl && (
        <div className="flex w-full max-w-full flex-col items-center gap-3 p-6 text-center">
          <FileText className="h-12 w-12 text-muted-foreground/60" />
          <p className="text-sm text-balance text-muted-foreground">
            {isIos ? (
              <Trans>Вбудований перегляд PDF недоступний на цьому пристрої</Trans>
            ) : (
              <Trans>Браузер заблокував вбудований перегляд PDF</Trans>
            )}
          </p>
          {isIos && (
            <Button size="lg" className="min-h-11 w-full sm:w-auto" asChild>
              <a
                href={blobUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`${testId}-open`}
              >
                <ExternalLink className="mr-1.5 h-4 w-4" />
                <Trans>Відкрити PDF</Trans>
              </a>
            </Button>
          )}
          <Button
            size={isIos ? 'lg' : 'sm'}
            variant="outline"
            className={isIos ? 'min-h-11 w-full sm:w-auto' : undefined}
            asChild
          >
            <a href={blobUrl} download={filename} target="_blank" rel="noopener noreferrer">
              <Download className="mr-1.5 h-4 w-4" />
              <Trans>Завантажити PDF</Trans>
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
          <p className="text-sm text-balance text-muted-foreground">
            <Trans>Не вдалося завантажити PDF — спробуйте відкрити файл ще раз</Trans>
          </p>
        </div>
      )}
    </div>
  )
}
