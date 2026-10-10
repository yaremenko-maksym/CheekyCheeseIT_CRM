import { HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ConfigService } from '@nestjs/config'
import {
  MEETING_RECORDER_TEST_EVENT_TYPE,
  MEETING_RECORDER_UPDATED_EVENT_TYPE,
  type SessionUser,
} from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'

import {
  MeetingRecorderAdminController,
  MeetingRecorderWebhookController,
} from './meeting-recorder.controller'
import {
  meetingRecorderWebhookError,
  normalizeMeetingRecorderWebhookIngestionError,
} from './meeting-recorder-errors'
import type { MeetingRecorderService } from './meeting-recorder.service'
import type { MeetingRecorderWebhookVerifier } from './meeting-recorder-webhook-verifier'
import type { RecordingMediaAuthService } from './media/recording-media-auth.service'
import type { RecordingMediaStorageService } from './media/recording-media-storage.service'
import type { Env } from '../../config/env'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const EVENT_ID = 'event_11111111-1111-4111-8111-111111111111'
const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

const event = {
  specversion: '1.0',
  id: EVENT_ID,
  source: 'urn:meeting-recorder:destination:producer_test',
  type: MEETING_RECORDER_TEST_EVENT_TYPE,
  subject: 'integration/test',
  time: '2026-10-07T19:00:00.000Z',
  datacontenttype: 'application/json',
  data: { test: true },
}

