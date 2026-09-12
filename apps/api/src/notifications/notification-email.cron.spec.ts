import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_EMAIL_ATTEMPTS,
  type DeliveryContext,
  type SkipReason,
} from './notification-email-outbox'
import {
  NotificationEmailCronService,
  SWEEP_STUCK_AFTER_MS,
  type ClaimedEmail,
  type OutboxGateway,
} from './notification-email.cron'

/**
 * Отправщик — AC2 позиции 7a: пятнадцать секунд, ретраи, `FAILED` после
 * пятой попытки, ноль попыток без ключа провайдера.
 *
 * Шов согласован как `OutboxGateway`: всё, что отправщик делает с базой, —
 * четыре именованных операции. Мокается ИМЕННО он, а не drizzle: мок
 * цепочки запросов проверял бы форму SQL, то есть реализацию, и краснел бы
 * на любом переписывании того же запроса. Настоящий SQL (`FOR UPDATE SKIP
 * LOCKED`, предикат частичного индекса) проверяется на живой Postgres в
 * `notification-email-delivery.integration.spec.ts` — то, чего мок не может
 * доказать по построению.
 */

function makeGateway(claimed: ClaimedEmail[] = []): OutboxGateway & {
  sent: { id: string; email: string }[]
  failed: { id: string; reason: string }[]
  skipped: { id: string; reason: SkipReason }[]
  retried: { id: string; reason: string; attempts: number }[]
  claims: number
  /** Контекст получателя, который вернёт `deliveryContextFor`. Тесты его подменяют. */
  context: DeliveryContext
  contextAskedFor: { userId: string; type: string }[]
} {
  const state = {
    sent: [] as { id: string; email: string }[],
    failed: [] as { id: string; reason: string }[],
    skipped: [] as { id: string; reason: SkipReason }[],
    retried: [] as { id: string; reason: string; attempts: number }[],
    claims: 0,
    // `null` = заглушка выводит адрес из идентификатора получателя, как это
    // делала бы база с одной рабочей строкой на человека. Тест, которому нужен
    // архив, выключенный канал или пустой список адресов, кладёт свой контекст
    // через `gw.context = …`.
    contextOverride: null as DeliveryContext | null,
    contextAskedFor: [] as { userId: string; type: string }[],
  }
  return {
    // Счётчики — ГЕТТЕРАМИ, а не через `...state`: спред копирует число один
    // раз, и `gw.claims` навсегда остался бы нулём — то есть проверка
    // «не захватил ни одной строки» проходила бы всегда, даже когда захватил.
    // Массивы спред скопировал бы по ссылке, но держать две разные механики
    // рядом — приглашение к той же ошибке.
    get sent() {
      return state.sent
    },
    get failed() {
      return state.failed
    },
    get skipped() {
      return state.skipped
    },
    get retried() {
      return state.retried
    },
    get claims() {
      return state.claims
    },
    get context() {
      return state.contextOverride ?? defaultContext('u-1')
    },
    set context(next: DeliveryContext) {
      state.contextOverride = next
    },
    get contextAskedFor() {
      return state.contextAskedFor
    },
    claimDue: async (_limit: number) => {
      state.claims += 1
      return state.claims === 1 ? claimed : []
    },
    // Контекст получателя читается в момент ОТПРАВКИ — поэтому шлюз отдаёт
    // его крону, а не сервису записи. Запоминается и то, О ЧЁМ спросили:
    // заглушка, отвечающая одно и то же на любой тип, не заметила бы, что
    // отправщик читает настройку не того типа.
    deliveryContextFor: async (userId: string, type: string) => {
      state.contextAskedFor.push({ userId, type })
      return state.contextOverride ?? defaultContext(userId)
    },
    markSent: async (id: string, email: string) => {
      state.sent.push({ id, email })
    },
    markSkipped: async (id: string, reason: SkipReason) => {
      state.skipped.push({ id, reason })
    },
    markFailed: async (id: string, reason: string) => {
      state.failed.push({ id, reason })
    },
    scheduleRetry: async (id: string, reason: string, attempts: number) => {
      state.retried.push({ id, reason, attempts })
    },
  } as never
}

