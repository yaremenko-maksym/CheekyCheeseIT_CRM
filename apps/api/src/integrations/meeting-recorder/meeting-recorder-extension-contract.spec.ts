import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { meetingRecorderWebhookEventSchema } from '@crm/shared'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerMeetingRecorderContentTypeParser } from './meeting-recorder-webhook-parser'
import {
  type MeetingRecorderWebhookHeaders,
  MeetingRecorderWebhookVerifier,
} from './meeting-recorder-webhook-verifier'

type FixtureManifest = {
  version: 1
  sourceExtensionCommit: string
  testSigningSecret: string
  fixtures: Array<{
    filename: string
    sha256: string
    headers: {
      'content-type': string
      'webhook-id': string
      'webhook-timestamp': string
      'webhook-signature': string
    }
  }>
}

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const manifest = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'),
) as FixtureManifest

function asNestFastifyApplication(instance: FastifyInstance): NestFastifyApplication {
  return {
    getHttpAdapter: () => ({ getInstance: () => instance }),
  } as unknown as NestFastifyApplication
}

describe('meeting recorder extension contract fixtures', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await app?.close()
    app = undefined
  })

  async function buildReceiver(): Promise<FastifyInstance> {
    const verifier = new MeetingRecorderWebhookVerifier()
    app = Fastify()
    registerMeetingRecorderContentTypeParser(asNestFastifyApplication(app))
    app.post('/probe', async (request, reply) => {
      const rawBody = request.body
      if (typeof rawBody !== 'string') return reply.code(415).send()

      const headers = {
        'webhook-id': request.headers['webhook-id'],
        'webhook-timestamp': request.headers['webhook-timestamp'],
        'webhook-signature': request.headers['webhook-signature'],
      }
      if (
        typeof headers['webhook-id'] !== 'string' ||
        typeof headers['webhook-timestamp'] !== 'string' ||
        typeof headers['webhook-signature'] !== 'string'
      ) {
        return reply.code(401).send()
      }

      if (
        !verifier.verify(
          rawBody,
          headers as MeetingRecorderWebhookHeaders,
          manifest.testSigningSecret,
        )
      ) {
        return reply.code(401).send()
      }

      const parsed = meetingRecorderWebhookEventSchema.safeParse(JSON.parse(rawBody))
      if (!parsed.success) return reply.code(422).send()

      return reply.code(204).send()
    })
    await app.ready()
    return app
  }

  it('records the exact extension commit that published the vendored fixtures', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.sourceExtensionCommit).toBe('4431290cf215c4f76ef17dd22b0580493caa7eb1')
  })

  for (const fixture of manifest.fixtures) {
    it(`accepts the extension-produced ${fixture.filename} bytes`, async () => {
      const body = readFileSync(join(FIXTURE_DIR, fixture.filename), 'utf8')
      expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(fixture.sha256)

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Number(fixture.headers['webhook-timestamp']) * 1000)

      const receiver = await buildReceiver()
      const response = await receiver.inject({
        method: 'POST',
        url: '/probe',
        headers: fixture.headers,
        payload: body,
      })

      expect(response.statusCode).toBe(204)
    })
  }

  it('rejects a schema-valid payload after its signed bytes are tampered with', async () => {
    const fixture = manifest.fixtures.find(({ filename }) => filename === 'recording-ready-v1.json')
    expect(fixture).toBeDefined()
    if (!fixture) return

    const body = readFileSync(join(FIXTURE_DIR, fixture.filename), 'utf8')
    const tamperedBody = body.replace('CRM contract review', 'CRM contract review!')
    expect(tamperedBody).not.toBe(body)
    expect(meetingRecorderWebhookEventSchema.safeParse(JSON.parse(tamperedBody)).success).toBe(true)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Number(fixture.headers['webhook-timestamp']) * 1000)

    const receiver = await buildReceiver()
    const response = await receiver.inject({
      method: 'POST',
      url: '/probe',
      headers: fixture.headers,
      payload: tamperedBody,
    })

    expect(response.statusCode).toBe(401)
  })
})
