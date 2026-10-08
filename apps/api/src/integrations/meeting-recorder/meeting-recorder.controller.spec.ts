import { HttpException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { MEETING_RECORDER_TEST_EVENT_TYPE, type SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'

import {
  MeetingRecorderAdminController,
  MeetingRecorderWebhookController,
} from './meeting-recorder.controller'
import type { MeetingRecorderService } from './meeting-recorder.service'
import type { MeetingRecorderWebhookVerifier } from './meeting-recorder-webhook-verifier'

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
  const controller = new MeetingRecorderWebhookController(
    service as unknown as MeetingRecorderService,
    verifier as unknown as MeetingRecorderWebhookVerifier,
  )
  return { service, verifier, controller }
}

async function expectWebhookError(promise: Promise<void>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(HttpException)
  expect((error as HttpException).getStatus()).toBe(status)
  expect((error as HttpException).getResponse()).toEqual({ code })
}

describe('MeetingRecorderWebhookController', () => {
  it('rejects malformed connection ids before authentication', async () => {
    const { controller, service } = mocks()

    await expectWebhookError(
      controller.receiveWebhook('not-a-uuid', JSON.stringify(event), request()),
      401,
      'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    )
    expect(service.getWebhookAuthentication).not.toHaveBeenCalled()
  })

  it.each([
    ['content-type', 'application/json', JSON.stringify(event)],
    ['body', 'application/cloudevents+json', event],
  ])('rejects unsupported webhook %s', async (_label, contentType, body) => {
    const { controller, service } = mocks()

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, body, request({ 'content-type': contentType })),
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
    const { controller, service } = mocks()

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, JSON.stringify(event), request({ [name]: value })),
      401,
      'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    )
    expect(service.getWebhookAuthentication).not.toHaveBeenCalled()
  })

  it('rejects a failed cryptographic verification', async () => {
    const { controller, verifier, service } = mocks()
    verifier.verify.mockReturnValue(false)

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, JSON.stringify(event), request()),
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
    const { controller, service } = mocks()

    await expectWebhookError(
      controller.receiveWebhook(CONNECTION_ID, '{', request()),
      422,
      'MEETING_RECORDER_EVENT_INVALID',
    )
    expect(service.ingestWebhookEvent).not.toHaveBeenCalled()
  })

  it('rejects schema-invalid events and webhook-id mismatches', async () => {
    const invalid = mocks()
    await expectWebhookError(
      invalid.controller.receiveWebhook(CONNECTION_ID, '{}', request()),
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
      ),
      422,
      'MEETING_RECORDER_EVENT_INVALID',
    )
    expect(mismatched.service.ingestWebhookEvent).not.toHaveBeenCalled()
  })

  it('verifies and ingests a valid signed event with the authenticated ciphertext', async () => {
    const { controller, service, verifier } = mocks()
    const body = JSON.stringify(event)

    await expect(controller.receiveWebhook(CONNECTION_ID, body, request())).resolves.toBeUndefined()

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
})

describe('MeetingRecorderAdminController', () => {
  const user = { id: '33333333-3333-4333-8333-333333333333' } as SessionUser

  it('validates inputs and delegates all connection administration methods', () => {
    const { service } = mocks()
    const controller = new MeetingRecorderAdminController(
      service as unknown as MeetingRecorderService,
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
