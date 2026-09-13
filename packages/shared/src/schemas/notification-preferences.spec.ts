import { describe, expect, it } from 'vitest'
import {
  ACTION_REQUIRED_NOTIFICATION_TYPES,
  ADMIN_NOTIFICATION_TYPES,
  INFORMING_NOTIFICATION_TYPES,
  NEW_NOTIFICATION_TYPES,
} from './notification-registry'
import {
  isEmailChannelLocked,
  notificationPreferencesResponseClientSchema,
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

  it('принимает пачку РАЗНЫХ типов', () => {
    // Пара к тесту про дубли ниже. Без неё проверка уникальности проходила бы
    // и тогда, когда она сравнивает не типы, а что угодно одинаковое: на
    // запросе из одного элемента любая такая подмена неотличима.
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: false },
        { type: 'TEAM_NEW_MEMBER', emailEnabled: false },
        { type: 'PROJECT_MEMBER_ADDED', emailEnabled: true },
      ],
    })
    expect(result.success).toBe(true)
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
    expect(issueMessages(result)).toContain('Каждый тип уведомления можно указать только один раз')
  })

  it('отвергает пачку, где ХОТЯ БЫ ОДИН запертый тип выключают', () => {
    // Запрет проверяется по КАЖДОМУ элементу, а не по наличию хотя бы одного
    // законного: клиент присылает форму целиком, и одна запрещённая строка
    // среди девяти законных обязана отвергнуть запрос.
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: false },
        { type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: false },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('отказ называет причину ПО-РУССКИ, а не отвергает молча', () => {
    // Сообщение — часть контракта: его читает 7b, чтобы показать человеку,
    // почему переключатель не поддался. Пустой текст отказа неотличим от
    // поломки сервера, английский — от отладочного вывода (SPEC-H-5 / CR-H-5 /
    // COPY-H-3: `ZodExceptionFilter` отдаёт эту строку клиенту дословно).
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [{ type: 'SHARE_CONFIRM_REQUIRED', emailEnabled: false }],
    })
    expect(issueMessages(result)).toContain(
      'Письма о запросах на подтверждение и подпись отключить нельзя',
    )
  })

  it('все четыре отказа обходятся без латиницы и без ссылок на внутренние документы', () => {
    // Проверяется свойство, а не вторая копия строки: латиница в
    // пользовательском тексте — то, чем отличался круг 1, а «(spec §3)»
    // читателю интерфейса не сообщает ничего. Расширено на границы длины
    // массива (COPY-L-6, copy-review PR #673 круг 2) — те же ветки, что и
    // `.refine()`, только раньше их в цепочке.
    const duplicate = updateNotificationPreferencesSchema.safeParse({
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: false },
        { type: 'TRANSACTION_ADDED', emailEnabled: true },
      ],
    })
    const locked = updateNotificationPreferencesSchema.safeParse({
      items: [{ type: 'DOCUMENT_SIGN_REQUIRED', emailEnabled: false }],
    })
    const empty = updateNotificationPreferencesSchema.safeParse({ items: [] })
    const tooMany = updateNotificationPreferencesSchema.safeParse({
      items: Array.from({ length: NEW_NOTIFICATION_TYPES.length + 1 }, (_, i) => ({
        type: NEW_NOTIFICATION_TYPES[i % NEW_NOTIFICATION_TYPES.length]!,
        emailEnabled: true,
      })),
    })
    for (const message of [
      ...issueMessages(duplicate),
      ...issueMessages(locked),
      ...issueMessages(empty),
      ...issueMessages(tooMany),
    ]) {
      expect(message).not.toMatch(/[A-Za-z]/)
      expect(message).not.toContain('§')
    }
  })

  it('неизвестный тип отвергается русским текстом, а не дефолтом Zod', () => {
    // Дефолт перечисляет допустимые значения по-английски — а именно это и
    // увидит человек, если 7b пошлёт устаревший тип из старого бандла.
    const result = updateNotificationPreferencesSchema.safeParse({
      items: [{ type: 'NOT_A_REAL_TYPE', emailEnabled: true }],
    })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain('Неизвестный тип уведомления')
  })

  it('отвергает пустой список текстом, а не тишиной', () => {
    // COPY-L-6: `.min(1)` без своего сообщения отдавал дефолт Zod
    // («Too small: expected array to have >=1 items») — английский и прямо
    // клиенту, тем же каналом, что и COPY-H-3.
    const result = updateNotificationPreferencesSchema.safeParse({ items: [] })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain('Укажите хотя бы одну настройку')
  })

  it('отвергает пачку длиннее списка типов текстом, а не тишиной', () => {
    // COPY-L-6: `.max(...)` без своего сообщения отдавал дефолт Zod
    // («Too big: expected array to have <=10 items»).
    const result = updateNotificationPreferencesSchema.safeParse({
      items: Array.from({ length: NEW_NOTIFICATION_TYPES.length + 1 }, (_, i) => ({
        type: NEW_NOTIFICATION_TYPES[i % NEW_NOTIFICATION_TYPES.length]!,
        emailEnabled: true,
      })),
    })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain('Слишком много настроек в одном запросе')
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
    expect(issueMessages(result)).toContain('A locked type can never report email as disabled')
  })

  it('отвергает ответ, где ОДНА строка из многих врёт про locked', () => {
    // По каждой строке, а не по наличию хотя бы одной честной: ответ из десяти
    // элементов, где соврала одна, — испорченный ответ целиком.
    const result = notificationPreferencesResponseSchema.safeParse({
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: true, locked: false },
        { type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: true, locked: false },
      ],
    })
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toContain(
      '`locked` must be derived from the type, not sent independently',
    )
  })

  it('отвергает ответ, где ОДНА строка из многих выключает запертое письмо', () => {
    const result = notificationPreferencesResponseSchema.safeParse({
      items: [
        { type: 'TRANSACTION_ADDED', emailEnabled: false, locked: false },
        { type: 'DOCUMENT_SIGN_REQUIRED', emailEnabled: false, locked: true },
      ],
    })
    expect(result.success).toBe(false)
  })
})

