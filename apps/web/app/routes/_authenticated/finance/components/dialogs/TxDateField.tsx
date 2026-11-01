import { Trans, useLingui } from '@lingui/react/macro'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
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
  const shouldReduceMotion = useReducedMotion()

  return (
    <div className="space-y-1.5">
      <Label htmlFor="admin-edit-tx-date-trigger" className="text-xs text-muted-foreground">
        <Trans>Дата транзакції</Trans>
      </Label>
      <DatePickerField
        id="admin-edit-tx-date-trigger"
        value={value}
        onChange={onChange}
        className="min-h-[44px] sm:min-h-0 sm:h-9 text-sm"
        data-testid="admin-edit-tx-date"
      />
      <AnimatePresence initial={false}>
        {changed && (
          <motion.div
            key="admin-edit-tx-date-reason"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            {...(!shouldReduceMotion && { exit: { opacity: 0, height: 0, y: -4 } })}
            transition={{ duration: shouldReduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden space-y-1.5"
            data-testid="admin-edit-tx-date-reason"
          >
            <Label
              htmlFor="admin-edit-tx-date-reason-field"
              className="text-xs text-muted-foreground"
            >
              <Trans>Причина зміни дати</Trans>
            </Label>
            <Input
              id="admin-edit-tx-date-reason-field"
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              maxLength={500}
              data-testid="admin-edit-tx-date-reason-input"
              placeholder={t`Для дат старших за 31 день`}
              className="min-h-[44px] sm:min-h-0 sm:h-9 text-sm"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
