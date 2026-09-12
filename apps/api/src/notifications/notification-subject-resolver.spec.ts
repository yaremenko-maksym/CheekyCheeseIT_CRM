import { describe, expect, it } from 'vitest'
import type { NotificationSubjectType } from '@crm/shared'
import {
  approvalChecksFor,
  approvalSubjectTypeFor,
  computeSubjectState,
  groupSubjectIds,
  liveApprovalKey,
  type SubjectRef,
  type SubjectState,
} from './notification-subject-resolver'

const ref = (over: Partial<SubjectRef> = {}): SubjectRef => ({
  userId: 'u-1',
  type: 'PROJECT_MEMBER_ADDED',
  subjectType: 'PROJECT',
  subjectId: 'p-1',
  ...over,
})

/** Всё найденное — живое: короткая запись для случаев, где архив ни при чём. */
const live = (
  entries: [NotificationSubjectType, string[]][],
): Map<NotificationSubjectType, Map<string, SubjectState>> =>
  new Map(entries.map(([k, ids]) => [k, new Map(ids.map((id) => [id, 'active' as SubjectState]))]))

/** То же, но состояние каждого объекта задаётся явно (QA-M-3 / QA-L-2). */
const archived = (
  entries: [NotificationSubjectType, [string, SubjectState][]][],
): Map<NotificationSubjectType, Map<string, SubjectState>> =>
  new Map(entries.map(([k, pairs]) => [k, new Map(pairs)]))

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

describe('computeSubjectState', () => {
  it('строка без структурного объекта не считается исчезнувшей', () => {
    expect(
      computeSubjectState(
        ref({ type: 'INVOICE_SIGN_REQUIRED', subjectType: null, subjectId: null }),
        live([]),
        new Set(),
      ),
    ).toBe('active')
  })

  it('идентификатор без вида объекта: спрашивать негде — значит, не исчезал', () => {
    // Вид объекта выбирает таблицу; без него запроса не было вовсе, и сказать
    // «объекта больше нет» не на чем. Строка проверяет ОДНО из двух условий
    // отдельно от второго.
    expect(
      computeSubjectState(
        ref({ subjectType: null, subjectId: 'p-1' }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
      ),
    ).toBe('active')
  })

  it('вид объекта без идентификатора: спрашивать не про что — значит, не исчезал', () => {
    // Зеркало предыдущей строки: второе условие отдельно от первого.
    expect(
      computeSubjectState(
        ref({ subjectType: 'PROJECT', subjectId: null }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
      ),
    ).toBe('active')
  })

  it('объект на месте — не исчез', () => {
    expect(computeSubjectState(ref(), live([['PROJECT', ['p-1']]]), new Set())).toBe('active')
  })

  it('объекта нет среди существующих — исчез', () => {
    expect(computeSubjectState(ref(), live([['PROJECT', ['p-2']]]), new Set())).toBe('missing')
  })

  it('вида объекта не спрашивали вовсе — исчез', () => {
    expect(computeSubjectState(ref(), live([['TEAM', ['p-1']]]), new Set())).toBe('missing')
  })

  it('проект жив, но согласование погашено — кнопка честно говорит, что вести некуда', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
      ),
    ).toBe('missing')
  })

  it('проект жив и согласование живо — не исчез', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        live([['PROJECT', ['p-1']]]),
        new Set([liveApprovalKey('PROJECT', 'p-1', 'u-1')]),
      ),
    ).toBe('active')
  })

  it('живое согласование ДРУГОГО подтверждающего этой строке не помогает', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        live([['PROJECT', ['p-1']]]),
        new Set([liveApprovalKey('PROJECT', 'p-1', 'u-2')]),
      ),
    ).toBe('missing')
  })
})

/**
 * QA-M-3 (MED) и QA-L-2 (LOW), manual-qa круг 2, #664.
 *
 * «Строка в таблице есть» — не то же самое, что «объект ещё живой». Живой
 * прогон: архивированный проект оставлял кнопку «Открыть проект» активной, и
 * джун, чьё членство завершилось каскадом архивации, приезжал на страницу с
 * текстом «Вас ещё не добавили в проект» — ложь про событие, которое БЫЛО.
 * Тот же класс уже чинили для контракта (QA-M-1), здесь он остался открытым
 * для трёх видов объекта сразу: проект, команда и профиль — у всех трёх есть
 * колонка `archived_at`.
 */
describe('computeSubjectState — архив это не удаление (QA-M-3 / QA-L-2)', () => {
  it('архивный проект — «в архиве», а не «удалён»', () => {
    expect(
      computeSubjectState(ref(), archived([['PROJECT', [['p-1', 'archived']]]]), new Set()),
    ).toBe('archived')
  })

  it('архивная команда — «в архиве»', () => {
    expect(
      computeSubjectState(
        ref({ type: 'TEAM_MEMBER_ADDED', subjectType: 'TEAM', subjectId: 't-1' }),
        archived([['TEAM', [['t-1', 'archived']]]]),
        new Set(),
      ),
    ).toBe('archived')
  })

  it('архивный профиль — «в архиве»', () => {
    expect(
      computeSubjectState(
        ref({ type: 'APPROVAL_CONFIRMED', subjectType: 'USER', subjectId: 'u-9' }),
        archived([['USER', [['u-9', 'archived']]]]),
        new Set(),
      ),
    ).toBe('archived')
  })

  it('состояние объекта сильнее живости согласования: архив не выдаётся за удаление', () => {
    // Порядок важен и проверяется отдельно: подпись выводится из состояния
    // ОБЪЕКТА, и «Проект удалён» на архивном проекте — ровно та ложь, ради
    // которой находка заведена. Погашенное согласование этого не меняет.
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        archived([['PROJECT', [['p-1', 'archived']]]]),
        new Set(),
      ),
    ).toBe('archived')
  })

  it('архив одного объекта не красит соседа того же вида', () => {
    expect(
      computeSubjectState(
        ref(),
        archived([
          [
            'PROJECT',
            [
              ['p-1', 'active'],
              ['p-2', 'archived'],
            ],
          ],
        ]),
        new Set(),
      ),
    ).toBe('active')
  })
})
