/**
 * ReceiptInput — receipt attachment for finance transactions (PHASE 6).
 *
 * Backed by the documents API (category=RECEIPT). Two mutually exclusive
 * modes (mirrors the DB-level XOR check on `transactions`):
 *   - 'file' — uploads the file via `useUploadDocument`. On success the
 *     parent receives `{ documentId, fileName, mimeType, previewUrl }`.
 *     `previewUrl` is the document download URL (presigned, 4h staleTime)
 *     so the dialog can render an inline thumbnail before submit.
 *   - 'url' — free-form external URL (etherscan, screenshot link). No
 *     upload; the parent stores it as `receiptExternalUrl`.
 *
 * Existing receipt loading:
 *   - `receiptStateFromDocument(docId)` — for edit dialogs whose tx has
 *     an uploaded receipt; the component fetches the presigned URL on
 *     mount via the same `useDocumentDownloadUrl` cache as DocumentImage.
 *   - `receiptStateFromExternalUrl(url)` — for edit dialogs with an
 *     external-URL receipt.
 */
import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { FileImage, FileText, Link as LinkIcon, Loader2, Paperclip, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useDocumentDownloadUrl,
  useUploadDocument,
} from '@/hooks/use-documents'

export type ReceiptMode = 'file' | 'url'

/**
 * Receipt state — XOR between document upload and external URL.
 *
 * Exactly one of `documentId` / `externalUrl` is populated at any time
 * (or both empty for "no receipt"). `previewUrl` is a UX-only cache of
 * the rendered preview source — for file mode it's a presigned S3 URL,
 * for url mode it mirrors `externalUrl`.
 */
export interface ReceiptState {
  mode: ReceiptMode
  documentId: string | null
  externalUrl: string
  fileName: string
  previewUrl: string | null
  mimeType: string
}

export function emptyReceiptState(): ReceiptState {
  return {
    mode: 'file',
    documentId: null,
    externalUrl: '',
    fileName: '',
    previewUrl: null,
    mimeType: '',
  }
}

/** Build initial state for an edit dialog whose tx has an external-URL receipt. */
export function receiptStateFromExternalUrl(url: string | null): ReceiptState {
  if (!url) return emptyReceiptState()
  return {
    mode: 'url',
    documentId: null,
    externalUrl: url,
    fileName: '',
    previewUrl: null,
    mimeType: '',
  }
}

/** Build initial state for an edit dialog whose tx has an uploaded-document receipt. */
export function receiptStateFromDocument(documentId: string | null): ReceiptState {
  if (!documentId) return emptyReceiptState()
  return {
    mode: 'file',
    documentId,
    externalUrl: '',
    fileName: '',
    previewUrl: null,
    mimeType: '',
  }
}

interface ReceiptInputProps {
  state: ReceiptState
  onChange: (next: ReceiptState) => void
  label?: string
  /**
   * For uploads on behalf of someone else (currently unused — receipts
   * are always owned by the current user; the field is here for future
   * ADMIN-uploads-on-behalf flows).
   */
  ownerId?: string
}

