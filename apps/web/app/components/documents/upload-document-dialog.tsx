/**
 * UploadDocumentDialog — modal form for uploading a single document.
 *
 * Implements client-side validation (size + MIME) BEFORE the network call:
 * a >10 MB file or a non-whitelisted MIME triggers a toast and aborts. The
 * backend re-validates everything, but failing fast keeps the user out of a
 * long upload that the API would only reject at the very end.
 *
 * Drag-and-drop is wired with native HTML5 events (no react-dropzone) — the
 * dropzone area swaps border color on dragenter/dragleave to telegraph the
 * drop target.
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Trans, useLingui } from '@lingui/react/macro'
import { FileUp, X } from 'lucide-react'
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_WHITELIST,
  documentCategorySchema,
  type DocumentCategory,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { UploadProgress } from '@/components/ui/upload-progress'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import { getAxiosStatus, getApiErrorMessage } from '@/lib/axios-utils'
import { formatBytes } from '@/lib/format-bytes'
import { useUploadDocument } from '@/hooks/use-documents'
import { useUploadProgressState } from '@/hooks/use-upload-progress-state'
import { CATEGORY_LABEL_MESSAGES } from './document-labels'

interface ProjectOption {
  id: string
  label: string
}

interface OwnerOption {
  id: string
  label: string
}

interface UploadDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Category prefilled from the active tab; user can change unless locked. */
  defaultCategory: DocumentCategory
  /** When true, the category Select is read-only (e.g. upload-from-Profile flow). */
  lockCategory?: boolean | undefined
  /** Available categories for the Select. Defaults to the 4 visible tabs. */
  allowedCategories?: DocumentCategory[] | undefined
  /** Project list — required for CONTRACT, optional otherwise. */
  projects?: ProjectOption[] | undefined
  /** Owner list — visible to ADMIN/HR/SENIOR; absent → upload as self. */
  owners?: OwnerOption[] | undefined
  /** Pre-selected owner id (default: self / undefined). */
  defaultOwnerId?: string | undefined
  /** Pre-selected project id. */
  defaultProjectId?: string | undefined
  /** Called after a successful upload (in addition to TanStack invalidation). */
  onUploaded?: (() => void) | undefined
}

const DEFAULT_ALLOWED: DocumentCategory[] = ['RESUME', 'SCAN', 'CONTRACT']