/**
 * notificationPreferencesResponseClientSchema — SR-M-1/CR-M-2 (fix-round 2,
 * PR #675). The strict schema above stays server-side; the client hook
 * (`use-notification-preferences.ts`) parses THIS one instead, so an
 * unrecognised `type` degrades to one row (design spec §7 / AC2) rather
 * than throwing the whole tab into its error state.
 */
describe('notificationPreferencesResponseClientSchema', () => {
  it('accepts all ten known types, same as the strict schema', () => {
    const payload = {
      items: NEW_NOTIFICATION_TYPES.map((type) => ({
        type,
        emailEnabled: true,
        locked: isEmailChannelLocked(type),
      })),
    }
    const parsed = notificationPreferencesResponseClientSchema.parse(payload)
    expect(parsed.items).toHaveLength(10)
  })

  it('accepts a well-formed item whose type is genuinely unknown', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [{ type: 'FUTURE_TYPE_XYZ', emailEnabled: true, locked: false }],
    })
    expect(result.success).toBe(true)
    expect(result.data?.items[0]).toEqual({
      type: 'FUTURE_TYPE_XYZ',
      emailEnabled: true,
      locked: false,
    })
  })

  // Guards against a schema collapsed to `z.object({})` (accepts anything):
  // an unknown-type row missing its required fields must still fail, not
  // silently pass through as "close enough to unknown".
  it('rejects an unknown-type item missing required fields', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [{ type: 'FUTURE_TYPE_XYZ' }],
    })
    expect(result.success).toBe(false)
  })

  // SR-L-5 (security-review, fix-round 3, PR #675): `preferenceViewUnknown`
  // is a plain `z.object` (never `.passthrough()`/`.looseObject()`), so an
  // extra key an unrecognised server payload might carry is DROPPED by
  // Zod's default strict-shape parsing, not smuggled through to whatever
  // reads `.data` on the client. Pinned explicitly rather than left to
  // Zod's default: a future `.passthrough()` added for some other reason
  // (e.g. to forward an extra field some OTHER caller wants) would silently
  // widen this specific branch too, since the object schema is shared.
  it('strips an extra key from an unknown-type item instead of passing it through', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [
        {
          type: 'FUTURE_TYPE_XYZ',
          emailEnabled: true,
          locked: false,
          extra: 'smuggled-field',
        },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.data?.items[0]).toEqual({
      type: 'FUTURE_TYPE_XYZ',
      emailEnabled: true,
      locked: false,
    })
    expect(result.data?.items[0]).not.toHaveProperty('extra')
  })

  // Guards against the wrapping `z.object({ items: ... })` collapsed to
  // `z.object({})` — a response with no `items` key at all must fail, not
  // parse as "an empty object is fine".
  it('rejects a response with no `items` key at all', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects a KNOWN type whose `locked` disagrees with the type, with the exact reason and field path', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [{ type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: true, locked: false }],
    })
    expect(result.success).toBe(false)
    const issue = result.error?.issues[0] as { message: string; path: unknown[] } | undefined
    expect(issue?.message).toBe('`locked` must be derived from the type, not sent independently')
    // The path names WHICH field is wrong (index 0, `locked`) — a mutant
    // emptying the path array, or renaming the field name, would still
    // leave `success: false` unchanged; only the path/message content
    // exposes it.
    expect(issue?.path).toEqual(['items', 0, 'locked'])
  })

  it('rejects a KNOWN locked type reporting email as disabled, with the exact reason and field path', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [{ type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: false, locked: true }],
    })
    expect(result.success).toBe(false)
    const issue = result.error?.issues[0] as { message: string; path: unknown[] } | undefined
    expect(issue?.message).toBe('A locked type can never report email as disabled')
    expect(issue?.path).toEqual(['items', 0, 'emailEnabled'])
  })

  it('never enforces the locked/emailEnabled invariant on an unknown type (nothing to derive it from)', () => {
    // A deliberately "inconsistent-looking" unknown-type row — locked=true
    // with emailEnabled=false would fail the KNOWN-type invariant, but this
    // type isn't in the registry, so there is no `isEmailChannelLocked`
    // answer to check it against.
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [{ type: 'FUTURE_TYPE_XYZ', emailEnabled: false, locked: true }],
    })
    expect(result.success).toBe(true)
  })

  // Union-nested message: `preferenceViewUnknown`'s own `.refine()` rejects
  // a KNOWN type reaching its branch (reachable only when that same known
  // type ALSO fails the strict branch on some other field) — proves this
  // guard fires with its OWN message, not silently passing via an emptied
  // `{ message: ... }` options object.
  it('a malformed KNOWN-type row is rejected with its own explicit reason, not silently accepted as unknown', () => {
    const result = notificationPreferencesResponseClientSchema.safeParse({
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: 'not-a-boolean', locked: false }],
    })
    expect(result.success).toBe(false)
    expect(unionBranchMessages(result)).toContain(
      'a known type must go through the strict branch, not this one',
    )
  })
})

/** Тексты причин отказа — часть контракта, а не украшение (их читает 7b). */
function issueMessages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((i) => i.message) ?? []
}

/**
 * Zod nests a failed union branch's own issues under `issue.errors[branchIndex]`
 * rather than surfacing them at the top level of `.issues` — this digs
 * through every branch of every top-level `invalid_union` issue to collect
 * every message any branch produced, so a test can assert on a SPECIFIC
 * branch's reason without hard-coding which array index that branch lives
 * at (a detail of union member order, not of this test's actual claim).
 */
function unionBranchMessages(result: {
  success: boolean
  error?: { issues: unknown[] }
}): string[] {
  const issues = (result.error?.issues ?? []) as Array<{
    code?: string
    message?: string
    errors?: Array<Array<{ message: string }>>
  }>
  const messages: string[] = []
  for (const issue of issues) {
    if (issue.message) messages.push(issue.message)
    if (issue.code === 'invalid_union' && issue.errors) {
      for (const branch of issue.errors) {
        for (const branchIssue of branch) messages.push(branchIssue.message)
      }
    }
  }
  return messages
}
