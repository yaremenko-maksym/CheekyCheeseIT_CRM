/**
 * <UploadProgress> — the ONE shared upload-status display for every file
 * upload entry point in the CRM (task-upload-freeze-and-progress.md AC2):
 * `image-upload-field.tsx`, `AvatarUploadDialog.tsx`,
 * `upload-document-dialog.tsx`, `ReceiptInput.tsx`. Before this component
 * existed, `upload-document-dialog.tsx` was the only place with a real
 * progress bar (correct a11y markup — `role="progressbar"` +
 * `aria-valuenow`/`min`/`max`, preserved below verbatim) and everywhere
 * else just showed a bare spinner ("Загрузка…") with no percent and no
 * distinction between "still sending bytes" and "server is still
 * processing what we already sent".
 *
 * Renders 5 distinguishable phases (AC3) — never claims "done" at 100% of
 * the upload, because 100% only means "the browser finished handing bytes
 * to the OS socket", not "the server finished writing the S3 object"
 * (sharp/pdf-lib compression + the S3 PUT both happen AFTER that):
 *   - preparing   — client-side work before any byte has left the browser
 *                   (crop/read/validate). Indeterminate.
 *   - uploading   — bytes actually in flight. Determinate, shows `percent`.
 *   - processing  — 100% sent, waiting on the server response. Indeterminate.
 *   - success     — server confirmed. Brief, callers usually reset/close
 *                   right after.
 *   - error       — failed at any stage; `onRetry` renders a real, focusable
 *                   Retry button (keyboard-operable — Tab + Enter/Space).
 *
 * Pair with `useUploadProgressState` (`@/hooks/use-upload-progress-state`)
 * — that hook is what actually fixes the root cause found while measuring
 * this task (see PR body): axios's `onUploadProgress` fires once per XHR
 * progress EVENT, each its own macrotask that React does NOT auto-batch,
 * so an unthrottled `setState` in the callback re-renders once per tick.
 * On a slow connection that's dozens of separate commits over the
 * transfer — no single one crosses the 50ms Long Task threshold, but
 * collectively they saturate the main thread's task queue and degrade
 * input responsiveness for the rest of the page. The hook coalesces ticks
 * to at most one commit per animation frame; this component just renders
 * whatever phase/percent it's handed.
 */
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export type UploadPhase = 'idle' | 'preparing' | 'uploading' | 'processing' | 'success' | 'error'

export interface UploadProgressState {
  phase: UploadPhase
  /** 0-100 integer — meaningful only while `phase === 'uploading'`. */
  percent?: number
  /** User-facing message — meaningful only while `phase === 'error'`. */
  error?: string
}

export interface UploadProgressProps {
  state: UploadProgressState
  /** Renders a focusable "Повторить" button when the phase is 'error'. */
  onRetry?: () => void
  /**
   * `sm` — compact icon + one-line label, for inline spots that used to be
   * a bare spinner inside a button (image-upload-field's picker button,
   * ReceiptInput's dropzone overlay). `default` — full block with a bar,
   * for dedicated space under a dropzone (upload-document-dialog).
   */
  size?: 'sm' | 'default'
  className?: string
  /** Override the default Russian label for the current phase. */
  label?: string
  testId?: string
}

const DEFAULT_LABELS: Record<Exclude<UploadPhase, 'idle'>, string> = {
  preparing: 'Подготовка файла…',
  uploading: 'Загрузка',
  processing: 'Обработка…',
  success: 'Готово',
  error: 'Не удалось загрузить файл',
}

function phaseLabel(state: UploadProgressState, override: string | undefined): string {
  if (state.phase === 'idle') return ''
  if (state.phase === 'error') return override ?? state.error ?? DEFAULT_LABELS.error
  if (state.phase === 'uploading')
    return `${override ?? DEFAULT_LABELS.uploading} ${state.percent ?? 0}%`
  return override ?? DEFAULT_LABELS[state.phase]
}

function PhaseIcon({ phase, className }: { phase: UploadPhase; className?: string }) {
  if (phase === 'error')
    return <AlertCircle className={cn('text-destructive', className)} aria-hidden />
  if (phase === 'success')
    return <CheckCircle2 className={cn('text-green-400', className)} aria-hidden />
  return <Loader2 className={cn('animate-spin', className)} aria-hidden />
}

export function UploadProgress({
  state,
  onRetry,
  size = 'default',
  className,
  label,
  testId,
}: UploadProgressProps) {
  const { phase } = state
  if (phase === 'idle') return null

  const isDeterminate = phase === 'uploading'
  const progressBarProps = isDeterminate
    ? { 'aria-valuenow': state.percent ?? 0 }
    : { 'aria-valuetext': phaseLabel(state, label) }

  if (size === 'sm') {
    return (
      <span
        className={cn('inline-flex items-center gap-1.5 tabular-nums', className)}
        role={phase === 'error' ? 'alert' : 'progressbar'}
        aria-live="polite"
        aria-valuemin={0}
        aria-valuemax={100}
        data-testid={testId}
        {...(phase === 'error' ? {} : progressBarProps)}
      >
        <PhaseIcon phase={phase} className="h-3.5 w-3.5 shrink-0" />
        <span>{phaseLabel(state, label)}</span>
      </span>
    )
  }

  return (
    <div className={cn('space-y-1.5', className)} data-testid={testId}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <PhaseIcon phase={phase} className="h-3.5 w-3.5 shrink-0" />
          <span>
            {phase === 'uploading' ? (label ?? DEFAULT_LABELS.uploading) : phaseLabel(state, label)}
          </span>
        </span>
        {phase === 'uploading' && <span className="tabular-nums">{state.percent ?? 0}%</span>}
      </div>

      {phase !== 'error' && phase !== 'success' && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full bg-primary transition-[width] duration-150',
              !isDeterminate && 'w-1/3 animate-pulse',
            )}
            style={isDeterminate ? { width: `${state.percent ?? 0}%` } : undefined}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            {...progressBarProps}
          />
        </div>
      )}

      {phase === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5"
        >
          <p className="text-xs text-destructive">{state.error ?? DEFAULT_LABELS.error}</p>
          {onRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="h-6 shrink-0 gap-1 px-2 text-xs"
              data-testid={testId ? `${testId}-retry` : 'upload-progress-retry'}
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Повторить
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
