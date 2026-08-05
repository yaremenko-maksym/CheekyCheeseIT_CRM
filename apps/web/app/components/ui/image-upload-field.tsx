/**
 * <ImageUploadField> — replacement for the legacy <ReceiptField> in the
 * project edit flow and (downstream) any LOGO / AVATAR upload UI that needs
 * the simple "file or URL" toggle.
 *
 * Unlike ReceiptField, the file mode goes through the Documents module:
 *   - file → `useUploadDocument({ category })` → server side stores the file
 *     in S3 / MinIO and returns a `documents` row; the field surfaces only
 *     the `documentId` upwards via `onChange`.
 *   - url  → keeps the value in the `externalUrl` slot (no upload).
 *
 * The XOR contract mirrors the DB CHECK constraint added in migration 0014:
 * only one of `documentId` / `externalUrl` may be set at a time. The toggle
 * also clears the *other* slot when switching modes so a stale value from
 * the previous tab can never leak into the persisted form.
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ImagePlus, Link2, Loader2, Paperclip, X } from 'lucide-react'
import { DOCUMENT_MAX_BYTES, DOCUMENT_MIME_WHITELIST, type DocumentCategory } from '@crm/shared'
import { Button } from './button'
import { Input } from './input'
import { cn } from '@/lib/utils'
import { useUploadDocument } from '@/hooks/use-documents'
import { DocumentImage } from '@/components/documents/document-image'

export interface ImageUploadFieldValue {
  documentId: string | null
  externalUrl: string | null
}

export interface ImageUploadFieldProps {
  /** Current XOR value. Both `null` ⇒ no image selected (placeholder shown). */
  value: ImageUploadFieldValue
  onChange: (value: ImageUploadFieldValue) => void
  /** AVATAR or LOGO — drives the upload category metadata. */
  category: Extract<DocumentCategory, 'AVATAR' | 'LOGO'>
  /** Optional document owner override (ADMIN editing someone else, etc.). */
  ownerId?: string | undefined
  /** Project context — required when category=LOGO and you want server-side scoping. */
  projectId?: string | undefined
  /** Visible only when accept differs from defaults. */
  accept?: string | undefined
  error?: string | undefined
  urlPlaceholder?: string | undefined
  /** Test id propagated to the root for E2E selectors. */
  testId?: string | undefined
  disabled?: boolean | undefined
}

const DEFAULT_ACCEPT = 'image/png,image/jpeg,image/webp'

