import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
} from '@crm/shared'

import { notificationEmailSkipReasonEnum, userEmailKindEnum } from '../database/schema'
import {
  backoffMs,
  decideDelivery,
  decideEnqueue,
  MAX_EMAIL_ATTEMPTS,
  pickEmailAddress,
  SKIP_REASONS,
  type DeliveryContext,
} from './notification-email-outbox'

/**
 * Решения очереди писем, вынесенные из сервиса и крона чистыми функциями:
 * «заводить ли строку» (постановка), «слать ли и куда» (отправка), «когда
 * повторить». Все проверяются здесь, потому что гейт мутаций не исполняет
 * интеграционных спек (`.claude/rules/common/mutation-gate-integration-specs.md`),
 * а ошибиться здесь дороже всего: первое молча теряет письмо, второе шлёт его
 * не тому — в том числе уволенному человеку на личную почту (SR-H-1).
 */

/** Контекст отправки по умолчанию: живой получатель, рабочий адрес, настройку не менял. */
function ctx(over: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    archived: false,
    addresses: [{ email: 'ivan@cheekycheese.tech', kind: 'WORK' }],
    emailEnabled: null,
    ...over,
  }
}

describe('decideEnqueue — что попадает в очередь при записи уведомления', () => {
  it('новый тип живому получателю встаёт в очередь', () => {
    for (const type of INFORMING_NOTIFICATION_TYPES) {
      expect(decideEnqueue(type, false)).toEqual({ status: 'QUEUED' })
    }
  })

  it('настройка канала на постановку НЕ влияет — строка всё равно QUEUED', () => {
    // SPEC-H-2 / CR-H-2 / SR-M-2: проверка настройки живёт в момент ОТПРАВКИ.
    // `decideEnqueue` не принимает настроек вовсе — именно поэтому «включил
    // канал после события, но до отправки» доносит письмо, а не теряет его.
    // Сигнатура и есть гарантия: нечего передать, значит нечем ошибиться.
    expect(decideEnqueue.length).toBe(2)
  })

  it('старый тип получает строку SKIPPED/LEGACY_TYPE, а не отсутствие строки', () => {
    // SPEC-H-1: след обязателен. «Строки нет» не отвечает на вопрос «почему
    // сотруднику не пришло письмо про X» — а именно за этим следом заказана
    // колонка `skip_reason`.
    expect(decideEnqueue('INVOICE_SIGN_REQUIRED', false)).toEqual({
      status: 'SKIPPED',
      skipReason: 'LEGACY_TYPE',
    })
    expect(decideEnqueue('VACANCY_APPLICATION', false)).toEqual({
      status: 'SKIPPED',
      skipReason: 'LEGACY_TYPE',
    })
  })

  it('архивированному получателю строка заводится сразу SKIPPED/USER_ARCHIVED', () => {
    // SPEC-H-4 / SR-H-1: архив — это увольнение. Письмо о внутренней жизни
    // компании бывшему сотруднику на личную почту — раскрытие, а не косметика.
    expect(decideEnqueue('TRANSACTION_ADDED', true)).toEqual({
      status: 'SKIPPED',
      skipReason: 'USER_ARCHIVED',
    })
  })

  it('у старого типа архивированному причина всё равно LEGACY_TYPE', () => {
    // Порядок причин зафиксирован: у типа, писем не имеющего вовсе, вопрос
    // «кто получатель» не встаёт. Мутант, переставивший ветки, красит этот
    // тест и соседний выше — иначе обе перестановки были бы неотличимы.
    expect(decideEnqueue('INVOICE_SIGN_REQUIRED', true)).toEqual({
      status: 'SKIPPED',
      skipReason: 'LEGACY_TYPE',
    })
  })
})

