import { useId, useRef, useState, type MouseEvent } from 'react'
import { FileText, Upload, X } from 'lucide-react'
import { cn, focusRing } from '@/lib/utils'
import { formatFileSize, validateResumeFile } from '@/lib/validate-resume'

/**
 * Drag & drop CV picker (landing-redesign.md §2.4 `CvDropzone`,
 * Vacancy.dc.html `.cc-drop`). The visually-hidden native `<input
 * type=file>` wrapped by a `<label>` is already a11y-correct in the source
 * export (keyboard-focusable via the input, click-through via the label) —
 * ported 1:1.
 */
interface CvDropzoneProps {
  file: File | null
  onFileChange: (file: File | null) => void
  error: string | null
  onErrorChange: (error: string | null) => void
}

export function CvDropzone({ file, onFileChange, error, onErrorChange }: CvDropzoneProps) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const errorId = useId()

  const setFile = (candidate: File) => {
    const validationError = validateResumeFile(candidate)
    if (validationError) {
      onErrorChange(validationError)
      return
    }
    onErrorChange(null)
    onFileChange(candidate)
  }

  const clearFile = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onFileChange(null)
    onErrorChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <label className="mb-2 block text-[0.9rem] font-medium text-foreground/88" htmlFor={inputId}>
        CV / Resume
        <span aria-hidden="true" className="ml-0.5 text-primary">
          *
        </span>
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="application/pdf"
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="absolute h-px w-px overflow-hidden opacity-0"
        onChange={(e) => {
          const picked = e.target.files?.[0]
          if (picked) setFile(picked)
        }}
      />
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const dropped = e.dataTransfer.files?.[0]
          if (dropped) setFile(dropped)
        }}
        className={cn(
          'block cursor-pointer rounded-xl border-[1.5px] border-dashed border-border bg-[color-mix(in_oklch,var(--card)_50%,transparent)] p-[26px] text-center transition-colors duration-200',
          dragging && 'border-primary bg-primary/8',
          file && 'border-solid border-[color-mix(in_oklch,var(--primary)_45%,transparent)]',
          focusRing,
        )}
      >
        {!file ? (
          <div>
            <Upload aria-hidden="true" className="mx-auto mb-2.5 size-[26px] text-primary" />
            <div className="mb-1 text-[0.94rem] font-medium text-foreground">
              Drop your CV here, or <span className="text-primary">browse</span>
            </div>
            <div className="m-0 text-[0.8rem] text-muted-foreground">PDF only · up to 5 MB</div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-left">
            <span className="flex size-10 flex-none items-center justify-center rounded-[9px] bg-primary/14 text-primary">
              <FileText aria-hidden="true" className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.92rem] font-medium text-foreground">{file.name}</div>
              <div className="m-0 text-[0.8rem] text-muted-foreground">
                {formatFileSize(file.size)}
              </div>
            </div>
            <button
              type="button"
              onClick={clearFile}
              aria-label="Remove file"
              className={cn('flex-none rounded p-1.5 text-muted-foreground', focusRing)}
            >
              <X aria-hidden="true" className="size-[18px]" />
            </button>
          </div>
        )}
      </label>
      {error && (
        <div id={errorId} className="mt-1.5 text-[0.8rem] text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}
