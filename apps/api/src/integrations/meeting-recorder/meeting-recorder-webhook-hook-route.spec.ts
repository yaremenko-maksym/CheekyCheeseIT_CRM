/**
 * SPEC-L-2 (PR #868 fix round 1). The hook's own spec SUPPLIES
 * `request.routeOptions.url`, so it proves the comparison and nothing about the value:
 * if Fastify reported a different template under Nest's global prefix, the fix would be
 * wrong in production with that test still green. Being wrong in exactly that way is
 * silent — the hook would simply never run, and every pre-body check (single
 * `webhook-*` headers, numeric timestamp, +-300 s tolerance) would be skipped while the
 * controller still answered normally.
 *
 * So this file boots a REAL Fastify instance through Nest, in the order `main.ts` uses
 * (hook registered, then `setGlobalPrefix('api')`), and drives it with `inject()`. No
 * routeOptions are supplied by the test: the value under assertion is whatever Fastify
 * itself reports.
 *
 * The probe is a STALE TIMESTAMP, which only the hook can refuse — it rejects before the
 * body is parsed, so the service and the verifier are never reached. That is asserted
 * too: a 401 alone would not distinguish the hook from the controller's own
 * unauthorized path.
 */
import { Test } from '@nestjs/testing'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MeetingRecorderWebhookController } from './meeting-recorder.controller'
import { MeetingRecorderService } from './meeting-recorder.service'
import { MeetingRecorderWebhookVerifier } from './meeting-recorder-webhook-verifier'
import {
  MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  registerMeetingRecorderWebhookOnRequestHook,
} from './meeting-recorder-webhook-auth-hook'
import { registerMeetingRecorderContentTypeParser } from './meeting-recorder-webhook-parser'

const CONNECTION_ID = '11111111-2222-4333-8444-555555555555'
const WEBHOOK_PATH = `/api/integrations/meeting-recorder/${CONNECTION_ID}/webhook`

const getWebhookAuthentication = vi.fn()
const ingestWebhookEvent = vi.fn()
const verify = vi.fn()

let app: NestFastifyApplication

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [MeetingRecorderWebhookController],
    providers: [
      {
        provide: MeetingRecorderService,
        useValue: { getWebhookAuthentication, ingestWebhookEvent },
      },
      { provide: MeetingRecorderWebhookVerifier, useValue: { verify } },
    ],
  }).compile()

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  // Same order as main.ts: the hook is registered BEFORE the prefix is set, which is
  // part of what makes the reported template worth proving.
  // Same two registrations main.ts makes, in main.ts's order, so the instance under
  // test differs from production in nothing that matters here.
  registerMeetingRecorderContentTypeParser(app)
  registerMeetingRecorderWebhookOnRequestHook(app)
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
})

afterAll(async () => {
  if (app !== undefined) await app.close()
})

describe('meeting-recorder webhook onRequest hook — real Fastify route template', () => {
  it('runs on the real prefixed route and refuses a stale timestamp before the body is read', async () => {
    getWebhookAuthentication.mockClear()
    ingestWebhookEvent.mockClear()
    verify.mockClear()

    const stale =
      Math.floor(Date.now() / 1000) - MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 60

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: WEBHOOK_PATH,
        headers: {
          'content-type': 'application/cloudevents+json',
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(stale),
          'webhook-signature': 'v1,signature',
        },
        payload: '{"id":"msg_1"}',
      })

    expect(response.statusCode).toBe(401)
    // The hook refused, not the controller: neither of the controller's collaborators
    // was reached. (The controller cannot produce this outcome without calling them.)
    expect(getWebhookAuthentication).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(ingestWebhookEvent).not.toHaveBeenCalled()
  })

  // The duplicated-header check is NOT exercised here on purpose: `inject` joins an
  // array header into a single value, so the array the hook branches on cannot be
  // produced through it. That branch stays covered by the unit spec, which can build
  // the header shape directly. Asserting it here would have tested the harness.

  it('refuses a non-UUID connection id read from the real route params', async () => {
    getWebhookAuthentication.mockClear()

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/integrations/meeting-recorder/not-a-uuid/webhook',
        headers: {
          'content-type': 'application/cloudevents+json',
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,signature',
        },
        payload: '{"id":"msg_1"}',
      })

    expect(response.statusCode).toBe(401)
    expect(getWebhookAuthentication).not.toHaveBeenCalled()
  })

  it('does not run on a route that is not the webhook (the hook returns early)', async () => {
    // A stale timestamp on some OTHER path must not be refused by this hook. 404 is the
    // router's answer; what matters is that it is not the hook's 401.
    const stale =
      Math.floor(Date.now() / 1000) - MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 60

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/integrations/meeting-recorder/connections',
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': String(stale),
          'webhook-signature': 'v1,signature',
        },
        payload: '{}',
      })

    expect(response.statusCode).not.toBe(401)
  })
})
