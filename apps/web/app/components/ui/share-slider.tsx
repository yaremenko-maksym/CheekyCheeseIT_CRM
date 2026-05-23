import { cn } from '@/lib/utils'

/**
 * Share split visualization. `value` represents the SENIOR's share —
 * the % the senior keeps (default 26%). The remaining (100 - value)
 * is the company's share. The visual order is:
 *
 *   [ company % ] [ senior % ]
 *
 * matching the natural reading order "company pays senior X%".
 *
 * Field labels in the parent form follow the same convention — "Доля
 * синьора (%)" describes what `value` controls. The number badge inside
 * each bar is suffixed with the role name when there's enough room
 * (≥ 12%); below that it's shown as a bare percentage.
 *
 * The component is form-agnostic — it owns no state and accepts:
 *  - `value`: current senior share % (must be within [min, max])
 *  - `onChange`: called with the next integer value (clamped to [min, max])
 *  - `min` / `max`: optional bounds. Defaults preserve backwards-compat
 *    with `users.seniorSharePercent` semantics (1-100). For places that
 *    legitimately allow 0% (e.g. per-project override → "company keeps
 *    everything"), pass `min={0}`.
 *  - `disabled`: blocks both the range slider and the number input
 *  - `inputTestId`: passed through to the number input — useful for
 *    targeting the editable control in E2E tests that drive the value
 *    directly via `page.fill(...)`.
 */
export function ShareSlider({
  value,
  onChange,
  onBlur,
  error,
  disabled = false,
  min = 1,
  max = 100,
  inputTestId,
}: {
  value: number
  onChange: (v: number) => void
  onBlur?: () => void
  /** @deprecated Computed internally from `value`. Kept for backwards compat. */
  seniorPct?: number
  error?: boolean
  disabled?: boolean
  min?: number
  max?: number
  inputTestId?: string
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const seniorPct = value
  const companyPct = 100 - seniorPct
  return (
    <div className={cn('space-y-3', disabled && 'opacity-60')}>
      <div className="relative h-7 rounded-md overflow-hidden flex text-[11px] font-medium select-none">
        <div
          className="flex items-center justify-center bg-primary/20 text-primary transition-all duration-150 whitespace-nowrap overflow-hidden"
          style={{ width: `${companyPct}%` }}
          title={`${companyPct}% компания`}
        >
          {companyPct >= 12 ? `${companyPct}% компания` : `${companyPct}%`}
        </div>
        <div
          className="flex items-center justify-center bg-emerald-500/20 text-emerald-400 transition-all duration-150 whitespace-nowrap overflow-hidden"
          style={{ width: `${seniorPct}%` }}
          title={`${seniorPct}% синьор`}
        >
          {seniorPct >= 12 ? `${seniorPct}% синьор` : `${seniorPct}%`}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={seniorPct}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={onBlur}
          disabled={disabled}
          className={cn(
            'flex-1 h-2 accent-primary cursor-pointer',
            disabled && 'cursor-not-allowed',
          )}
          aria-label="Доля синьора"
        />
        <input
          type="number"
          min={min}
          max={max}
          value={seniorPct}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return
            const n = clamp(Number(raw))
            onChange(Number.isNaN(n) ? min : n)
          }}
          onBlur={onBlur}
          disabled={disabled}
          data-testid={inputTestId}
          className={cn(
            'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            error && 'border-destructive',
            disabled && 'cursor-not-allowed bg-muted',
          )}
          aria-label="Доля синьора в процентах"
        />
      </div>
    </div>
  )
}
