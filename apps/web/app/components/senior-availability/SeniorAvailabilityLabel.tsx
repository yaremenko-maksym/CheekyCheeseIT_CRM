import { Trans } from '@lingui/react/macro'
import { formatDay, type SeniorAvailabilityDto } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * A senior's availability (vacancy-queue design §5.2): text plus a dot SHAPE, never colour alone
 * (WCAG 1.4.1). Filled dot «Вільно з {day}», hollow dot «Зайнято»; gender-neutral wording.
 */
export function SeniorAvailabilityLabel({
  availability,
  className,
  testId,
}: {
  availability: SeniorAvailabilityDto
  className?: string
  testId?: string
}) {
  const locale = useLocale()
  const day = availability.status === 'FREE' ? formatDay(availability.availableFrom, locale) : null
  return (
    <span
      data-testid={testId}
      data-availability={availability.status}
      className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full border border-current',
          day !== null && 'bg-current',
        )}
      />
      {day !== null ? <Trans>Вільно з {day}</Trans> : <Trans>Зайнято</Trans>}
    </span>
  )
}
