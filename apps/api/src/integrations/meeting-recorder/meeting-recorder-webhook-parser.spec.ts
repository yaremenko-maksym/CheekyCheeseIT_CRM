import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  isMeetingRecorderCloudEventsContentType,
  MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES,
  registerMeetingRecorderContentTypeParser,
} from './meeting-recorder-webhook-parser'

function asNestFastifyApplication(instance: FastifyInstance): NestFastifyApplication {
  return {
    getHttpAdapter: () => ({ getInstance: () => instance }),
  } as unknown as NestFastifyApplication
}

describe('meeting recorder raw-body content-type parser', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function buildApp(): Promise<FastifyInstance> {
    app = Fastify()
    registerMeetingRecorderContentTypeParser(asNestFastifyApplication(app))
    app.post('/probe', async (request) => ({
      body: request.body,
      utf8Bytes: Buffer.byteLength(request.body as string, 'utf8'),
    }))
    await app.ready()
    return app
  }

  it('pins the sender-compatible inclusive 2 MiB UTF-8 byte limit', () => {
    expect(MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024)
  })

  it.each([
    'application/cloudevents+json',
    'Application/CloudEvents+Json ; charset=utf-8',
    'application/cloudevents+json; charset=utf-8',
  ])('recognizes the exact CloudEvents content type %s', (value) => {
    expect(isMeetingRecorderCloudEventsContentType(value)).toBe(true)
  })

  it.each([
    'xapplication/cloudevents+json',
    'application/cloudevents+jsonx',
    'application/json',
    ['application/cloudevents+json'],
    null,
    42,
  ])('does not recognize unrelated or non-string content type %j', (value) => {
    expect(isMeetingRecorderCloudEventsContentType(value)).toBe(false)
  })

  it('accepts exactly 2 MiB and preserves the exact raw string', async () => {
    const server = await buildApp()
    const body = 'x'.repeat(MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES)

    const response = await server.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/cloudevents+json' },
      payload: body,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      body,
      utf8Bytes: MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES,
    })
  })

  it('rejects 2 MiB + 1 byte with 413 before the route handler can consume it', async () => {
    const server = await buildApp()
    const body = 'x'.repeat(MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES + 1)

    const response = await server.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/cloudevents+json' },
      payload: body,
    })

    expect(response.statusCode).toBe(413)
  })

  it('counts UTF-8 bytes rather than JavaScript code units', async () => {
    const server = await buildApp()
    const twoByteCharacter = 'é'
    const body = twoByteCharacter.repeat(MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES / 2)

    expect(body.length).toBe(MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES / 2)
    expect(Buffer.byteLength(body, 'utf8')).toBe(MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES)

    const response = await server.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/cloudevents+json; charset=utf-8' },
      payload: body,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      body,
      utf8Bytes: MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES,
    })
  })

  it('accepts optional content-type parameters case-insensitively', async () => {
    const server = await buildApp()
    const body = '{"signed":"bytes stay raw"}'

    const response = await server.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'Application/CloudEvents+Json ; charset=utf-8' },
      payload: body,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ body, utf8Bytes: Buffer.byteLength(body, 'utf8') })
  })

  it('does not claim unrelated content types', async () => {
    const server = await buildApp()

    const response = await server.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'raw bytes',
    })

    expect(response.statusCode).toBe(415)
  })
})
