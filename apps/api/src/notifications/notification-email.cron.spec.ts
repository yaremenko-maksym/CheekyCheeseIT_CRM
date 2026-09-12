import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { makeTelemetryErrorsStub } from '../telemetry/__test-helpers__/telemetry-errors-stub'
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
    ...state,
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
  const sends: { to: string[]; subject: string }[] = []
  const mailer = {
    get isConfigured() {
      return opts.configured ?? true
    },
    send: async (input: { to: string[]; subject: string; text: string; html: string }) => {
      sends.push({ to: input.to, subject: input.subject })
      if (opts.send) await opts.send(input)
    },
  }
  const service = new NotificationEmailCronService(
    opts.gateway,
    mailer as never,
    makeTelemetryErrorsStub() as never,
    { get: () => 'https://app.cheekycheese.tech' } as never,
  )
  return { service, sends }
}

describe('отправщик — успешный путь', () => {
  it('шлёт письмо и помечает строку отправленной', async () => {
    const gw = makeGateway([claimed()])
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(1)
    expect(sends[0]!.subject).toBe('Запрос на добавление проекта «Мобильный банк»')
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

  it('человек без единого адреса — строка FAILED сразу, без попыток слать в пустоту', async () => {
    const gw = makeGateway([claimed()])
    gw.addressesFor = async () => []
    const { service, sends } = makeService({ gateway: gw })

    await service.drainOnce()

    expect(sends).toHaveLength(0)
    expect(gw.failed).toEqual([{ id: 'e-1', reason: 'no email address' }])
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
    error.mockRestore()
  })
})
