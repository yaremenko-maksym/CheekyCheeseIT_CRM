/**
 * DocumentList — grid of DocumentCard, or skeleton/empty state.
 *
 * Renders the empty state slot supplied by the parent (so the Receipts tab
 * can replace it with a link to /crm/finance). Uploader display names are
 * embedded in each document DTO (API LEFT JOIN), so no precomputed map is
 * needed any more.
 */
import { FileText } from 'lucide-react'
import type { Document, SessionUser } from '@crm/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { DocumentCard } from './document-card'

interface DocumentListProps {
  documents: Document[]
  loading: boolean
  viewer: SessionUser
  /**
   * Custom empty-state node. When omitted, a generic "Нет документов"
   * placeholder is shown.
   */
  emptyState?: React.ReactNode | undefined
  /**
   * Called when the user clicks the card preview or filename. The parent
   * opens DocumentDetailDialog with the clicked document. When undefined,
   * cards render without a click handler (used in tests).
   */
  onOpen?: ((doc: Document) => void) | undefined
  /**
   * PR-1 MED fix: controls the skeleton shape shown during loading.
   * 'grid' (default) — card-shaped 4/3 aspect ratio skeletons.
   * 'list' — compact row-shaped skeletons matching DocumentRow height.
   */
  view?: 'grid' | 'list'
}

export function DocumentList({
  documents,
  loading,
  viewer,
  emptyState,
  onOpen,
  view = 'grid',
}: DocumentListProps) {
  if (loading) {
    if (view === 'list') {
      // PR-1 MED fix: row-shaped skeleton for list view loading state.
      return (
        <div className="flex flex-col gap-1" data-testid="documents-list-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[60px] w-full rounded-lg" />
          ))}
        </div>
      )
    }
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
        <DocumentCard key={doc.id} doc={doc} viewer={viewer} onOpen={onOpen} />
      ))}
    </div>
  )
}