/** Живой получатель с одним рабочим адресом, выведенным из его идентификатора. */
function defaultContext(userId: string): DeliveryContext {
  return {
    archived: false,
    addresses: [{ email: `${userId}@cheekycheese.tech`, kind: 'WORK' }],
    emailEnabled: null,
  }
}

/** Информирующее уведомление — тип, у которого письмо МОЖНО выключить. */
function informing(): ClaimedEmail['notification'] {
  return {
    type: 'TRANSACTION_ADDED',
    title: 'Новая транзакция',
    body: null,
    link: null,
    subjectType: 'TRANSACTION',
    subjectId: '77777777-7777-4777-8777-777777777777',
    data: { amount: '100.000000', currency: 'USDT', projectName: 'Мобильный банк' },
  }
}

function claimed(over: Partial<ClaimedEmail> = {}): ClaimedEmail {
  return {
    id: 'e-1',
    userId: 'u-1',
    attempts: 1,
    notification: {
      type: 'PROJECT_CONFIRM_REQUIRED',
      title: 'Проект ждёт решения',
      body: null,
      link: null,
      subjectType: 'PROJECT',
      subjectId: '55555555-5555-4555-8555-555555555555',
      data: { projectName: 'Мобильный банк', approvalId: '66666666-6666-4666-8666-666666666666' },
    },
    ...over,
  }
}

function makeService(opts: {
  gateway: OutboxGateway
  configured?: boolean
  send?: (input: { to: string[]; subject: string }) => Promise<void>
  /** Телеметрия сама отказала — отдельный путь, у него свой тест. */
  telemetryFails?: Error
}) {
  const sends: { to: string[]; subject: string; text: string; replyTo: string }[] = []
  const mailer = {
    get isConfigured() {
      return opts.configured ?? true
    },
    send: async (input: {
      to: string[]
      subject: string
      text: string
      html: string
      replyTo: string
    }) => {
      sends.push({
        to: input.to,
        subject: input.subject,
        text: input.text,
        replyTo: input.replyTo,
      })
      if (opts.send) await opts.send(input)
    },
  }
  const recorded: Record<string, unknown>[] = []
  const telemetry = {
    recordError: (p: Record<string, unknown>) => {
      recorded.push(p)
      return opts.telemetryFails ? Promise.reject(opts.telemetryFails) : Promise.resolve()
    },
  }
  // Отвечает ТОЛЬКО на своё имя: заглушка, отдающая адрес на любой ключ, не
  // заметила бы, что сервис читает не ту настройку.
  const config = {
    get: (key: string) =>
      key === 'FRONTEND_URL'
        ? 'https://app.cheekycheese.tech'
        : key === 'CONTACT_PUBLIC_EMAIL'
          ? 'hr@cheekycheese.tech'
          : undefined,
  }
  const service = new NotificationEmailCronService(
    opts.gateway,
    mailer as never,
    telemetry as never,
    config as never,
  )
  return { service, sends, recorded }
}

describe('отправщик — успешный путь', () => {
  it('шлёт письмо и помечает строку отправленной', async () => {
    const gw = makeGateway([claimed()])
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(1)
    expect(sends[0]!.subject).toBe('Запрос на добавление проекта «Мобильный банк»')
    // Адрес в письме — из настройки `FRONTEND_URL`, а не из константы в коде.
    // Тип требует действия, поэтому ведёт на `/pending` (SPEC-H-3).
    expect(sends[0]!.text).toContain('https://app.cheekycheese.tech/pending')
    expect(gw.sent).toEqual([{ id: 'e-1', email: 'u-1@cheekycheese.tech' }])
    expect(gw.failed).toHaveLength(0)
  })

  it('личный адрес предпочитается рабочему', async () => {
    const gw = makeGateway([claimed()])
    gw.context = {
      archived: false,
      addresses: [
        { email: 'work@cheekycheese.tech', kind: 'WORK' },
        { email: 'ivan@gmail.com', kind: 'PERSONAL' },
      ],
      emailEnabled: null,
    }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends[0]!.to).toEqual(['ivan@gmail.com'])
  })

  it('несколько строк за проход', async () => {
    const gw = makeGateway([claimed(), claimed({ id: 'e-2', userId: 'u-2' })])
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(2)
    expect(gw.sent.map((s) => s.id)).toEqual(['e-1', 'e-2'])
  })

  it('падение одного письма не отменяет соседнее', async () => {
    // Пачка не транзакция: у каждой строки своя судьба, иначе один битый
    // адрес задерживал бы всю очередь.
    const gw = makeGateway([claimed(), claimed({ id: 'e-2', userId: 'u-2' })])
    const { service, sends } = makeService({
      gateway: gw,
      send: async (input) => {
        if (input.to[0] === 'u-1@cheekycheese.tech') throw new Error('Resend API HTTP 500: boom')
      },
    })

    await service.drainOnce()

    expect(sends).toHaveLength(2)
    expect(gw.sent.map((s) => s.id)).toEqual(['e-2'])
    expect(gw.retried.map((r) => r.id)).toEqual(['e-1'])
  })
})

