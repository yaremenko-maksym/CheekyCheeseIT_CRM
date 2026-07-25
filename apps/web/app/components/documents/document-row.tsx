/**
 * DocumentRow — compact list-view row for /documents?view=list.
 *
 * Renders a single document as a horizontal row with:
 *   - category icon + filename (truncated)
 *   - size · relative date · uploader name
 *   - badge slot (pending-signature amber badge when applicable)
 *   - action buttons: Скачать, soft-delete (owner/ADMIN), restore / hard-delete (ADMIN)
 *
 * Intentionally mirrors the layout conventions of DocumentCard but in a
 * compact horizontal form, so switching between views doesn't disorient the
 * user. RECEIPT/INVOICE deletion rules are identical to DocumentCard.
 */
import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  Download,
  FileSignature,
  FileText,
  Receipt as ReceiptIcon,
  RotateCcw,
  Trash,
  Trash2,
  UserCircle2,
} from 'lucide-react'
import type { Document, SessionUser } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { DocumentStatusBadge } from './document-status-badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format-bytes'
import {
  useDeleteDocument,
  useDocumentDownloadUrl,
  useHardDeleteDocument,
  useRestoreDocument,
} from '@/hooks/use-documents'

interface DocumentRowProps {
  doc: Document
  viewer: SessionUser
  onOpen?: ((doc: Document) => void) | undefined
}

const RECEIPT_DELETE_TOOLTIP = 'Чек удаляется вместе с транзакцией'
const INVOICE_DELETE_TOOLTIP = 'Инвойс удаляется вместе с транзакцией'

const CATEGORY_ICON_MAP: Partial<Record<string, typeof FileText>> = {
  RECEIPT: ReceiptIcon,
  INVOICE: FileSignature,
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id
}

export function DocumentRow({ doc, viewer, onOpen }: DocumentRowProps) {
  const [confirmSoftDelete, setConfirmSoftDelete] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)

  const downloadQuery = useDocumentDownloadUrl(doc.id, { enabled: false })
  const softDelete = useDeleteDocument()
  const restore = useRestoreDocument()
  const hardDelete = useHardDeleteDocument()

  const isDeleted = doc.deletedAt !== null
  const isReceipt = doc.category === 'RECEIPT'
  const isInvoice = doc.category === 'INVOICE'
  const isOwner = viewer.id === doc.ownerId
  const isAdmin = viewer.role === 'ADMIN'

  const canSoftDelete = !isDeleted && !isReceipt && !isInvoice && (isOwner || isAdmin)
  const canRestore = isDeleted && isAdmin
  const canHardDelete = isDeleted && isAdmin

  const uploaderLabel = doc.uploadedByDisplayName ?? shortId(doc.uploadedBy)
  const displayName = doc.originalName ?? doc.name

  const Icon = CATEGORY_ICON_MAP[doc.category] ?? FileText

  const relativeDate = useMemo(() => {
    try {
      return formatDistanceToNow(new Date(doc.createdAt), {
        addSuffix: true,
        locale: ru,
      })
    } catch {
      return doc.createdAt
    }
  }, [doc.createdAt])

  async function handleDownload() {
    const result = await downloadQuery.refetch()
    const url = result.data?.url
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      data-testid="document-row"
      data-doc-id={doc.id}
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition hover:bg-muted/40',
        isDeleted && 'opacity-50',
      )}
    >
      {/* Category icon */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>

      {/* Filename + meta */}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen?.(doc)}
          className="line-clamp-1 max-w-full text-left text-sm font-medium hover:underline focus:outline-none focus-visible:underline"
          title={displayName}
          data-testid="document-row-title"
        >
          {displayName}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>{doc.sizeBytes > 0 ? formatBytes(doc.sizeBytes) : '—'}</span>
          <span aria-hidden="true">·</span>
          <span title={doc.createdAt}>{relativeDate}</span>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1">
            <UserCircle2 className="h-3 w-3" />
            <ProfileNameLink
              userId={doc.uploadedBy}
              viewerRole={viewer.role}
              className="hover:text-foreground hover:underline focus:outline-none"
              testId="document-row-uploader-link"
            >
              {uploaderLabel}
            </ProfileNameLink>
          </span>
        </div>
      </div>

      {/* Badges */}
      <div className="flex shrink-0 items-center gap-2">
        {isDeleted ? (
          <Badge variant="secondary" className="bg-muted-foreground/15 text-foreground">
            Удалён
          </Badge>
        ) : null}
        {/* PR-2: unified status badge (supersedes invoicePendingSignature). */}
        {doc.statusBadge ? (
          <DocumentStatusBadge badge={doc.statusBadge} data-testid="document-row-status-badge" />
        ) : null}
        {/* Back-compat: render amber badge for pre-PR-2 rows that still carry
            invoicePendingSignature but no statusBadge. */}
        {!doc.statusBadge && doc.invoicePendingSignature ? (
          <Badge
            className="border-amber-500/30 bg-amber-500/20 text-amber-300"
            data-testid="document-row-pending-signature"
          >
            Требует подписи
          </Badge>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDownload}
          disabled={downloadQuery.isFetching}
          data-testid="document-row-download"
          data-track="document-download"
          aria-label="Скачать"
        >
          <Download className="h-4 w-4" />
        </Button>

        {canSoftDelete ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmSoftDelete(true)}
            data-testid="document-row-delete"
            aria-label="Удалить"
          >
            <Trash className="h-4 w-4" />
          </Button>
        ) : null}

        {(isReceipt || isInvoice) && !isDeleted ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled
                    className="text-muted-foreground"
                    aria-label="Удалить (недоступно)"
                  >
                    <Trash className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isReceipt ? RECEIPT_DELETE_TOOLTIP : INVOICE_DELETE_TOOLTIP}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}

        {canRestore ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => restore.mutate(doc.id)}
            disabled={restore.isPending}
            data-testid="document-row-restore"
            aria-label="Восстановить"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}

        {canHardDelete ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmHardDelete(true)}
            disabled={hardDelete.isPending}
            data-testid="document-row-hard-delete"
            aria-label="Удалить навсегда"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {/* Soft delete confirm */}
      <AlertDialog open={confirmSoftDelete} onOpenChange={setConfirmSoftDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Переместить в корзину?</AlertDialogTitle>
            <AlertDialogDescription>
              Документ «{displayName}» можно восстановить позже из режима «Архив».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                softDelete.mutate(doc.id)
                setConfirmSoftDelete(false)
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hard delete confirm — ADMIN only */}
      <AlertDialog open={confirmHardDelete} onOpenChange={setConfirmHardDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить навсегда?</AlertDialogTitle>
            <AlertDialogDescription>
              Файл будет удалён навсегда из S3 и базы. Действие необратимо. Продолжить?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                hardDelete.mutate(doc.id)
                setConfirmHardDelete(false)
              }}
            >
              Удалить навсегда
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
