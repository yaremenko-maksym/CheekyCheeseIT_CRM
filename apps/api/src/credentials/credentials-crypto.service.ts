import { createDecipheriv, createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Aes256GcmHkdf } from '../common/crypto/aes-256-gcm-hkdf'

/**
 * AES-256-GCM encryption for project credential passwords (at-rest).
 *
 * Token format:  `<ver>:<iv b64>:<tag b64>:<ciphertext b64>`
 *   - ver  — scheme version (`v1` legacy / `v2` current). Lets us rotate the
 *            key-derivation function without re-reading every row blindly:
 *            decrypt picks the KDF from the token's own version marker.
 *   - iv   — 12-byte random nonce (GCM standard), base64.
 *   - tag  — 16-byte GCM auth tag, base64. Tamper-detection: a flipped bit in
 *            ciphertext/tag makes `decrypt` throw (GCM integrity check fails).
 *   - data — ciphertext, base64.
 *
 * Key derivation (32-byte AES-256 key) from `CREDENTIALS_ENC_KEY`:
 *   - v2 (CURRENT, write path): HKDF-SHA-256 with a fixed domain-separation
 *     `info` label. HKDF is a proper KDF (extract-then-expand) — unlike a bare
 *     SHA-256 hash it is purpose-built for deriving keying material and the
 *     `info` label binds the derived key to *this* use (credential at-rest enc),
 *     so the same env secret reused elsewhere yields a different key.
 *   - v1 (LEGACY, decrypt-only): bare SHA-256 of the raw secret. Kept ONLY so
 *     ciphertext written before the KDF upgrade stays decryptable. NEVER used
 *     for new encrypts. Rows are transparently re-written to v2 on the next
 *     update (`encrypt` always emits v2).
 *
 * The env value only needs ≥32 chars of entropy (validated in config/env.ts) —
 * both KDFs normalize it to exactly 256 bits regardless of the raw length.
 *
 * SECURITY: plaintext is never logged here, never stored, and only lives in
 * memory for the duration of an encrypt/decrypt call.
 */
@Injectable()
export class CredentialsCryptoService {
  private static readonly ALGORITHM = 'aes-256-gcm'
  /** Current scheme version emitted by `encrypt`. */
  private static readonly VERSION = 'v2'
  /**
   * Domain-separation label for the v2 HKDF derivation. Changing it would break
   * decryption of all v2 ciphertext — treat as a frozen constant (versioned).
   */
  private static readonly V2_INFO = 'cheekycheese-credentials-v1'

  /** v2 primitive — HKDF-SHA-256(secret, info=V2_INFO). Used for all new encrypts. */
  private readonly cryptoV2: Aes256GcmHkdf
  /** v1 key — legacy bare SHA-256(secret). Decrypt-only backward compatibility. */
  private readonly keyV1Legacy: Buffer

  constructor(private readonly config: ConfigService) {
    // ConfigService is validated at startup (validateEnv); CREDENTIALS_ENC_KEY is
    // guaranteed ≥32 chars.
    const raw = this.config.get<string>('CREDENTIALS_ENC_KEY')
    if (!raw) {
      // Defensive: validateEnv should have caught this. Fail loud, not silent.
      throw new Error('CREDENTIALS_ENC_KEY is not configured')
    }
    this.cryptoV2 = new Aes256GcmHkdf(raw, CredentialsCryptoService.V2_INFO)
    // v1: legacy SHA-256 derivation — retained for decrypting pre-upgrade rows.
    this.keyV1Legacy = createHash('sha256').update(raw, 'utf8').digest()
  }

  /**
   * Encrypt a plaintext password into the current (v2) versioned token string.
   */
  encrypt(plaintext: string): string {
    const { iv, authTag, ciphertext } = this.cryptoV2.encrypt(plaintext)

    return [
      CredentialsCryptoService.VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':')
  }

  /**
   * Decrypt a versioned token back into plaintext. The KDF is selected from the
   * token's own version marker (v2 → HKDF, v1 → legacy SHA-256), so existing
   * pre-upgrade ciphertext keeps decrypting.
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

    if (version !== CredentialsCryptoService.VERSION && version !== 'v1') {
      throw new Error(`Unsupported credential token version: ${version}`)
    }

    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ciphertext = Buffer.from(dataB64, 'base64')

    if (version === CredentialsCryptoService.VERSION) {
      return this.cryptoV2.decrypt({ iv, authTag: tag, ciphertext }).toString('utf8')
    }

    const decipher = createDecipheriv(CredentialsCryptoService.ALGORITHM, this.keyV1Legacy, iv)
    decipher.setAuthTag(tag)
    // .final() throws "Unsupported state or unable to authenticate data" on a
    // tampered ciphertext/tag — this is the integrity guarantee we rely on.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  }
}
