import { cn } from '@/lib/utils'

export function ShareSlider({
  value,
  onChange,
  onBlur,
  seniorPct,
  error,
}: {
  value: number
  onChange: (v: number) => void
  onBlur?: () => void
  seniorPct: number
  error?: boolean
}) {
  // Always show the percent value inside each bar; suffix only when there's
  // enough room ( >=12% ) — keeps small slivers readable without empty cells.
  return (
    <div className="space-y-3">
      <div className="relative h-7 rounded-md overflow-hidden flex text-[11px] font-medium select-none">
        <div
          className="flex items-center justify-center bg-primary/20 text-primary transition-all duration-150 whitespace-nowrap overflow-hidden"
          style={{ width: `${value}%` }}
          title={`${value}% компания`}
        >
          {value >= 12 ? `${value}% компания` : `${value}%`}
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
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={onBlur}
          className="flex-1 h-2 accent-primary cursor-pointer"
        />
        <input
          type="number"
          min={1}
          max={100}
          value={value}
          onChange={(e) => {
            const n = Math.min(100, Math.max(1, Number(e.target.value)))
            onChange(n)
          }}
          onBlur={onBlur}
          className={cn(
            'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            error && 'border-destructive',
          )}
        />
      </div>
    </div>
  )
}
