/**
 * DocumentDetailDialog — modal viewer for a single document.
 *
 * Shows a larger preview (image or PDF inline), full metadata
 * (original filename, size, MIME, uploaded by, date, project link when
 * applicable), and a row of actions (download, delete, restore /
 * delete permanently for ADMIN, close). Triggered by clicking the
 * preview area or filename on a DocumentCard. All copy is uk/en via Lingui;
 * categories, the archived badge and the delete confirmations come from the
 * `document-labels.ts` hub.
 *
 * PDF rendering (Task: documents-pdf-preview):
 *   - Загружает presigned URL один раз через useDocumentBlob.
 *   - Превью = <iframe src={blobUrl}> через PdfPreview.
 *   - «Скачать» = <a href={blobUrl} download> — 0 повторных запросов к S3.
 *   - Для виртуальных контрактов (source='employee_contract'):
 *     использует fetchContractPdfBlob (same-origin /api/users/:id/contract/pdf).
 *
 * Variant 3 hybrid filenames: shows `doc.originalName` (cyrillic /
 * unicode preserved) prominently, with the sanitized `doc.name`
 * displayed in a smaller secondary line so power users can see what
 * actually lives in S3 / on disk after download.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import {
  Calendar,
  Download,
  FileText,
  PenLine,
  RotateCcw,
  Trash,
  Trash2,
  UserCircle2,
  FolderOpen,
  HardDrive,
  FileType,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DOCUMENT_MIME_WHITELIST, formatDate, formatRelativeTime } from '@crm/shared'
import type { Document, ProjectDetailDto, SessionUser } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
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
import { useLocale } from '@/lib/i18n'
import { api } from '@/lib/axios'
import { formatBytes } from '@/lib/format-bytes'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import {
  useDeleteDocument,
  useDocumentDownloadUrl,
  useHardDeleteDocument,
  useRestoreDocument,
} from '@/hooks/use-documents'
import { useDocumentBlob } from '@/hooks/use-document-blob'
import { fetchContractPdfBlob } from '@/components/user-profile/contract/useEmployeeContract'
import { DocumentImage } from './document-image'
import { PdfPreview } from './pdf-preview'
import {
  CATEGORY_LABEL_MESSAGES,
  DELETE_CONFIRM_MESSAGES,
  DOCUMENT_STATUS_MESSAGES,
} from './document-labels'

interface DocumentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  doc: Document | null
  viewer: SessionUser
}

/**
 * Human-readable «Format» row (COPY-M-docs-10): the raw MIME
 * (`application/vnd.openxml…`) was printed as the value. The raw string now
 * lives only in the row's `title`, for whoever needs it.
 */
const FORMAT_MESSAGES = {
  'application/pdf': msg`PDF`,
  'image/jpeg': msg`Зображення JPEG`,
  'image/png': msg`Зображення PNG`,
  'image/webp': msg`Зображення WebP`,
  'image/heic': msg`Зображення HEIC`,
} satisfies Record<(typeof DOCUMENT_MIME_WHITELIST)[number], MessageDescriptor>

/** Anything outside the upload whitelist (legacy rows) — still not a raw MIME. */
const FORMAT_OTHER = msg`Інший формат`

function formatMessageFor(mimeType: string): MessageDescriptor {
  return (
    (FORMAT_MESSAGES as Record<string, MessageDescriptor | undefined>)[mimeType] ?? FORMAT_OTHER
  )
}

// ---------------------------------------------------------------------------
// Contract blob hook (for employee_contract virtual docs)
// ---------------------------------------------------------------------------

interface ContractBlobState {
  blobUrl: string | null
  isLoading: boolean
  hasError: boolean
}

/**
 * Загружает PDF контракта через same-origin API (/api/users/:id/contract/pdf).
 * Не кешируется в SW (no-store). Revoke при закрытии.
 */
