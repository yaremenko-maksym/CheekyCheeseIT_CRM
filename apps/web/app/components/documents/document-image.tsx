/**
 * Lazy <img> wrapper for document thumbnails / previews.
 *
 * Two modes (controlled by `variant`):
 *   - 'thumbnail' (default): fetches the 256x256 JPEG thumbnail via
 *     `useDocumentThumbnailUrl`. Cheap (~10 KB), instant; used by
 *     DocumentCard so a grid of 20 cards doesn't pull 20 full-res images.
 *   - 'full': fetches the full-resolution presigned URL via
 *     `useDocumentDownloadUrl`. Used by the detail modal previewer.
 *
 * Both URL queries share a 4h staleTime so re-renders / tab switches
 * don't hammer S3 with new presign round-trips.
 *
 * Returns null (no element) when the thumbnail is unavailable AND the
 * parent supplied no fallback — the parent (DocumentCard) renders the
 * category icon overlay in that case.
 *
 * `crossOrigin="anonymous"` (security HIGH-1, task-scan-cache-leak):
 * without it, a cross-origin `<img>` fetch is made in `no-cors` mode and the
 * browser hands back an OPAQUE Response — status always `0`, every header
 * (including `Cache-Control`) unreadable. The Service Worker's `media-cache`
 * rule (apps/web/app/lib/pwa-runtime-caching.ts) relies on reading
 * `Cache-Control` to keep sensitive categories (SCAN/RESUME/CONTRACT/
 * RECEIPT/INVOICE — `private, no-store` per `cacheControlForCategory` in
 * apps/api/src/documents/s3.service.ts) out of the cache; an opaque response
 * defeats that check by construction, so those scans silently sat in the
 * on-device cache for 30 days. `crossOrigin="anonymous"` switches the fetch
 * to `cors` mode (no credentials sent — matches an unauthenticated presigned
 * URL) so the response is transparent and the existing no-store check
 * actually runs. This requires the storage bucket to allow GET from the web
 * origin (already a hard requirement for `useDocumentBlob`'s
 * `fetch(url, { mode: 'cors' })` PDF preview — see docs/runbooks/s3-storage.md
 * §5 — so this doesn't add a new infra dependency, it just uses the same one
 * consistently). AVATAR/LOGO responses (`public, max-age=31536000,
 * immutable`) keep getting cached exactly as before — only the categories
 * that were already SUPPOSED to be excluded lose the accidental opaque
 * bypass.
 */
import { ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDocumentDownloadUrl, useDocumentThumbnailUrl } from '@/hooks/use-documents'

interface DocumentImageProps {
  docId: string
  alt: string
  className?: string
  /**
   * 'thumbnail' (default) — 256x256 jpeg, used in the card grid.
   * 'full' — full-res preview, used in the detail modal.
   */
  variant?: 'thumbnail' | 'full'
  /**
   * When true and the document has no thumbnail (PDF / legacy row), the
   * component renders `null` instead of the placeholder icon — so the
   * parent (DocumentCard) can show the category icon overlay. Used only
   * by the card grid; the full-res preview keeps the placeholder.
   */
  fallbackToParent?: boolean
}

export function DocumentImage({
  docId,
  alt,
  className,
  variant = 'thumbnail',
  fallbackToParent = false,
}: DocumentImageProps) {
  // Pick the right query based on variant. Both have identical caching
  // behavior so this is essentially a routing choice.
  const thumbQuery = useDocumentThumbnailUrl(docId, {
    enabled: variant === 'thumbnail',
  })
  const fullQuery = useDocumentDownloadUrl(docId, {
    enabled: variant === 'full',
  })

  const query = variant === 'thumbnail' ? thumbQuery : fullQuery
  const { data, isLoading, isError } = query

  if (isLoading) {
    return (
      <div
        className={cn('flex items-center justify-center bg-muted animate-pulse', className)}
        aria-label="Загружается изображение"
      />
    )
  }

  // For thumbnails the API returns `null` (200) when the doc has no
  // thumbnail (PDF / legacy). That's not an error — just signal the
  // parent to render its own fallback.
  if (!data || isError) {
    if (fallbackToParent) return null
    return (
      <div
        className={cn('flex items-center justify-center bg-muted text-muted-foreground', className)}
        aria-label="Превью недоступно"
      >
        <ImageIcon className="h-8 w-8" />
      </div>
    )
  }

  return (
    <img
      src={data.url}
      alt={alt}
      loading="lazy"
      crossOrigin="anonymous"
      className={cn('object-cover', className)}
      onError={(e) => {
        // Hide broken image; fallback handled by parent if needed.
        ;(e.currentTarget as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}
