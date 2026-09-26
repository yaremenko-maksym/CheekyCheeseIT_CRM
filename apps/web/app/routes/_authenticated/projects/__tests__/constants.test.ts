/**
 * task-project-status-filter-ui (design spec §5 table). Pins the exact
 * label text for all four `ProjectStatusFilter` values, desktop AND
 * mobile — a plain "renders something" assertion elsewhere would not catch
 * a swapped/blanked string, which is exactly the mutant class the mutation
 * gate reported here (StringLiteral mutants on every value).
 *
 * task-i18n-stage3c-pr3 (Task 3, Step 2): both maps are now
 * `Record<ProjectStatusFilter, MessageDescriptor>` — resolved through the
 * REAL compiled catalog (`loadCatalog`/`i18n._`, SPEC-H-1), not read as a
 * plain string, so a mutated/emptied `msg` template is still caught.
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { loadCatalog } from '@/test/i18n'
import {
  PAYMENT_TYPE_MESSAGES,
  PROJECT_STATUS_FILTERS,
  STATUS_FILTER_LABEL_MESSAGES,
  STATUS_FILTER_LABEL_MESSAGES_MOBILE,
} from '../constants'

describe('PROJECT_STATUS_FILTERS / STATUS_FILTER_LABEL_MESSAGES (design spec §2/§5)', () => {
  it('lists exactly the four values, in the design spec §2 order', () => {
    expect(PROJECT_STATUS_FILTERS).toEqual(['ACTIVE', 'PENDING', 'REJECTED', 'ARCHIVED'])
  })

  it('desktop labels match the canon (uk) — COPY-H-proj-5/M-8', async () => {
    await loadCatalog('uk')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.ACTIVE)).toBe('Активні')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.PENDING)).toBe('Очікують рішення')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.REJECTED)).toBe('Відхилені')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.ARCHIVED)).toBe('Архів')
  })

  it('desktop labels translate to en', async () => {
    await loadCatalog('en')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.ACTIVE)).toBe('Active')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.PENDING)).toBe('Awaiting decision')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.REJECTED)).toBe('Rejected')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES.ARCHIVED)).toBe('Archived')
  })

  it('mobile (short) labels match the canon (uk), all distinct from ARCHIVED/ACTIVE where the canon calls for it', async () => {
    await loadCatalog('uk')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES_MOBILE.ACTIVE)).toBe('Активні')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES_MOBILE.PENDING)).toBe('Чекають')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES_MOBILE.REJECTED)).toBe('Відмова')
    expect(i18n._(STATUS_FILTER_LABEL_MESSAGES_MOBILE.ARCHIVED)).toBe('Архів')
  })

  it('every filter value has both a desktop and a mobile message', () => {
    for (const value of PROJECT_STATUS_FILTERS) {
      expect(STATUS_FILTER_LABEL_MESSAGES[value]).toBeTruthy()
      expect(STATUS_FILTER_LABEL_MESSAGES_MOBILE[value]).toBeTruthy()
    }
  })
})

describe('PAYMENT_TYPE_MESSAGES (COPY-H-proj-5)', () => {
  it('resolves all three payment types on uk and en', async () => {
    await loadCatalog('uk')
    expect(i18n._(PAYMENT_TYPE_MESSAGES.FOP)).toBe('ФОП')
    expect(i18n._(PAYMENT_TYPE_MESSAGES.GIG_CONTRACT)).toBe('гіг-контракт')
    expect(i18n._(PAYMENT_TYPE_MESSAGES.USDT)).toBe('USDT')
    await loadCatalog('en')
    expect(i18n._(PAYMENT_TYPE_MESSAGES.FOP)).toBe('FOP')
    expect(i18n._(PAYMENT_TYPE_MESSAGES.GIG_CONTRACT)).toBe('gig contract')
    expect(i18n._(PAYMENT_TYPE_MESSAGES.USDT)).toBe('USDT')
  })
})
