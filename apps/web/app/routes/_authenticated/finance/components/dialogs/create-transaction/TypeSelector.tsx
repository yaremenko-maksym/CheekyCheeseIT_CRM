import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { TYPE_DESCRIPTION_MESSAGES, TYPE_ICONS, typeLabel, type DialogTxType } from './shared'

// Type selector — card-style.
export function TypeSelector({
  availableTypes,
  type,
  onSelectType,
}: {
  availableTypes: DialogTxType[]
  type: DialogTxType
  onSelectType: (txType: DialogTxType) => void
}) {
  const { i18n } = useLingui()
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        <Trans>Тип операції</Trans>
      </Label>
      <div className="grid grid-cols-1 gap-1.5">
        {availableTypes.map((txType) => (
          <button
            key={txType}
            type="button"
            onClick={() => onSelectType(txType)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
              // Stryker disable next-line ConditionalExpression,EqualityOperator: purely decorative active-state border styling — same cosmetic reasoning as the identical pattern already suppressed on `renderFundingSourceToggle`'s buttons in this file; not asserted by any test, verified visually via the i18n-3d-pr3 screenshots.
              type === txType
                ? 'border-primary bg-primary/8 text-foreground'
                : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
            )}
            data-testid={`create-transaction-type-${txType.toLowerCase()}`}
          >
            <span className="text-muted-foreground shrink-0">{TYPE_ICONS[txType]}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-tight">{typeLabel(txType, i18n)}</div>
              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {i18n._(TYPE_DESCRIPTION_MESSAGES[txType]!)}
              </div>
            </div>
            {
              // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: purely decorative active-state dot, redundant with the border-color styling immediately above — same cosmetic reasoning, no testid, not part of any AC's observable contract.
              type === txType && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />
            }
          </button>
        ))}
      </div>
    </div>
  )
}
