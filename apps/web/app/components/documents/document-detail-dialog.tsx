/**
 * DocumentDetailDialog — modal viewer for a single document.
 *
 * Shows a larger preview (image / PDF first-page icon), full metadata
 * (original filename, size, MIME, uploaded by, date, project link when
 * applicable), and a row of actions (Скачать, Удалить, Восстановить /
 * Удалить навсегда for ADMIN, Закрыть). Triggered by clicking the
 * preview area or filename on a DocumentCard.
 *
 * The dialog uses the full-resolution presigned URL via
 * `useDocumentDownloadUrl` so the preview is sharper than the
 * thumbnail. PDFs still render the category icon (no PDF→image library
 * is wired up); the user can click Скачать to open the file in-browser.
 *
 * Variant 3 hybrid filenames: shows `doc.originalName` (cyrillic /
 * unicode preserved) prominently, with the sanitized `doc.name`
 * displayed in a smaller secondary line so power users can see what
 * actually lives in S3 / on disk after download.
 */
import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  Calendar,
  Download,
  FileText,
  RotateCcw,
  Trash,
  Trash2,
  UserCircle2,
  FolderOpen,
  HardDrive,
  FileType,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Document, SessionUser } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
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
import { formatBytes } from '@/lib/format-bytes'
import {
  useDeleteDocument,
  useDocumentDownloadUrl,
  useHardDeleteDocument,
  useRestoreDocument,
} from '@/hooks/use-documents'
import { DocumentImage } from './document-image'

type UploaderInfo = { id: string; displayName: string | null }

interface DocumentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  doc: Document | null
  viewer: SessionUser
  uploaders?: Record<string, UploaderInfo | undefined> | undefined
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id
}

