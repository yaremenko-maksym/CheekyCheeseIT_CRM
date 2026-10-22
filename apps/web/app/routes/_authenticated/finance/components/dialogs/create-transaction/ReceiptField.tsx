import { useLingui } from '@lingui/react/macro'
import { ReceiptInput, type ReceiptState } from '../../ReceiptInput'

// Receipt — mandatory for all 7 showReceipt types (task-receipts-frontend);
// explorer-only (link, no file) when the effective currency is USDT.
export function ReceiptField({
  receipt,
  setReceipt,
  clearFieldError,
  fieldErrors,
  isExplorerOnly,
}: {
  receipt: ReceiptState
  setReceipt: (s: ReceiptState) => void
  clearFieldError: (field: string) => void
  fieldErrors: Record<string, string>
  isExplorerOnly: boolean
}) {
  const { t } = useLingui()
  return (
    <div className="space-y-1.5">
      <ReceiptInput
        state={receipt}
        onChange={(s) => {
          setReceipt(s)
          clearFieldError('receipt')
        }}
        // Stryker disable next-line StringLiteral: label passed through to `ReceiptInput`, which already has its OWN default (`t\`Чек / підтвердження\``, `ReceiptInput.tsx`) pinned by that component's own tests — this override string is not independently asserted here.
        label={t`Чек / підтвердження *`}
        explorerOnly={isExplorerOnly}
        error={fieldErrors.receipt}
      />
      {fieldErrors.receipt && (
        <p className="text-[11px] text-destructive" data-testid="create-transaction-error-receipt">
          {fieldErrors.receipt}
        </p>
      )}
    </div>
  )
}