function useContractBlob(userId: string | undefined, open: boolean): ContractBlobState {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const revokeRef = useRef<(() => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const loadedForRef = useRef<string | null>(null)

  const loadContract = useCallback(async (uid: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setHasError(false)
    revokeRef.current?.()
    revokeRef.current = null

    try {
      const { blobUrl: url, revoke } = await fetchContractPdfBlob(uid, controller.signal)
      if (controller.signal.aborted) return
      revokeRef.current = revoke
      loadedForRef.current = uid
      setBlobUrl(url)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (controller.signal.aborted) return
      setHasError(true)
    } finally {
      if (!controller.signal.aborted) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !userId) return
    if (loadedForRef.current === userId && blobUrl !== null) return
    void loadContract(userId)
  }, [open, userId, blobUrl, loadContract])

  // Сброс при закрытии
  useEffect(() => {
    if (!open || !userId) {
      abortRef.current?.abort()
      revokeRef.current?.()
      revokeRef.current = null
      setBlobUrl(null)
      setIsLoading(false)
      setHasError(false)
      loadedForRef.current = null
    }
  }, [open, userId])

  // Cleanup при размонтировании
  const abortRefStable = abortRef
  const revokeRefStable = revokeRef
  useEffect(() => {
    return () => {
      abortRefStable.current?.abort()
      revokeRefStable.current?.()
      revokeRefStable.current = null
    }
  }, [abortRefStable, revokeRefStable])

  return { blobUrl, isLoading, hasError }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DocumentDetailDialog({
  open,
  onOpenChange,
  doc,
  viewer,
}: DocumentDetailDialogProps) {
  const locale = useLocale()
  const { t, i18n } = useLingui()
  const [confirmSoftDelete, setConfirmSoftDelete] = useState(false)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)

  const isDeleted = doc?.deletedAt != null
  const isReceipt = doc?.category === 'RECEIPT'
  const isImage = doc?.mimeType.startsWith('image/') ?? false
  const isPdf = doc?.mimeType === 'application/pdf'
  const isContractVirtual = doc?.source === 'employee_contract'

  const isOwner = doc != null && viewer.id === doc.ownerId
  const isAdmin = viewer.role === 'ADMIN'

  const canSoftDelete = !isDeleted && !isReceipt && (isOwner || isAdmin)
  const canRestore = isDeleted && isAdmin
  const canHardDelete = isDeleted && isAdmin

  // Uploader display name is part of the document DTO (LEFT JOIN
  // performed server-side). Fall back to a neutral «deleted user» label when the field is
  // null (hard-deleted user / legacy row).
  const uploaderLabel = doc?.uploadedByDisplayName ?? t`Видалений користувач`

  // Project NAME for the «Project» row (COPY-M-docs-11: it used to print
  // `#<last 8 chars of the id>`). Same key + endpoint as the project page, so
  // the cache is shared; RBAC stays on the API. When the viewer can't read the
  // project (403/404) the row falls back to a generic link label (the visible text is never an id; the raw id lives only in the row's `title`, plan M-11).
  const projectId = doc?.projectId ?? null
  const projectQuery = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.get<ProjectDetailDto>(`/projects/${projectId}`).then((r) => r.data),
    enabled: open && projectId !== null,
    retry: false,
  })

  // Display name: original (cyrillic preserved) when available, else sanitized.
  const displayName = doc?.originalName ?? doc?.name ?? ''

  // -------------------------------------------------------------------------
  // Blob loading — единый fetch для превью + скачивание
  // -------------------------------------------------------------------------

  // Для загруженных PDF/файлов — presigned S3 URL → blob (кешируется SW)
  const docBlob = useDocumentBlob(
    isContractVirtual ? null : doc?.id,
    open && !isContractVirtual && Boolean(doc),
    displayName,
  )

  // Для виртуальных контрактов — same-origin contract PDF (no-store, не кешируется)
  const contractBlob = useContractBlob(
    isContractVirtual ? doc?.ownerId : undefined,
    open && isContractVirtual && Boolean(doc),
  )

  // Активный blob (в зависимости от типа документа)
  const activeBlobUrl = isContractVirtual ? contractBlob.blobUrl : docBlob.blobUrl
  const activeBlobLoading = isContractVirtual ? contractBlob.isLoading : docBlob.isLoading
  const activeBlobError = isContractVirtual ? contractBlob.hasError : docBlob.hasError

  // -------------------------------------------------------------------------
  // Presigned URL query — остаётся для кнопки «Скачать» когда blob ещё не готов
  // (также нужен для DocumentImage — картинки не blob-загружаются)
  // -------------------------------------------------------------------------
  const downloadQuery = useDocumentDownloadUrl(isContractVirtual ? undefined : doc?.id, {
    enabled: open && !isContractVirtual && Boolean(doc),
  })

  const softDelete = useDeleteDocument()
  const restore = useRestoreDocument()
  const hardDelete = useHardDeleteDocument()

  // -------------------------------------------------------------------------
  // Download handler
  // -------------------------------------------------------------------------

  // PDF/контракт: используем blob (0 новых запросов)
  // Картинки: открываем presigned URL (SW media-cache уже держит их)
  function handleDownload() {
    if (isPdf || isContractVirtual) {
      // Blob уже загружен — используем его напрямую
      if (activeBlobUrl) {
        const a = document.createElement('a')
        a.href = activeBlobUrl
        a.download = displayName || 'document.pdf'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        return
      }
      // Blob ещё грузится — ждём (кнопка задизейблена через isDownloadDisabled)
      return
    }
    // Картинки — открываем presigned URL (уже в SW кеше)
    void downloadQuery.refetch().then((result) => {
      const url = result.data?.url
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    })
  }

  // Кнопка «Скачать» заблокирована если blob ещё грузится
  const isDownloadDisabled =
    isPdf || isContractVirtual ? activeBlobLoading && !activeBlobUrl : downloadQuery.isFetching

  if (!doc) return null

  // Plain derivation (not a hook), so it lives below the null guard.
  const relativeDate = formatRelativeTime(doc.createdAt, locale)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* PR #56 final UT (AC5): widened from sm:max-w-2xl to sm:max-w-4xl
            so the new 2-column layout (metadata left, large preview right)
            has room to breathe. On narrow viewports the grid collapses to
            a single column — metadata first, preview below. */}
        <CrmDialogContent maxWidth="sm:max-w-4xl">
          <CrmDialogHeader>
            <DialogTitle data-testid="document-detail-title" className="line-clamp-1 pr-8">
              {displayName}
            </DialogTitle>
            {/* Use div instead of DialogDescription to avoid <div>-in-<p> nesting warning (Badge renders <div>). */}
            <div
              id="document-detail-description"
              className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
            >
              {isDeleted ? (
                <Badge variant="secondary" className="bg-muted-foreground/15">
                  {i18n._(DOCUMENT_STATUS_MESSAGES.ARCHIVED)}
                </Badge>
              ) : null}
              {isPdf ? (
                <Badge variant="secondary" className="bg-red-500/15 text-red-600">
                  PDF
                </Badge>
              ) : null}
              {isContractVirtual ? (
                <Badge variant="secondary" className="bg-blue-500/15 text-blue-600">
                  {i18n._(CATEGORY_LABEL_MESSAGES.CONTRACT)}
                </Badge>
              ) : null}
              {!isContractVirtual ? (
                <span>{i18n._(CATEGORY_LABEL_MESSAGES[doc.category])}</span>
              ) : null}
            </div>
          </CrmDialogHeader>

          <CrmDialogBody className="overflow-y-hidden pb-4">
            {/* PR #56 final UT (AC5): 2-column split — metadata on the left
                (~40%), large preview on the right (~60%). Mirrors the layout
                used in TransactionDetailDialog for receipt previews so the
                two surfaces feel like the same component family. Collapses
                to a single column on mobile. */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              {/* Metadata column */}
              <div className="flex flex-col gap-3 overflow-y-auto text-sm">
                <DetailRow
                  icon={UserCircle2}
                  label={t`Хто завантажив`}
                  value={
                    <ProfileNameLink
                      userId={doc.uploadedBy}
                      viewerRole={viewer.role}
                      className="text-primary hover:underline focus:outline-none focus-visible:underline"
                      testId="document-detail-uploader-link"
                    >
                      {uploaderLabel}
                    </ProfileNameLink>
                  }
                />
                <DetailRow
                  icon={Calendar}
                  label={t`Дата`}
                  value={relativeDate}
                  title={formatDate(doc.createdAt, locale, 'dateTimeWithYear')}
                />
                {doc.sizeBytes > 0 ? (
                  <DetailRow
                    icon={HardDrive}
                    label={t`Розмір`}
                    value={formatBytes(doc.sizeBytes, locale)}
                  />
                ) : null}
                <DetailRow
                  icon={FileType}
                  label={t`Формат`}
                  value={i18n._(formatMessageFor(doc.mimeType))}
                  title={doc.mimeType}
                />
                {/* AC5: «Имя файла» row deliberately removed — the title
                    already shows displayName (original cyrillic-preserved
                    name) and the S3 key is implementation detail. */}
                {doc.projectId ? (
                  <DetailRow
                    icon={FolderOpen}
                    label={t`Проєкт`}
                    value={
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: doc.projectId }}
                        className="text-primary hover:underline focus:outline-none focus-visible:underline"
                        title={doc.projectId}
                        data-testid="document-detail-project-link"
                      >
                        {projectQuery.data?.name ?? <Trans>Відкрити проєкт</Trans>}
                      </Link>
                    }
                  />
                ) : null}
                {isContractVirtual && doc.signedByName ? (
                  <DetailRow
                    icon={PenLine}
                    label={t`Підписант`}
                    value={
                      <span className="flex flex-col gap-0.5">
                        <span>{doc.signedByName}</span>
                        <span className="text-muted-foreground">CheekyCheeseIT</span>
                      </span>
                    }
                  />
                ) : null}
                {isContractVirtual && doc.signedAt ? (
                  <DetailRow
                    icon={Calendar}
                    label={t`Дата підписання`}
                    value={formatDate(doc.signedAt, locale, 'long')}
                    title={formatDate(doc.signedAt, locale, 'dateTimeWithYear')}
                  />
                ) : null}
              </div>

              {/* Preview column */}
              <div
                data-testid="document-detail-preview"
                className="relative h-[60vh] max-h-[560px] min-h-[360px] w-full overflow-y-auto rounded-xl border border-border bg-muted"
              >
                {isImage ? (
                  <DocumentImage
                    docId={doc.id}
                    alt={displayName}
                    variant="full"
                    className="h-full w-full"
                  />
                ) : isPdf || isContractVirtual ? (
                  /* PDF inline preview через blob */
                  <PdfPreview
                    blobUrl={activeBlobUrl}
                    isLoading={activeBlobLoading}
                    hasError={activeBlobError}
                    filename={displayName}
                    testId="document-pdf-preview"
                    className="h-full w-full"
                  />
                ) : (
                  /* Не-PDF, не-image */
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
                    <FileText className="h-20 w-20" />
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        Попередній перегляд недоступний — натисніть «Завантажити», щоб відкрити файл
                      </Trans>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </CrmDialogBody>

          <CrmDialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="document-detail-close"
            >
              <Trans>Закрити</Trans>
            </Button>

            <Button
              onClick={handleDownload}
              disabled={isDownloadDisabled}
              data-testid="document-detail-download"
            >
              <Download className="mr-1.5 h-4 w-4" />
              <Trans>Завантажити</Trans>
            </Button>

            {canSoftDelete ? (
              <Button
                variant="outline"
                onClick={() => setConfirmSoftDelete(true)}
                className="border-destructive/40 text-destructive hover:bg-destructive/5"
                data-testid="document-detail-delete"
              >
                <Trash className="mr-1.5 h-4 w-4" />
                <Trans>Видалити</Trans>
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
                <Trans>Відновити</Trans>
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
                <Trans>Видалити назавжди</Trans>
              </Button>
            ) : null}
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* Soft delete confirm */}
      <AlertDialog open={confirmSoftDelete} onOpenChange={setConfirmSoftDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Перенести в архів?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {i18n._(DELETE_CONFIRM_MESSAGES.ARCHIVE_BODY)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                softDelete.mutate(doc.id)
                setConfirmSoftDelete(false)
                onOpenChange(false)
              }}
            >
              <Trans>Перенести в архів</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hard delete confirm — ADMIN only */}
      <AlertDialog open={confirmHardDelete} onOpenChange={setConfirmHardDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Видалити назавжди?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {i18n._(DELETE_CONFIRM_MESSAGES.PERMANENT_BODY)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                hardDelete.mutate(doc.id)
                setConfirmHardDelete(false)
                onOpenChange(false)
              }}
            >
              <Trans>Видалити назавжди</Trans>
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
  /**
   * Value can be a plain string (rendered in a `<p>`) or any ReactNode
   * (rendered as-is, useful for links like the uploader profile link).
   */
  value: string | ReactNode
  title?: string
  className?: string
}

function DetailRow({ icon: Icon, label, value, title, className }: DetailRowProps) {
  const isString = typeof value === 'string'
  return (
    <div className={`flex items-start gap-2 text-xs ${className ?? ''}`} title={title}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">{label}</p>
        {isString ? (
          <p className="line-clamp-2 break-all text-sm text-foreground">{value}</p>
        ) : (
          <div className="line-clamp-2 break-all text-sm text-foreground">{value}</div>
        )}
      </div>
    </div>
  )
}
