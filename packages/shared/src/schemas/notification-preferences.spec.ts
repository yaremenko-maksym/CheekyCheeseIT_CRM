import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
} from './notification-registry'
import {
  isEmailChannelLocked,
  notificationPreferencesResponseSchema,
  updateNotificationPreferencesSchema,
} from './notification-preferences'

/**
 * Настройки каналов — позиция 7a, §3 решение 6 («каналы настраивает сам
 * сотрудник») и §3 допущение «письма про подтверждения и подписи отключить
 * нельзя — приглушить можно, выключить нет».
 *
 * Форма проверяется здесь, в общем пакете, потому что `locked` — не свойство
 * пользователя и не строка в базе, а свойство ТИПА: он выводится из состава
 * `ACTION_REQUIRED_NOTIFICATION_TYPES`, который живёт в реестре рядом. Запись
 * «выключено» для такого типа не должна существовать ни в базе, ни в теле
 * запроса, и запрет обязан читаться одинаково сервером и клиентом (7b).
 */
describe('isEmailChannelLocked', () => {
  it('заперт для каждого типа, требующего действия', () => {
    for (const type of ACTION_REQUIRED_NOTIFICATION_TYPES) {
      expect(isEmailChannelLocked(type)).toBe(true)
    }
  })

  it('свободен для каждого информирующего типа', () => {
    for (const type of INFORMING_NOTIFICATION_TYPES) {
      expect(isEmailChannelLocked(type)).toBe(false)
    }
  })

  it('свободен для уведомлений админу', () => {
    // Админ узнаёт об отказе письмом, но это не «требует действия» в смысле
    // §7.2 — процесс не встаёт, если он читает их только в CRM.
    for (const type of ADMIN_NOTIFICATION_TYPES) {
      expect(isEmailChannelLocked(type)).toBe(false)
    }
  })

  it('ровно три типа заперты — не больше и не меньше', () => {
    const locked = NEW_NOTIFICATION_TYPES.filter((t) => isEmailChannelLocked(t))
    expect(locked).toEqual([
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
    ])
  })
})

describe('updateNotificationPreferencesSchema', () => {
  it('принимает выключение информирующего типа', () => {
    const parsed = updateNotificationPreferencesSchema.parse({
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })
    expect(parsed.items[0]).toEqual({ type: 'TRANSACTION_ADDED', emailEnabled: false })
  })

  it('отвергает выключение письма у типа, требующего действия', () => {
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [{ type: 'SHARE_CONFIRM_REQUIRED', emailEnabled: false }],
    })
    expect(result.success).toBe(false)
  })

  it('принимает включение у типа, требующего действия — он и так включён', () => {
    // Запрет односторонний: «приглушить можно, выключить нет». Запрос,
    // который просит ВКЛЮЧИТЬ уже включённое, — не попытка обойти правило, и
    // отвечать на него отказом значило бы ломать клиента, который шлёт всю
    // форму целиком.
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [{ type: 'DOCUMENT_SIGN_REQUIRED', emailEnabled: true }],
    })
    expect(result.success).toBe(true)
  })

  it('отвергает неизвестный тип', () => {
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [{ type: 'INVOICE_SIGN_REQUIRED', emailEnabled: false }],
    })
    // Три старых типа (инвойсы, вакансии) настройками не управляются: у них
    // нет письма вовсе, и молча принять для них запись значило бы завести
    // настройку, которая ни на что не влияет.
    expect(result.success).toBe(false)
  })

  it('отвергает повторяющийся тип в одном запросе', () => {
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: false },
        { type: 'TRANSACTION_ADDED', emailEnabled: true },
      ],
    })
    // Иначе исход зависит от порядка применения, и пользователь не знает,
    // какая из двух записей победила.
    expect(result.success).toBe(false)
  })

  it('отвергает пустой список', () => {
    const result = updateNotificationPreferencesSchema.safeParse({ items: [] })
    expect(result.success).toBe(false)
  })
})

describe('notificationPreferencesResponseSchema', () => {
  it('несёт все десять типов с признаком locked', () => {
    const payload = {
      items: NEW_NOTIFICATION_TYPES.map((type) => ({
        type,
        emailEnabled: true,
        locked: isEmailChannelLocked(type),
      })),
    }
    const parsed = notificationPreferencesResponseSchema.parse(payload)
    expect(parsed.items).toHaveLength(10)
  })

  it('отвергает ответ, где у запертого типа письмо выключено', () => {
    const result = notificationPreferencesResponseSchema.safeParse({
      items: [{ type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: false, locked: true }],
    })
    expect(result.success).toBe(false)
  })
})
