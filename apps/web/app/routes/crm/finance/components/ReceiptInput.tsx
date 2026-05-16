import { useRef } from 'react'
import { motion } from 'framer-motion'
import { FileImage, FileText, Link, Paperclip, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type ReceiptMode = 'file' | 'url'

export interface ReceiptState {
  mode: ReceiptMode
  url: string
  fileName: string
  previewUrl: string | null
  mimeType: string
}

export function emptyReceiptState(): ReceiptState {
  return { mode: 'file', url: '', fileName: '', previewUrl: null, mimeType: '' }
}

export function receiptStateFromUrl(url: string | null): ReceiptState {
  if (!url) return emptyReceiptState()
  return { mode: 'url', url, fileName: '', previewUrl: null, mimeType: '' }
}

interface ReceiptInputProps {
  state: ReceiptState
  onChange: (next: ReceiptState) => void
  label?: string
}

export function ReceiptInput({ state, onChange, label = 'Чек / подтверждение' }: ReceiptInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function switchToFile() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
    onChange({ mode: 'file', url: '', fileName: '', previewUrl: null, mimeType: '' })
  }

  function switchToUrl() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
    onChange({ mode: 'url', url: '', fileName: '', previewUrl: null, mimeType: '' })
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const objUrl = URL.createObjectURL(file)
    onChange({ mode: 'file', url: objUrl, fileName: file.name, previewUrl: objUrl, mimeType: file.type })
    e.target.value = ''
  }

  function clearFile() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
    onChange({ mode: 'file', url: '', fileName: '', previewUrl: null, mimeType: '' })
  }

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
            className={cn(
              'relative flex-1 flex items-center justify-center gap-1.5 z-10 transition-colors duration-150',
              state.mode === mode ? 'text-primary font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {mode === 'file' ? <Paperclip className="h-3 w-3" /> : <Link className="h-3 w-3" />}
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
            onChange={handleFileChange}
          />
          {state.previewUrl ? (
            <div className="relative rounded-lg border border-border overflow-hidden bg-muted/20">
              {state.mimeType.startsWith('image/') ? (
                <img
                  src={state.previewUrl}
                  alt="Receipt preview"
                  className="w-full max-h-40 object-contain"
                />
              ) : (
                <div className="flex items-center gap-3 px-3 py-3">
                  <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{state.fileName}</div>
                    <div className="text-xs text-muted-foreground">PDF документ</div>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={clearFile}
                className="absolute top-1.5 right-1.5 rounded-full bg-background/80 border border-border p-0.5 text-muted-foreground hover:text-foreground transition-colors"
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
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-lg border border-dashed border-border px-4 py-5 flex flex-col items-center gap-2 text-muted-foreground hover:border-primary/40 hover:bg-primary/3 transition-colors"
            >
              <div className="flex gap-2">
                <FileImage className="h-5 w-5 opacity-60" />
                <FileText className="h-5 w-5 opacity-60" />
              </div>
              <div className="text-center">
                <div className="text-xs font-medium text-foreground/70">Нажмите для выбора файла</div>
                <div className="text-[10px] mt-0.5">JPG, PNG, PDF — до 10 МБ</div>
              </div>
            </button>
          )}
          <p className="text-[10px] text-muted-foreground/50 mt-1">
            Загрузка в S3 — Phase 6. Файл сохраняется локально на сессию.
          </p>
        </div>
      )}

      {/* URL mode */}
      {state.mode === 'url' && (
        <Input
          value={state.url}
          onChange={(e) => onChange({ ...state, url: e.target.value })}
          placeholder="https://..."
          className="h-9 text-sm"
        />
      )}
    </div>
  )
}