export function UploadDocumentDialog({
  open,
  onOpenChange,
  defaultCategory,
  lockCategory,
  allowedCategories,
  projects,
  owners,
  defaultOwnerId,
  defaultProjectId,
  onUploaded,
}: UploadDocumentDialogProps) {
  const locale = useLocale()
  const { t, i18n } = useLingui()
  // Named once so every sentence below shares the SAME rendered limit
  // (`10,0 МБ` / `10.0 MB`) as a plain-identifier slot.
  const maxSize = formatBytes(DOCUMENT_MAX_BYTES, locale)
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState<DocumentCategory>(defaultCategory)
  const [projectId, setProjectId] = useState<string | undefined>(defaultProjectId)
  const [ownerId, setOwnerId] = useState<string | undefined>(defaultOwnerId)
  const [isDragging, setIsDragging] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadDocument()
  const progress = useUploadProgressState()

  // Reset form when the dialog opens (so re-opening from the same trigger
  // doesn't leak stale state).
  useEffect(() => {
    if (open) {
      setFile(null)
      setCategory(defaultCategory)
      setProjectId(defaultProjectId)
      setOwnerId(defaultOwnerId)
      setIsDragging(false)
      progress.reset()
    }
  }, [open, defaultCategory, defaultProjectId, defaultOwnerId, progress.reset])

  // Stryker disable next-line StringLiteral: the category is always preselected (defaultCategory), so Radix never renders this placeholder text — unobservable.
  const categoryPlaceholder = t`Оберіть категорію`
  const categoriesToShow = allowedCategories ?? DEFAULT_ALLOWED
  const requiresProject = category === 'CONTRACT'
  const canSubmit = file !== null && !upload.isPending && (!requiresProject || Boolean(projectId))

  function validateAndSet(picked: File | null) {
    if (!picked) {
      setFile(null)
      return
    }
    if (picked.size > DOCUMENT_MAX_BYTES) {
      const fileSize = formatBytes(picked.size, locale)
      toast.error(t`Файл завеликий (${fileSize}) — оберіть файл менше ${maxSize}`)
      setFile(null)
      return
    }
    if (!(DOCUMENT_MIME_WHITELIST as readonly string[]).includes(picked.type)) {
      toast.error(t`Цей формат не підтримується — оберіть PDF, JPG, PNG, WebP або HEIC`)
      setFile(null)
      return
    }
    setFile(picked)
  }

  function handleSubmit() {
    if (!file) return
    // Re-parse category to ensure it matches the shared enum at the boundary.
    const parsedCategory = documentCategorySchema.parse(category)
    progress.prepare()
    upload.mutate(
      {
        file,
        category: parsedCategory,
        projectId: projectId ?? null,
        ownerId: ownerId ?? null,
        onProgress: progress.onProgress,
      },
      {
        onSuccess: () => {
          progress.success()
          onOpenChange(false)
          onUploaded?.()
        },
        onError: (e) => {
          // Status-based text, never the raw axios `e.message` (COPY-H-docs-6):
          // 413/415 name the next step; everything else goes through the
          // catalog by error code, with an actionable fallback.
          const status = getAxiosStatus(e)
          if (status === 413) {
            progress.error(t`Файл завеликий — оберіть файл менше ${maxSize}`)
          } else if (status === 415) {
            progress.error(t`Цей формат не підтримується — оберіть PDF, JPG, PNG, WebP або HEIC`)
          } else {
            const fallback = t`Не вдалося завантажити документ — спробуйте ще раз`
            // `||`: an error with an empty `message` must not render a blank alert.
            progress.error(getApiErrorMessage(e, fallback) || fallback)
          }
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Завантажити документ</Trans>
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            <Trans>
              Максимальний розмір: {maxSize}. Допустимі формати: PDF, JPG, PNG, WebP, HEIC.
            </Trans>
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          {/* Dropzone */}
          <div
            data-testid="upload-dropzone"
            data-dragging={isDragging || undefined}
            className={cn(
              'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-border bg-muted/30 hover:border-primary/60',
            )}
            onDragEnter={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              // Only flip off if the leave target is outside the dropzone itself.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              setIsDragging(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragging(false)
              const dropped = e.dataTransfer.files?.[0] ?? null
              validateAndSet(dropped)
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                inputRef.current?.click()
              }
            }}
            aria-label={t`Зона перетягування файлу`}
          >
            <FileUp className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">
              {file ? file.name : t`Перетягніть файл сюди або натисніть, щоб обрати`}
            </p>
            {file ? (
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  setFile(null)
                  if (inputRef.current) inputRef.current.value = ''
                }}
              >
                <X className="h-3 w-3" />
                <Trans>Прибрати файл</Trans>
              </button>
            ) : (
              <p className="mt-1 text-xs text-balance text-muted-foreground">
                <Trans>До {maxSize}, формати: PDF, JPG, PNG, WebP, HEIC</Trans>
              </p>
            )}
          </div>
          {/* The native input lives OUTSIDE the dropzone so click-to-pick
              doesn't bubble back into the dropzone's onClick handler (which
              would recursively re-trigger the input click in some testing
              environments). */}
          <input
            ref={inputRef}
            type="file"
            accept={[...DOCUMENT_MIME_WHITELIST].join(',')}
            className="hidden"
            onChange={(e) => validateAndSet(e.target.files?.[0] ?? null)}
            data-testid="upload-file-input"
          />

          {/* Category */}
          <div className="space-y-1.5">
            <Label htmlFor="document-category">
              <Trans>Категорія</Trans>
            </Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as DocumentCategory)}
              disabled={Boolean(lockCategory)}
            >
              <SelectTrigger id="document-category" data-testid="upload-category-select">
                <SelectValue placeholder={categoryPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {categoriesToShow.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {i18n._(CATEGORY_LABEL_MESSAGES[cat])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Project — only when CONTRACT */}
          {requiresProject ? (
            <div className="space-y-1.5">
              <Label htmlFor="document-project">
                <Trans>Проєкт</Trans> <span className="text-destructive">*</span>
              </Label>
              <Select value={projectId ?? ''} onValueChange={setProjectId}>
                <SelectTrigger id="document-project">
                  <SelectValue placeholder={t`Оберіть проєкт`} />
                </SelectTrigger>
                <SelectContent>
                  {(projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                  {(!projects || projects.length === 0) && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      <Trans>Немає доступних проєктів</Trans>
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* Owner — only when owners list is supplied (ADMIN/HR/SENIOR) */}
          {owners && owners.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="document-owner">
                <Trans>Власник</Trans>
              </Label>
              <Select value={ownerId ?? ''} onValueChange={setOwnerId}>
                <SelectTrigger id="document-owner">
                  <SelectValue placeholder={t`Оберіть власника`} />
                </SelectTrigger>
                <SelectContent>
                  {owners.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* Progress */}
          <UploadProgress state={progress.state} onRetry={handleSubmit} testId="upload-progress" />
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={upload.isPending}
            data-testid="cancel-button"
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} data-testid="upload-submit">
            {upload.isPending ? t`Завантаження…` : t`Завантажити файл`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