export function ImageUploadField({
  value,
  onChange,
  category,
  ownerId,
  projectId,
  accept = DEFAULT_ACCEPT,
  error,
  urlPlaceholder = 'https://example.com/logo.svg',
  testId,
  disabled,
}: ImageUploadFieldProps) {
  // Mode follows the populated slot — when both null we default to the file
  // tab (the typical case) but persist the user's choice in local state so
  // toggling between tabs doesn't keep snapping back.
  const initialMode: 'file' | 'url' = value.externalUrl ? 'url' : 'file'
  const [mode, setMode] = useState<'file' | 'url'>(initialMode)
  const [urlDraft, setUrlDraft] = useState<string>(value.externalUrl ?? '')
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = useUploadDocument()

  // Keep urlDraft synced with parent when value.externalUrl changes externally
  // (e.g. form reset, async data load).
  useEffect(() => {
    setUrlDraft(value.externalUrl ?? '')
  }, [value.externalUrl])

  const handleFile = async (file: File) => {
    if (disabled) return
    // Mirror upload-document-dialog: validate size + MIME client-side BEFORE
    // wasting bandwidth on a doomed POST.
    if (!DOCUMENT_MIME_WHITELIST.includes(file.type as (typeof DOCUMENT_MIME_WHITELIST)[number])) {
      toast.error(`Тип ${file.type || 'unknown'} не поддерживается`)
      return
    }
    if (file.size > DOCUMENT_MAX_BYTES) {
      toast.error('Файл больше 10 МБ — выберите другой')
      return
    }
    try {
      setUploadProgress(0)
      const doc = await upload.mutateAsync({
        file,
        category,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        onProgress: (p) => setUploadProgress(p),
      })
      // Switching to documentId clears externalUrl per XOR contract.
      onChange({ documentId: doc.id, externalUrl: null })
      setUploadProgress(null)
    } catch {
      // The mutation hook already toasts the error message.
      setUploadProgress(null)
    }
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleFile(file)
    e.target.value = ''
  }

  const handleUrlBlur = () => {
    const trimmed = urlDraft.trim()
    if (trimmed === (value.externalUrl ?? '')) return
    if (trimmed === '') {
      onChange({ documentId: null, externalUrl: null })
      return
    }
    // Setting externalUrl clears documentId per XOR contract.
    onChange({ documentId: null, externalUrl: trimmed })
  }

  const handleClearAll = () => {
    onChange({ documentId: null, externalUrl: null })
    setUrlDraft('')
    if (fileRef.current) fileRef.current.value = ''
  }

  // Tab-switch handler — keep the *other* slot clear so the XOR invariant
  // can never be violated mid-edit (parent form state stays sane even if
  // the user toggles back-and-forth).
  const handleSwitchMode = (next: 'file' | 'url') => {
    if (next === mode) return
    setMode(next)
    if (next === 'file' && value.externalUrl !== null) {
      onChange({ documentId: value.documentId, externalUrl: null })
      setUrlDraft('')
    } else if (next === 'url' && value.documentId !== null) {
      onChange({ documentId: null, externalUrl: value.externalUrl })
    }
  }

  const hasValue = Boolean(value.documentId || value.externalUrl)
  const showPreview = mode === 'file' && value.documentId

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex rounded-lg border overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => handleSwitchMode('file')}
          className={cn(
            'flex-1 px-3 py-1.5 font-medium transition-colors flex items-center justify-center gap-1',
            mode === 'file' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
          aria-pressed={mode === 'file'}
          data-testid="image-upload-field-mode-file"
          disabled={disabled}
        >
          <Paperclip className="h-3 w-3" /> Файл
        </button>
        <button
          type="button"
          onClick={() => handleSwitchMode('url')}
          className={cn(
            'flex-1 px-3 py-1.5 font-medium transition-colors flex items-center justify-center gap-1',
            mode === 'url' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
          aria-pressed={mode === 'url'}
          data-testid="image-upload-field-mode-url"
          disabled={disabled}
        >
          <Link2 className="h-3 w-3" /> Ссылка
        </button>
      </div>

      {mode === 'url' ? (
        <div className="space-y-1">
          <Input
            type="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={urlPlaceholder}
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={handleUrlBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleUrlBlur()
              }
            }}
            disabled={disabled}
            data-testid="image-upload-field-url-input"
          />
          <p className="text-[11px] text-muted-foreground">
            Внешняя ссылка на картинку (https://…)
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={handleFileInputChange}
            disabled={disabled || upload.isPending}
            data-testid="image-upload-field-file-input"
          />
          {showPreview && value.documentId ? (
            <div className="relative w-full rounded-md border overflow-hidden bg-muted/30">
              <DocumentImage
                docId={value.documentId}
                alt="Загруженный файл"
                variant="thumbnail"
                className="max-h-32 w-full"
              />
              <button
                type="button"
                onClick={handleClearAll}
                className="absolute top-1 right-1 rounded-full bg-background/80 p-0.5 hover:bg-background border border-border"
                aria-label="Очистить изображение"
                data-testid="image-upload-field-clear"
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="w-full text-sm"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || upload.isPending}
              data-testid="image-upload-field-pick"
            >
              {upload.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Загрузка {uploadProgress ?? 0}%
                </>
              ) : (
                <>
                  <ImagePlus className="h-3.5 w-3.5 mr-1" />
                  Выбрать файл
                </>
              )}
            </Button>
          )}
          {!showPreview && (
            <p className="text-[11px] text-muted-foreground text-center">
              PNG, JPEG, WebP — до 10 МБ. Файл загружается в защищённое хранилище.
            </p>
          )}
        </div>
      )}

      {hasValue && (
        <button
          type="button"
          onClick={handleClearAll}
          className="text-[11px] text-muted-foreground hover:text-destructive"
          data-testid="image-upload-field-reset"
          disabled={disabled}
        >
          Очистить
        </button>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
