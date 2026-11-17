import { Trans } from '@lingui/react/macro'
import { formatDate, kyivToday, type SeniorAvailabilityDto } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * A senior's availability (vacancy-queue design §5.2): text plus a dot SHAPE, never colour alone
 * (WCAG 1.4.1). Filled dot «Вільно з {day}» (short month, §5.2: «Вільно з 1 лист.»), hollow dot
 * «Зайнято»; gender-neutral wording. A FREE day that is today or already past (on the Kyiv calendar)
 * means free now: the filled dot with the plain «Вільно», never a stale «Вільно з <old day>».
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
  const free = availability.status === 'FREE'
  // ISO `YYYY-MM-DD` strings compare as days
  const day =
    free && availability.availableFrom > kyivToday()
      ? formatDate(availability.availableFrom, locale, 'dayMonth')
      : null
  return (
    <span
      data-testid={testId}
      data-availability={availability.status}
      className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}
    >
      <span
        aria-hidden="true"
        className={cn('size-2 shrink-0 rounded-full border border-current', free && 'bg-current')}
      />
      {day !== null ? (
        <Trans>Вільно з {day}</Trans>
      ) : free ? (
        // own context: the bare «Вільно» is the resume density option («Relaxed») in English
        <Trans context="senior availability">Вільно</Trans>
      ) : (
        <Trans>Зайнято</Trans>
      )}
    </span>
  )
}
