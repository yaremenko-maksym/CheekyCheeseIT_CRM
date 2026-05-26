/**
 * <ProjectLogo> — render priority for a project's logo, mirroring the
 * backend XOR contract:
 *
 *   1. `logoDocumentId` → fetch presigned thumbnail URL via Documents hooks
 *      and render as `<img>`. This is the S3-backed canonical path.
 *   2. `logoExternalUrl` → direct `<img>` to the supplied URL.
 *   3. Both null → fallback (parent supplies an `<AvatarFallback>` typically
 *      containing the company's first letter).
 *
 * Wraps shadcn `<Avatar>` so callers can drop this inside any layout that
 * previously composed `<Avatar>` + `<AvatarImage>` directly.
 */
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DocumentImage } from '@/components/documents/document-image'
import { cn } from '@/lib/utils'

interface ProjectLogoProps {
  documentId: string | null
  externalUrl: string | null
  companyName: string
  className?: string | undefined
  /** Class applied to the wrapping <Avatar> (size, rounding). */
  avatarClassName?: string | undefined
  /** Optional fallback initial when companyName is empty. */
  fallback?: string | undefined
}

function getInitial(name: string): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?'
}

export function ProjectLogo({
  documentId,
  externalUrl,
  companyName,
  className,
  avatarClassName,
  fallback,
}: ProjectLogoProps) {
  const initial = fallback ?? getInitial(companyName)

  return (
    <Avatar className={cn(avatarClassName)}>
      {documentId && (
        <DocumentImage
          docId={documentId}
          alt={companyName}
          variant="thumbnail"
          className={cn('h-full w-full object-contain', className)}
        />
      )}
      {!documentId && externalUrl && (
        <AvatarImage
          src={externalUrl}
          alt={companyName}
          className={cn('object-contain', className)}
        />
      )}
      <AvatarFallback className="font-bold">{initial}</AvatarFallback>
    </Avatar>
  )
}
