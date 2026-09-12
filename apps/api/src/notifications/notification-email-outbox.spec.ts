import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
} from '@crm/shared'

import { userEmailKindEnum } from '../database/schema'
import {
  backoffMs,
  MAX_EMAIL_ATTEMPTS,
  pickEmailAddress,
  shouldQueueEmail,
} from './notification-email-outbox'

/**
 * Два решения очереди, вынесенные из сервиса и крона отдельными функциями:
 * «ставить ли письмо» и «на какой адрес». Оба — чистые, и оба проверяются
 * здесь, потому что гейт мутаций не исполняет интеграционных спек
 * (`.claude/rules/common/mutation-gate-integration-specs.md`), а именно эти
 * два решения дороже всего ошибиться: первое молча теряет письмо, второе
 * шлёт его не тому.
 */
describe('shouldQueueEmail', () => {
  it('ставит письмо, когда настройки пользователя пусты', () => {
    // Умолчание — «письма идут». Пустой список означает, что человек ни разу
    // не заходил в настройки, а не что он всё выключил.
    for (const type of INFORMING_NOTIFICATION_TYPES) {
      expect(shouldQueueEmail(type, new Map())).toBe(true)
    }
  })

  it('не ставит письмо информирующего типа, выключенного пользователем', () => {
    const prefs = new Map([['TRANSACTION_ADDED', false]])
    expect(shouldQueueEmail('TRANSACTION_ADDED', prefs)).toBe(false)
  })

  it('выключение одного типа не задевает соседний', () => {
    const prefs = new Map([['TRANSACTION_ADDED', false]])
    expect(shouldQueueEmail('TEAM_MEMBER_ADDED', prefs)).toBe(true)
  })

  it('ставит письмо типа, требующего действия, даже если запись говорит «выключено»', () => {
    // Запись «выключено» для такого типа не может появиться через API
    // (`updateNotificationPreferencesSchema` её отвергает), но может остаться
    // от прежней версии или быть вписана руками в базу. §3: «иначе процесс
    // встаёт молча». Последний рубеж — здесь, а не только в разборе запроса.
    for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
      expect(shouldQueueEmail(type, new Map([[type, false]]))).toBe(true)
    }
  })

  it('уведомления админу выключаются как обычные', () => {
    for (const type of ADMIN_NOTIFICATION_TYPES) {
      expect(shouldQueueEmail(type, new Map([[type, false]]))).toBe(false)
    }
  })

  it('старому типу без письма очередь не заводится', () => {
    // Три старых типа (инвойсы, вакансии) писем не имеют: у них нет ни
    // шаблона, ни настройки, и ставить их в очередь значило бы слать письмо,
    // текста которого никто не писал.
    expect(shouldQueueEmail('INVOICE_SIGN_REQUIRED', new Map())).toBe(false)
    expect(shouldQueueEmail('VACANCY_APPLICATION', new Map())).toBe(false)
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
    [1, 60_000],
    [2, 120_000],
    [3, 240_000],
    [4, 480_000],
    [5, 960_000],
  ])('после %i-й неудачи ждать %i мс', (attempt, expected) => {
    // Значения выписаны, а не вычислены той же формулой: удвоение от минуты —
    // решение, и проверка, повторяющая формулу, согласилась бы с любой другой.
    expect(backoffMs(attempt)).toBe(expected)
  })

  it('первая пауза не короче минуты — провайдер, ответивший 429, не станет добрее через секунду', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(60_000)
  })

  it('пауза имеет потолок в час', () => {
    // Потолок нужен, чтобы пятая попытка случилась в тот же рабочий день.
    // Проверяется ЗА пределом удвоений, иначе потолок неотличим от их
    // отсутствия: на пятой попытке 960 000 мс до него ещё не доходит.
    expect(backoffMs(MAX_EMAIL_ATTEMPTS)).toBeLessThan(60 * 60 * 1000)
    expect(backoffMs(10)).toBe(60 * 60 * 1000)
    expect(backoffMs(99)).toBe(60 * 60 * 1000)
  })
})
