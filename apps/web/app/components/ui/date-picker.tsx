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
            [
              ...(minDate ? [{ before: parseISO(minDate) }] : []),
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
