/**
 * Lazy <img> wrapper that fetches and caches the presigned download URL via
 * `useDocumentDownloadUrl`. Falls back to a generic icon on error.
 *
 * Used by DocumentCard for image thumbnails. The URL query has a 4h
 * staleTime so re-renders / tab switches don't hammer S3 with GETs.
 */
import { ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDocumentDownloadUrl } from '@/hooks/use-documents'

interface DocumentImageProps {
  docId: string
  alt: string
  className?: string
}

export function DocumentImage({ docId, alt, className }: DocumentImageProps) {
  const { data, isLoading, isError } = useDocumentDownloadUrl(docId)

  if (isLoading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-muted animate-pulse',
          className,
        )}
        aria-label="Загружается изображение"
      />
    )
  }

  if (isError || !data) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-muted text-muted-foreground',
          className,
        )}
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
      className={cn('object-cover', className)}
      onError={(e) => {
        // Hide broken image; fallback handled by parent if needed.
        (e.currentTarget as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}
