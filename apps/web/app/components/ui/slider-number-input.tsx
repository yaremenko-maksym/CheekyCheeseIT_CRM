import { cn } from '@/lib/utils'

export interface SliderNumberInputProps {
  value: number
  onChange: (value: number) => void
  onBlur?: () => void
  min?: number
  max?: number
  step?: number
  /** Suffix label rendered next to the number input — e.g. "%". */
  suffix?: string
  /** When true, marks the number input border red (validation error). */
  error?: boolean
  className?: string
  /** Optional aria-label on the range input — useful for tests/screenreaders. */
  ariaLabel?: string
  disabled?: boolean
}

/**
 * Generic "slider + number input" pair for picking a number in a small range
 * (0–100, 1–10, etc.). The slider drives the number and vice versa; values
 * are clamped to [min, max].
 *
 * Used by ChangeSalaryDialog (% share) and other places that need a compact
 * numeric picker with visual feedback.
 */
export function SliderNumberInput({
  value,
  onChange,
  onBlur,
  min = 0,
  max = 100,
  step = 1,
  suffix,
  error,
  className,
  ariaLabel,
  disabled,
}: SliderNumberInputProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        onBlur={onBlur}
        disabled={disabled}
        aria-label={ariaLabel}
        className="flex-1 h-2 accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const raw = Number(e.target.value)
          if (Number.isNaN(raw)) return
          onChange(clamp(raw))
        }}
        onBlur={onBlur}
        disabled={disabled}
        className={cn(
          'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-destructive',
        )}
      />
      {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
    </div>
  )
}