describe('отправщик — отказы и ретраи', () => {
  it('неудача до потолка попыток откладывает, а не хоронит', async () => {
    const gw = makeGateway([claimed({ attempts: 1 })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 429: slow down')
      },
    })

    await service.drainOnce()

    expect(gw.retried).toHaveLength(1)
    expect(gw.failed).toHaveLength(0)
  })

  it(`после ${MAX_EMAIL_ATTEMPTS}-й попытки строка становится FAILED`, async () => {
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })

    await service.drainOnce()

    expect(gw.failed).toEqual([{ id: 'e-1', reason: 'Resend API HTTP 500' }])
    expect(gw.retried).toHaveLength(0)
  })

  it('предпоследняя попытка ещё откладывает', async () => {
    // Граница проверяется с обеих сторон — иначе мутант `>=` → `>` выживает.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS - 1 })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })

    await service.drainOnce()

    expect(gw.retried).toHaveLength(1)
    expect(gw.failed).toHaveLength(0)
  })

  it('сдача после потолка попыток доезжает до телеметрии', async () => {
    // Человек не узнал о том, о чём должен был. Это событие для дайджеста, и
    // молчание здесь — второй конец той же палки, что тихо потерянное письмо.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service, recorded } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })

    await service.drainOnce()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!).toEqual({
      source: 'API',
      message: 'Notification email gave up after retries',
      route: '/api/notifications',
      // Причина и тип — то, по чему сдачу вообще можно диагностировать в
      // дайджесте. Ни адреса, ни текста письма здесь нет и быть не должно.
      meta: { reason: 'Resend API HTTP 500', type: 'PROJECT_CONFIRM_REQUIRED' },
    })
  })

  it('отложенная попытка телеметрию НЕ будит', async () => {
    // Иначе дайджест заполнится обычными повторами, и в нём перестанут
    // находиться настоящие сдачи.
    const gw = makeGateway([claimed({ attempts: 1 })])
    const { service, recorded } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 429: slow down')
      },
    })

    await service.drainOnce()

    expect(recorded).toHaveLength(0)
  })

  it('в базу уходит обеззараженная причина, а не ответ провайдера', async () => {
    // Тело ответа Resend цитирует отвергнутый адрес — ровно те данные,
    // которых этот проект не пишет ни в журнал, ни в базу.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 422: invalid recipient "ivan@gmail.com"')
      },
    })

    await service.drainOnce()

    expect(gw.failed[0]!.reason).toBe('Resend API HTTP 422')
    expect(gw.failed[0]!.reason).not.toContain('ivan@gmail.com')
  })

  it('ошибка без ответа провайдера записывается КЛАССОМ, а не текстом', async () => {
    // Сетевой сбой (`TypeError: fetch failed`) не имеет статуса HTTP. Писать
    // его текст в базу нельзя тем же соображением, что и тело ответа, а знать,
    // что это была за поломка, полезно — остаётся имя класса.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.resend.com')
      },
    })

    await service.drainOnce()

    expect(gw.failed[0]!.reason).toBe('TypeError')
    expect(gw.failed[0]!.reason).not.toContain('resend.com')
  })

  it('брошено вообще не исключение — причина «unknown»', async () => {
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw 'что-то пошло не так'
      },
    })

    await service.drainOnce()

    expect(gw.failed[0]!.reason).toBe('unknown')
  })

  it('статус вырезается ТОЛЬКО из начала строки', async () => {
    // Тело ответа провайдера может САМО содержать «Resend API HTTP 200».
    // Привязка к началу строки — то, что отличает наш собственный формат от
    // цитаты внутри чужого текста.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('upstream said: Resend API HTTP 200 was expected')
      },
    })

    await service.drainOnce()

    expect(gw.failed[0]!.reason).toBe('Error')
  })

  it('человек без единого адреса — строка SKIPPED/NO_ADDRESS, без попыток слать в пустоту', async () => {
    // Круг 1 писал здесь `FAILED` с текстом `no email address`, и «не смогли
    // отправить» становилось неотличимо от «не полагалось отправлять»
    // (SPEC-H-1 / SR-L-2). `FAILED` обязан остаться пустым: ошибки не было.
    const gw = makeGateway([claimed()])
    gw.context = { archived: false, addresses: [], emailEnabled: null }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(0)
    expect(gw.skipped).toEqual([{ id: 'e-1', reason: 'NO_ADDRESS' }])
    expect(gw.failed).toHaveLength(0)
  })
})

