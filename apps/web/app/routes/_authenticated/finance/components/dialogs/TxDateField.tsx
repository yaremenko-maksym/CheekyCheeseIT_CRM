import { useEffect, useRef } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { BACKDATE_LIMIT_DAYS } from '@crm/shared'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { getApiErrorCode } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePickerField } from '@/components/ui/date-picker'

// A module-level `msg` plural, not the `plural()` macro: the latter breaks under
// Stryker instrumentation (see DropDashboard). `days` is the server's window.
const REASON_PLACEHOLDER = msg`Для дат давніших за {days, plural, one {# день} few {# дні} many {# днів} other {# дня}}`

interface TxDateFieldProps {
  value: string
  stored: string
  reason: string
  onChange: (txDate: string) => void
  onReasonChange: (reason: string) => void
  /** The last save was refused for a missing reason: mark the field and focus it. */
  invalid?: boolean
  /** Same text as the failed-save banner, repeated under the field (the banner may be below the fold). */
  errorMessage?: string | null | undefined
}

const REASON_ERROR_ID = 'admin-edit-tx-date-reason-error'

export const isReasonRequiredError = (err: unknown) =>
  getApiErrorCode(err) === 'FINANCE_TX_DATE_EDIT_REASON_REQUIRED'

/**
 * Business date of the transaction. The reason input appears only once the day
 * differs from the stored one: the server asks for it when the new date is
 * older than the backdating window and rejects otherwise.
 */
export function TxDateField({
  value,
  stored,
  reason,
  onChange,
  onReasonChange,
  invalid = false,
  errorMessage,
}: TxDateFieldProps) {
  const { i18n } = useLingui()
  const changed = !!value && value !== stored
  const shouldReduceMotion = useReducedMotion()
  const reasonRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (invalid) reasonRef.current?.focus()
  }, [invalid])

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
            className="-mx-0.5 -mb-0.5 space-y-1.5 overflow-hidden px-0.5 pb-0.5"
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
              ref={reasonRef}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid && errorMessage ? REASON_ERROR_ID : undefined}
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              maxLength={500}
              data-testid="admin-edit-tx-date-reason-input"
              placeholder={i18n._(REASON_PLACEHOLDER.id, { days: BACKDATE_LIMIT_DAYS })}
              className={cn(
                'min-h-[44px] sm:min-h-0 sm:h-9 text-sm',
                invalid && 'border-destructive focus-visible:ring-destructive',
              )}
            />
            {invalid && errorMessage && (
              <p
                id={REASON_ERROR_ID}
                data-testid="admin-edit-tx-date-reason-error"
                className="text-xs text-destructive"
              >
                {errorMessage}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