export function DocumentDetailDialog({
  open,
  onOpenChange,
  doc,
  viewer,
  uploaders,
}: DocumentDetailDialogProps) {
  const [confirmSoftDelete, setConfirmSoftDelete] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)

  // We always enable the full-size URL query — the dialog only renders
  // when `doc !== null && open`, so the enable flag below is sufficient.
  const downloadQuery = useDocumentDownloadUrl(doc?.id, { enabled: open && Boolean(doc) })
  const softDelete = useDeleteDocument()
  const restore = useRestoreDocument()
  const hardDelete = useHardDeleteDocument()

  const isDeleted = doc?.deletedAt != null
  const isReceipt = doc?.category === 'RECEIPT'
  const isImage = doc?.mimeType.startsWith('image/') ?? false
  const isPdf = doc?.mimeType === 'application/pdf'

  const isOwner = doc != null && viewer.id === doc.ownerId
  const isAdmin = viewer.role === 'ADMIN'

  const canSoftDelete = !isDeleted && !isReceipt && (isOwner || isAdmin)
  const canRestore = isDeleted && isAdmin
  const canHardDelete = isDeleted && isAdmin

  const uploader = doc ? uploaders?.[doc.uploadedBy] : undefined
  const uploaderLabel = uploader?.displayName ?? (doc ? shortId(doc.uploadedBy) : '')

  const relativeDate = useMemo(() => {
    if (!doc) return ''
    try {
      return formatDistanceToNow(new Date(doc.createdAt), {
        addSuffix: true,
        locale: ru,
      })
    } catch {
      return doc.createdAt
    }
  }, [doc])

  // Display name: original (cyrillic preserved) when available, else sanitized.
  const displayName = doc?.originalName ?? doc?.name ?? ''

  async function handleDownload() {
    const result = await downloadQuery.refetch()
    const url = result.data?.url
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  if (!doc) return null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <CrmDialogContent maxWidth="sm:max-w-2xl">
          <CrmDialogHeader>
            <DialogTitle data-testid="document-detail-title" className="line-clamp-1 pr-8">
              {displayName}
            </DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-2 text-xs">
              {isDeleted ? (
                <Badge variant="secondary" className="bg-muted-foreground/15">
                  В корзине
                </Badge>
              ) : null}
              {isPdf ? (
                <Badge variant="secondary" className="bg-red-500/15 text-red-600">
                  PDF
                </Badge>
              ) : null}
              <span className="text-muted-foreground">{doc.category}</span>
            </DialogDescription>
          </CrmDialogHeader>

          <CrmDialogBody className="space-y-4 pb-4">
            {/* Preview — full-resolution image, or large PDF icon */}
            <div
              data-testid="document-detail-preview"
              className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-muted"
            >
              {isImage ? (
                <DocumentImage
                  docId={doc.id}
                  alt={displayName}
                  variant="full"
                  className="h-full w-full"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
                  <FileText className="h-20 w-20" />
                  {isPdf ? (
                    <Badge
                      variant="secondary"
                      className="bg-red-500/15 text-red-600"
                    >
                      PDF
                    </Badge>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Превью недоступно — нажмите «Скачать» чтобы открыть файл
                  </p>
                </div>
              )}
            </div>

            {/* Metadata grid */}
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <DetailRow
                icon={UserCircle2}
                label="Загрузил"
                value={uploaderLabel}
              />
              <DetailRow
                icon={Calendar}
                label="Дата"
                value={relativeDate}
                title={doc.createdAt}
              />
              <DetailRow
                icon={HardDrive}
                label="Размер"
                value={formatBytes(doc.sizeBytes)}
              />
              <DetailRow icon={FileType} label="Формат" value={doc.mimeType} />
              {doc.originalName && doc.originalName !== doc.name ? (
                <DetailRow
                  icon={FileText}
                  label="Имя файла"
                  value={doc.name}
                  title={`S3-имя: ${doc.name}`}
                  className="sm:col-span-2"
                />
              ) : null}
              {doc.projectId ? (
                <DetailRow
                  icon={FolderOpen}
                  label="Проект"
                  value={`#${shortId(doc.projectId)}`}
                  className="sm:col-span-2"
                />
              ) : null}
            </div>
          </CrmDialogBody>

          <CrmDialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="document-detail-close"
            >
              Закрыть
            </Button>

            <Button
              onClick={handleDownload}
              disabled={downloadQuery.isFetching}
              data-testid="document-detail-download"
            >
              <Download className="mr-1.5 h-4 w-4" />
              Скачать
            </Button>

            {canSoftDelete ? (
              <Button
                variant="outline"
                onClick={() => setConfirmSoftDelete(true)}
                className="border-destructive/40 text-destructive hover:bg-destructive/5"
                data-testid="document-detail-delete"
              >
                <Trash className="mr-1.5 h-4 w-4" />
                Удалить
              </Button>
            ) : null}

            {canRestore ? (
              <Button
                variant="outline"
                onClick={() => restore.mutate(doc.id)}
                disabled={restore.isPending}
                data-testid="document-detail-restore"
              >
                <RotateCcw className="mr-1.5 h-4 w-4" />
                Восстановить
              </Button>
            ) : null}

            {canHardDelete ? (
              <Button
                variant="destructive"
                onClick={() => setConfirmHardDelete(true)}
                disabled={hardDelete.isPending}
                data-testid="document-detail-hard-delete"
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                Удалить навсегда
              </Button>
            ) : null}
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

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
                onOpenChange(false)
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
              Файл «{displayName}» будет удалён навсегда из S3 и базы. Действие
              необратимо. Продолжить?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                hardDelete.mutate(doc.id)
                setConfirmHardDelete(false)
                onOpenChange(false)
              }}
            >
              Удалить навсегда
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Internal — metadata row
// ---------------------------------------------------------------------------

interface DetailRowProps {
  icon: LucideIcon
  label: string
  value: string
  title?: string
  className?: string
}

function DetailRow({ icon: Icon, label, value, title, className }: DetailRowProps) {
  return (
    <div
      className={`flex items-start gap-2 text-xs ${className ?? ''}`}
      title={title}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">{label}</p>
        <p className="line-clamp-2 break-all text-sm text-foreground">{value}</p>
      </div>
    </div>
  )
}
