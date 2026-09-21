import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import { cn } from '@/lib/utils'

/**
 * Share split visualization. `value` represents the role's share —
 * the % the SENIOR (default) or DROP keeps. The remaining (100 - value)
 * is the company's share. The visual order is:
 *
 *   [ company % ] [ role % ]
 *
 * matching the natural reading order "company pays role X%".
 *
 * Field labels in the parent form follow the same convention — "Частка
 * синьйора (%)" / «Частка дропа (%)» describes what `value` controls.
 * The number badge inside each bar is suffixed with the role label when
 * there's enough room (≥ 12%); below that it's shown as a bare percentage.
 *
 * The component is form-agnostic — it owns no state and accepts:
 *  - `value`: current role share % (must be within [min, max])
 *  - `onChange`: called with the next integer value (clamped to [min, max])
 *  - `min` / `max`: optional bounds. Defaults preserve backwards-compat
 *    with `users.seniorSharePercent` semantics (1-100). For places that
 *    legitimately allow 0% (e.g. per-project override → "company keeps
 *    everything"), pass `min={0}`.
 *  - `disabled`: blocks both the range slider and the number input
 *  - `inputTestId`: passed through to the number input — useful for
 *    targeting the editable control in E2E tests that drive the value
 *    directly via `page.fill(...)`.
 *  - `role`: drives the right-hand label and aria text. Defaults to
 *    `'SENIOR'` so every existing call site keeps the legacy texts
 *    verbatim; the DROP-create form passes `'DROP'` to surface the
 *    Drop-specific wording. New roles can extend the map without
 *    touching call sites.
 *
 * task-i18n-stage3a (Task 1), COPY-M-core-10 — this map is PRIVATE to the
 * component (never exported), so there is no external consumer pinned to
 * the old Russian text the way `role-select.tsx`'s `ROLE_LABELS` has eight
 * — no legacy/canon split needed, this is a straight in-place migration.
 * The old map also mixed grammatical case between roles (`'синьор'`
 * nominative vs `'дропу'` dative) — fixed here to genitive for both,
 * matching the already-canon `ArchivePendingTransactionsList.tsx` pattern
 * (`Дохід синьйора`, `Дохід дропа`).
 */
type ShareSliderRole = 'SENIOR' | 'DROP'

const ROLE_LABEL_MESSAGES: Record<
  ShareSliderRole,
  { side: MessageDescriptor; aria: MessageDescriptor }
> = {
  SENIOR: { side: msg`сеньйора`, aria: msg`Частка сеньйора у відсотках` },
  DROP: { side: msg`дропа`, aria: msg`Частка дропа у відсотках` },
}

export function ShareSlider({
  value,
  onChange,
  onBlur,
  error,
  disabled = false,
  min = 1,
  max = 100,
  inputTestId,
  role = 'SENIOR',
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
  role?: ShareSliderRole
}) {
  const { i18n, t } = useLingui()
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const seniorPct = value
  const companyPct = 100 - seniorPct
  const roleMessages = ROLE_LABEL_MESSAGES[role]
  const sideLabel = i18n._(roleMessages.side)
  const ariaLabel = i18n._(roleMessages.aria)
  const companyLabel = t`компанії`
  return (
    <div className={cn('space-y-3', disabled && 'opacity-60')}>
      <div className="relative h-7 rounded-md overflow-hidden flex text-[11px] font-medium select-none">
        <div
          className="flex items-center justify-center bg-primary/20 text-primary transition-all duration-150 whitespace-nowrap overflow-hidden"
          style={{ width: `${companyPct}%` }}
          title={`${companyPct}% ${companyLabel}`}
        >
          {companyPct >= 12 ? `${companyPct}% ${companyLabel}` : `${companyPct}%`}
        </div>
        <div
          className="flex items-center justify-center bg-emerald-500/20 text-emerald-400 transition-all duration-150 whitespace-nowrap overflow-hidden"
          style={{ width: `${seniorPct}%` }}
          title={`${seniorPct}% ${sideLabel}`}
        >
          {seniorPct >= 12 ? `${seniorPct}% ${sideLabel}` : `${seniorPct}%`}
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
          aria-label={ariaLabel}
        />
        <input
          type="number"
          inputMode="numeric"
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
          aria-label={ariaLabel}
        />
      </div>
    </div>
  )
}
