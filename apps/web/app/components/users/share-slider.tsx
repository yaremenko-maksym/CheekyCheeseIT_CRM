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
 */
export function ShareSlider({
  value,
  onChange,
  onBlur,
  error,
}: {
  value: number
  onChange: (v: number) => void
  onBlur?: () => void
  /** @deprecated Computed internally from `value`. Kept for backwards compat. */
  seniorPct?: number
  error?: boolean
}) {
  const seniorPct = value
  const companyPct = 100 - seniorPct
  return (
    <div className="space-y-3">
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
          min={1}
          max={100}
          step={1}
          value={seniorPct}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={onBlur}
          className="flex-1 h-2 accent-primary cursor-pointer"
          aria-label="Доля синьора"
        />
        <input
          type="number"
          min={1}
          max={100}
          value={seniorPct}
          onChange={(e) => {
            const n = Math.min(100, Math.max(1, Number(e.target.value)))
            onChange(n)
          }}
          onBlur={onBlur}
          className={cn(
            'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            error && 'border-destructive',
          )}
          aria-label="Доля синьора в процентах"
        />
      </div>
    </div>
  )
}
