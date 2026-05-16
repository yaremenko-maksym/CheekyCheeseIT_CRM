'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker, useDayPicker, type DayPickerProps, type MonthCaptionProps } from 'react-day-picker'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

export type CalendarProps = DayPickerProps

const MONTHS_SHORT = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек']
const MONTHS_FULL  = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']

type Picker = 'month' | 'year' | null

function CustomMonthCaption({ calendarMonth }: MonthCaptionProps) {
  const { goToMonth, previousMonth, nextMonth } = useDayPicker()
  const [picker, setPicker] = useState<Picker>(null)

  const date = calendarMonth.date
  const year = date.getFullYear()
  const monthIndex = date.getMonth()

  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i)
  const pickerContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!picker) return
    const handler = (e: MouseEvent) => {
      if (pickerContainerRef.current && !pickerContainerRef.current.contains(e.target as Node)) {
        setPicker(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [picker])

  const selectMonth = (idx: number) => {
    goToMonth(new Date(year, idx, 1))
    setPicker(null)
  }

  const selectYear = (y: number) => {
    goToMonth(new Date(y, monthIndex, 1))
    setPicker(null)
  }

  const navBtn = cn(
    buttonVariants({ variant: 'outline' }),
    'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 shrink-0',
  )

  return (
    <div className="flex items-center justify-between w-full h-7 gap-1">
      {/* Prev arrow */}
      <button
        type="button"
        disabled={!previousMonth}
        onClick={() => previousMonth && goToMonth(previousMonth)}
        className={navBtn}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {/* Month / Year labels */}
      <div ref={pickerContainerRef} className="flex items-center gap-1 relative">
        {/* Month button */}
        <button
          type="button"
          onClick={() => setPicker(p => p === 'month' ? null : 'month')}
          className="text-sm font-medium hover:opacity-70 transition-opacity cursor-pointer"
        >
          {MONTHS_FULL[monthIndex]}
        </button>

        {/* Year button */}
        <button
          type="button"
          onClick={() => setPicker(p => p === 'year' ? null : 'year')}
          className="text-sm font-medium hover:opacity-70 transition-opacity cursor-pointer"
        >
          {year}
        </button>

        {/* Month picker dropdown */}
        {picker === 'month' && (
          <div className="absolute top-full mt-1 left-0 z-50 bg-popover border border-border rounded-md shadow-md p-2 w-48">
            <div className="grid grid-cols-3 gap-1">
              {MONTHS_SHORT.map((name, idx) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => selectMonth(idx)}
                  className={cn(
                    'text-xs rounded py-1.5 hover:bg-accent hover:text-accent-foreground transition-colors text-center',
                    idx === monthIndex && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Year picker dropdown */}
        {picker === 'year' && (
          <div className="absolute top-full mt-1 left-0 z-50 bg-popover border border-border rounded-md shadow-md p-2 w-48">
            <div className="grid grid-cols-3 gap-1">
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => selectYear(y)}
                  className={cn(
                    'text-xs rounded py-1.5 hover:bg-accent hover:text-accent-foreground transition-colors text-center',
                    y === year && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                  )}
                >
                  {y}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Next arrow */}
      <button
        type="button"
        disabled={!nextMonth}
        onClick={() => nextMonth && goToMonth(nextMonth)}
        className={navBtn}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0',
        month: 'space-y-4',
        month_caption: 'flex justify-center relative items-center',
        caption_label: 'hidden',
        nav: 'hidden',
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday: 'text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: 'h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-9 w-9 p-0 font-normal aria-selected:opacity-100',
        ),
        range_end: 'day-range-end',
        selected: 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
        today: 'bg-accent text-accent-foreground',
        outside: 'day-outside text-muted-foreground aria-selected:bg-accent/50 aria-selected:text-muted-foreground',
        disabled: 'text-muted-foreground opacity-50',
        range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        MonthCaption: CustomMonthCaption,
      }}
      {...props}
    />
  )
}
