import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ru } from 'date-fns/locale'
import { CalendarIcon } from 'lucide-react'
import { Calendar } from './calendar'
import { Button } from './button'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { cn } from '@/lib/utils'

interface DatePickerFieldProps {
  value: string // "YYYY-MM-DD"
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  // task-drop-payout-currency (owner addendum, 2026-08): optional bounds,
  // "YYYY-MM-DD" — additive, opt-in props so every EXISTING caller
  // (CreateTransactionDialog, legend.tsx) that never passes them keeps its
  // unrestricted picker byte-for-byte. Rendered as a react-day-picker
  // `disabled` matcher (dates strictly outside the [minDate, maxDate] range
  // are greyed out and unselectable), not just a submit-time validation —
  // the operator sees the restriction in the calendar itself.
  minDate?: string
  maxDate?: string
  'data-testid'?: string
}

export function DatePickerField({
  value,
  onChange,
  placeholder = 'Выберите дату',
  className,
  disabled,
  minDate,
  maxDate,
  'data-testid': dataTestId,
}: DatePickerFieldProps) {
  const [open, setOpen] = useState(false)
  const selected = value ? parseISO(value) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          data-testid={dataTestId}
          className={cn(
            'w-full justify-start text-left font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate">
            {selected ? format(selected, 'dd MMM yyyy', { locale: ru }) : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          // Bug: without this, react-day-picker's own default (`defaultMonth`
          // defaults to "the current month" per its docs — it does NOT infer
          // the month from `selected`) opens the calendar on TODAY's month
          // regardless of which date is already chosen. Radix's
          // PopoverContent unmounts on close (no forceMount above), so this
          // recomputes fresh — and correctly — every time the popover opens.
          defaultMonth={selected ?? new Date()}
          onSelect={(day) => {
            if (day) {
              onChange(format(day, 'yyyy-MM-dd'))
              setOpen(false)
            }
          }}
          disabled={
            // An array of matchers is an OR — a day is disabled if it
            // matches ANY entry. `{ before }` / `{ after }` are each
            // EXCLUSIVE of the bound itself, so minDate/maxDate stay
            // selectable (only strictly-outside days are greyed out).
            //
            // The FALSE branch of each ternary (no bound passed) is
            // genuinely `[]` in shipped code — react-day-picker's own
            // Matcher evaluation only recognises specific shapes (Date,
            // function, DateRange/DateBefore/DateAfter/DateInterval,
            // DayOfWeek); anything else (e.g. a stray string) matches NO
            // day and is silently a no-op, so no test — however it probes
            // "does an unrestricted picker leave any day disabled" — can
            // distinguish `[]` from a malformed placeholder here.
            [
              // Stryker disable next-line ArrayDeclaration: see the comment above — the false branch's exact contents (empty array vs a malformed non-Matcher value) are unobservable, since react-day-picker ignores anything that isn't a recognised Matcher shape either way
              ...(minDate ? [{ before: parseISO(minDate) }] : []),
              // Stryker disable next-line ArrayDeclaration: same reasoning as minDate above
              ...(maxDate ? [{ after: parseISO(maxDate) }] : []),
            ]
          }
          initialFocus
          locale={ru}
        />
      </PopoverContent>
    </Popover>
  )
}
