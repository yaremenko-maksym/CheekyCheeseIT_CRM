import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { MAX_EMAIL_ATTEMPTS } from './notification-email-outbox'
import {
  NotificationEmailCronService,
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
  retried: { id: string; reason: string; attempts: number }[]
  claims: number
} {
  const state = {
    sent: [] as { id: string; email: string }[],
    failed: [] as { id: string; reason: string }[],
    retried: [] as { id: string; reason: string; attempts: number }[],
    claims: 0,
    addresses: new Map<string, { email: string; kind: 'WORK' | 'PERSONAL' }[]>(),
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
    get retried() {
      return state.retried
    },
    get claims() {
      return state.claims
    },
    get addresses() {
      return state.addresses
    },
    claimDue: async (_limit: number) => {
      state.claims += 1
      return state.claims === 1 ? claimed : []
    },
    addressesFor: async (userId: string) =>
      state.addresses.get(userId) ?? [{ email: `${userId}@cheekycheese.tech`, kind: 'WORK' }],
    markSent: async (id: string, email: string) => {
      state.sent.push({ id, email })
    },
    markFailed: async (id: string, reason: string) => {
      state.failed.push({ id, reason })
    },
    scheduleRetry: async (id: string, reason: string, attempts: number) => {
      state.retried.push({ id, reason, attempts })
    },
  } as never
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
}) {
  const sends: { to: string[]; subject: string; text: string }[] = []
  const mailer = {
    get isConfigured() {
      return opts.configured ?? true
    },
    send: async (input: { to: string[]; subject: string; text: string; html: string }) => {
      sends.push({ to: input.to, subject: input.subject, text: input.text })
      if (opts.send) await opts.send(input)
    },
  }
  const recorded: Record<string, unknown>[] = []
  const telemetry = {
    recordError: (p: Record<string, unknown>) => {
      recorded.push(p)
      return Promise.resolve()
    },
  }
  // Отвечает ТОЛЬКО на своё имя: заглушка, отдающая адрес на любой ключ, не
  // заметила бы, что сервис читает не ту настройку.
  const config = {
    get: (key: string) => (key === 'FRONTEND_URL' ? 'https://app.cheekycheese.tech' : undefined),
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
    expect(sends[0]!.text).toContain('https://app.cheekycheese.tech/projects/')
    expect(gw.sent).toEqual([{ id: 'e-1', email: 'u-1@cheekycheese.tech' }])
    expect(gw.failed).toHaveLength(0)
  })

  it('личный адрес предпочитается рабочему', async () => {
    const gw = makeGateway([claimed()])
    gw.addressesFor = async () => [
      { email: 'work@cheekycheese.tech', kind: 'WORK' },
      { email: 'ivan@gmail.com', kind: 'PERSONAL' },
    ]
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

  it('человек без единого адреса — строка FAILED сразу, без попыток слать в пустоту', async () => {
    const gw = makeGateway([claimed()])
    gw.addressesFor = async () => []
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(0)
    expect(gw.failed).toEqual([{ id: 'e-1', reason: 'no email address' }])
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

  it('отсутствие адреса названо прямо', async () => {
    const gw = makeGateway([claimed()])
    gw.addressesFor = async () => []
    const { service } = makeService({ gateway: gw })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await service.drainOnce()

    expect(String(error.mock.calls[0]?.[0] ?? '')).toContain('ни одного адреса')
    error.mockRestore()
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
    // Сообщение обязано называть, ЧТО упало: «проход отправщика» отличает
    // этот отказ от любого другого в общем журнале процесса.
    expect(String(error.mock.calls[0]?.[0] ?? '')).toContain('отправщик')
    error.mockRestore()
  })
})