const snapshotEvent = {
  ...event,
  id: 'event_22222222-2222-4222-8222-222222222222',
  type: MEETING_RECORDER_UPDATED_EVENT_TYPE,
  subject: 'recording/recording-external-1',
  data: {
    revision: 2,
    readiness: { complete: true, release: 'complete', pending: [] },
    recording: {
      id: 'recording-external-1',
      title: 'Interview',
      startedAt: '2026-10-07T18:00:00.000Z',
      durationMs: 2_520_000,
      source: {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    },
  },
}

function request(overrides: Record<string, unknown> = {}): FastifyRequest {
  return {
    headers: {
      'content-type': 'application/cloudevents+json',
      'webhook-id': EVENT_ID,
      'webhook-timestamp': '1791374400',
      'webhook-signature': 'v1,signature',
      ...overrides,
    },
  } as unknown as FastifyRequest
}

function mocks() {
  const service = {
    getWebhookAuthentication: vi.fn().mockResolvedValue({
      secret: SECRET,
      signingSecretCiphertext: 'v1:encrypted',
    }),
    ingestWebhookEvent: vi.fn().mockResolvedValue(undefined),
    listConnections: vi.fn().mockReturnValue('connections'),
    createConnection: vi.fn().mockReturnValue('created'),
    updateConnection: vi.fn().mockReturnValue('updated'),
    setConnectionSecret: vi.fn().mockReturnValue('secret-set'),
    resetPairing: vi.fn().mockReturnValue('pairing-reset'),
  }
  const verifier = { verify: vi.fn().mockReturnValue(true) }
  const mediaAuth = {
    isProvisioned: vi.fn().mockResolvedValue(false),
    replaceToken: vi.fn().mockResolvedValue({ token: 'new-token' }),
  }
  const storage = {
    uploadOrigin: vi.fn().mockResolvedValue('https://bucket.r2.cloudflarestorage.com'),
  }
  const config = { get: vi.fn().mockReturnValue('https://app.cheekycheese.tech') }
  const reply = {
    code: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply
  const controller = new MeetingRecorderWebhookController(
    service as unknown as MeetingRecorderService,
    verifier as unknown as MeetingRecorderWebhookVerifier,
    mediaAuth as unknown as RecordingMediaAuthService,
    storage as unknown as RecordingMediaStorageService,
    config as unknown as ConfigService<Env, true>,
  )
  return { service, verifier, mediaAuth, storage, config, reply, controller }
}

async function expectWebhookError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(HttpException)
  expect((error as HttpException).getStatus()).toBe(status)
  expect((error as HttpException).getResponse()).toEqual({ code })
}

describe('MeetingRecorderWebhookController', () => {
  it.each([
    'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    'MEETING_RECORDER_SOURCE_MISMATCH',
    'MEETING_RECORDER_CONNECTION_DISABLED',
    'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
    'MEETING_RECORDER_EVENT_INVALID',
  ] as const)('preserves allow-listed webhook error %s', (code) => {
    const expected = meetingRecorderWebhookError(code, HttpStatus.BAD_REQUEST)

    expect(normalizeMeetingRecorderWebhookIngestionError(expected, CONNECTION_ID)).toBe(expected)
  })

  it.each([400, 499])('preserves allow-listed webhook errors at 4xx boundary %s', (status) => {
    const expected = meetingRecorderWebhookError(
      'MEETING_RECORDER_CONNECTION_DISABLED',
      status as never,
    )

    expect(normalizeMeetingRecorderWebhookIngestionError(expected, CONNECTION_ID)).toBe(expected)
  })

  it.each([399, 500])(
    'normalizes allow-listed codes outside the 4xx range at status %s',
    (status) => {
      const unexpected = new HttpException({ code: 'MEETING_RECORDER_CONNECTION_DISABLED' }, status)

      const normalized = normalizeMeetingRecorderWebhookIngestionError(unexpected, CONNECTION_ID)

      expect(normalized).not.toBe(unexpected)
      expect(normalized.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    },
  )

  it.each([
    ['string response', 'MEETING_RECORDER_CONNECTION_DISABLED'],
    ['null response', null],
    ['object without code', {}],
  ])('normalizes a 4xx HttpException with malformed %s', (_label, response) => {
    const unexpected = new HttpException(response as never, HttpStatus.GONE)

    const normalized = normalizeMeetingRecorderWebhookIngestionError(unexpected, CONNECTION_ID)

    expect(normalized).not.toBe(unexpected)
    expect(normalized.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
  })

  it('rejects malformed connection ids before authentication', async () => {
    const { controller, service, reply } = mocks()

    await expectWebhookError(
      controller.receiveWebhook('not-a-uuid', JSON.stringify(event), request(), reply),
      401,
      'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    )
    expect(service.getWebhookAuthentication).not.toHaveBeenCalled()
  })

  it.each([
    ['content-type', 'application/json', JSON.stringify(event)],
    ['body', 'application/cloudevents+json', event],
  ])('rejects unsupported webhook %s', async (_label, contentType, body) => {
    const { controller, service, reply } = mocks()

    await expectWebhookError(
      controller.receiveWebhook(
        CONNECTION_ID,
        body,
        request({ 'content-type': contentType }),
        reply,
      ),
      415,
      'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
    )
    expect(service.getWebhookAuthentication).not.toHaveBeenCalled()
  })

  it.each([
    ['webhook-id', undefined],
    ['webhook-timestamp', undefined],
    ['webhook-signature', undefined],
    ['webhook-id', ['duplicate']],
    ['webhook-timestamp', ['duplicate']],
    ['webhook-signature', ['duplicate']],
  ])('rejects invalid %s header value', async (name, value) => {
    const { controller, service, reply } = mocks()

    await expectWebhookError(
      controller.receiveWebhook(
        CONNECTION_ID,
        JSON.stringify(event),
        request({ [name]: value }),
        reply,
      ),
      401,
      'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    )
    expect(service.getWebhookAuthentication).not.toHaveBeenCalled()
  })

  it('rejects a failed cryptographic verification', async () => {
    const { controller, verifier, service, reply } = mocks()
    verifier.verify.mockReturnValue(false)

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply),
      401,
      'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    )
    expect(verifier.verify).toHaveBeenCalledWith(
      JSON.stringify(event),
      {
        'webhook-id': EVENT_ID,
        'webhook-timestamp': '1791374400',
        'webhook-signature': 'v1,signature',
      },
      SECRET,
    )
    expect(service.ingestWebhookEvent).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON after signature verification', async () => {
    const { controller, service, reply } = mocks()

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, '{', request(), reply),
      422,
      'MEETING_RECORDER_EVENT_INVALID',
    )
    expect(service.ingestWebhookEvent).not.toHaveBeenCalled()
  })

  it('rejects schema-invalid events and webhook-id mismatches', async () => {
    const invalid = mocks()
    await expectWebhookError(
      invalid.controller.receiveWebhook(CONNECTION_ID, '{}', request(), invalid.reply),
      422,
      'MEETING_RECORDER_EVENT_INVALID',
    )
    expect(invalid.service.ingestWebhookEvent).not.toHaveBeenCalled()

    const mismatched = mocks()
    await expectWebhookError(
      mismatched.controller.receiveWebhook(
        CONNECTION_ID,
        JSON.stringify(event),
        request({ 'webhook-id': 'event_different' }),
        mismatched.reply,
      ),
      422,
      'MEETING_RECORDER_EVENT_INVALID',
    )
    expect(mismatched.service.ingestWebhookEvent).not.toHaveBeenCalled()
  })

  it('verifies and ingests a valid signed event with the authenticated ciphertext', async () => {
    const { controller, service, verifier, reply } = mocks()
    const body = JSON.stringify(event)

    await expect(
      controller.receiveWebhook(CONNECTION_ID, body, request(), reply),
    ).resolves.toBeUndefined()
    expect(reply.code).toHaveBeenCalledWith(204)

    expect(service.getWebhookAuthentication).toHaveBeenCalledWith(CONNECTION_ID)
    expect(verifier.verify).toHaveBeenCalledWith(
      body,
      {
        'webhook-id': EVENT_ID,
        'webhook-timestamp': '1791374400',
        'webhook-signature': 'v1,signature',
      },
      SECRET,
    )
    expect(service.ingestWebhookEvent).toHaveBeenCalledWith(CONNECTION_ID, event, 'v1:encrypted')
  })

  // CR-M-2: the 503 carries no detail, so the requestId it mints must correlate
  // with a server-side line or a prod ingestion failure is unexplainable. The
  // line goes through the #1042 redaction helpers, so it carries the SQLSTATE
  // and frames but none of the bound parameter values.
  it('logs the redacted failure under the same requestId, with no transcript in the line', async () => {
    const { controller, service, reply } = mocks()
    const transcript = 'PRIVATE_TRANSCRIPT_CANARY'
    // Shaped like a real drizzle error, which is what makes this a test of the
    // redaction and not of a stub: `query` plus a `params` ARRAY holding the bound
    // values (where the transcript actually lives), and a pg `cause` carrying the
    // SQLSTATE and `severity` — the two fields `pg-errors` keys its detectors on.
    const driverError = Object.assign(
      new Error(`Failed query: insert into "interview_recordings" ... params: ${transcript}`),
      {
        query: 'insert into "interview_recordings" (snapshot) values ($1)',
        params: [transcript],
        cause: Object.assign(new Error('null value in column violates not-null constraint'), {
          code: '23502',
          severity: 'ERROR',
          table: 'interview_recordings',
        }),
      },
    )
    service.ingestWebhookEvent.mockRejectedValue(driverError)

    const logged: Array<unknown[]> = []
    const contexts: Array<string | undefined> = []
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(function (
      this: Logger,
      ...args: unknown[]
    ) {
      contexts.push((this as unknown as { context?: string }).context)
      logged.push(args)
    })

    try {
      const error = await controller
        .receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply)
        .then(
          () => null,
          (reason: unknown) => reason,
        )

      const response = (error as HttpException).getResponse() as Record<string, unknown>
      const requestId = response['requestId'] as string
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)

      expect(logged).toHaveLength(1)
      // The context is what an on-call greps for to find this line among the others.
      expect(contexts).toEqual(['MeetingRecorderWebhook'])
      const line = logged[0]!.map((part) => String(part)).join(' ')
      // Correlates with what the caller was handed …
      expect(line).toContain(requestId)
      expect(line).toContain(CONNECTION_ID)
      // … carries a usable diagnostic …
      expect(line).toContain('23502')
      // … and none of the bound values OF THIS SHAPE. This proves the drizzle
      // case only — a drizzle error whose `params` array holds the value. The
      // plain-`Error` shape is a different redaction path, covered by the case
      // above it (SR-M-2).
      expect(line).not.toContain(transcript)
      expect(line).not.toContain('params:')
    } finally {
      spy.mockRestore()
    }
  })

  // SR-M-2: the shape that is latent today and the one the sibling tests in this
  // very file already build — a plain `Error` whose MESSAGE carries the transcript,
  // as any wrapper rethrowing with `${e.message}` would produce. `safeErrorStack`
  // would have logged that message verbatim, because it redacts only pg/drizzle
  // nodes; `strictErrorStack` logs the name and frames and never the message.
  it('logs no message for a plain Error whose message carries a transcript', async () => {
    const { controller, service, reply } = mocks()
    const transcript = 'PRIVATE_TRANSCRIPT_CANARY'
    service.ingestWebhookEvent.mockRejectedValue(
      new Error(`wrapper failed while ingesting: ${transcript}`),
    )

    const logged: Array<unknown[]> = []
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => void logged.push(args))

    try {
      const error = await controller
        .receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply)
        .then(
          () => null,
          (reason: unknown) => reason,
        )

      const response = (error as HttpException).getResponse() as Record<string, unknown>
      const requestId = response['requestId'] as string

      expect(logged).toHaveLength(1)
      const line = logged[0]!.map((part) => String(part)).join(' ')
      expect(line).toContain(requestId)
      expect(line).not.toContain(transcript)
      // The name survives, so the line is still worth having.
      expect(line).toContain('Error')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports a non-Error throw by type alone, never by its value', async () => {
    const { controller, service, reply } = mocks()
    // `String(err)` on a thrown string IS the value — exactly what must not be logged.
    service.ingestWebhookEvent.mockRejectedValue('PRIVATE_TRANSCRIPT_CANARY')

    const logged: Array<unknown[]> = []
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => void logged.push(args))

    try {
      await controller
        .receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply)
        .catch(() => undefined)
      const line = logged[0]!.map((part) => String(part)).join(' ')
      expect(line).not.toContain('PRIVATE_TRANSCRIPT_CANARY')
      expect(line).toContain('NonError(string)')
    } finally {
      spy.mockRestore()
    }
  })

  it('normalizes unexpected ingestion failures before telemetry can see private recorder content', async () => {
    const { controller, service, reply } = mocks()
    const canaries = [
      'PRIVATE_TRANSCRIPT_CANARY',
      'PRIVATE_NOTE_CANARY',
      'urn:private:source:canary',
      'recording-private-canary',
      'v1,private-signature-canary',
      'private-secret-canary',
    ]
    service.ingestWebhookEvent.mockRejectedValue(
      new Error(`driver failed sql=params ${canaries.join(' ')}`),
    )

    const error = await controller
      .receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply)
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    const response = (error as HttpException).getResponse() as Record<string, unknown>
    expect(response['code']).toBe('MEETING_RECORDER_WEBHOOK_INGESTION_FAILED')
    expect(response['operation']).toBe('meeting-recorder-webhook-ingest')
    expect(response['diagnosticCode']).toBe('UNEXPECTED_INGESTION_FAILURE')
    expect(response['connectionId']).toBe(CONNECTION_ID)
    expect(response['requestId']).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(response['message']).toBe(
      `meeting-recorder-webhook-ingest failed; requestId=${response['requestId']}; connectionId=${CONNECTION_ID}; diagnosticCode=UNEXPECTED_INGESTION_FAILURE`,
    )
    const serialized = JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
      response,
    })
    for (const canary of canaries) expect(serialized).not.toContain(canary)
    expect(serialized).toContain('meeting-recorder-webhook-ingest')
    expect(serialized).toContain(CONNECTION_ID)
  })

  it('preserves the allow-listed expected webhook 4xx error shape from ingestion', async () => {
    const { controller, service, reply } = mocks()
    const expected = meetingRecorderWebhookError(
      'MEETING_RECORDER_CONNECTION_DISABLED',
      HttpStatus.GONE,
    )
    service.ingestWebhookEvent.mockRejectedValue(expected)

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply),
      HttpStatus.GONE,
      'MEETING_RECORDER_CONNECTION_DISABLED',
    )
  })

  it('normalizes unexpected webhook 5xx HttpExceptions instead of forwarding their message/cause', async () => {
    const { controller, service, reply } = mocks()
    service.ingestWebhookEvent.mockRejectedValue(
      new HttpException('PRIVATE_TRANSCRIPT_CANARY', HttpStatus.INTERNAL_SERVER_ERROR),
    )

    const error = await controller
      .receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), reply)
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(JSON.stringify(error)).not.toContain('PRIVATE_TRANSCRIPT_CANARY')
  })

  it('advertises media only for a provisioned connection with HTTPS storage', async () => {
    const ctx = mocks()
    ctx.mediaAuth.isProvisioned.mockResolvedValue(true)
    const result = await ctx.controller.receiveWebhook(
      CONNECTION_ID,
      JSON.stringify(event),
      request(),
      ctx.reply,
    )
    expect(ctx.reply.code).toHaveBeenCalledWith(200)
    expect(ctx.reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(ctx.config.get).toHaveBeenCalledWith('FRONTEND_URL', { infer: true })
    expect(result).toEqual({
      protocol: 'io.github.kstroevsky.meeting-recorder.service.v1',
      capabilities: {
        events: { version: 1 },
        media: {
          version: 1,
          apiBase: 'https://app.cheekycheese.tech/api/integrations/meeting-recorder/media',
          upload: {
            strategy: 'multipart-put-v1',
            origins: ['https://bucket.r2.cloudflarestorage.com'],
          },
          playback: { strategy: 'refreshable-url-v1' },
        },
      },
    })
    ctx.storage.uploadOrigin.mockResolvedValue(null)
    await expect(
      ctx.controller.receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), ctx.reply),
    ).resolves.toBeUndefined()
    expect(ctx.reply.code).toHaveBeenLastCalledWith(204)
  })

  it('never advertises media capabilities on ordinary recording events', async () => {
    const ctx = mocks()
    ctx.mediaAuth.isProvisioned.mockResolvedValue(true)
    const body = JSON.stringify(snapshotEvent)
    const req = request({ 'webhook-id': snapshotEvent.id })

    await expect(
      ctx.controller.receiveWebhook(CONNECTION_ID, body, req, ctx.reply),
    ).resolves.toBeUndefined()
    expect(ctx.mediaAuth.isProvisioned).not.toHaveBeenCalled()
    expect(ctx.storage.uploadOrigin).not.toHaveBeenCalled()
    expect(ctx.reply.code).toHaveBeenLastCalledWith(204)
  })

  it('requires an HTTPS CRM frontend origin before advertising media', async () => {
    const ctx = mocks()
    ctx.mediaAuth.isProvisioned.mockResolvedValue(true)
    ctx.config.get.mockReturnValue('http://localhost:3000')

    await expect(
      ctx.controller.receiveWebhook(CONNECTION_ID, JSON.stringify(event), request(), ctx.reply),
    ).resolves.toBeUndefined()
    expect(ctx.storage.uploadOrigin).toHaveBeenCalledTimes(1)
    expect(ctx.config.get).toHaveBeenCalledWith('FRONTEND_URL', { infer: true })
    expect(ctx.reply.code).toHaveBeenLastCalledWith(204)
  })
})