export function ReceiptInput({ state, onChange, label = 'Чек / подтверждение' }: ReceiptInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadMutation = useUploadDocument()

  // For existing receipt docs (edit flow), fetch the presigned URL so we
  // can show the preview. Enabled only when we have a documentId but no
  // local previewUrl (i.e. not freshly uploaded — uploadResult already
  // populated the preview).
  const downloadQuery = useDocumentDownloadUrl(
    state.documentId ?? undefined,
    { enabled: !!state.documentId && !state.previewUrl && state.mode === 'file' },
  )

  // Once the presigned URL resolves for an existing receipt, materialize
  // it into state.previewUrl so the parent can render a thumbnail.
  useEffect(() => {
    if (downloadQuery.data?.url && state.documentId && !state.previewUrl) {
      onChange({ ...state, previewUrl: downloadQuery.data.url })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadQuery.data?.url])

  function switchToFile() {
    if (state.previewUrl && state.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(state.previewUrl)
    }
    onChange(emptyReceiptState())
  }

  function switchToUrl() {
    if (state.previewUrl && state.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(state.previewUrl)
    }
    onChange({
      mode: 'url',
      documentId: null,
      externalUrl: '',
      fileName: '',
      previewUrl: null,
      mimeType: '',
    })
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return

    // Local objectURL for instant preview while the upload is in flight.
    const localPreview = URL.createObjectURL(file)
    onChange({
      mode: 'file',
      documentId: null,
      externalUrl: '',
      fileName: file.name,
      previewUrl: localPreview,
      mimeType: file.type,
    })

    try {
      const doc = await uploadMutation.mutateAsync({
        file,
        category: 'RECEIPT',
      })
      // Revoke the local blob — we'll use the presigned URL going forward
      // (downloadQuery is enabled for state.documentId on next render).
      URL.revokeObjectURL(localPreview)
      onChange({
        mode: 'file',
        documentId: doc.id,
        externalUrl: '',
        fileName: doc.originalName ?? doc.name,
        previewUrl: null, // will be populated via downloadQuery → useEffect
        mimeType: doc.mimeType,
      })
    } catch {
      // useUploadDocument shows a toast; revert to empty so the user can retry.
      URL.revokeObjectURL(localPreview)
      onChange(emptyReceiptState())
    }
  }

  function clearFile() {
    if (state.previewUrl && state.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(state.previewUrl)
    }
    onChange(emptyReceiptState())
  }

  const uploading = uploadMutation.isPending
  const hasFile = state.mode === 'file' && (state.documentId || state.previewUrl)

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>

      {/* Tab toggle — sliding pill */}
      <div className="relative flex rounded-md border border-border bg-muted/20 text-xs h-8 p-0.5 overflow-hidden">
        {/* Pill: always 50% wide, slides via x transform — no size glitch */}
        <motion.div
          className="absolute top-0.5 bottom-0.5 w-[calc(50%-1px)] rounded-[5px] bg-primary/15 border border-primary/30 pointer-events-none"
          animate={{ x: state.mode === 'file' ? 0 : '100%' }}
          transition={{ type: 'spring', stiffness: 500, damping: 40, mass: 0.8 }}
        />
        {(['file', 'url'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={mode === 'file' ? switchToFile : switchToUrl}
            disabled={uploading}
            className={cn(
              'relative flex-1 flex items-center justify-center gap-1.5 z-10 transition-colors duration-150',
              state.mode === mode ? 'text-primary font-medium' : 'text-muted-foreground hover:text-foreground',
              uploading && 'opacity-50 cursor-not-allowed',
            )}
          >
            {mode === 'file' ? <Paperclip className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
            {mode === 'file' ? 'Файл' : 'Ссылка'}
          </button>
        ))}
      </div>

      {/* File mode */}
      {state.mode === 'file' && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => { void handleFileChange(e) }}
          />
          {hasFile ? (
            <div className="relative rounded-lg border border-border overflow-hidden bg-muted/20">
              {state.mimeType.startsWith('image/') && state.previewUrl ? (
                <img
                  src={state.previewUrl}
                  alt="Превью чека"
                  className="w-full max-h-40 object-contain"
                />
              ) : state.mimeType === 'application/pdf' ? (
                <div className="flex items-center gap-3 px-3 py-3">
                  <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{state.fileName || 'Документ'}</div>
                    <div className="text-xs text-muted-foreground">PDF документ</div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 px-3 py-3">
                  <FileImage className="h-8 w-8 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{state.fileName || 'Документ'}</div>
                    <div className="text-xs text-muted-foreground">Файл загружен</div>
                  </div>
                </div>
              )}
              {uploading && (
                <div className="absolute inset-0 bg-background/70 flex items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              )}
              {!uploading && (
                <>
                  <button
                    type="button"
                    onClick={clearFile}
                    className="absolute top-1.5 right-1.5 rounded-full bg-background/80 border border-border p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Удалить файл"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute bottom-1.5 right-1.5 rounded-md bg-background/80 border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Заменить
                  </button>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className={cn(
                'w-full rounded-lg border border-dashed border-border px-4 py-5 flex flex-col items-center gap-2 text-muted-foreground hover:border-primary/40 hover:bg-primary/3 transition-colors',
                uploading && 'opacity-50 cursor-not-allowed',
              )}
            >
              {uploading ? (
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              ) : (
                <div className="flex gap-2">
                  <FileImage className="h-5 w-5 opacity-60" />
                  <FileText className="h-5 w-5 opacity-60" />
                </div>
              )}
              <div className="text-center">
                <div className="text-xs font-medium text-foreground/70">
                  {uploading ? 'Загрузка...' : 'Нажмите для выбора файла'}
                </div>
                <div className="text-[10px] mt-0.5">JPG, PNG, PDF — до 10 МБ</div>
              </div>
            </button>
          )}
        </div>
      )}

      {/* URL mode */}
      {state.mode === 'url' && (
        <Input
          value={state.externalUrl}
          onChange={(e) => onChange({ ...state, externalUrl: e.target.value })}
          placeholder="https://..."
          className="h-9 text-sm"
        />
      )}
    </div>
  )
}
