import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { DatabaseService } from './database.service'

// `pg.Pool` connects lazily, so initialising against an unreachable URL opens no socket;
// the test drives the pool's real `error` emitter, the same path an idle-client failure takes.
const config = {
  get: () => 'postgres://nobody:nopass@127.0.0.1:1/none',
} as unknown as ConfigService<Env>

describe('DatabaseService pool error listener', () => {
  let service: DatabaseService
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    service = new DatabaseService(config)
    await service.onModuleInit()
  })

  afterEach(async () => {
    await service.onModuleDestroy()
    errorSpy.mockRestore()
  })

  const pool = () => (service as unknown as { pool: import('pg').Pool }).pool

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