describe('MeetingRecorderAdminController', () => {
  const user = { id: '33333333-3333-4333-8333-333333333333' } as SessionUser

  it('validates inputs and delegates all connection administration methods', () => {
    const { service } = mocks()
    const controller = new MeetingRecorderAdminController(
      service as unknown as MeetingRecorderService,
      { replaceToken: vi.fn() } as unknown as RecordingMediaAuthService,
    )

    expect(controller.listConnections()).toBe('connections')
    expect(controller.createConnection({ name: ' Recorder ' }, user)).toBe('created')
    expect(service.createConnection).toHaveBeenCalledWith({ name: 'Recorder' }, user.id)

    expect(controller.updateConnection(CONNECTION_ID, { enabled: false }, user)).toBe('updated')
    expect(service.updateConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      { enabled: false },
      user.id,
    )

    expect(controller.setSecret(CONNECTION_ID, { secret: SECRET }, user)).toBe('secret-set')
    expect(service.setConnectionSecret).toHaveBeenCalledWith(
      CONNECTION_ID,
      { secret: SECRET },
      user.id,
    )

    expect(controller.resetPairing(CONNECTION_ID, user)).toBe('pairing-reset')
    expect(service.resetPairing).toHaveBeenCalledWith(CONNECTION_ID, user.id)
  })
})
