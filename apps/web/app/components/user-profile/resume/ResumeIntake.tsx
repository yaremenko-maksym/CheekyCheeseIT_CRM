/**
 * Resume intake — upload a PDF/DOCX or paste the text (task-resume-base §2/§3).
 *
 * Serves BOTH the empty state ("резюме ещё нет") and the "replace the source"
 * action on an existing resume, because they are literally the same two
 * choices; two components would drift apart.
 *
 * The paste-text branch is not a nice-to-have: when a PDF is a scan there is no
 * text layer at all, and without it the user would hit a dead end. The client
 * checks the extension only as a courtesy hint — the authoritative check is
 * server-side on the file's bytes.
 */
import { useRef, useState } from 'react'
import { FileUp, ClipboardType } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { RESUME_LIMITS, RESUME_SOURCE_MAX_BYTES } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { translateZodCode } from '@/lib/axios-utils'

interface ResumeIntakeProps {
  onUploadFile: (file: File) => void
  onSubmitText: (text: string) => void
  isBusy: boolean
  /** Compact rendering for the "replace source" panel above an existing resume. */
  variant?: 'empty' | 'compact'
}

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx']
const MAX_MB = Math.floor(RESUME_SOURCE_MAX_BYTES / 1024 / 1024)

export function ResumeIntake({
  onUploadFile,
  onSubmitText,
  isBusy,
  variant = 'empty',
}: ResumeIntakeProps) {
  const { t } = useLingui()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<'idle' | 'text'>('idle')
  const [text, setText] = useState('')

  function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset immediately so re-picking the SAME file fires `change` again.
    event.target.value = ''
    if (!file) return
    if (file.size > RESUME_SOURCE_MAX_BYTES) {
      toast.error(t`Файл більший за ${MAX_MB} МБ`)
      return
    }
    onUploadFile(file)
  }

  function submitText() {
    const trimmed = text.trim()
    if (trimmed.length < RESUME_LIMITS.minExtractableChars) {
      // task-i18n-stage3b-pr3 (Step 4, COPY-M-ppl-9): same catalog key the
      // SERVER-side check already uses (etap 4) — one text for two packages.
      toast.error(translateZodCode('RESUME_TEXT_TOO_SHORT'))
      return
    }
    onSubmitText(trimmed)
    setText('')
    setMode('idle')
  }

  return (
    <div
      className={
        variant === 'empty'
          ? 'rounded-lg border border-dashed bg-muted/30 px-4 py-10 text-center sm:px-6'
          : 'rounded-lg border bg-muted/20 p-4'
      }
      data-testid="resume-intake"
    >
      {variant === 'empty' && (
        <>
          <FileUp className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <h3 className="mt-3 text-base font-medium">
            <Trans>Резюме ще не заповнено</Trans>
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            <Trans>
              Завантажте резюме (PDF або DOCX) — ми один раз розкладемо його на розділи, а далі ви
              редагуєте їх тут. Якщо у файлі немає тексту, вставте текст вручну.
            </Trans>
          </p>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="sr-only"
        onChange={handleFileChosen}
        data-testid="resume-file-input"
        aria-label={t`Файл резюме`}
      />

      <div
        className={
          variant === 'empty'
            ? 'mt-5 flex flex-col items-stretch justify-center gap-2 sm:flex-row'
            : 'flex flex-col items-stretch gap-2 sm:flex-row'
        }
      >
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          data-testid="resume-upload-button"
          className="min-h-11"
        >
          <FileUp className="mr-2 h-4 w-4" aria-hidden />
          {variant === 'empty' ? <Trans>Завантажити файл</Trans> : <Trans>Замінити файл</Trans>}
        </Button>
        <Button
          variant="outline"
          onClick={() => setMode((m) => (m === 'text' ? 'idle' : 'text'))}
          disabled={isBusy}
          data-testid="resume-paste-toggle"
          className="min-h-11"
        >
          <ClipboardType className="mr-2 h-4 w-4" aria-hidden />
          <Trans>Вставити текстом</Trans>
        </Button>
      </div>

      {mode === 'text' && (
        <div className="mt-4 space-y-2 text-left">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t`Вставте сюди текст резюме цілком`}
            rows={10}
            data-testid="resume-text-input"
            aria-label={t`Текст резюме`}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => {
                setText('')
                setMode('idle')
              }}
              className="min-h-11"
            >
              <Trans>Скасувати</Trans>
            </Button>
            <Button
              onClick={submitText}
              disabled={isBusy}
              data-testid="resume-text-submit"
              className="min-h-11"
            >
              <Trans>Розпізнати текст</Trans>
            </Button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        <Trans>PDF або DOCX, до {MAX_MB} МБ. Файл бачите тільки ви і команда найму.</Trans>
      </p>
    </div>
  )
}
