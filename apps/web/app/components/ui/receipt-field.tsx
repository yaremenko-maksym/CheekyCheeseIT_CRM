import { useState, useRef } from 'react'
import { ClipboardPaste, FileText, Link2, Paperclip, X } from 'lucide-react'
import { Button } from './button'
import { Input } from './input'
import { cn } from '@/lib/utils'

interface ReceiptFieldProps {
  value: string
  onChange: (v: string) => void
  error?: string | undefined
  accept?: string
  urlPlaceholder?: string
  urlHint?: string
  fileHint?: string
}

function FilePreview({ value, onClear }: { value: string; onClear: () => void }) {
  const isPdf = value.startsWith('data:application/pdf')
  const isImage = value.startsWith('data:image/')

  return (
    <div className="w-full rounded-md border overflow-hidden">
      {isImage && (
        <div className="relative bg-muted/30">
          <img
            src={value}
            alt="Preview"
            className="max-h-32 w-full object-contain"
          />
          <button
            type="button"
            onClick={onClear}
            className="absolute top-1 right-1 rounded-full bg-background/80 p-0.5 hover:bg-background border border-border"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {isPdf && (
        <div className="flex items-center gap-2 px-3 py-2">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="truncate text-xs text-muted-foreground flex-1">PDF загружен</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={onClear}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {!isImage && !isPdf && (
        <div className="flex items-center gap-2 px-3 py-2">
          <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate text-xs text-muted-foreground flex-1">Файл загружен</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={onClear}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

export function ReceiptField({ value, onChange, error, accept = 'image/*,application/pdf', urlPlaceholder = 'https://drive.google.com/...', urlHint = 'Скопируйте ссылку на чек и вставьте в это поле или нажмите кнопку вставить', fileHint = 'PNG, JPG, PDF — файл хранится локально в записи' }: ReceiptFieldProps) {
  const [mode, setMode] = useState<'url' | 'file'>(
    value?.startsWith('http') ? 'url' : 'file',
  )
  const [urlDraft, setUrlDraft] = useState(value.startsWith('http') ? value : '')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => onChange(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleUrlChange = (raw: string) => {
    setUrlDraft(raw)
    onChange(raw)
  }

  const handlePaste = async () => {
    const text = await navigator.clipboard.readText()
    setUrlDraft(text)
    onChange(text)
  }

  const handleClear = () => {
    onChange('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const isDataUrl = value?.startsWith('data:')

  return (
    <div className="space-y-1.5">
      <div className="flex rounded-lg border overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setMode('file')}
          className={cn(
            'flex-1 px-3 py-1.5 font-medium transition-colors flex items-center justify-center gap-1',
            mode === 'file' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
        >
          <Paperclip className="h-3 w-3" /> Файл
        </button>
        <button
          type="button"
          onClick={() => setMode('url')}
          className={cn(
            'flex-1 px-3 py-1.5 font-medium transition-colors flex items-center justify-center gap-1',
            mode === 'url' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
        >
          <Link2 className="h-3 w-3" /> Ссылка
        </button>
      </div>

      {mode === 'url' ? (
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input
              placeholder={urlPlaceholder}
              value={urlDraft}
              onChange={(e) => handleUrlChange(e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handlePaste}
              title="Вставить из буфера"
            >
              <ClipboardPaste className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {urlHint}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={handleFile}
          />
          {isDataUrl ? (
            <FilePreview value={value} onClear={handleClear} />
          ) : (
            <Button
              type="button"
              variant="outline"
              className="w-full text-sm"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip className="h-3.5 w-3.5 mr-1" /> Выбрать файл
            </Button>
          )}
          {!isDataUrl && (
            <p className="text-[11px] text-muted-foreground text-center">
              {fileHint}
            </p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