describe('проход не наезжает на предыдущий', () => {
  it('второй вызов во время первого не берёт строки повторно', async () => {
    // Крон тикает каждые 15 секунд; пачка из двадцати писем с медленным
    // провайдером идёт дольше. Без защиты второй тик захватил бы следующую
    // пачку поверх первой и удвоил бы нагрузку на провайдера ровно тогда,
    // когда тот и так не отвечает.
    const gw = makeGateway([claimed()])
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service } = makeService({ gateway: gw, send: () => blocked })

    const first = service.handleDue()
    await service.handleDue() // второй тик, пока первый ещё в отправке
    expect(gw.claims).toBe(1)

    release()
    await first
  })

  it('после завершения прохода следующий снова работает', async () => {
    // Обратная сторона: флаг обязан сниматься. Не снятый превращает
    // однократный сбой в вечную остановку очереди.
    const gw = makeGateway([claimed()])
    const { service } = makeService({ gateway: gw })

    await service.handleDue()
    await service.handleDue()

    expect(gw.claims).toBe(2)
  })

  it('упавший проход тоже отпускает флаг', async () => {
    const gw = makeGateway()
    let fail = true
    gw.claimDue = async () => {
      if (fail) {
        fail = false
        throw new Error('db is down')
      }
      return []
    }
    const { service } = makeService({ gateway: gw })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await service.handleDue()
    await service.handleDue()

    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

describe('отправщик без ключа провайдера', () => {
  it('не берёт ни одной строки и предупреждает ОДИН раз', async () => {
    // AC8: событие кладёт строку QUEUED, крон делает один warn и НОЛЬ
    // попыток. Предупреждение на каждом проходе — четыре строки в минуту,
    // то есть журнал, в котором больше ничего не видно.
    const gw = makeGateway([claimed()])
    const { service, sends } = makeService({ gateway: gw, configured: false })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    await service.drainOnce()
    await service.drainOnce()
    await service.drainOnce()

    expect(gw.claims).toBe(0)
    expect(sends).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    // Предупреждение обязано называть ПРИЧИНУ и то, что письма не потеряны:
    // пустая строка в журнале сообщает ровно столько же, сколько молчание.
    const said = String(warn.mock.calls[0]?.[0] ?? '')
    expect(said).toContain('RESEND_API_KEY')
    expect(said).toContain('notification_emails')
    // И вторую половину: «письма не потеряны, уйдут как только появится ключ».
    // Без неё читатель журнала знает про поломку и не знает, надо ли что-то
    // досылать руками.
    expect(said).toContain('QUEUED')
    expect(said).toContain('as soon as the key appears')
    warn.mockRestore()
  })
})

describe('отказы видны в журнале, а не только в базе', () => {
  it('отложенная попытка называет номер попытки и потолок', async () => {
    const gw = makeGateway([claimed({ attempts: 2 })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 429: slow down')
      },
    })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    await service.drainOnce()

    const said = String(warn.mock.calls[0]?.[0] ?? '')
    expect(said).toContain(`2/${MAX_EMAIL_ATTEMPTS}`)
    expect(said).toContain('Resend API HTTP 429')
    expect(said).toContain('e-1')
    warn.mockRestore()
  })

  it('сдача называет число попыток и причину', async () => {
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      send: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await service.drainOnce()

    const said = String(error.mock.calls[0]?.[0] ?? '')
    expect(said).toContain(String(MAX_EMAIL_ATTEMPTS))
    expect(said).toContain('Resend API HTTP 500')
    error.mockRestore()
  })

  it('пропуск называет свою причину кодом, а не прозой', async () => {
    // Строку журнала читают грепом по коду причины — тем же, что лежит в
    // колонке `skip_reason`. Проза («некуда слать») требовала бы второго
    // словаря рядом с первым.
    const gw = makeGateway([claimed()])
    gw.context = { archived: false, addresses: [], emailEnabled: null }
    const { service } = makeService({ gateway: gw })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    await service.drainOnce()

    const said = String(warn.mock.calls[0]?.[0] ?? '')
    expect(said).toContain('NO_ADDRESS')
    expect(said).toContain('e-1')
    // Адреса в журнале нет — ни одной строки этого файла он не касается.
    expect(said).not.toContain('@')
    warn.mockRestore()
  })
})

describe('крон не роняет планировщик', () => {
  it('отказ шлюза остаётся в журнале, а не улетает наружу', async () => {
    // Необработанный отказ в `@Cron`-обработчике молча убивает планировщик
    // для ВСЕХ кронов процесса — тот же довод, что у
    // `TelemetryRetentionCronService`.
    const gw = makeGateway()
    gw.claimDue = async () => {
      throw new Error('db is down')
    }
    const { service } = makeService({ gateway: gw })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await expect(service.handleDue()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    // Сообщение обязано называть, ЧТО упало: «notification email sweep»
    // отличает этот отказ от любого другого в общем журнале процесса.
    expect(String(error.mock.calls[0]?.[0] ?? '')).toContain('Notification email sweep')
    error.mockRestore()
  })
})

describe('отказ телеметрии не уносит с собой проход', () => {
  it('провалившаяся запись в телеметрию остаётся в журнале и не роняет отправщик', async () => {
    // Единственный путь, который вообще может бросить ПОСЛЕ того как строка уже
    // похоронена. Без этой проверки `catch` вокруг телеметрии — код, который
    // никто не исполнял: он либо не нужен, либо не работает, и узнать это можно
    // только в тот день, когда телеметрия действительно откажет.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      telemetryFails: new Error('telemetry is down'),
      send: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await expect(service.drainOnce()).resolves.toBeUndefined()

    // Строка похоронена — то есть отказ телеметрии не отменил основную работу.
    expect(gw.failed).toEqual([{ id: 'e-1', reason: 'Resend API HTTP 500' }])
    const said = error.mock.calls.map((c) => String(c[0] ?? ''))
    expect(said.some((m) => m.includes('Telemetry rejected'))).toBe(true)
    // И называет ПРИЧИНУ отказа телеметрии: пустая строка тут сообщала бы
    // ровно столько же, сколько молчание.
    expect(said.some((m) => m.includes('telemetry is down'))).toBe(true)
    error.mockRestore()
  })

  it('телеметрия, отказавшая НЕ исключением, тоже названа в журнале', async () => {
    // `String(e)` вместо `e.message` — ветка, которую даёт `throw 'строка'`.
    const gw = makeGateway([claimed({ attempts: MAX_EMAIL_ATTEMPTS })])
    const { service } = makeService({
      gateway: gw,
      telemetryFails: 'telemetry said no' as unknown as Error,
      send: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await service.drainOnce()

    expect(
      error.mock.calls.map((c) => String(c[0] ?? '')).some((m) => m.includes('telemetry said no')),
    ).toBe(true)
    error.mockRestore()
  })
})

describe('решение принимается в момент ОТПРАВКИ, а не при постановке (AC6)', () => {
  it('выключенный получателем тип не уходит — SKIPPED/CHANNEL_OFF', async () => {
    // AC6, первая половина. Строка стоит в очереди `QUEUED` — настройку на
    // постановке никто не смотрел, — и терминальное решение принимается здесь.
    const gw = makeGateway([claimed({ notification: informing() })])
    gw.context = {
      archived: false,
      addresses: [{ email: 'u-1@cheekycheese.tech', kind: 'WORK' }],
      emailEnabled: false,
    }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(0)
    expect(gw.skipped).toEqual([{ id: 'e-1', reason: 'CHANNEL_OFF' }])
  })

  it('запертый тип уходит, даже когда в базе лежит «выключено»', async () => {
    // AC6, вторая половина. §3: письма про подтверждения и подписи отключить
    // нельзя — иначе процесс встаёт молча.
    const gw = makeGateway([claimed()])
    gw.context = {
      archived: false,
      addresses: [{ email: 'u-1@cheekycheese.tech', kind: 'WORK' }],
      emailEnabled: false,
    }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(1)
    expect(gw.skipped).toHaveLength(0)
  })

  it('настройка читается по типу ЭТОГО письма и для ЭТОГО получателя', async () => {
    // Мимо этой проверки прошёл бы отправщик, читающий настройку соседнего
    // типа: контекст у заглушки один на всех, и решение выглядело бы верным.
    const gw = makeGateway([claimed({ id: 'e-2', userId: 'u-7', notification: informing() })])
    const { service } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(gw.contextAskedFor).toEqual([{ userId: 'u-7', type: 'TRANSACTION_ADDED' }])
  })

  it('архивированный получатель письма не получает — SKIPPED/USER_ARCHIVED', async () => {
    // SR-H-1: архив — это увольнение. Строка могла встать в очередь ДО него
    // (или ждать ретрая часами), и единственное место, которое видит все
    // десять типов сразу, — здесь.
    const gw = makeGateway([claimed()])
    gw.context = {
      archived: true,
      addresses: [{ email: 'ivan@gmail.com', kind: 'PERSONAL' }],
      emailEnabled: null,
    }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(0)
    expect(gw.skipped).toEqual([{ id: 'e-1', reason: 'USER_ARCHIVED' }])
    // Именно НЕ `FAILED`: иначе ретраить было бы что, и «уволен» читалось бы
    // как сбой провайдера.
    expect(gw.failed).toHaveLength(0)
    expect(gw.retried).toHaveLength(0)
  })

  it('письмо запертого типа архивированному тоже не уходит', async () => {
    // «Отключить нельзя» — про настройку человека, а не про его увольнение.
    const gw = makeGateway([claimed()])
    gw.context = {
      archived: true,
      addresses: [{ email: 'ivan@gmail.com', kind: 'PERSONAL' }],
      emailEnabled: false,
    }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(0)
    expect(gw.skipped).toEqual([{ id: 'e-1', reason: 'USER_ARCHIVED' }])
  })
})

describe('заголовки письма', () => {
  it('ответ уходит в публичный ящик, а не на адрес читателя', async () => {
    // SR-M-3: «ответ на наши письма приходит в публичный ящик» — как у
    // приглашения. Круг 1 ставил сюда адрес получателя, и ответ уходил ему же,
    // а личный адрес вдобавок ехал в заголовке исходящего письма.
    const gw = makeGateway([claimed()])
    gw.context = {
      archived: false,
      addresses: [{ email: 'ivan@gmail.com', kind: 'PERSONAL' }],
      emailEnabled: null,
    }
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends[0]!.replyTo).toBe('hr@cheekycheese.tech')
    expect(sends[0]!.replyTo).not.toBe('ivan@gmail.com')
  })

  it('перевод строки в имени проекта не разрывает тему на две', async () => {
    // SR-M-1: `projectName` приходит из пользовательского ввода, где
    // `z.string().max(255)` перевод строки разрешает. Тема, собранная из двух
    // строк, — приглашение подсунуть лишний заголовок.
    const gw = makeGateway([
      claimed({
        notification: {
          ...claimed().notification,
          data: {
            projectName: 'Проект\r\nBcc: attacker@example.com',
            approvalId: '66666666-6666-4666-8666-666666666666',
          },
        },
      }),
    ])
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends[0]!.subject).not.toMatch(/[\r\n]/)
    expect(sends[0]!.subject).toBe(
      'Запрос на добавление проекта «Проект Bcc: attacker@example.com»',
    )
  })
})

describe('зависший проход не глушит отправщик навсегда (SR-L-4)', () => {
  it('через пять минут следующий тик начинает работу, не дожидаясь предыдущего', async () => {
    // Флаг «идёт», который некому снять, выглядит точно так же, как пустая
    // очередь: писем нет и жалоб нет. Метка времени даёт выход из этого
    // состояния без ручного перезапуска процесса.
    vi.useFakeTimers()
    try {
      const gw = makeGateway([claimed()])
      let release: () => void = () => undefined
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const { service } = makeService({ gateway: gw, send: () => blocked })
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      const first = service.handleDue()
      // Ещё не «зависло»: соседний тик обязан пройти мимо.
      vi.setSystemTime(Date.now() + SWEEP_STUCK_AFTER_MS - 1)
      await service.handleDue()
      expect(gw.claims).toBe(1)

      vi.setSystemTime(Date.now() + 2)
      await service.handleDue()
      expect(gw.claims).toBe(2)
      // Молча начинать второй проход нельзя: зависший `await` — поломка, о
      // которой в журнале должна остаться строка.
      expect(warn.mock.calls.some((c) => String(c[0] ?? '').includes('has not finished'))).toBe(
        true,
      )

      warn.mockRestore()
      release()
      await first
    } finally {
      vi.useRealTimers()
    }
  })

  it('срок зависания — ровно пять минут', () => {
    // Значение выписано числом, а не формулой: проверка `5 * 60_000` согласилась
    // бы с любой арифметикой, которой это значение посчитано. Пять минут —
    // решение (с запасом больше самого долгого возможного прохода: двадцать
    // писем по десять секунд таймаута), и менять его надо осознанно.
    expect(SWEEP_STUCK_AFTER_MS).toBe(300_000)
  })

  it('обычный проход не жалуется на зависание', () => {
    // Обратная сторона: жалоба на КАЖДОМ тике сообщала бы ровно столько же,
    // сколько молчание, — а мимо такой проверки проходит условие, снятое
    // целиком («считать зависшим всегда»).
    const gw = makeGateway([claimed()])
    const { service } = makeService({ gateway: gw })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    return service.handleDue().then(() => {
      expect(warn.mock.calls.some((c) => String(c[0] ?? '').includes('has not finished'))).toBe(
        false,
      )
      warn.mockRestore()
    })
  })

  it('на самой границе пяти минут проход уже считается зависшим', async () => {
    // Ровно `SWEEP_STUCK_AFTER_MS`, не больше: без этого случая «меньше срока»
    // неотличимо от «не больше срока», то есть граница может съехать на тик.
    vi.useFakeTimers()
    try {
      const gw = makeGateway([claimed()])
      let release: () => void = () => undefined
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const { service } = makeService({ gateway: gw, send: () => blocked })
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      const first = service.handleDue()
      vi.setSystemTime(Date.now() + SWEEP_STUCK_AFTER_MS)
      await service.handleDue()

      expect(gw.claims).toBe(2)
      // И называет срок в жалобе — минутами, а не миллисекундами: иначе
      // «5 minutes» превратилось бы в «300000 minutes» незаметно.
      const said = warn.mock.calls.map((c) => String(c[0] ?? '')).find((m) => m.includes('has not'))
      expect(said).toContain('5 minutes')

      warn.mockRestore()
      release()
      await first
    } finally {
      vi.useRealTimers()
    }
  })

  it('доехавший до конца зависший проход не открывает дорогу третьему', async () => {
    // Иначе лечение зависания плодило бы проходы: сменённый проход, дойдя до
    // `finally`, снял бы метку СМЕНИВШЕГО, и следующий тик пошёл бы третьим.
    vi.useFakeTimers()
    try {
      const gw = makeGateway([claimed()])
      let releaseFirst: () => void = () => undefined
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      let releaseSecond: () => void = () => undefined
      const secondBlocked = new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      let call = 0
      const { service } = makeService({
        gateway: gw,
        send: () => {
          call += 1
          return call === 1 ? firstBlocked : secondBlocked
        },
      })
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      const first = service.handleDue()
      vi.setSystemTime(Date.now() + SWEEP_STUCK_AFTER_MS + 1)
      gw.claimDue = async () => [claimed({ id: 'e-2' })]
      const second = service.handleDue()

      // Первый закончил — но второй ещё идёт, и его метка обязана уцелеть.
      releaseFirst()
      await first
      const claimsBefore = gw.claims
      await service.handleDue()
      expect(gw.claims).toBe(claimsBefore)

      releaseSecond()
      await second
    } finally {
      vi.useRealTimers()
    }
  })
})
