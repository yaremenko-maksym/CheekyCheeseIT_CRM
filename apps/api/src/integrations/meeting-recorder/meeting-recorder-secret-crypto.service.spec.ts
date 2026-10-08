import type { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../../config/env'
import {
  MEETING_RECORDER_WEBHOOK_SECRET_INFO,
  MeetingRecorderSecretCryptoService,
} from './meeting-recorder-secret-crypto.service'

const RAW_KEY = 'k'.repeat(64)
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

function configWithKey(key: string | undefined): ConfigService<Env> {
  return {
    get: vi.fn().mockReturnValue(key),
  } as unknown as ConfigService<Env>
}

describe('MeetingRecorderSecretCryptoService', () => {
  it('uses the shared credentials key and the meeting-recorder domain label', () => {
    const config = configWithKey(RAW_KEY)
    const service = new MeetingRecorderSecretCryptoService(config)

    expect(config.get).toHaveBeenCalledWith('CREDENTIALS_ENC_KEY', { infer: true })
    expect(MEETING_RECORDER_WEBHOOK_SECRET_INFO).toBe(
      'cheekycheese-meeting-recorder-webhook-secret-v1',
    )
    expect(service).toBeDefined()
  })

  it('fails closed when the credentials encryption key is missing', () => {
    expect(() => new MeetingRecorderSecretCryptoService(configWithKey(undefined))).toThrow(
      'CREDENTIALS_ENC_KEY is not configured',
    )
  })

  it('roundtrips a versioned token and binds it to the connection id', () => {
    const service = new MeetingRecorderSecretCryptoService(configWithKey(RAW_KEY))
    const token = service.encrypt('whsec_example', CONNECTION_ID)
    const parts = token.split(':')

    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    expect(parts.slice(1).every((part) => part.length > 0)).toBe(true)
    expect(service.decrypt(token, CONNECTION_ID)).toBe('whsec_example')
    expect(() => service.decrypt(token, '22222222-2222-4222-8222-222222222222')).toThrow()
  })

  it.each(['', 'v1', 'v1:::', 'v2:a:b:c', 'v1::b:c', 'v1:a::c', 'v1:a:b:', 'v1:a:b:c:extra'])(
    'rejects malformed serialized token %j',
    (token) => {
      const service = new MeetingRecorderSecretCryptoService(configWithKey(RAW_KEY))

      expect(() => service.decrypt(token, CONNECTION_ID)).toThrow(
        'Malformed meeting recorder secret token',
      )
    },
  )
})
