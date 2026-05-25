/**
 * DocumentList — grid of DocumentCard, or skeleton/empty state.
 *
 * Renders the empty state slot supplied by the parent (so the Receipts tab
 * can replace it with a link to /crm/finance). Parent passes the precomputed
 * uploaders map to spare the cards from running their own queries.
 */
import { FileText } from 'lucide-react'
import type { Document, SessionUser } from '@crm/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { DocumentCard } from './document-card'

type UploaderInfo = { id: string; displayName: string | null }

interface DocumentListProps {
  documents: Document[]
  loading: boolean
  viewer: SessionUser
  uploaders?: Record<string, UploaderInfo | undefined>
  /**
   * Custom empty-state node. When omitted, a generic "Нет документов"
   * placeholder is shown.
   */
  emptyState?: React.ReactNode
}

export function DocumentList({
  documents,
  loading,
  viewer,
  uploaders,
  emptyState,
}: DocumentListProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[4/3] w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (documents.length === 0) {
    if (emptyState) return <>{emptyState}</>
    return (
      <div
        data-testid="documents-empty"
        className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
      >
        <FileText className="h-10 w-10 text-muted-foreground/30" />
        <p className="mt-4 text-sm font-medium">Нет документов</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Загрузите свой первый документ — он появится здесь
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {documents.map((doc) => (
        <DocumentCard
          key={doc.id}
          doc={doc}
          viewer={viewer}
          uploaders={uploaders}
        />
      ))}
    </div>
  )
}
