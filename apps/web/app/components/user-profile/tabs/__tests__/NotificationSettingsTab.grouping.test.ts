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
import { createI18n } from '@crm/shared'
import {
  groupPreferences,
  isMoneyType,
  isRowInteractive,
  rowChecked,
  rowExplanation,
  rowExplanationId,
  rowTitle,
  type PreferenceRow,
} from '../NotificationSettingsTab'

function row(type: string, over: Partial<PreferenceRow> = {}): PreferenceRow {
  return { type, emailEnabled: true, locked: false, ...over }
}

// COPY-H-1 (copy-review круг 1, PR #714): `rowTitle` now renders the CANON
// `NOTIFICATION_TITLE_MESSAGES` on the caller's `I18n` instance — built once
// here per locale, same pattern as `notification-registry.spec.ts`'s `UK`/`EN`.
const UK = createI18n('uk')
const EN = createI18n('en')

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

  it('omits the admin group when canSeeAdminGroup is false, even when admin-only types are present in the input', () => {
    const items = [row('APPROVAL_CONFIRMED'), row('TRANSACTION_ADDED')]
    const groups = groupPreferences(items, false)
    expect(groups.find((g) => g.key === 'admin')).toBeUndefined()
  })

  it('includes the admin group, correctly titled and populated, when canSeeAdminGroup is true', () => {
    const items = [row('APPROVAL_CONFIRMED'), row('APPROVAL_REJECTED')]
    const groups = groupPreferences(items, true)
    const admin = groups.find((g) => g.key === 'admin')
    expect(admin?.title).toBe('Ваши предложения')
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
  // COPY-H-1 (copy-review круг 1, PR #714): known type renders the CANON
  // `NOTIFICATION_TITLE_MESSAGES` on the VIEWER's locale — the same source
  // the bell popup renders from — not the legacy `NOTIFICATION_TITLES`
  // record (ten Russian strings + three Ukrainian, unmigrated).
  it('known type on uk → the canon uk title, not the legacy Russian label', () => {
    expect(rowTitle(row('TRANSACTION_ADDED'), UK)).toBe('Вам додали транзакцію')
  })

  it('known type on en → an English title, not Russian or Ukrainian', () => {
    expect(rowTitle(row('TRANSACTION_ADDED'), EN)).toBe('Transaction added for you')
  })

  it('a frozen type (registered before this PR, unaffected) renders on both locales', () => {
    expect(rowTitle(row('INVOICE_SIGN_REQUIRED'), UK)).toBe('Рахунок на підпис')
    expect(rowTitle(row('INVOICE_SIGN_REQUIRED'), EN)).toBe('Invoice to sign')
  })

  // COPY-H-1 (copy-review, fix-round 2, PR #675): the raw enum value must
  // never be the VISIBLE label — see the comment on `rowTitle` itself.
  // COPY-L-4 (copy-review, fix-round 3, PR #675): "Уведомление" narrowed to
  // "Новый тип" — the row already sits inside the "Уведомления" tab, in a
  // table column headed "Тип уведомления"; the one thing this label needs
  // to add is that the type is new.
  it('unknown type → the "Новый тип" label, not the raw type string', () => {
    expect(rowTitle(row('FUTURE_TYPE_XYZ'), UK)).toBe('Новый тип')
  })
})

describe('rowExplanation', () => {
  it('locked row → the fixed "cannot disable" text, even for a nominally-unknown type', () => {
    expect(rowExplanation(row('PROJECT_CONFIRM_REQUIRED', { locked: true }))).toBe(
      'Письма о запросах на подтверждение и подпись отключить нельзя — без них процесс встанет.',
    )
  })

  // COPY-L-1 (copy-review, fix-round 2, PR #675).
  // COPY-L-4 (copy-review, fix-round 3, PR #675): dropped the repeated
  // "новый тип уведомления" — the row's own label now says "Новый тип"
  // right above this sentence.
  it('unlocked unknown type → the "new type" text', () => {
    expect(rowExplanation(row('FUTURE_TYPE_XYZ'))).toBe(
      'Настройка появится после обновления приложения.',
    )
  })

  it('unlocked known type → no explanation', () => {
    expect(rowExplanation(row('TRANSACTION_ADDED'))).toBeNull()
  })
})

describe('rowExplanationId', () => {
  // COPY-M-2 (copy-review, fix-round 2, PR #675): a locked row's
  // aria-describedby now points at the ONE shared group-level paragraph, not
  // a per-row id — same id regardless of which of the three locked types
  // this row is, but distinct per layout (desktop/mobile render the shared
  // paragraph in two separate DOM subtrees).
  it('locked row → the shared per-layout id, identical across different locked types', () => {
    expect(rowExplanationId(row('PROJECT_CONFIRM_REQUIRED', { locked: true }), 'desktop')).toBe(
      'notification-pref-explain-locked-desktop',
    )
    expect(rowExplanationId(row('SHARE_CONFIRM_REQUIRED', { locked: true }), 'desktop')).toBe(
      'notification-pref-explain-locked-desktop',
    )
    expect(rowExplanationId(row('PROJECT_CONFIRM_REQUIRED', { locked: true }), 'mobile')).toBe(
      'notification-pref-explain-locked-mobile',
    )
  })

  it('unlocked unknown type → a per-row, per-type id (unchanged from before COPY-M-2)', () => {
    expect(rowExplanationId(row('FUTURE_TYPE_XYZ'), 'desktop')).toBe(
      'notification-pref-explain-desktop-FUTURE_TYPE_XYZ',
    )
  })

  it('unlocked known type → no id at all', () => {
    expect(rowExplanationId(row('TRANSACTION_ADDED'), 'desktop')).toBeUndefined()
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
