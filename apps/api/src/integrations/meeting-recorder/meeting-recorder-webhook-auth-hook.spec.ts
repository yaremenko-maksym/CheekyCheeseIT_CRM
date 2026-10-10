import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isMeetingRecorderConnectionId,
  MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  registerMeetingRecorderWebhookOnRequestHook,
} from './meeting-recorder-webhook-auth-hook'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = NOW_MS / 1000

type OnRequestHook = (request: FastifyRequest, reply: FastifyReply, done: () => void) => void

function captureHook(): OnRequestHook {
  const addHook = vi.fn()
  const app = {
    getHttpAdapter: () => ({
      getInstance: () => ({ addHook }),
    }),
  } as unknown as NestFastifyApplication

  registerMeetingRecorderWebhookOnRequestHook(app)

  expect(addHook).toHaveBeenCalledOnce()
  expect(addHook.mock.calls[0]?.[0]).toBe('onRequest')
  return addHook.mock.calls[0]?.[1] as OnRequestHook
}

function requestFor(options?: {
  url?: string
  routeUrl?: string
  connectionId?: string
  timestamp?: string
  rawHeaders?: string[]
  headers?: Record<string, string | string[] | undefined>
}) {
  const timestamp = options?.timestamp ?? String(NOW_SECONDS)
  const headers = {
    'webhook-id': 'event-1',
    'webhook-timestamp': timestamp,
    'webhook-signature': 'v1,signature',
    ...options?.headers,
  }
  const rawHeaders = options?.rawHeaders ?? [
    'Webhook-Id',
    String(headers['webhook-id']),
    'Webhook-Timestamp',
    String(headers['webhook-timestamp']),
    'Webhook-Signature',
    String(headers['webhook-signature']),
  ]

  return {
    raw: {
      url: options?.url ?? `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook`,
      rawHeaders,
    },
    headers,
    params: { connectionId: options?.connectionId ?? CONNECTION_ID },
    routeOptions: {
      url: options?.routeUrl ?? '/api/integrations/meeting-recorder/:connectionId/webhook',
    },
  } as unknown as FastifyRequest
}

