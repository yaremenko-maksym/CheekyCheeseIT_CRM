import { describe, expect, it } from 'vitest'
import { Aes256GcmHkdf } from './aes-256-gcm-hkdf'

const RAW_KEY = 'k'.repeat(64)

describe('Aes256GcmHkdf', () => {
  it('roundtrips plaintext with an explicit HKDF info label', () => {
    const crypto = new Aes256GcmHkdf(RAW_KEY, 'test-domain-v1')
    const encrypted = crypto.encrypt('secret value')

    expect(crypto.decrypt(encrypted).toString('utf8')).toBe('secret value')
    expect(encrypted.iv).toHaveLength(12)
    expect(encrypted.authTag).toHaveLength(16)
  })

  it('uses the HKDF info label for domain separation', () => {
    const firstDomain = new Aes256GcmHkdf(RAW_KEY, 'domain-a-v1')
    const secondDomain = new Aes256GcmHkdf(RAW_KEY, 'domain-b-v1')
    const encrypted = firstDomain.encrypt('same root key')

    expect(() => secondDomain.decrypt(encrypted)).toThrow()
  })

  it('binds ciphertext to optional AAD', () => {
    const crypto = new Aes256GcmHkdf(RAW_KEY, 'cheekycheese-meeting-recorder-webhook-secret-v1')
    const connectionId = '5d8938da-0470-48ce-b985-5cfbb478e825'
    const encrypted = crypto.encrypt('whsec_example', connectionId)

    expect(crypto.decrypt(encrypted, connectionId).toString('utf8')).toBe('whsec_example')
    expect(() => crypto.decrypt(encrypted, '5f074ea3-b0dc-4fcf-8d06-aeb27ed98521')).toThrow()
    expect(() => crypto.decrypt(encrypted)).toThrow()
  })

  it('requires a non-empty HKDF info label', () => {
    expect(() => new Aes256GcmHkdf(RAW_KEY, '')).toThrow('HKDF info label is required')
  })
})
