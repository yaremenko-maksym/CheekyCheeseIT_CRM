import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

/**
 * AES-256-GCM encryption for project credential passwords (at-rest).
 *
 * Token format:  `v1:<iv b64>:<tag b64>:<ciphertext b64>`
 *   - v1   — scheme version, lets us rotate the algorithm later without
 *            re-reading every row blindly.
 *   - iv   — 12-byte random nonce (GCM standard), base64.
 *   - tag  — 16-byte GCM auth tag, base64. Tamper-detection: a flipped bit in
 *            ciphertext/tag makes `decrypt` throw (GCM integrity check fails).
 *   - data — ciphertext, base64.
 *
 * The 32-byte AES key is derived from `CREDENTIALS_ENC_KEY` via SHA-256, so the
 * env value only needs ≥32 chars of entropy (validated in config/env.ts) — the
 * derivation normalizes it to exactly 256 bits regardless of the raw length.
 *
 * SECURITY: plaintext is never logged here, never stored, and only lives in
 * memory for the duration of an encrypt/decrypt call.
 */
@Injectable()
export class CredentialsCryptoService {
  private static readonly ALGORITHM = 'aes-256-gcm'
  private static readonly IV_BYTES = 12
  private static readonly VERSION = 'v1'

  private readonly key: Buffer

  constructor(private readonly config: ConfigService) {
    // ConfigService is validated at startup (validateEnv); CREDENTIALS_ENC_KEY is
    // guaranteed ≥32 chars. Derive a stable 32-byte key via SHA-256.
    const raw = this.config.get<string>('CREDENTIALS_ENC_KEY')
    if (!raw) {
      // Defensive: validateEnv should have caught this. Fail loud, not silent.
      throw new Error('CREDENTIALS_ENC_KEY is not configured')
    }
    this.key = createHash('sha256').update(raw, 'utf8').digest()
  }

  /**
   * Encrypt a plaintext password into the versioned token string.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(CredentialsCryptoService.IV_BYTES)
    const cipher = createCipheriv(CredentialsCryptoService.ALGORITHM, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return [
      CredentialsCryptoService.VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':')
  }

  /**
   * Decrypt a versioned token back into plaintext.
   * Throws if the token is malformed, the version is unknown, or the GCM auth
   * tag does not match (tamper detection).
   */
  decrypt(token: string): string {
    const parts = token.split(':')
    // Explicit per-segment guard (not just length): keeps the values typed as
    // `string` under noUncheckedIndexedAccess and rejects empty segments.
    const [version, ivB64, tagB64, dataB64] = parts
    if (parts.length !== 4 || !version || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed credential token')
    }
    if (version !== CredentialsCryptoService.VERSION) {
      throw new Error(`Unsupported credential token version: ${version}`)
    }

    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ciphertext = Buffer.from(dataB64, 'base64')

    const decipher = createDecipheriv(CredentialsCryptoService.ALGORITHM, this.key, iv)
    decipher.setAuthTag(tag)
    // .final() throws "Unsupported state or unable to authenticate data" on a
    // tampered ciphertext/tag — this is the integrity guarantee we rely on.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  }
}
