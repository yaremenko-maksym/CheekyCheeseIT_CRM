import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

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
  private static readonly IV_BYTES = 12
  private static readonly KEY_BYTES = 32
  /** Current scheme version emitted by `encrypt`. */
  private static readonly VERSION = 'v2'
  /**
   * Domain-separation label for the v2 HKDF derivation. Changing it would break
   * decryption of all v2 ciphertext — treat as a frozen constant (versioned).
   */
  private static readonly V2_INFO = 'cheekycheese-credentials-v1'

  /** v2 key — HKDF-SHA-256(secret, info=V2_INFO). Used for all new encrypts. */
  private readonly keyV2: Buffer
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
    // v2: HKDF with empty salt + fixed `info` for domain separation. hkdfSync
    // returns an ArrayBuffer; wrap it in a Buffer for the cipher API.
    this.keyV2 = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(raw, 'utf8'),
        Buffer.alloc(0),
        Buffer.from(CredentialsCryptoService.V2_INFO, 'utf8'),
        CredentialsCryptoService.KEY_BYTES,
      ),
    )
    // v1: legacy SHA-256 derivation — retained for decrypting pre-upgrade rows.
    this.keyV1Legacy = createHash('sha256').update(raw, 'utf8').digest()
  }

  /**
   * Encrypt a plaintext password into the current (v2) versioned token string.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(CredentialsCryptoService.IV_BYTES)
    const cipher = createCipheriv(CredentialsCryptoService.ALGORITHM, this.keyV2, iv)
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

    const key = this.keyForVersion(version)
    if (!key) {
      throw new Error(`Unsupported credential token version: ${version}`)
    }

    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ciphertext = Buffer.from(dataB64, 'base64')

    const decipher = createDecipheriv(CredentialsCryptoService.ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    // .final() throws "Unsupported state or unable to authenticate data" on a
    // tampered ciphertext/tag — this is the integrity guarantee we rely on.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  }

  /** Returns the AES key for a known token version, or null for an unknown one. */
  private keyForVersion(version: string): Buffer | null {
    if (version === CredentialsCryptoService.VERSION) return this.keyV2
    if (version === 'v1') return this.keyV1Legacy
    return null
  }
}