describe('decideDelivery — слать ли это письмо и куда, в момент отправки', () => {
  it('живому получателю с адресом — слать', () => {
    expect(decideDelivery('TRANSACTION_ADDED', ctx())).toEqual({
      send: true,
      to: 'ivan@cheekycheese.tech',
    })
  })

  it('архивированный получатель — SKIPPED/USER_ARCHIVED, даже когда адрес есть', () => {
    // Тот самый случай, которого не закрывает проверка на постановке: человека
    // архивировали ПОСЛЕ того, как строка встала в очередь (или пока шли
    // ретраи — до пяти попыток и часов ожидания).
    expect(
      decideDelivery(
        'TEAM_NEW_MEMBER',
        ctx({ archived: true, addresses: [{ email: 'ivan@gmail.com', kind: 'PERSONAL' }] }),
      ),
    ).toEqual({ send: false, skipReason: 'USER_ARCHIVED' })
  })

  it('архив перебивает и выключенный канал, и отсутствие адреса', () => {
    // Причина в следе должна называть САМОЕ сильное основание: «уволен»
    // объясняет непришедшее письмо, «нет адреса» — нет.
    expect(
      decideDelivery(
        'TRANSACTION_ADDED',
        ctx({ archived: true, addresses: [], emailEnabled: false }),
      ),
    ).toEqual({ send: false, skipReason: 'USER_ARCHIVED' })
  })

  it('выключенный пользователем тип — SKIPPED/CHANNEL_OFF', () => {
    // AC6: «настройки применяются». Проверяется в момент отправки, поэтому
    // выключение действует и на уже поставленные письма.
    expect(decideDelivery('TRANSACTION_ADDED', ctx({ emailEnabled: false }))).toEqual({
      send: false,
      skipReason: 'CHANNEL_OFF',
    })
  })

  it('включённый явно тип уходит так же, как тип без записи', () => {
    expect(decideDelivery('TRANSACTION_ADDED', ctx({ emailEnabled: true }))).toEqual({
      send: true,
      to: 'ivan@cheekycheese.tech',
    })
  })

  it('тип, требующий действия, уходит ДАЖЕ с записью «выключено»', () => {
    // §3: «письма про подтверждения и подписи отключить нельзя — иначе
    // процесс встаёт молча». Разбор запроса такую запись не пропустит, но в
    // базу она может попасть мимо API (руками, миграцией, прежней версией) —
    // последний рубеж здесь.
    for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
      expect(decideDelivery(type, ctx({ emailEnabled: false }))).toEqual({
        send: true,
        to: 'ivan@cheekycheese.tech',
      })
    }
  })

  it('письма админу выключаются как обычные', () => {
    for (const type of ADMIN_NOTIFICATION_TYPES) {
      expect(decideDelivery(type, ctx({ emailEnabled: false }))).toEqual({
        send: false,
        skipReason: 'CHANNEL_OFF',
      })
    }
  })

  it('старый тип не уходит даже из очереди — SKIPPED/LEGACY_TYPE', () => {
    // Строка такого типа заводится уже пропущенной и крону не достаётся. Но
    // если она там окажется (вписана руками, осталась от прежней версии),
    // письма, текста которого никто не писал, всё равно не будет.
    expect(decideDelivery('INVOICE_SIGN_REQUIRED', ctx())).toEqual({
      send: false,
      skipReason: 'LEGACY_TYPE',
    })
  })

  it('нет ни одного адреса — SKIPPED/NO_ADDRESS, а не FAILED', () => {
    // Круг 1 писал здесь `FAILED` с текстом в `last_error`, и «не смогли
    // отправить» становилось неотличимо от «не полагалось отправлять»
    // (SR-L-2). Повторять тут нечего: каждая следующая попытка дала бы то же.
    expect(decideDelivery('TRANSACTION_ADDED', ctx({ addresses: [] }))).toEqual({
      send: false,
      skipReason: 'NO_ADDRESS',
    })
  })

  it('личный адрес предпочитается рабочему и на отправке тоже', () => {
    expect(
      decideDelivery(
        'TRANSACTION_ADDED',
        ctx({
          addresses: [
            { email: 'ivan@cheekycheese.tech', kind: 'WORK' },
            { email: 'ivan@gmail.com', kind: 'PERSONAL' },
          ],
        }),
      ),
    ).toEqual({ send: true, to: 'ivan@gmail.com' })
  })

  it('выключенный канал перебивает отсутствие адреса', () => {
    // Обе причины терминальны, но «сам выключил» — то, что объясняет
    // непришедшее письмо человеку, а «нет адреса» — то, что требует от
    // администратора действия. Путать их значило бы звать чинить то, что
    // работает как задумано.
    expect(
      decideDelivery('TRANSACTION_ADDED', ctx({ addresses: [], emailEnabled: false })),
    ).toEqual({ send: false, skipReason: 'CHANNEL_OFF' })
  })
})

