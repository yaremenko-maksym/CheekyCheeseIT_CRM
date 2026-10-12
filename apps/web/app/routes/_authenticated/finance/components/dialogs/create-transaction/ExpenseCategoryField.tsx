import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_MESSAGES } from '../../../constants'

// Expense category — owner override 2026-09-28 (i18n-3d-pr3): FREE TEXT, not a
// closed Select (see the identical note in `AdminEditTransactionDialog`). The
// Input IS the field; the chips below are translated quick-fill suggestions
// only — clicking one fills the input, it does not validate or lock the
// operator into these three.
export function ExpenseCategoryField({
  category,
  setCategory,
}: {
  category: string
  setCategory: (v: string) => void
}) {
  const { t, i18n } = useLingui()
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        <Trans>Категорія</Trans>
      </Label>
      <Input
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder={t`Категорія витрати`}
        className="h-9 text-sm"
        data-testid="create-transaction-expense-category-input"
      />
      <div className="flex flex-wrap gap-1.5">
        {EXPENSE_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(i18n._(EXPENSE_CATEGORY_MESSAGES[c]!))}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-all min-h-[44px] sm:min-h-0 flex items-center',
              category === i18n._(EXPENSE_CATEGORY_MESSAGES[c]!)
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-border/80 hover:bg-muted/50',
            )}
            data-testid={`create-transaction-expense-category-suggestion-${EXPENSE_CATEGORIES.indexOf(c)}`}
          >
            {i18n._(EXPENSE_CATEGORY_MESSAGES[c]!)}
          </button>
        ))}
      </div>
    </div>
  )
}
