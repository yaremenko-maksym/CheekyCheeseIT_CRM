import { describe, expect, it } from 'vitest'
import type { NotificationSubjectType } from '@crm/shared'
import {
  approvalChecksFor,
  approvalSubjectTypeFor,
  computeSubjectMissing,
  groupSubjectIds,
  liveApprovalKey,
  type SubjectRef,
} from './notification-subject-resolver'

const ref = (over: Partial<SubjectRef> = {}): SubjectRef => ({
  userId: 'u-1',
  type: 'PROJECT_MEMBER_ADDED',
  subjectType: 'PROJECT',
  subjectId: 'p-1',
  ...over,
})

const existing = (
  entries: [NotificationSubjectType, string[]][],
): Map<NotificationSubjectType, Set<string>> =>
  new Map(entries.map(([k, ids]) => [k, new Set(ids)]))

describe('approvalSubjectTypeFor', () => {
  it('подтверждение проекта проверяется согласованием PROJECT', () => {
    expect(approvalSubjectTypeFor('PROJECT_CONFIRM_REQUIRED', 'PROJECT')).toBe('PROJECT')
  })

  it('доля по проекту — PROJECT_SENIOR_SHARE, базовая доля — USER_SENIOR_SHARE', () => {
    expect(approvalSubjectTypeFor('SHARE_CONFIRM_REQUIRED', 'PROJECT')).toBe('PROJECT_SENIOR_SHARE')
    expect(approvalSubjectTypeFor('SHARE_CONFIRM_REQUIRED', 'USER')).toBe('USER_SENIOR_SHARE')
  })

  it('доля без вида объекта проверять нечем', () => {
    expect(approvalSubjectTypeFor('SHARE_CONFIRM_REQUIRED', null)).toBeNull()
    expect(approvalSubjectTypeFor('SHARE_CONFIRM_REQUIRED', 'TEAM')).toBeNull()
  })

  it('информирующий тип согласованием не проверяется', () => {
    expect(approvalSubjectTypeFor('TRANSACTION_ADDED', 'TRANSACTION')).toBeNull()
  })
})

describe('groupSubjectIds', () => {
  it('по одному запросу на вид объекта, без повторов', () => {
    const grouped = groupSubjectIds([
      ref(),
      ref({ subjectId: 'p-1' }),
      ref({ subjectId: 'p-2' }),
      ref({ subjectType: 'TEAM', subjectId: 't-1' }),
      ref({ subjectType: null, subjectId: null }),
      ref({ subjectType: 'USER', subjectId: null }),
      // Половинчатая строка: идентификатор есть, а вида объекта нет. Спрашивать
      // по ней нечего — вид объекта и есть таблица, в которую пошёл бы запрос.
      // Каждое из двух условий проверяется в ОДИНОЧКУ: пара «оба null» не
      // отличает «или» от любого из его слагаемых.
      ref({ subjectType: null, subjectId: 'orphan-1' }),
    ])
    expect([...grouped.keys()]).toEqual(['PROJECT', 'TEAM'])
    expect(grouped.get('PROJECT')).toEqual(['p-1', 'p-2'])
    expect(grouped.get('TEAM')).toEqual(['t-1'])
  })
})

describe('approvalChecksFor', () => {
  it('собирает только строки про согласование и не повторяет одинаковые', () => {
    expect(
      approvalChecksFor([
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        ref({ type: 'SHARE_CONFIRM_REQUIRED', subjectType: 'USER', subjectId: 'u-9' }),
        ref({ type: 'TEAM_NEW_MEMBER', subjectType: 'TEAM', subjectId: 't-1' }),
        ref({ type: 'PROJECT_CONFIRM_REQUIRED', subjectId: null }),
      ]),
    ).toEqual([
      { approvalSubjectType: 'PROJECT', subjectId: 'p-1', approverUserId: 'u-1' },
      { approvalSubjectType: 'USER_SENIOR_SHARE', subjectId: 'u-9', approverUserId: 'u-1' },
    ])
  })
})

describe('computeSubjectMissing', () => {
  it('строка без структурного объекта не считается исчезнувшей', () => {
    expect(
      computeSubjectMissing(
        ref({ type: 'INVOICE_SIGN_REQUIRED', subjectType: null, subjectId: null }),
        existing([]),
        new Set(),
      ),
    ).toBe(false)
  })

  it('идентификатор без вида объекта: спрашивать негде — значит, не исчезал', () => {
    // Вид объекта выбирает таблицу; без него запроса не было вовсе, и сказать
    // «объекта больше нет» не на чем. Строка проверяет ОДНО из двух условий
    // отдельно от второго.
    expect(
      computeSubjectMissing(
        ref({ subjectType: null, subjectId: 'p-1' }),
        existing([['PROJECT', ['p-1']]]),
        new Set(),
      ),
    ).toBe(false)
  })

  it('вид объекта без идентификатора: спрашивать не про что — значит, не исчезал', () => {
    // Зеркало предыдущей строки: второе условие отдельно от первого.
    expect(
      computeSubjectMissing(
        ref({ subjectType: 'PROJECT', subjectId: null }),
        existing([['PROJECT', ['p-1']]]),
        new Set(),
      ),
    ).toBe(false)
  })

  it('объект на месте — не исчез', () => {
    expect(computeSubjectMissing(ref(), existing([['PROJECT', ['p-1']]]), new Set())).toBe(false)
  })

  it('объекта нет среди существующих — исчез', () => {
    expect(computeSubjectMissing(ref(), existing([['PROJECT', ['p-2']]]), new Set())).toBe(true)
  })

  it('вида объекта не спрашивали вовсе — исчез', () => {
    expect(computeSubjectMissing(ref(), existing([['TEAM', ['p-1']]]), new Set())).toBe(true)
  })

  it('проект жив, но согласование погашено — кнопка честно говорит, что вести некуда', () => {
    expect(
      computeSubjectMissing(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        existing([['PROJECT', ['p-1']]]),
        new Set(),
      ),
    ).toBe(true)
  })

  it('проект жив и согласование живо — не исчез', () => {
    expect(
      computeSubjectMissing(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        existing([['PROJECT', ['p-1']]]),
        new Set([liveApprovalKey('PROJECT', 'p-1', 'u-1')]),
      ),
    ).toBe(false)
  })

  it('живое согласование ДРУГОГО подтверждающего этой строке не помогает', () => {
    expect(
      computeSubjectMissing(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        existing([['PROJECT', ['p-1']]]),
        new Set([liveApprovalKey('PROJECT', 'p-1', 'u-2')]),
      ),
    ).toBe(true)
  })
})
