import { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { CredentialsCryptoService } from './credentials-crypto.service'

function makeService(encKey = 'a'.repeat(64)): CredentialsCryptoService {
  const config = {
    get: (key: string) => (key === 'CREDENTIALS_ENC_KEY' ? encKey : undefined),
  } as unknown as ConfigService
  return new CredentialsCryptoService(config)
}

describe('CredentialsCryptoService', () => {
  it('roundtrips a plaintext password (encrypt → decrypt)', () => {
    const svc = makeService()
    const plaintext = 'p4ssw0rd!2024$ секрет'
    const token = svc.encrypt(plaintext)
    expect(svc.decrypt(token)).toBe(plaintext)
  })

  it('produces the versioned token format v1:<iv>:<tag>:<data>', () => {
    const svc = makeService()
    const token = svc.encrypt('hunter2')
    const parts = token.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    // iv/tag/data are non-empty base64 segments
    expect(parts[1].length).toBeGreaterThan(0)
    expect(parts[2].length).toBeGreaterThan(0)
    expect(parts[3].length).toBeGreaterThan(0)
  })

  it('uses a fresh random IV per encryption (same input → different ciphertext)', () => {
    const svc = makeService()
    const a = svc.encrypt('same-input')
    const b = svc.encrypt('same-input')
    expect(a).not.toBe(b)
    // but both decrypt back to the same plaintext
    expect(svc.decrypt(a)).toBe('same-input')
    expect(svc.decrypt(b)).toBe('same-input')
  })

  it('throws on a tampered ciphertext (flipped byte → GCM auth fails)', () => {
    const svc = makeService()
    const token = svc.encrypt('top-secret')
    const parts = token.split(':')
    // Corrupt the ciphertext segment: decode, flip first byte, re-encode.
    const data = Buffer.from(parts[3], 'base64')
    data[0] = data[0] ^ 0xff
    const tampered = [parts[0], parts[1], parts[2], data.toString('base64')].join(':')
    expect(() => svc.decrypt(tampered)).toThrow()
  })

  it('throws on a tampered auth tag', () => {
    const svc = makeService()
    const token = svc.encrypt('top-secret')
    const parts = token.split(':')
    const tag = Buffer.from(parts[2], 'base64')
    tag[0] = tag[0] ^ 0xff
    const tampered = [parts[0], parts[1], tag.toString('base64'), parts[3]].join(':')
    expect(() => svc.decrypt(tampered)).toThrow()
  })

  it('throws on a malformed token (wrong segment count)', () => {
    const svc = makeService()
    expect(() => svc.decrypt('not-a-valid-token')).toThrow('Malformed credential token')
    expect(() => svc.decrypt('v1:only:three')).toThrow('Malformed credential token')
  })

  it('throws on an unsupported version prefix', () => {
    const svc = makeService()
    const token = svc.encrypt('x')
    const parts = token.split(':')
    const wrongVersion = ['v99', parts[1], parts[2], parts[3]].join(':')
    expect(() => svc.decrypt(wrongVersion)).toThrow('Unsupported credential token version')
  })

  it('cannot decrypt with a different key (key isolation)', () => {
    const a = makeService('a'.repeat(64))
    const b = makeService('b'.repeat(64))
    const token = a.encrypt('cross-key')
    expect(() => b.decrypt(token)).toThrow()
  })

  it('throws at construction when CREDENTIALS_ENC_KEY is missing', () => {
    const config = { get: () => undefined } as unknown as ConfigService
    expect(() => new CredentialsCryptoService(config)).toThrow(
      'CREDENTIALS_ENC_KEY is not configured',
    )
  })
})
