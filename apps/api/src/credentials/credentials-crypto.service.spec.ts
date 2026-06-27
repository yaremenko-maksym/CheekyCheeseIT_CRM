import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { CredentialsCryptoService } from './credentials-crypto.service'

function makeService(encKey = 'a'.repeat(64)): CredentialsCryptoService {
  const config = {
    get: (key: string) => (key === 'CREDENTIALS_ENC_KEY' ? encKey : undefined),
  } as unknown as ConfigService
  return new CredentialsCryptoService(config)
}

/**
 * Produce a LEGACY v1 token exactly the way the pre-upgrade implementation did:
 * AES-256-GCM with a key derived via bare SHA-256(secret). This is the frozen
 * compatibility vector — the current service must still decrypt it so existing
 * at-rest ciphertext is not orphaned by the KDF upgrade.
 */
function makeLegacyV1Token(plaintext: string, encKey: string): string {
  const key = createHash('sha256').update(encKey, 'utf8').digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  )
}

describe('CredentialsCryptoService', () => {
  it('roundtrips a plaintext password (encrypt → decrypt)', () => {
    const svc = makeService()
    const plaintext = 'p4ssw0rd!2024$ секрет'
    const token = svc.encrypt(plaintext)
    expect(svc.decrypt(token)).toBe(plaintext)
  })

  it('produces the current versioned token format v2:<iv>:<tag>:<data>', () => {
    const svc = makeService()
    const token = svc.encrypt('hunter2')
    const parts = token.split(':')
    expect(parts).toHaveLength(4)
    // KDF upgrade: new ciphertext is tagged v2 (HKDF), never the legacy v1.
    expect(parts[0]).toBe('v2')
    // iv/tag/data are non-empty base64 segments
    expect(parts[1].length).toBeGreaterThan(0)
    expect(parts[2].length).toBeGreaterThan(0)
    expect(parts[3].length).toBeGreaterThan(0)
  })

  it('still decrypts a LEGACY v1 token (SHA-256 KDF backward compatibility)', () => {
    // Pre-upgrade rows were encrypted with a SHA-256-derived key and a v1 marker.
    // The KDF upgrade MUST NOT orphan them — decrypt selects the legacy key by
    // the token's own version marker. Frozen compatibility vector.
    const encKey = 'a'.repeat(64)
    const svc = makeService(encKey)
    const legacyPlaintext = 'legacy-secret-password-2023 §'
    const legacyToken = makeLegacyV1Token(legacyPlaintext, encKey)
    expect(legacyToken.startsWith('v1:')).toBe(true)
    expect(svc.decrypt(legacyToken)).toBe(legacyPlaintext)
  })

  it('does not decrypt a v2 token with the legacy v1 key (KDFs are distinct)', () => {
    // Sanity: HKDF (v2) and SHA-256 (v1) produce different keys, so a v2
    // ciphertext re-labelled as v1 must fail the GCM auth check.
    const svc = makeService()
    const v2Token = svc.encrypt('domain-separated')
    const parts = v2Token.split(':')
    const downgraded = ['v1', parts[1], parts[2], parts[3]].join(':')
    expect(() => svc.decrypt(downgraded)).toThrow()
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
