import type { VariantProps } from 'class-variance-authority'
import { useLingui } from '@lingui/react/macro'
import type { JobHealthState, JobSourceCorrelation, JobSourceProfileSummary } from '@crm/shared'
import type { badgeVariants } from '@/components/ui/badge'

type BadgeVariant = VariantProps<typeof badgeVariants>['variant']

/**
 * Source-fetch-strategy U7 — localized labels + badge variants for the health vocabulary. `t` must
 * run at render (not module load), so this is a hook. States map to the house Badge variants by
 * severity: a failing source reads destructive, a watch state reads pending, a healthy one active.
 */
export function useSourceHealthLabels() {
  const { t } = useLingui()

  const stateLabel = (state: JobHealthState | null): string => {
    switch (state) {
      case 'HEALTHY':
        return t`Справний`
      case 'DEGRADED':
        return t`Погіршення`
      case 'EMPTY':
        return t`Порожні відповіді`
      case 'SILENT':
        return t`Мовчить`
      case 'FAILING':
        return t`Збої`
      case 'CAPPED':
        return t`Ліміт збоїв`
      case 'PAUSED':
        return t`Призупинено`
      case 'BLOCKED':
        return t`Заблоковано`
      case null:
        return t`Немає даних`
    }
  }

  const reasonLabel = (reason: string | null): string => {
    switch (reason) {
      case 'VOLUME_DROP':
        return t`Падіння обсягу`
      case 'NO_NEW_ITEMS':
        return t`Немає нових вакансій`
      case 'EMPTY_RESPONSE':
        return t`Порожня відповідь`
      case 'SCHEMA_DRIFT':
        return t`Змінився формат`
      case 'ACCESS_CHANGED':
        return t`Змінився доступ`
      case 'THROTTLED':
        return t`Обмеження швидкості`
      case 'SLOW':
        return t`Повільно`
      case 'PAYLOAD_GROWTH':
        return t`Зростання відповіді`
      case 'STALE_FEED':
        return t`Застарілий фід`
      case 'BOARD_GONE':
        return t`Дошку видалено`
      case 'DEADLINE_NEAR':
        return t`Наближається дедлайн`
      default:
        return ''
    }
  }

  /**
   * The correlation hint (ADR section 10): what moved on our side when the health changed. Names the
   * specific adapter/config version the event carries (COPY-M-2). `NO_CHANGE` states exactly what the
   * derivation compared — adapter and config version — and nothing more (COPY-M-3).
   */
  const correlationLabel = (
    correlation: JobSourceCorrelation | null,
    versions?: { adapterVersion: string | null; configVersion: number | null },
  ): string => {
    switch (correlation) {
      case 'ADAPTER_CHANGE':
        return versions?.adapterVersion
          ? t`Почалося зі зміни адаптера на ${versions.adapterVersion}`
          : t`Почалося зі зміни версії адаптера`
      case 'CONFIG_CHANGE':
        return versions?.configVersion != null
          ? t`Почалося зі зміни конфігурації на версію ${versions.configVersion}`
          : t`Почалося зі зміни конфігурації`
      case 'NO_CHANGE':
        return t`Без змін адаптера чи конфігурації з нашого боку`
      case null:
        return ''
    }
  }

  /** Localized outcome of a collection run (UX-L-3): an enum rendered as a word, not a raw code. */
  const outcomeLabel = (outcome: string): string => {
    switch (outcome) {
      case 'STARTED':
        return t`Виконується`
      case 'PARTIAL':
        return t`Частково`
      case 'SUCCEEDED':
        return t`Успішно`
      case 'FAILED':
        return t`Помилка`
      case 'CANCELLED':
        return t`Скасовано`
      default:
        return outcome
    }
  }

  const dayLabel = (day: string): string => {
    switch (day) {
      case 'MON':
        return t`Пн`
      case 'TUE':
        return t`Вт`
      case 'WED':
        return t`Ср`
      case 'THU':
        return t`Чт`
      case 'FRI':
        return t`Пт`
      case 'SAT':
        return t`Сб`
      case 'SUN':
        return t`Нд`
      default:
        return day
    }
  }

  /** A compact, localized cadence line (replaces the old raw `minIntervalHours`). */
  const profileSummaryText = (summary: JobSourceProfileSummary | null): string => {
    if (summary === null) return t`Без розкладу`
    const interval =
      summary.intervalMinutes % 60 === 0
        ? t`кожні ${summary.intervalMinutes / 60} год`
        : t`кожні ${summary.intervalMinutes} хв`
    if (summary.fixedSlotTimes) {
      return `${interval} · ${summary.fixedSlotTimes.join(', ')}`
    }
    if (summary.window) {
      const days = summary.window.days.map(dayLabel).join(', ')
      return `${interval} · ${days} ${summary.window.from}–${summary.window.to}`
    }
    return interval
  }

  return { stateLabel, reasonLabel, correlationLabel, outcomeLabel, profileSummaryText }
}

/** Non-localized: the house Badge variant for a health state (severity → colour). */
export function stateBadgeVariant(state: JobHealthState | null): BadgeVariant {
  switch (state) {
    case 'HEALTHY':
      return 'status-active'
    case 'DEGRADED':
    case 'EMPTY':
    case 'SILENT':
      return 'pending'
    case 'FAILING':
    case 'CAPPED':
    case 'PAUSED':
    case 'BLOCKED':
      return 'destructive'
    case null:
      return 'secondary'
  }
}

/** Non-localized: the house Badge variant for a run outcome (succeeded = active, failed = destructive). */
export function outcomeBadgeVariant(outcome: string): BadgeVariant {
  if (outcome === 'SUCCEEDED') return 'status-active'
  if (outcome === 'FAILED') return 'destructive'
  return 'secondary'
}
