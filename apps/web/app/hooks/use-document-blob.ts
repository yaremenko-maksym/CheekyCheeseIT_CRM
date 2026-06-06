/**
 * useDocumentBlob — единый fetch presigned URL → Blob → blobURL.
 *
 * Загружает PDF (или любой файл) ОДИН РАЗ при открытии диалога:
 *   1. Запрашивает presigned URL через useDocumentDownloadUrl (staleTime 4h).
 *   2. Fetch presigned URL → Blob через window.fetch (CORS, кешируется SW).
 *   3. Создаёт ObjectURL и возвращает его.
 *   4. Revoke при закрытии диалога / смене документа (нет утечек памяти).
 *
 * «Скачать» использует тот же blobURL → 0 повторных запросов к S3.
 *
 * Стратегия in-flight sharing: внутри компонента blobUrl/isLoading/error
 * одиночные, любой потребитель (превью + кнопка скачать) читает общий стейт.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDocumentDownloadUrl } from './use-documents'

export interface UseDocumentBlobResult {
  /** ObjectURL готов для <iframe src> и <a href download>. */
  blobUrl: string | null
  isLoading: boolean
  hasError: boolean
  /** Имя файла для атрибута download="" */
  filename: string
}

/**
 * @param docId    — id документа (null/undefined = disabled)
 * @param open     — загружать только когда диалог открыт
 * @param originalName — оригинальное имя файла (для download-атрибута)
 */
export function useDocumentBlob(
  docId: string | undefined | null,
  open: boolean,
  originalName: string,
): UseDocumentBlobResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)

  // Храним revoke чтобы вызвать при смене дока или закрытии.
  const revokeRef = useRef<(() => void) | null>(null)
  // Abort controller для in-flight fetch — отменяем если компонент размонтируется.
  const abortRef = useRef<AbortController | null>(null)
  // Запомним для какого docId уже загружен blob — не перезапускаем повторно.
  const loadedForRef = useRef<string | null>(null)

  // Presigned URL (staleTime 4h — не делаем лишних запросов к API).
  const urlQuery = useDocumentDownloadUrl(docId ?? undefined, {
    enabled: open && Boolean(docId),
  })

  const presignedUrl = urlQuery.data?.url ?? null

  const revokeCurrent = useCallback(() => {
    revokeRef.current?.()
    revokeRef.current = null
  }, [])

  const fetchBlob = useCallback(
    async (url: string, id: string) => {
      // Отменяем предыдущий in-flight
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsLoading(true)
      setHasError(false)
      // Revoke предыдущий blob перед новой загрузкой
      revokeCurrent()

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          // CORS fetch к presigned S3 URL — MinIO dev ок, prod требует CORS bucket policy.
          mode: 'cors',
        })

        if (controller.signal.aborted) return

        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status}`)
        }

        const blob = await response.blob()
        if (controller.signal.aborted) return

        const objectUrl = URL.createObjectURL(blob)
        revokeRef.current = () => URL.revokeObjectURL(objectUrl)
        loadedForRef.current = id
        setBlobUrl(objectUrl)
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return
        if (controller.signal.aborted) return
        setHasError(true)
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    },
    [revokeCurrent],
  )

  useEffect(() => {
    // Не загружаем если диалог закрыт или нет presigned URL
    if (!open || !presignedUrl || !docId) {
      return
    }
    // Уже загружено для этого docId — не перезапускаем
    if (loadedForRef.current === docId && blobUrl !== null) {
      return
    }
    void fetchBlob(presignedUrl, docId)
  }, [open, presignedUrl, docId, blobUrl, fetchBlob])

  // Сброс при смене документа или закрытии
  useEffect(() => {
    if (!open || !docId) {
      abortRef.current?.abort()
      revokeCurrent()
      setBlobUrl(null)
      setIsLoading(false)
      setHasError(false)
      loadedForRef.current = null
    }
  }, [open, docId, revokeCurrent])

  // Cleanup при размонтировании — используем ref-значения напрямую,
  // чтобы не пересоздавать эффект при каждом рендере.
  const abortRefStable = abortRef
  const revokeRefStable = revokeRef
  useEffect(() => {
    return () => {
      abortRefStable.current?.abort()
      revokeRefStable.current?.()
      revokeRefStable.current = null
    }
  }, [abortRefStable, revokeRefStable])

  return {
    blobUrl,
    isLoading: isLoading || (open && Boolean(docId) && urlQuery.isLoading),
    hasError,
    filename: originalName,
  }
}
