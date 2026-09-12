import { describe, expect, it } from 'vitest'
import type { ApprovalStatus, NotificationSubjectType } from '@crm/shared'
import {
  approvalIdFromData,
  approvalIdsToCheck,
  awaitsApproval,
  classifyApprovalRow,
  computeSubjectState,
  groupSubjectIds,
  type SubjectRef,
  type SubjectState,
} from './notification-subject-resolver'

const ref = (over: Partial<SubjectRef> = {}): SubjectRef => ({
  userId: 'u-1',
  type: 'PROJECT_MEMBER_ADDED',
  subjectType: 'PROJECT',
  subjectId: 'p-1',
  approvalId: 'a-1',
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

describe('awaitsApproval', () => {
  it('подтверждение проекта и предложение доли зависят от строки согласования', () => {
    expect(awaitsApproval('PROJECT_CONFIRM_REQUIRED')).toBe(true)
    expect(awaitsApproval('SHARE_CONFIRM_REQUIRED')).toBe(true)
  })

  it('информирующий тип — не зависит', () => {
    expect(awaitsApproval('TRANSACTION_ADDED')).toBe(false)
    expect(awaitsApproval('DOCUMENT_SIGN_REQUIRED')).toBe(false)
  })
})

/**
 * QA-H-1 (manual-qa круг 3, #664). `data` — `jsonb`: форму гарантирует запись,
 * а не чтение, поэтому каждый способ НЕ найти идентификатор проверяется
 * отдельно. Строка с чужими данными обязана приехать без идентификатора, а не
 * уронить чтение всего списка.
 */
describe('approvalIdFromData', () => {
  const validUuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

  it('идентификатор строки согласования — из данных производителя', () => {
    expect(approvalIdFromData({ projectName: 'Acme', approvalId: validUuid })).toBe(validUuid)
  })

  it('данных нет вовсе', () => {
    expect(approvalIdFromData(null)).toBeNull()
    expect(approvalIdFromData(undefined)).toBeNull()
  })

  it('данные не объект', () => {
    expect(approvalIdFromData('a-7')).toBeNull()
    expect(approvalIdFromData(42)).toBeNull()
  })

  it('ключа нет', () => {
    expect(approvalIdFromData({ projectName: 'Acme' })).toBeNull()
  })

  it('ключ есть, но не строка или пустой', () => {
    expect(approvalIdFromData({ approvalId: 7 })).toBeNull()
    expect(approvalIdFromData({ approvalId: null })).toBeNull()
    expect(approvalIdFromData({ approvalId: '' })).toBeNull()
  })

  /**
   * SR-M-18 (security-review круг 6, #664). `approvals.id` — колонка `uuid`;
   * строка не той формы, доехавшая до `inArray(approvals.id, …)`, роняет
   * запрос ошибкой Postgres `22P02` — а с ним весь `GET /api/notifications`
   * этого пользователя, а не одну строку. Раньше сюда проходила ЛЮБАЯ
   * непустая строка, в том числе такая, как `'a-7'` в тесте выше — отсюда
   * смена его ожидания на невалидный uuid.
   */
  it('SR-M-18: строка не в форме uuid не проходит — иначе она уронит запрос к approvals', () => {
    expect(approvalIdFromData({ approvalId: 'a-7' })).toBeNull()
    expect(approvalIdFromData({ approvalId: 'garbage' })).toBeNull()
    expect(approvalIdFromData({ approvalId: 'not-a-uuid-at-all' })).toBeNull()
  })

  it('SR-M-18: валидный uuid — в любом регистре — проходит', () => {
    expect(approvalIdFromData({ approvalId: validUuid })).toBe(validUuid)
    expect(approvalIdFromData({ approvalId: validUuid.toUpperCase() })).toBe(
      validUuid.toUpperCase(),
    )
  })
})

/**
 * SR-M-18 (security-review круг 6, #664). Не-uuid обязан отсеяться уже на
 * этапе разбора данных (`approvalIdFromData`) — значит он физически не может
 * попасть в `approvalIdsToCheck`, а оттуда в `inArray(approvals.id, …)`.
 * Проверяется весь путь «данные производителя → список к запросу», а не
 * только парсер в изоляции.
 */
describe('SR-M-18: не-uuid не попадает в запрос к approvals', () => {
  it('строка с мусором в data.approvalId не отдаёт идентификатор в approvalIdsToCheck', () => {
    const garbageRow: SubjectRef = {
      ...ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
      approvalId: approvalIdFromData({ approvalId: 'garbage' }),
    }
    expect(garbageRow.approvalId).toBeNull()
    expect(approvalIdsToCheck([garbageRow])).toEqual([])
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

describe('approvalIdsToCheck', () => {
  it('собирает только строки про согласование и не повторяет одинаковые', () => {
    expect(
      approvalIdsToCheck([
        ref({ type: 'PROJECT_CONFIRM_REQUIRED', approvalId: 'a-1' }),
        ref({ type: 'PROJECT_CONFIRM_REQUIRED', approvalId: 'a-1' }),
        ref({ type: 'SHARE_CONFIRM_REQUIRED', subjectType: 'USER', approvalId: 'a-2' }),
        // Информирующий тип: у него идентификатора согласования и не бывает,
        // спрашивать нечего.
        ref({ type: 'TEAM_NEW_MEMBER', subjectType: 'TEAM', approvalId: 'a-3' }),
        // QA-H-1: два ПОКОЛЕНИЯ одного предложения — разные строки, и
        // спрашивать надо про обе. Раньше ключ у них совпадал, и именно это
        // оставляло старое уведомление активным.
        ref({ type: 'SHARE_CONFIRM_REQUIRED', subjectType: 'USER', approvalId: 'a-4' }),
        ref({ type: 'PROJECT_CONFIRM_REQUIRED', approvalId: null }),
      ]),
    ).toEqual(['a-1', 'a-2', 'a-4'])
  })
})

describe('computeSubjectState', () => {
  it('строка без структурного объекта не считается исчезнувшей', () => {
    expect(
      computeSubjectState(
        ref({ type: 'INVOICE_SIGN_REQUIRED', subjectType: null, subjectId: null }),
        live([]),
        new Set(),
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
        new Set(),
      ),
    ).toBe('active')
  })

  it('объект на месте — не исчез', () => {
    expect(computeSubjectState(ref(), live([['PROJECT', ['p-1']]]), new Set(), new Set())).toBe(
      'active',
    )
  })

  it('объекта нет среди существующих — исчез', () => {
    expect(computeSubjectState(ref(), live([['PROJECT', ['p-2']]]), new Set(), new Set())).toBe(
      'missing',
    )
  })

  it('вида объекта не спрашивали вовсе — исчез', () => {
    expect(computeSubjectState(ref(), live([['TEAM', ['p-1']]]), new Set(), new Set())).toBe(
      'missing',
    )
  })

  it('проект жив и согласование живо — не исчез', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        live([['PROJECT', ['p-1']]]),
        new Set(['a-1']),
        new Set(),
      ),
    ).toBe('active')
  })
})

/**
 * ORCH-2 (fix-раунд 6, #664). Раньше «проект жив, но согласование по нему
 * больше не актуально» было ОДНИМ ответом («missing») — тем же, что и
 * «проекта нет вовсе». Живой прогон круга 5 поймал это как ложь: «Проект
 * удалён» на существующем проекте, чьё предложение просто отозвали. Теперь
 * два разных ответа: «отозвано» (нет живой строки для ЭТОГО подтверждающего)
 * и «решено» (строка есть, но статус её сдвинулся с PENDING, а генерацию
 * никто не гасил).
 */
describe('computeSubjectState — объект жив, согласование по нему уже нет (ORCH-2)', () => {
  it('нет ни живой, ни решённой строки — решения больше не ждут', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
        new Set(),
      ),
    ).toBe('approvalSuperseded')
  })

  it('живая строка ДРУГОГО поколения этой не помогает — решения больше не ждут', () => {
    // QA-H-1 (manual-qa круг 3, #664) — СУТЬ находки в одной строке. Раньше
    // ключом была тройка «вид + объект + подтверждающий», одинаковая у обоих
    // поколений: живое НОВОЕ предложение делало активным и СТАРОЕ уведомление,
    // и синьор видел два «Предложение по доле» с разными процентами. Теперь
    // строка опознаётся идентификатором, и чужое поколение ей не засчитывается.
    expect(
      computeSubjectState(
        ref({ type: 'SHARE_CONFIRM_REQUIRED', subjectType: 'USER', approvalId: 'a-old' }),
        live([['USER', ['p-1']]]),
        new Set(['a-new']),
        new Set(),
      ),
    ).toBe('approvalSuperseded')
  })

  it('этот же подтверждающий уже решил — «решено», а не «больше не требуется»', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
        new Set(['a-1']),
      ),
    ).toBe('approvalDecided')
  })

  it('решённая строка ЧУЖОГО поколения этой не помогает', () => {
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED', approvalId: 'a-old' }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
        new Set(['a-new']),
      ),
    ).toBe('approvalSuperseded')
  })

  it('идентификатора строки нет — кнопка остаётся, утверждать нечего', () => {
    // Написать такую строку могла только сборка до круга 3: оба производителя
    // кладут идентификатор, и форма данных его требует. Сказать про неё
    // «решение больше не требуется» значило бы утверждать факт, которого мы не
    // знаем; страница объекта покажет настоящее состояние предложения.
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED', approvalId: null }),
        live([['PROJECT', ['p-1']]]),
        new Set(),
        new Set(),
      ),
    ).toBe('active')
  })

  it('состояние объекта сильнее живости согласования: архив не путается с отозванным предложением', () => {
    // Тот же порядок, что и у QA-M-3/QA-L-2 ниже для «удалён» — архив решает
    // РАНЬШЕ, чем разбор вообще доходит до вопроса про согласование.
    expect(
      computeSubjectState(
        ref({ type: 'PROJECT_CONFIRM_REQUIRED' }),
        archived([['PROJECT', [['p-1', 'archived']]]]),
        new Set(),
        new Set(),
      ),
    ).toBe('archived')
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
      computeSubjectState(
        ref(),
        archived([['PROJECT', [['p-1', 'archived']]]]),
        new Set(),
        new Set(),
      ),
    ).toBe('archived')
  })

  it('архивная команда — «в архиве»', () => {
    expect(
      computeSubjectState(
        ref({ type: 'TEAM_MEMBER_ADDED', subjectType: 'TEAM', subjectId: 't-1' }),
        archived([['TEAM', [['t-1', 'archived']]]]),
        new Set(),
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
        new Set(),
      ),
    ).toBe('active')
  })
})

