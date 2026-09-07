/**
 * task-project-status-filter-ui (design spec §5 table). Pins the exact
 * label text for all four `ProjectStatusFilter` values, desktop AND
 * mobile — a plain "renders something" assertion elsewhere would not catch
 * a swapped/blanked string, which is exactly the mutant class the mutation
 * gate reported here (StringLiteral mutants on every value).
 */
import { describe, expect, it } from 'vitest'
import {
  PROJECT_STATUS_FILTERS,
  STATUS_FILTER_LABELS,
  STATUS_FILTER_LABELS_MOBILE,
} from '../constants'

describe('PROJECT_STATUS_FILTERS / STATUS_FILTER_LABELS (design spec §2/§5)', () => {
  it('lists exactly the four values, in the design spec §2 order', () => {
    expect(PROJECT_STATUS_FILTERS).toEqual(['ACTIVE', 'PENDING', 'REJECTED', 'ARCHIVED'])
  })

  it('desktop labels match the design spec §5 table (COPY-M-2, PR #646 fix-round 2: PENDING shortened from "Ожидают подтверждения" — 154px broke the 4-column equal-width toggle at 640-749px)', () => {
    expect(STATUS_FILTER_LABELS).toEqual({
      ACTIVE: 'Активные',
      PENDING: 'На подтверждении',
      REJECTED: 'Отклонённые',
      ARCHIVED: 'Архив',
    })
  })

  it('COPY-M-3 (PR #646 fix-round 2): mobile labels are the full 4-abbreviation set measured to fit 320px with no two a single letter apart — the old ACTIVE (full-length "Активные") and REJECTED ("Откл.", one letter from "Ожид.", and readable as "disabled") both got replaced', () => {
    expect(STATUS_FILTER_LABELS_MOBILE).toEqual({
      ACTIVE: 'Идут',
      PENDING: 'Ждут',
      REJECTED: 'Отказ',
      ARCHIVED: 'Архив',
    })
  })

  it('every filter value has both a desktop and a mobile label — no key falls through the cracks', () => {
    for (const value of PROJECT_STATUS_FILTERS) {
      expect(STATUS_FILTER_LABELS[value]).toBeTruthy()
      expect(STATUS_FILTER_LABELS_MOBILE[value]).toBeTruthy()
    }
  })
})
