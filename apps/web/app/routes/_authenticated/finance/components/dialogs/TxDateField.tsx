import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePickerField } from '@/components/ui/date-picker'

interface TxDateFieldProps {
  value: string
  stored: string
  reason: string
  onChange: (txDate: string) => void
  onReasonChange: (reason: string) => void
}

/**
 * Business date of the transaction. The reason input appears only once the day
 * differs from the stored one: the server asks for it when the new date is
 * older than the backdating window and rejects otherwise.
 */
export function TxDateField({ value, stored, reason, onChange, onReasonChange }: TxDateFieldProps) {
  const { t } = useLingui()
  const changed = !!value && value !== stored

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        <Trans>Дата транзакції</Trans>
      </Label>
      <DatePickerField
        value={value}
        onChange={onChange}
        className="h-9 text-sm"
        data-testid="admin-edit-tx-date"
      />
      {changed && (
        <div className="space-y-1.5" data-testid="admin-edit-tx-date-reason">
          <Label className="text-xs text-muted-foreground">
            <Trans>Причина зміни дати</Trans>
          </Label>
          <Input
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            maxLength={500}
            data-testid="admin-edit-tx-date-reason-input"
            placeholder={t`Обов'язково для дат старших за 31 день`}
            className="h-9 text-sm"
          />
        </div>
      )}
    </div>
  )
}
