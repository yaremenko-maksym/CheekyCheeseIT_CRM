import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { DatabaseService } from './database.service'

const { poolConstructorSpy } = vi.hoisted(() => ({
  poolConstructorSpy: vi.fn(),
}))

vi.mock('pg', () => {
  const Pool = vi.fn().mockImplementation(function (this: unknown, config?: unknown) {
    poolConstructorSpy(config)
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(handler)
        return this
      }),
      emit: vi.fn((event: string, ...args: unknown[]) => {
        const handlers = listeners[event] || []
        for (const h of handlers) h(...args)
        return handlers.length > 0
      }),
      end: vi.fn().mockResolvedValue(undefined),
    }
  })
  return { Pool }
})

// `pg.Pool` connects lazily, so initialising against an unreachable URL opens no socket;
// the test drives the pool's real `error` emitter, the same path an idle-client failure takes.
const config = {
  get: () => 'postgres://nobody:nopass@127.0.0.1:1/none',
} as unknown as ConfigService<Env>

describe('DatabaseService pool error listener', () => {
  let service: DatabaseService
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    poolConstructorSpy.mockClear()
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    service = new DatabaseService(config)
    await service.onModuleInit()
  })

  afterEach(async () => {
    await service.onModuleDestroy()
    errorSpy.mockRestore()
  })

  const pool = () =>
    (service as unknown as { pool: { emit: (event: string, ...args: unknown[]) => boolean } }).pool

  it('pins that DatabaseService.onModuleInit builds its Pool with options containing jit=off', () => {
    expect(poolConstructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://nobody:nopass@127.0.0.1:1/none',
        options: expect.stringContaining('jit=off'),
      }),
    )
  })

  it('survives an idle-client error and logs the SQLSTATE', () => {
    const err = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    })
    expect(() => pool().emit('error', err)).not.toThrow()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [message, stack] = errorSpy.mock.calls[0]
    expect(message).toBe(
      'Postgres pool idle-client error sqlstate=57P01: terminating connection due to administrator command',
    )
    expect(stack).toBe(err.stack)
  })

  it('logs an error without a SQLSTATE and omits the sqlstate field', () => {
    const err = new Error('read ECONNRESET')
    expect(() => pool().emit('error', err)).not.toThrow()
    const [message, stack] = errorSpy.mock.calls[0]
    expect(message).toBe('Postgres pool idle-client error: read ECONNRESET')
    expect(stack).toBe(err.stack)
  })
})
