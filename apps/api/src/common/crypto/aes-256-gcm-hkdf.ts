import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

export interface Aes256GcmCiphertext {
  iv: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

type BinaryInput = string | Buffer

function toBuffer(value: BinaryInput): Buffer {
  return Buffer.from(value)
}

/**
 * Neutral AES-256-GCM primitive with HKDF-SHA-256 domain separation.
 * Serialization/versioning belongs to the caller; this class only derives a
 * purpose-specific key and encrypts/decrypts bytes, with optional GCM AAD.
 */
export class Aes256GcmHkdf {
  private readonly key: Buffer

  constructor(keyMaterial: BinaryInput, info: string) {
    if (info.length === 0) {
      throw new Error('HKDF info label is required')
    }

    this.key = Buffer.from(
      hkdfSync('sha256', toBuffer(keyMaterial), Buffer.alloc(0), Buffer.from(info), KEY_BYTES),
    )
  }

  encrypt(plaintext: BinaryInput, aad?: BinaryInput): Aes256GcmCiphertext {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    if (aad !== undefined) {
      cipher.setAAD(toBuffer(aad))
    }
    const ciphertext = Buffer.concat([cipher.update(toBuffer(plaintext)), cipher.final()])

    return {
      iv,
      authTag: cipher.getAuthTag(),
      ciphertext,
    }
  }

  decrypt(value: Aes256GcmCiphertext, aad?: BinaryInput): Buffer {
    const decipher = createDecipheriv(ALGORITHM, this.key, value.iv)
    if (aad !== undefined) {
      decipher.setAAD(toBuffer(aad))
    }
    decipher.setAuthTag(value.authTag)
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()])
  }
}
