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
import { FileImage, FileText, Link as LinkIcon, Paperclip, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UploadProgress } from '@/components/ui/upload-progress'
import { useDocumentDownloadUrl, useUploadDocument } from '@/hooks/use-documents'
import { useUploadProgressState } from '@/hooks/use-upload-progress-state'

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
  /**
   * task-receipts-frontend. When true the component shows ONLY the url-mode
   * (no tab-toggle, no «Файл» option) with an explorer-specific hint below
   * the input. Used for USDT-currency transactions, which require a
   * blockchain-explorer link (not a file). If `state.mode === 'file'` at the
   * moment this flips to true, the component auto-resets to an empty
   * url-mode state (see the effect below) — it never leaves an invalid
   * file-chosen state hidden behind a currency switch.
   */
  explorerOnly?: boolean
  /**
   * task-receipts-frontend. External validation error (e.g. a non-allowlist
   * domain) — renders a red ring on the url-input. The caller renders the
   * error TEXT itself (existing `fieldErrors.receipt` pattern); this prop
   * only drives the visual state of the input.
   */
  error?: string | undefined
}

export function ReceiptInput({
  state,
  onChange,
  label = 'Чек / подтверждение',
  explorerOnly = false,
  error,
}: ReceiptInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadMutation = useUploadDocument()
  const progress = useUploadProgressState()

  // task-receipts-frontend: when explorerOnly flips true while the user has
  // a file selected, auto-normalize to an empty url-mode state — a file
  // chosen under a non-USDT currency is never left silently attached once
  // the currency switches to USDT. Narrow trigger (only `explorerOnly`, not
  // the whole `state`) mirrors the existing resolvedUrl effect above.
  useEffect(() => {
    if (explorerOnly && state.mode === 'file') {
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
    // Trigger by explorerOnly only (pattern mirrors the resolvedUrl effect below —
    // `state`/`onChange` are read but intentionally not in the dep array).
  }, [explorerOnly])

  // For existing receipt docs (edit flow), fetch the presigned URL so we
  // can show the preview. Enabled only when we have a documentId but no
  // local previewUrl (i.e. not freshly uploaded — uploadResult already
  // populated the preview).
  const downloadQuery = useDocumentDownloadUrl(state.documentId ?? undefined, {
    enabled: !!state.documentId && !state.previewUrl && state.mode === 'file',
  })

  // Once the presigned URL resolves for an existing receipt, materialize
  // it into state.previewUrl so the parent can render a thumbnail. We
  // intentionally key the effect only on downloadQuery.data?.url +
  // documentId — including the full `state` would loop because onChange
  // returns a new state object each render. `onChange` and the rest of
  // `state` are read but not part of the trigger set.
  const resolvedUrl = downloadQuery.data?.url
  useEffect(() => {
    if (resolvedUrl && state.documentId && !state.previewUrl) {
      onChange({ ...state, previewUrl: resolvedUrl })
    }
  }, [resolvedUrl, state.documentId])

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

    progress.prepare()
    try {
      const doc = await uploadMutation.mutateAsync({
        file,
        category: 'RECEIPT',
        onProgress: progress.onProgress,
      })
      progress.success()
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
    } catch (err) {
      // useUploadDocument shows a toast; revert to empty so the user can
      // retry (there's no file left to retry IN PLACE — the picker resets —
      // so no `onRetry` is wired into the progress display; the 'error'
      // phase itself stays visible in the (now-empty) picker button below
      // until the user picks a new file, which calls `progress.prepare()`
      // and clears it — matching AC3 without a dangling retry action).
      progress.error(err instanceof Error ? err.message : 'Не удалось загрузить чек')
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

      {/* Tab toggle — sliding pill. Hidden entirely in explorerOnly mode: a
          single remaining tab in a 2-way toggle reads as broken, so the
          whole toggle disappears and only the url-input below renders. */}
      {!explorerOnly && (
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
              data-testid={`receipt-input-mode-${mode}`}
              className={cn(
                'relative flex-1 flex items-center justify-center gap-1.5 z-10 transition-colors duration-150',
                state.mode === mode
                  ? 'text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground',
                uploading && 'opacity-50 cursor-not-allowed',
              )}
            >
              {mode === 'file' ? (
                <Paperclip className="h-3 w-3" />
              ) : (
                <LinkIcon className="h-3 w-3" />
              )}
              {mode === 'file' ? 'Файл' : 'Ссылка'}
            </button>
          ))}
        </div>
      )}

      {/* File mode */}
      {!explorerOnly && state.mode === 'file' && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              void handleFileChange(e)
            }}
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
                    <div className="text-sm font-medium truncate">
                      {state.fileName || 'Документ'}
                    </div>
                    <div className="text-xs text-muted-foreground">PDF документ</div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 px-3 py-3">
                  <FileImage className="h-8 w-8 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {state.fileName || 'Документ'}
                    </div>
                    <div className="text-xs text-muted-foreground">Файл загружен</div>
                  </div>
                </div>
              )}
              {uploading && (
                <div className="absolute inset-0 bg-background/70 flex items-center justify-center">
                  <UploadProgress
                    state={progress.state}
                    size="sm"
                    testId="receipt-input-progress"
                  />
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
              {progress.state.phase === 'idle' ? (
                <div className="flex gap-2">
                  <FileImage className="h-5 w-5 opacity-60" />
                  <FileText className="h-5 w-5 opacity-60" />
                </div>
              ) : (
                <UploadProgress
                  state={progress.state}
                  size="sm"
                  testId="receipt-input-progress-idle"
                />
              )}
              {progress.state.phase === 'idle' && (
                <div className="text-center">
                  <div className="text-xs font-medium text-foreground/70">
                    Нажмите для выбора файла
                  </div>
                  <div className="text-[10px] mt-0.5">JPG, PNG, PDF — до 10 МБ</div>
                </div>
              )}
            </button>
          )}
        </div>
      )}

      {/* URL mode — also the ONLY mode rendered when explorerOnly is set,
          regardless of state.mode (the effect above normalizes state.mode to
          'url' as soon as explorerOnly flips true, but we don't gate the
          render on that timing — explorerOnly alone is enough to show it). */}
      {(explorerOnly || state.mode === 'url') && (
        <div>
          <Input
            type="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={state.externalUrl}
            onChange={(e) => onChange({ ...state, mode: 'url', externalUrl: e.target.value })}
            placeholder={explorerOnly ? 'https://etherscan.io/tx/0x...' : 'https://...'}
            className={cn('h-9 text-sm', error && 'border-destructive ring-1 ring-destructive/40')}
            data-testid="receipt-input-url-field"
          />
          {explorerOnly && (
            <p
              className="text-[11px] text-muted-foreground mt-1"
              data-testid="receipt-input-explorer-hint"
            >
              Ссылка на blockchain-explorer (etherscan.io, tronscan.org, bscscan.com и др.)
            </p>
          )}
        </div>
      )}
    </div>
  )
}
