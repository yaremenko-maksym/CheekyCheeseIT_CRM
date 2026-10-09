import { Controller, Get, HttpException, HttpStatus, Module, UseGuards } from '@nestjs/common'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Throttle, ThrottlerModule } from '@nestjs/throttler'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RecordingMediaAuthService } from './recording-media-auth.service'
import {
  RecordingMediaAuthenticationGuard,
  RecordingMediaConnectionThrottlerGuard,
} from './recording-media-guards'

@Controller('media-probe')
@UseGuards(RecordingMediaAuthenticationGuard, RecordingMediaConnectionThrottlerGuard)
class MediaProbeController {
  @Get()
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  probe() {
    return { ok: true }
  }

  @Get('status')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  status() {
    return { ok: true }
  }
}

describe('recording media authentication and per-connection throttling', () => {
  let app: NestFastifyApplication | undefined
  const authenticate = vi.fn(async (header: string | undefined) => {
    if (header === 'Bearer revoked')
      throw new HttpException({ code: 'MEDIA_CONNECTION_DISABLED' }, HttpStatus.GONE)
    if (header === 'Bearer connection-a' || header === 'Bearer second-token-a')
      return 'connection-a'
    if (header === 'Bearer connection-b') return 'connection-b'
    throw new HttpException({ code: 'MEDIA_UNAUTHORIZED' }, HttpStatus.UNAUTHORIZED)
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    authenticate.mockClear()
  })

  async function request(token: string, route = '/media-probe') {
    return app!.inject({
      method: 'GET',
      url: route,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  async function setup() {
    @Module({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }])],
      controllers: [MediaProbeController],
      providers: [
        RecordingMediaAuthenticationGuard,
        RecordingMediaConnectionThrottlerGuard,
        { provide: RecordingMediaAuthService, useValue: { authenticate } },
      ],
    })
    class MediaProbeModule {}
    const moduleRef = await Test.createTestingModule({ imports: [MediaProbeModule] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }

  it('shares one quota across tokens for a connection while other connections retain their own budget', async () => {
    await setup()
    expect((await request('connection-a')).statusCode).toBe(200)
    expect((await request('second-token-a')).statusCode).toBe(200)
    expect((await request('connection-b')).statusCode).toBe(200)
    expect((await request('connection-b')).statusCode).toBe(200)
    expect((await request('connection-a')).statusCode).toBe(429)
    expect((await request('connection-b')).statusCode).toBe(429)
  })

  it('shares the connection budget across two distinct handlers', async () => {
    await setup()
    expect((await request('connection-a')).statusCode).toBe(200)
    expect((await request('second-token-a', '/media-probe/status')).statusCode).toBe(200)
    expect((await request('connection-a')).statusCode).toBe(429)
    expect((await request('connection-a', '/media-probe/status')).statusCode).toBe(429)
    expect((await request('connection-b', '/media-probe/status')).statusCode).toBe(200)
  })

  it('rejects unknown or disabled connections before they can consume a connection bucket', async () => {
    await setup()
    expect((await request('invalid')).statusCode).toBe(401)
    expect((await request('revoked')).statusCode).toBe(410)
    expect((await request('connection-a')).statusCode).toBe(200)
    expect((await request('connection-a')).statusCode).toBe(200)
    expect((await request('connection-a')).statusCode).toBe(429)
  })
})
