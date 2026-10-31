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
    expect(stateBadgeVariant('SILENT')).toBe('pending')
    expect(stateBadgeVariant('FAILING')).toBe('destructive')
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

  it('labels states, reasons and correlations', () => {
    const l = labels()
    expect(l.stateLabel('HEALTHY')).toBe('Справний')
    expect(l.stateLabel(null)).toBe('Немає даних')
    expect(l.reasonLabel('ACCESS_CHANGED')).toBe('Змінився доступ')
    expect(l.reasonLabel(null)).toBe('')
    expect(l.correlationLabel('NO_CHANGE')).toBe('Без змін з нашого боку')
    expect(l.correlationLabel(null)).toBe('')
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

  it('formats fixed slot times', () => {
    expect(
      labels().profileSummaryText({
        intervalMinutes: 1440,
        offIntervalMinutes: null,
        window: null,
        fixedSlotTimes: ['08:30'],
        floorHours: 24,
      }),
    ).toBe('кожні 24 год · 08:30')
  })
})