/**
 * Страж исчерпаемости — тот же приём и та же причина, что у
 * `describeNotification` (CR-M-1, круг 1): состояние объекта собирается
 * вручную из колонки `archived_at`, и значение, которого разбор не ждёт,
 * обязано ронять его громко. Молча — это активная кнопка на объекте, про
 * который ничего не известно.
 *
 * Доехать сюда, не обманув компилятор, нельзя — поэтому тест и обманывает его
 * приведением: иначе ветка осталась бы без единого исполнения, а гейт мутаций
 * отчитывался бы по ней «нет покрытия».
 */
describe('computeSubjectState — неизвестное состояние роняет разбор, а не превращается в «живой»', () => {
  it('падает с названием состояния', () => {
    const broken = new Map([
      ['PROJECT', new Map([['p-1', 'ЧТО-ТО ТРЕТЬЕ' as SubjectState]])],
    ]) as Map<NotificationSubjectType, Map<string, SubjectState>>
    expect(() => computeSubjectState(ref(), broken, new Set(), new Set())).toThrow('ЧТО-ТО ТРЕТЬЕ')
  })
})

/**
 * ORCH-2 (fix-раунд 6, #664). Строка `approvals` с `supersededAt IS NULL`
 * классифицируется по `status` — живая ждёт ответа, решённая уже получила
 * его от ЭТОГО подтверждающего. `CANCELLED` проверяется defensively: сегодня
 * она всегда приходит вместе с `supersededAt` (`ApprovalsService.cancelInTx`
 * ставит оба поля одной записью), но это инвариант сервиса, а не базы —
 * явная ветка не даёт ему молча стать «живым», если инвариант когда-нибудь
 * нарушат.
 */
describe('classifyApprovalRow', () => {
  it('PENDING — живая', () => {
    expect(classifyApprovalRow('PENDING')).toBe('live')
  })

  it('APPROVED — решённая', () => {
    expect(classifyApprovalRow('APPROVED')).toBe('decided')
  })

  it('REJECTED — тоже решённая (подтверждающий ответил, просто отказом)', () => {
    expect(classifyApprovalRow('REJECTED')).toBe('decided')
  })

  it('CANCELLED — не живая и не решённая (сегодня defensively, см. doc-комментарий)', () => {
    expect(classifyApprovalRow('CANCELLED')).toBe('superseded')
  })

  it('неизвестный статус роняет разбор, а не становится «живым»', () => {
    expect(() => classifyApprovalRow('ЧТО-ТО ЧЕТВЁРТОЕ' as ApprovalStatus)).toThrow(
      'ЧТО-ТО ЧЕТВЁРТОЕ',
    )
  })
})