function invoke(hook: OnRequestHook, request: FastifyRequest) {
  const send = vi.fn()
  const status = vi.fn().mockReturnValue({ send })
  const done = vi.fn()

  hook(request, { status } as unknown as FastifyReply, done)

  return { done, status, send }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('meeting recorder webhook auth hook', () => {
  it('uses an exact five-minute timestamp tolerance', () => {
    expect(MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(300)
  })

  it.each([CONNECTION_ID, CONNECTION_ID.toUpperCase()])(
    'accepts UUID-shaped connection id %s',
    (value) => {
      expect(isMeetingRecorderConnectionId(value)).toBe(true)
    },
  )

  it.each([
    `x${CONNECTION_ID}`,
    `${CONNECTION_ID}x`,
    '1-1111-4111-8111-111111111111',
    'gggggggg-1111-4111-8111-111111111111',
    '11111111-1-4111-8111-111111111111',
    '11111111-gggg-4111-8111-111111111111',
    '11111111-1111-4-8111-111111111111',
    '11111111-1111-gggg-8111-111111111111',
    '11111111-1111-4111-8-111111111111',
    '11111111-1111-4111-gggg-111111111111',
    '11111111-1111-4111-8111-1',
    '11111111-1111-4111-8111-gggggggggggg',
  ])('rejects malformed connection id %s', (value) => {
    expect(isMeetingRecorderConnectionId(value)).toBe(false)
  })

  it('ignores non-webhook routes without inspecting authentication headers', () => {
    const hook = captureHook()
    const result = invoke(hook, requestFor({ url: '/api/interviews', routeUrl: '/api/interviews' }))

    expect(result.done).toHaveBeenCalledOnce()
    expect(result.status).not.toHaveBeenCalled()
  })

  it.each([
    `/prefix/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook`,
    `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook/extra`,
  ])('does not treat a near-match route as the webhook endpoint: %s', (url) => {
    const hook = captureHook()
    const result = invoke(
      hook,
      requestFor({
        url,
        routeUrl: '/api/interviews',
        headers: { 'webhook-id': undefined },
        rawHeaders: ['webhook-timestamp', String(NOW_SECONDS), 'webhook-signature', 'v1,signature'],
      }),
    )

    expect(result.done).toHaveBeenCalledOnce()
    expect(result.status).not.toHaveBeenCalled()
  })

  it('accepts the exact webhook route with or without a multi-character query string', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()

    const withoutQuery = invoke(hook, requestFor())
    const withQuery = invoke(
      hook,
      requestFor({
        url: `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook?trace=abc123`,
      }),
    )

    expect(withoutQuery.done).toHaveBeenCalledOnce()
    expect(withoutQuery.status).not.toHaveBeenCalled()
    expect(withQuery.done).toHaveBeenCalledOnce()
    expect(withQuery.status).not.toHaveBeenCalled()
  })

  it('authenticates an encoded static-path alias using the matched Fastify route metadata', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(
      hook,
      requestFor({
        url: `/api/integrations/meeting-recorder/${CONNECTION_ID}/%77ebhook`,
        headers: { 'webhook-id': undefined },
        rawHeaders: ['webhook-timestamp', String(NOW_SECONDS), 'webhook-signature', 'v1,signature'],
      }),
    )

    expect(result.done).not.toHaveBeenCalled()
    expect(result.status).toHaveBeenCalledWith(401)
  })

  it.each([
    `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook`,
    `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook?trace=abc123`,
  ])('authenticates requests on the exact webhook route: %s', (url) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(
      hook,
      requestFor({
        url,
        headers: { 'webhook-id': undefined },
        rawHeaders: ['webhook-timestamp', String(NOW_SECONDS), 'webhook-signature', 'v1,signature'],
      }),
    )

    expect(result.done).not.toHaveBeenCalled()
    expect(result.status).toHaveBeenCalledWith(401)
  })

  it('rejects a malformed connection id on the exact webhook route', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(
      hook,
      requestFor({
        url: '/api/integrations/meeting-recorder/not-a-uuid/webhook',
        connectionId: 'not-a-uuid',
      }),
    )

    expect(result.done).not.toHaveBeenCalled()
    expect(result.status).toHaveBeenCalledWith(401)
    expect(result.send).toHaveBeenCalledWith({
      code: 'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    })
  })

  it('accepts each required header exactly once, case-insensitively in raw headers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(
      hook,
      requestFor({
        rawHeaders: [
          'WEBHOOK-ID',
          'event-1',
          'webhook-timestamp',
          String(NOW_SECONDS),
          'Webhook-Signature',
          'v1,signature',
        ],
      }),
    )

    expect(result.done).toHaveBeenCalledOnce()
    expect(result.status).not.toHaveBeenCalled()
  })

  it('rejects duplicate required headers before body buffering', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(
      hook,
      requestFor({
        rawHeaders: [
          'webhook-id',
          'event-1',
          'Webhook-Id',
          'event-2',
          'webhook-timestamp',
          String(NOW_SECONDS),
          'webhook-signature',
          'v1,signature',
        ],
      }),
    )

    expect(result.done).not.toHaveBeenCalled()
    expect(result.status).toHaveBeenCalledWith(401)
  })

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const)(
    'rejects a missing %s header',
    (missingHeader) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
      const hook = captureHook()
      const headers: Record<string, string | string[] | undefined> = {
        'webhook-id': 'event-1',
        'webhook-timestamp': String(NOW_SECONDS),
        'webhook-signature': 'v1,signature',
      }
      headers[missingHeader] = undefined
      const rawHeaders = Object.entries(headers).flatMap(([name, value]) =>
        value === undefined ? [] : [name, String(value)],
      )
      const result = invoke(
        hook,
        requestFor({
          headers,
          rawHeaders,
        }),
      )

      expect(result.done).not.toHaveBeenCalled()
      expect(result.status).toHaveBeenCalledWith(401)
    },
  )

  it('rejects empty and non-string required header values', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const empty = invoke(
      hook,
      requestFor({
        headers: { 'webhook-id': '' },
        rawHeaders: [
          'webhook-id',
          '',
          'webhook-timestamp',
          String(NOW_SECONDS),
          'webhook-signature',
          'v1,signature',
        ],
      }),
    )
    const arrayValue = invoke(
      hook,
      requestFor({
        headers: { 'webhook-signature': ['v1,a', 'v1,b'] },
        rawHeaders: [
          'webhook-id',
          'event-1',
          'webhook-timestamp',
          String(NOW_SECONDS),
          'webhook-signature',
          'v1,a',
        ],
      }),
    )

    expect(empty.status).toHaveBeenCalledWith(401)
    expect(arrayValue.status).toHaveBeenCalledWith(401)
  })

  it.each([
    'abc',
    `${NOW_SECONDS}x`,
    `x${NOW_SECONDS}`,
    `+${NOW_SECONDS}`,
    `${NOW_SECONDS}.5`,
    `${NOW_SECONDS} `,
    '',
  ])('rejects non-integer timestamp syntax %j', (timestamp) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(hook, requestFor({ timestamp }))

    expect(result.done).not.toHaveBeenCalled()
    expect(result.status).toHaveBeenCalledWith(401)
  })

  it('rejects integers outside the safe JavaScript range', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const result = invoke(hook, requestFor({ timestamp: '999999999999999999999' }))

    expect(result.done).not.toHaveBeenCalled()
    expect(result.status).toHaveBeenCalledWith(401)
  })

  it('accepts timestamps exactly at either tolerance boundary', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()

    const past = invoke(
      hook,
      requestFor({
        timestamp: String(NOW_SECONDS - MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS),
      }),
    )
    const future = invoke(
      hook,
      requestFor({
        timestamp: String(NOW_SECONDS + MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS),
      }),
    )

    expect(past.done).toHaveBeenCalledOnce()
    expect(future.done).toHaveBeenCalledOnce()
  })

  it('rejects timestamps just outside either tolerance boundary', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const hook = captureHook()
    const delta = MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1

    const past = invoke(hook, requestFor({ timestamp: String(NOW_SECONDS - delta) }))
    const future = invoke(hook, requestFor({ timestamp: String(NOW_SECONDS + delta) }))

    expect(past.done).not.toHaveBeenCalled()
    expect(past.status).toHaveBeenCalledWith(401)
    expect(future.done).not.toHaveBeenCalled()
    expect(future.status).toHaveBeenCalledWith(401)
  })
})
