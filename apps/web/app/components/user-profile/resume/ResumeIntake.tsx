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
import { FileUp, ClipboardType, PencilLine } from 'lucide-react'
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
  /** Empty state only: open the empty facts form instead of uploading. */
  onFillManually?: () => void
  /** Focus "Заповнити вручну" on mount: the user came back here from the manual form. */
  focusFillManually?: boolean
}

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx']
const MAX_MB = Math.floor(RESUME_SOURCE_MAX_BYTES / 1024 / 1024)

export function ResumeIntake({
  onUploadFile,
  onSubmitText,
  isBusy,
  variant = 'empty',
  onFillManually,
  focusFillManually = false,
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

  const uploadButtons = (
    <>
      <Button
        variant={variant === 'empty' ? 'outline' : 'default'}
        onClick={() => fileInputRef.current?.click()}
        disabled={isBusy}
        data-testid="resume-upload-button"
        className={
          variant === 'empty' ? 'h-11 whitespace-nowrap' : 'h-auto min-h-11 whitespace-normal'
        }
      >
        <FileUp className="mr-2 h-4 w-4 shrink-0" aria-hidden />
        {variant === 'empty' ? (
          <Trans>Завантажити, щоб заповнити</Trans>
        ) : (
          <Trans>Замінити файл</Trans>
        )}
      </Button>
      <Button
        variant={variant === 'empty' ? 'ghost' : 'outline'}
        onClick={() => setMode((m) => (m === 'text' ? 'idle' : 'text'))}
        disabled={isBusy}
        data-testid="resume-paste-toggle"
        className="h-auto min-h-11 whitespace-normal"
      >
        <ClipboardType className="mr-2 h-4 w-4" aria-hidden />
        <Trans>Вставити текстом</Trans>
      </Button>
    </>
  )

  return (
    <div
      className={
        variant === 'empty'
          ? 'max-w-[720px] rounded-lg border bg-card px-4 py-6 sm:p-6'
          : 'rounded-lg border bg-muted/20 p-4'
      }
      data-testid="resume-intake"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="sr-only"
        tabIndex={-1}
        onChange={handleFileChosen}
        data-testid="resume-file-input"
        aria-label={t`Файл резюме`}
      />

      {variant === 'empty' ? (
        <>
          <h3 className="text-base font-semibold">
            <Trans>Резюме ще не заповнено</Trans>
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans>
              Заповніть факти вручну або завантажте резюме — ми заповнимо з нього поля, а ви
              переглянете.
            </Trans>
          </p>
          {/* minmax(0,1fr): a long button label wraps instead of widening the tile past 320 px (QA-2). */}
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            {onFillManually && (
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div
                  className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                  aria-hidden
                >
                  <PencilLine className="size-4" />
                </div>
                <h4 className="font-semibold text-foreground">
                  <Trans>Заповнити вручну</Trans>
                </h4>
                <p className="text-sm text-muted-foreground">
                  <Trans>Порожня форма фактів. Перевірка запускається, коли все заповнено.</Trans>
                </p>
                <Button
                  onClick={onFillManually}
                  autoFocus={focusFillManually}
                  disabled={isBusy}
                  data-testid="resume-fill-manually"
                  className="mt-auto h-11 whitespace-nowrap"
                >
                  <Trans>Заповнити вручну</Trans>
                </Button>
              </div>
            )}
            <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div
                className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                aria-hidden
              >
                <FileUp className="size-4" />
              </div>
              <h4 className="font-semibold text-foreground">
                <Trans>Завантажити, щоб заповнити</Trans>
              </h4>
              <p className="text-sm text-muted-foreground">
                <Trans>PDF або DOCX, до {MAX_MB} МБ. Файл бачите тільки ви і команда найму.</Trans>
              </p>
              <div className="mt-auto flex flex-col gap-2">{uploadButtons}</div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-stretch gap-2 sm:flex-row">{uploadButtons}</div>
      )}

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
        {variant === 'empty' ? (
          <Trans>
            Завантаження лише заповнює поля. Статус «Перевірено» резюме отримає після перевірки й
            підтвердження HR.
          </Trans>
        ) : (
          <Trans>PDF або DOCX, до {MAX_MB} МБ. Файл бачите тільки ви і команда найму.</Trans>
        )}
      </p>
    </div>
  )
}
