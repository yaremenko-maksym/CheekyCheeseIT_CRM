/**
 * NotificationSettingsTab.grouping.test.ts — task-notification-settings-ui
 * (position 7b), AC2.
 *
 * Pure-function tests for the grouping/row-derivation helpers exported by
 * `NotificationSettingsTab.tsx` (design spec §2) — the correct seam for this
 * logic (`codebase-design`): a full DOM render cannot cheaply distinguish
 * "predicate by type-name" from "predicate by array position", or assert an
 * EMPTY group is dropped (an empty group renders nothing either way, so a
 * render-only test cannot tell "correctly omitted" from "included but
 * invisible").
 */
import { describe, expect, it } from 'vitest'
import {
  groupPreferences,
  isMoneyType,
  isRowInteractive,
  rowChecked,
  rowExplanation,
  rowTitle,
  type PreferenceRow,
} from '../NotificationSettingsTab'

function row(type: string, over: Partial<PreferenceRow> = {}): PreferenceRow {
  return { type, emailEnabled: true, locked: false, ...over }
}

describe('isMoneyType', () => {
  it('true for TRANSACTION_* types', () => {
    expect(isMoneyType('TRANSACTION_ADDED')).toBe(true)
    expect(isMoneyType('TRANSACTION_STATUS_CHANGED')).toBe(true)
  })

  it('false for any other type name', () => {
    expect(isMoneyType('TEAM_MEMBER_ADDED')).toBe(false)
    expect(isMoneyType('APPROVAL_CONFIRMED')).toBe(false)
  })
})

describe('groupPreferences', () => {
  it('splits informing types into money (TRANSACTION_*) vs team (the rest) — by NAME, not position', () => {
    // Deliberately out of registry order — a position-based predicate would
    // mis-split this; a name-based one (isMoneyType) will not.
    const items = [
      row('TEAM_MEMBER_ADDED'),
      row('TRANSACTION_ADDED'),
      row('PROJECT_MEMBER_ADDED'),
      row('TRANSACTION_STATUS_CHANGED'),
      row('TEAM_NEW_MEMBER'),
    ]
    const groups = groupPreferences(items, false)
    const money = groups.find((g) => g.key === 'money')
    const team = groups.find((g) => g.key === 'team')
    expect(money?.title).toBe('Деньги')
    expect(money?.rows.map((r) => r.type)).toEqual([
      'TRANSACTION_ADDED',
      'TRANSACTION_STATUS_CHANGED',
    ])
    expect(team?.title).toBe('Команда и проекты')
    expect(team?.rows.map((r) => r.type)).toEqual([
      'TEAM_MEMBER_ADDED',
      'PROJECT_MEMBER_ADDED',
      'TEAM_NEW_MEMBER',
    ])
  })

  it('groups the three action-required types under "Требуют ответа"', () => {
    const items = [row('PROJECT_CONFIRM_REQUIRED', { locked: true }), row('TRANSACTION_ADDED')]
    const groups = groupPreferences(items, false)
    const ar = groups.find((g) => g.key === 'action-required')
    expect(ar?.title).toBe('Требуют ответа')
    expect(ar?.rows.map((r) => r.type)).toEqual(['PROJECT_CONFIRM_REQUIRED'])
  })

  it('omits the admin group for a non-admin viewer, even when admin-only types are present in the input', () => {
    const items = [row('APPROVAL_CONFIRMED'), row('TRANSACTION_ADDED')]
    const groups = groupPreferences(items, false)
    expect(groups.find((g) => g.key === 'admin')).toBeUndefined()
  })

  it('includes the admin group, correctly titled and populated, for an admin viewer', () => {
    const items = [row('APPROVAL_CONFIRMED'), row('APPROVAL_REJECTED')]
    const groups = groupPreferences(items, true)
    const admin = groups.find((g) => g.key === 'admin')
    expect(admin?.title).toBe('Для администратора')
    expect(admin?.rows.map((r) => r.type)).toEqual(['APPROVAL_CONFIRMED', 'APPROVAL_REJECTED'])
  })

  it('drops a group whose row list is empty (no money types present) instead of returning it empty', () => {
    const items = [row('TEAM_MEMBER_ADDED')]
    const groups = groupPreferences(items, false)
    expect(groups.map((g) => g.key)).toEqual(['team'])
  })

  it('appends an untitled trailing group for unknown types, and omits it entirely when there are none', () => {
    const withUnknown = groupPreferences([row('TRANSACTION_ADDED'), row('FUTURE_TYPE_XYZ')], false)
    const unknownGroup = withUnknown.find((g) => g.key === 'unknown')
    expect(unknownGroup?.title).toBeNull()
    expect(unknownGroup?.rows.map((r) => r.type)).toEqual(['FUTURE_TYPE_XYZ'])

    const withoutUnknown = groupPreferences([row('TRANSACTION_ADDED')], false)
    expect(withoutUnknown.find((g) => g.key === 'unknown')).toBeUndefined()
  })
})

describe('rowTitle', () => {
  it('known type → the shared NOTIFICATION_TITLES label', () => {
    expect(rowTitle(row('TRANSACTION_ADDED'))).toBe('Вам добавили транзакцию')
  })

  it('unknown type → the raw type string (no crash, no translation)', () => {
    expect(rowTitle(row('FUTURE_TYPE_XYZ'))).toBe('FUTURE_TYPE_XYZ')
  })
})

describe('rowExplanation', () => {
  it('locked row → the fixed "cannot disable" text, even for a nominally-unknown type', () => {
    expect(rowExplanation(row('PROJECT_CONFIRM_REQUIRED', { locked: true }))).toBe(
      'Письма о запросах на подтверждение и подпись отключить нельзя — без них процесс встанет.',
    )
  })

  it('unlocked unknown type → the "new type" text', () => {
    expect(rowExplanation(row('FUTURE_TYPE_XYZ'))).toBe(
      'Новый тип уведомления, ожидайте обновления интерфейса.',
    )
  })

  it('unlocked known type → no explanation', () => {
    expect(rowExplanation(row('TRANSACTION_ADDED'))).toBeNull()
  })
})

describe('isRowInteractive', () => {
  it('false when locked', () => {
    expect(isRowInteractive(row('PROJECT_CONFIRM_REQUIRED', { locked: true }))).toBe(false)
  })

  it('false when the type is unknown, even if not locked', () => {
    expect(isRowInteractive(row('FUTURE_TYPE_XYZ'))).toBe(false)
  })

  it('true for a known, unlocked type', () => {
    expect(isRowInteractive(row('TRANSACTION_ADDED'))).toBe(true)
  })
})

describe('rowChecked', () => {
  it('locked row is forced true, even if the server sent emailEnabled: false', () => {
    expect(rowChecked(row('PROJECT_CONFIRM_REQUIRED', { locked: true, emailEnabled: false }))).toBe(
      true,
    )
  })

  it('unlocked row mirrors the server value, in both directions', () => {
    expect(rowChecked(row('TRANSACTION_ADDED', { emailEnabled: true }))).toBe(true)
    expect(rowChecked(row('TRANSACTION_ADDED', { emailEnabled: false }))).toBe(false)
  })
})
