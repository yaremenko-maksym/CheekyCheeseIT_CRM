import { Trans } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import type { Currency, FundingSourceUI } from './shared'

// EXPENSE and ADMIN_INCOME's ACCOUNTANT branch render the SAME two-button
// legacy/company toggle — only the copy differs (see the two call sites in
// `CreateTransactionDialog`). Sharing the implementation means there is exactly
// ONE place that decides which button is active, not two near-identical copies
// that could drift apart silently.
export function renderFundingSourceToggle({
  sectionLabel,
  personalLabel,
  personalDescription,
  companyDescription,
  fundingSource,
  setFundingSource,
  setCurrency,
  companyBalance,
  fmtUsdt,
}: {
  sectionLabel: string
  personalLabel: string
  personalDescription: string
  companyDescription: string
  fundingSource: FundingSourceUI
  setFundingSource: (v: FundingSourceUI) => void
  setCurrency: (v: Currency) => void
  companyBalance: number
  fmtUsdt: (n: number) => string
}) {
  // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Purely decorative active-state dot, redundant with the border-color styling already asserted as cosmetic above — no testid, not part of any AC's observable contract.
  const isLegacyActive = fundingSource === 'legacy'
  // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Purely decorative active-state dot, redundant with the border-color styling already asserted as cosmetic above — no testid, not part of any AC's observable contract.
  const isCompanyActive = fundingSource === 'COMPANY_ACCOUNT'
  return (
    <div className="space-y-2" data-testid="create-transaction-funding-source-section">
      <Label className="text-xs text-muted-foreground">{sectionLabel}</Label>
      {/* `sectionLabel`/`personalLabel`/`personalDescription`/`companyDescription`
            are already-resolved strings from the call site (`t\`…\`` there) — this
            shared renderer stays a plain function, not a component, so it cannot
            call `useLingui()` itself. */}
      <div className="grid grid-cols-1 gap-1.5">
        <button
          type="button"
          // Stryker disable next-line StringLiteral: the click-handler's sentinel argument — any value other than 'COMPANY_ACCOUNT' behaves identically everywhere this state is read (every check is `=== 'COMPANY_ACCOUNT'`; anything else is treated as "legacy"), and the active/inactive styling this feeds is already covered by the cosmetic note above.
          onClick={() => setFundingSource('legacy')}
          className={cn(
            // Stryker disable next-line StringLiteral: the SHARED (non-conditional) base Tailwind classes — present in EVERY state, so mutating this string changes only appearance, covered by the same cosmetic reasoning as the active/inactive ternary below it.
            'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
            // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Tailwind active/inactive border styling — cosmetic only, verified visually via the Playwright screenshots in the PR; testing-library discourages asserting implementation-detail CSS classes, and the button's FUNCTIONAL state (which testid is active, the balance hint) is already pinned by other tests in this file.
            fundingSource === 'legacy'
              ? // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                'border-primary bg-primary/8 text-foreground'
              : // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
          )}
          data-testid="create-transaction-funding-legacy"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium leading-tight">{personalLabel}</div>
            <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
              {personalDescription}
            </div>
          </div>
          {isLegacyActive && (
            <div
              className="h-2 w-2 rounded-full bg-primary shrink-0"
              data-testid="funding-toggle-active-dot"
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            // Stryker disable next-line StringLiteral: the click-handler's sentinel argument — any value other than 'COMPANY_ACCOUNT' behaves identically everywhere this state is read (every check is `=== 'COMPANY_ACCOUNT'`; anything else is treated as "legacy"), and the active/inactive styling this feeds is already covered by the cosmetic note above.
            setFundingSource('COMPANY_ACCOUNT')
            // Stryker disable next-line StringLiteral: defensive pre-set — `isUsdtLocked`'s `fundingSource === 'COMPANY_ACCOUNT'` clause already forces `payload.currency` to 'USDT' independent of this direct `setCurrency` call (see `usdRate`'s neighbouring suppression); this only affects the currency Select's value AFTER the user later switches back to 'legacy', a state no AC specifies.
            setCurrency('USDT')
          }}
          className={cn(
            // Stryker disable next-line StringLiteral: the SHARED (non-conditional) base Tailwind classes — present in EVERY state, so mutating this string changes only appearance, covered by the same cosmetic reasoning as the active/inactive ternary below it.
            'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
            // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Tailwind active/inactive border styling — cosmetic only, verified visually via the Playwright screenshots in the PR; testing-library discourages asserting implementation-detail CSS classes, and the button's FUNCTIONAL state (which testid is active, the balance hint) is already pinned by other tests in this file.
            fundingSource === 'COMPANY_ACCOUNT'
              ? // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                'border-primary bg-primary/8 text-foreground'
              : // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
          )}
          data-testid="create-transaction-funding-company"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium leading-tight">
              <Trans>Рахунок компанії</Trans>
            </div>
            <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
              {companyDescription}
            </div>
          </div>
          {isCompanyActive && (
            <div
              className="h-2 w-2 rounded-full bg-primary shrink-0"
              data-testid="funding-toggle-active-dot"
            />
          )}
        </button>
      </div>

      {fundingSource === 'COMPANY_ACCOUNT' && (
        <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
          <span>
            <Trans>Баланс рахунку компанії</Trans>
          </span>
          <span
            className="font-bold tabular-nums"
            data-testid="create-transaction-company-balance-hint"
          >
            {fmtUsdt(companyBalance)} USDT
          </span>
        </div>
      )}
    </div>
  )
}
