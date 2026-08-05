/**
 * useApplicationResumeBlob — task-candidate-card-resume (AC2). Presigned
 * URL → fetch → Blob → blobURL, for the CandidateCard resume preview
 * dialog (the resulting Blob is what actually renders inline in
 * `PdfPreview`'s iframe — the presigned URL's own Content-Disposition is
 * irrelevant to this hook, since `fetch()` never looks at it).
 *
 * Mirrors `useDocumentBlob` (apps/web/app/hooks/use-document-blob.ts) —
 * NOT a shared hook with it because the presigned-URL source differs
 * (vacancy-application resumes have their own vacancyId/appId-scoped
 * endpoint, `useApplicationResumePreviewUrl`, not a `Document.id`). Reusing
 * `useDocumentBlob` directly would mean it accepting either a `docId` or a
 * vacancy-application pair, which is a bigger, riskier refactor of an
 * existing, currently-untested hook for exactly two call sites — the
 * fetch→blob→revoke plumbing below is intentionally the same shape, kept in
 * sync by inspection rather than by sharing code.
 *
 * task §2 (AC2) — unsupported-format handling: `VacancyApplicationResumeUrl`
 * carries no `mimeType` field (the public apply pipeline only ever accepts
 * `application/pdf`, `ApplicationsService`'s `RESUME_MIME`), so there is no
 * DB-stored signal to branch on. Instead this hook reads the `Content-Type`
 * off the SAME fetch() response used to build the blob (zero extra round-
 * trip) — R2/S3 always serves back whatever `ContentType` the object was
 * PUT with, so this is a genuine, defensible check even though every
 * CURRENTLY-uploaded resume is a PDF: a future-format change or a stray
 * legacy row would degrade to the honest "unsupported" card instead of a
 * broken iframe.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApplicationResumePreviewUrl } from './use-vacancies'

export interface UseApplicationResumeBlobResult {
  /** ObjectURL ready for <iframe src>. Null while loading / on error / unsupported format. */
  blobUrl: string | null
  isLoading: boolean
  hasError: boolean
  /** True when the resource loaded but its Content-Type isn't application/pdf. */
  isUnsupportedFormat: boolean
}

const PDF_CONTENT_TYPE = 'application/pdf'

export function useApplicationResumeBlob(
  vacancyId: string,
  appId: string | undefined,
  open: boolean,
): UseApplicationResumeBlobResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [isUnsupportedFormat, setIsUnsupportedFormat] = useState(false)

  const revokeRef = useRef<(() => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const loadedForRef = useRef<string | null>(null)

  const urlQuery = useApplicationResumePreviewUrl(vacancyId, appId, {
    enabled: open && Boolean(appId),
  })
  const presignedUrl = urlQuery.data?.url ?? null

  const revokeCurrent = useCallback(() => {
    revokeRef.current?.()
    revokeRef.current = null
  }, [])

  const fetchBlob = useCallback(
    async (url: string, id: string) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsLoading(true)
      setHasError(false)
      setIsUnsupportedFormat(false)
      revokeCurrent()

      try {
        // CORS fetch to the presigned R2 URL — app.cheekycheese.tech's CSP
        // allow-lists `https://*.r2.cloudflarestorage.com` for connect-src
        // (nginx/conf.d/csp-map.conf), same as useDocumentBlob's fetch.
        const response = await fetch(url, { signal: controller.signal, mode: 'cors' })
        if (controller.signal.aborted) return
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)

        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().startsWith(PDF_CONTENT_TYPE)) {
          // Drain the body so the connection is cleanly released, but don't
          // build a blob URL for a format the preview can't render inline.
          await response.arrayBuffer().catch(() => undefined)
          if (controller.signal.aborted) return
          loadedForRef.current = id
          setIsUnsupportedFormat(true)
          return
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
    if (!open || !presignedUrl || !appId) return
    if (loadedForRef.current === appId) return
    void fetchBlob(presignedUrl, appId)
  }, [open, presignedUrl, appId, fetchBlob])

  useEffect(() => {
    if (!open || !appId) {
      abortRef.current?.abort()
      revokeCurrent()
      setBlobUrl(null)
      setIsLoading(false)
      setHasError(false)
      setIsUnsupportedFormat(false)
      loadedForRef.current = null
    }
  }, [open, appId, revokeCurrent])

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
    isLoading: isLoading || (open && Boolean(appId) && urlQuery.isLoading),
    hasError: hasError || (open && Boolean(appId) && urlQuery.isError),
    isUnsupportedFormat,
  }
}
