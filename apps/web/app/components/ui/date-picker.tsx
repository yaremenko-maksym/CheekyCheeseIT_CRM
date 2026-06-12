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
}

export function DatePickerField({
  value,
  onChange,
  placeholder = 'Выберите дату',
  className,
  disabled,
}: DatePickerFieldProps) {
  const [open, setOpen] = useState(false)
  const selected = value ? parseISO(value) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
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
          initialFocus
          locale={ru}
        />
      </PopoverContent>
    </Popover>
  )
}
