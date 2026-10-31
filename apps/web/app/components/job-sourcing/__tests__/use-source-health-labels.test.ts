import { beforeAll, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { JobSourceProfileSummary } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { stateBadgeVariant, useSourceHealthLabels } from '../use-source-health-labels'

/**
 * Source-fetch-strategy U7 — the page's health vocabulary. `uk` is the source locale, so the labels
 * assert the Ukrainian source strings. Each expected value is an independent literal, not recomputed
 * from the hook, so the mutation gate can tell a wrong branch from a right one.
 */

describe('stateBadgeVariant (pure severity → colour)', () => {
  it('maps each severity band to its house variant', () => {
    expect(stateBadgeVariant('HEALTHY')).toBe('status-active')
    expect(stateBadgeVariant('DEGRADED')).toBe('pending')
    expect(stateBadgeVariant('EMPTY')).toBe('pending')
    expect(stateBadgeVariant('SILENT')).toBe('pending')
    expect(stateBadgeVariant('FAILING')).toBe('destructive')
    expect(stateBadgeVariant('CAPPED')).toBe('destructive')
    expect(stateBadgeVariant('PAUSED')).toBe('destructive')
    expect(stateBadgeVariant('BLOCKED')).toBe('destructive')
    expect(stateBadgeVariant(null)).toBe('secondary')
  })
})

describe('useSourceHealthLabels', () => {
  beforeAll(async () => {
    await loadCatalog('uk')
  })

  const labels = () =>
    renderHook(() => useSourceHealthLabels(), { wrapper: I18nTestProvider }).result.current

  // Every branch is asserted with an independent literal — the mutation gate otherwise leaves each
  // label's StringLiteral alive (a `""` the UI would render as an empty badge).
  it('labels every health state', () => {
    const l = labels()
    expect(l.stateLabel('BLOCKED')).toBe('Заблоковано')
    expect(l.stateLabel('CAPPED')).toBe('Ліміт збоїв')
    expect(l.stateLabel('PAUSED')).toBe('Призупинено')
    expect(l.stateLabel('FAILING')).toBe('Збої')
    expect(l.stateLabel('EMPTY')).toBe('Порожні відповіді')
    expect(l.stateLabel('DEGRADED')).toBe('Погіршення')
    expect(l.stateLabel('SILENT')).toBe('Мовчить')
    expect(l.stateLabel('HEALTHY')).toBe('Справний')
    expect(l.stateLabel(null)).toBe('Немає даних')
  })

  it('labels every detector reason, and an unknown reason as empty', () => {
    const l = labels()
    expect(l.reasonLabel('VOLUME_DROP')).toBe('Падіння обсягу')
    expect(l.reasonLabel('NO_NEW_ITEMS')).toBe('Немає нових вакансій')
    expect(l.reasonLabel('EMPTY_RESPONSE')).toBe('Порожня відповідь')
    expect(l.reasonLabel('SCHEMA_DRIFT')).toBe('Змінився формат')
    expect(l.reasonLabel('ACCESS_CHANGED')).toBe('Змінився доступ')
    expect(l.reasonLabel('THROTTLED')).toBe('Обмеження швидкості')
    expect(l.reasonLabel('SLOW')).toBe('Повільно')
    expect(l.reasonLabel('PAYLOAD_GROWTH')).toBe('Зростання відповіді')
    expect(l.reasonLabel('STALE_FEED')).toBe('Застарілий фід')
    expect(l.reasonLabel('BOARD_GONE')).toBe('Дошку видалено')
    expect(l.reasonLabel('DEADLINE_NEAR')).toBe('Наближається дедлайн')
    expect(l.reasonLabel(null)).toBe('')
  })

  it('labels every correlation hint (with and without a version subject), null as empty', () => {
    const l = labels()
    // Without versions: the generic fallback.
    expect(l.correlationLabel('ADAPTER_CHANGE')).toBe('Почалося зі зміни версії адаптера')
    expect(l.correlationLabel('CONFIG_CHANGE')).toBe('Почалося зі зміни конфігурації')
    // With versions: the hint names the specific adapter/config version (COPY-M-2).
    expect(
      l.correlationLabel('ADAPTER_CHANGE', { adapterVersion: 'remotive-2', configVersion: 4 }),
    ).toBe('Почалося зі зміни адаптера на remotive-2')
    expect(
      l.correlationLabel('CONFIG_CHANGE', { adapterVersion: 'remotive-2', configVersion: 4 }),
    ).toBe('Почалося зі зміни конфігурації на версію 4')
    // NO_CHANGE states exactly what was compared (COPY-M-3), nothing broader.
    expect(l.correlationLabel('NO_CHANGE')).toBe('Без змін адаптера чи конфігурації з нашого боку')
    expect(l.correlationLabel(null)).toBe('')
  })

  it('labels every run outcome, and an unknown one as its raw code', () => {
    const l = labels()
    expect(l.outcomeLabel('STARTED')).toBe('Виконується')
    expect(l.outcomeLabel('PARTIAL')).toBe('Частково')
    expect(l.outcomeLabel('SUCCEEDED')).toBe('Успішно')
    expect(l.outcomeLabel('FAILED')).toBe('Помилка')
    expect(l.outcomeLabel('CANCELLED')).toBe('Скасовано')
    expect(l.outcomeLabel('WAT')).toBe('WAT')
  })

  it('formats a windowed cadence with hours and localized days', () => {
    const summary: JobSourceProfileSummary = {
      intervalMinutes: 360,
      offIntervalMinutes: null,
      window: { timeZone: 'Europe/Kyiv', days: ['MON', 'FRI'], from: '09:00', to: '21:00' },
      fixedSlotTimes: null,
      floorHours: 6,
    }
    expect(labels().profileSummaryText(summary)).toBe('кожні 6 год · Пн, Пт 09:00–21:00')
  })

  it('localizes every weekday in a full-week window', () => {
    expect(
      labels().profileSummaryText({
        intervalMinutes: 120,
        offIntervalMinutes: null,
        window: {
          timeZone: 'UTC',
          days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
          from: '00:00',
          to: '23:00',
        },
        fixedSlotTimes: null,
        floorHours: 0,
      }),
    ).toBe('кожні 2 год · Пн, Вт, Ср, Чт, Пт, Сб, Нд 00:00–23:00')
  })

  it('formats a sub-hour interval in minutes and a null profile as "no schedule"', () => {
    const l = labels()
    expect(
      l.profileSummaryText({
        intervalMinutes: 90,
        offIntervalMinutes: null,
        window: null,
        fixedSlotTimes: null,
        floorHours: 0,
      }),
    ).toBe('кожні 90 хв')
    expect(l.profileSummaryText(null)).toBe('Без розкладу')
  })

  it('formats fixed slot times, comma-separated', () => {
    // Two times so the ', ' separator is observable (one element would hide it).
    expect(
      labels().profileSummaryText({
        intervalMinutes: 1440,
        offIntervalMinutes: null,
        window: null,
        fixedSlotTimes: ['08:30', '14:00'],
        floorHours: 24,
      }),
    ).toBe('кожні 24 год · 08:30, 14:00')
  })
})
