/**
 * <UserAvatar> — single source of truth for rendering a user's avatar with the
 * new "document FK first, fallback URL second, initials last" priority.
 *
 *   1. `avatarDocumentId` → presigned thumbnail via Documents hooks (S3-backed
 *      custom upload). This is the canonical path post-PHASE 6.
 *   2. `avatarUrl`         → direct `<img>` (Google / dicebear fallback).
 *   3. neither            → shadcn `<AvatarFallback>` with initials.
 *
 * Wraps shadcn `<Avatar>` so callers swap in for the old
 * `<Avatar>...{avatar && <AvatarImage src={avatar} />}<AvatarFallback>` block
 * with a single component.
 */
import * as React from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DocumentImage } from '@/components/documents/document-image'
import { cn } from '@/lib/utils'

interface UserAvatarProps extends Omit<React.ComponentPropsWithoutRef<typeof Avatar>, 'children'> {
  avatarDocumentId: string | null | undefined
  avatarUrl: string | null | undefined
  displayName: string
  /** Class applied to the wrapping <Avatar> (sets sizing, rounding, etc.). */
  className?: string | undefined
  /** Optional class applied to the inner <img>. */
  imgClassName?: string | undefined
}

export function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

export const UserAvatar = React.forwardRef<React.ElementRef<typeof Avatar>, UserAvatarProps>(
  ({ avatarDocumentId, avatarUrl, displayName, className, imgClassName, ...props }, ref) => (
    <Avatar ref={ref} className={cn(className)} {...props}>
      {avatarDocumentId && (
        <DocumentImage
          docId={avatarDocumentId}
          alt={displayName}
          variant="thumbnail"
          fallbackToParent
          className={cn('h-full w-full object-cover', imgClassName)}
        />
      )}
      {!avatarDocumentId && avatarUrl && (
        <AvatarImage src={avatarUrl} alt={displayName} className={cn(imgClassName)} />
      )}
      <AvatarFallback>{getInitials(displayName)}</AvatarFallback>
    </Avatar>
  ),
)
UserAvatar.displayName = 'UserAvatar'