describe('коды причин пропуска', () => {
  it('перечень в коде совпадает с типом в базе', () => {
    // Два описания одного набора — Postgres-enum и союз в TypeScript.
    // Разойдутся — запись упадёт на проде, а не в тесте.
    expect([...SKIP_REASONS].sort()).toEqual([...notificationEmailSkipReasonEnum.enumValues].sort())
  })

  it('все четыре причины из задания на месте', () => {
    expect([...SKIP_REASONS].sort()).toEqual([
      'CHANNEL_OFF',
      'LEGACY_TYPE',
      'NO_ADDRESS',
      'USER_ARCHIVED',
    ])
  })
})

describe('pickEmailAddress', () => {
  const personal = { email: 'ivan@gmail.com', kind: 'PERSONAL' as const }
  const work = { email: 'ivan@cheekycheese.tech', kind: 'WORK' as const }

  it('личный адрес предпочитается рабочему', () => {
    expect(pickEmailAddress([work, personal])).toBe('ivan@gmail.com')
  })

  it('порядок строк из базы значения не имеет', () => {
    expect(pickEmailAddress([personal, work])).toBe('ivan@gmail.com')
  })

  it('без личного уходит на рабочий', () => {
    expect(pickEmailAddress([work])).toBe('ivan@cheekycheese.tech')
  })

  it('без адресов вовсе — некуда слать', () => {
    expect(pickEmailAddress([])).toBeNull()
  })

  it('видов адреса ровно два — на этом держится выбор «личный, иначе любой»', () => {
    // Не украшение: `pickEmailAddress` после отбора личного берёт ПЕРВУЮ
    // оставшуюся строку, и это верно ровно потому, что оставшаяся может быть
    // только рабочей. Появится третий вид — тест покраснеет здесь, и выбор
    // придётся переписать осознанно.
    expect(userEmailKindEnum.enumValues).toEqual(['WORK', 'PERSONAL'])
  })
})

describe('backoffMs', () => {
  it.each([
    [1, 120_000],
    [2, 240_000],
    [3, 480_000],
    [4, 960_000],
    [5, 1_920_000],
    [6, 3_600_000],
  ])('после %i-й неудачи ждать %i мс', (attempt, expected) => {
    // Таблица задания дословно: `min(2^attempts, 60)` минут — 2/4/8/16/32/60
    // (SPEC-M-3 / CR-M-1; круг 1 считал `2^(attempts-1)` и ретраил вдвое
    // чаще). Значения выписаны, а не вычислены той же формулой: проверка,
    // повторяющая формулу, согласилась бы с любой другой.
    expect(backoffMs(attempt)).toBe(expected)
  })

  it('первая пауза — две минуты, а не одна', () => {
    // Ровно то число, которым круг 1 разошёлся с заданием. Без этой строки
    // сдвиг экспоненты на единицу читался бы как «тоже экспонента».
    expect(backoffMs(1)).toBe(2 * 60_000)
  })

  it('пауза имеет потолок в час', () => {
    // Проверяется ЗА пределом удвоений, иначе потолок неотличим от их
    // отсутствия: на пятой попытке 1 920 000 мс до него ещё не доходит.
    expect(backoffMs(MAX_EMAIL_ATTEMPTS)).toBeLessThan(60 * 60 * 1000)
    expect(backoffMs(10)).toBe(60 * 60 * 1000)
    expect(backoffMs(99)).toBe(60 * 60 * 1000)
  })
})
