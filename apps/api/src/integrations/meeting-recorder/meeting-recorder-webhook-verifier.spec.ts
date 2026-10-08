import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
}))

vi.mock('standardwebhooks', () => {
  class WebhookVerificationError extends Error {}
  class Webhook {
    constructor(readonly secret: string) {}

    verify(rawBody: string, headers: unknown, options: unknown) {
      return mocks.verify(this.secret, rawBody, headers, options)
    }
  }

  return { Webhook, WebhookVerificationError }
})

import { WebhookVerificationError } from 'standardwebhooks'

import {
  type MeetingRecorderWebhookHeaders,
  MeetingRecorderWebhookVerifier,
} from './meeting-recorder-webhook-verifier'

const headers: MeetingRecorderWebhookHeaders = {
  'webhook-id': 'event-1',
  'webhook-timestamp': '1791374400',
  'webhook-signature': 'v1,signature',
}

describe('MeetingRecorderWebhookVerifier', () => {
  beforeEach(() => {
    mocks.verify.mockReset()
  })

  it('verifies the exact raw body without JSON parsing', () => {
    mocks.verify.mockReturnValue(undefined)
    const verifier = new MeetingRecorderWebhookVerifier()
    const rawBody = '{\n  "signed": "bytes stay exact"\n}\n'

    expect(verifier.verify(rawBody, headers, 'whsec_test')).toBe(true)
    expect(mocks.verify).toHaveBeenCalledOnce()
    expect(mocks.verify).toHaveBeenCalledWith('whsec_test', rawBody, headers, { jsonParse: false })
  })

  it('maps signature verification failures to false', () => {
    mocks.verify.mockImplementation(() => {
      throw new WebhookVerificationError('invalid signature')
    })
    const verifier = new MeetingRecorderWebhookVerifier()

    expect(verifier.verify('{}', headers, 'whsec_test')).toBe(false)
  })

  it('rethrows unexpected verifier failures', () => {
    const unexpected = new TypeError('unexpected verifier failure')
    mocks.verify.mockImplementation(() => {
      throw unexpected
    })
    const verifier = new MeetingRecorderWebhookVerifier()

    expect(() => verifier.verify('{}', headers, 'whsec_test')).toThrow(unexpected)
  })
})
