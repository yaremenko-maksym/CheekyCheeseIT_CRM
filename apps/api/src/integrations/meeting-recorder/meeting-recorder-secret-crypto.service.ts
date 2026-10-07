import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { Aes256GcmHkdf } from '../../common/crypto/aes-256-gcm-hkdf'
import type { Env } from '../../config/env'

export const MEETING_RECORDER_WEBHOOK_SECRET_INFO =
  'cheekycheese-meeting-recorder-webhook-secret-v1'

const TOKEN_VERSION = 'v1'

@Injectable()
export class MeetingRecorderSecretCryptoService {
  private readonly crypto: Aes256GcmHkdf

  constructor(config: ConfigService<Env>) {
    const keyMaterial = config.get('CREDENTIALS_ENC_KEY', { infer: true })
    if (!keyMaterial) throw new Error('CREDENTIALS_ENC_KEY is not configured')
    this.crypto = new Aes256GcmHkdf(keyMaterial, MEETING_RECORDER_WEBHOOK_SECRET_INFO)
  }

  encrypt(secret: string, connectionId: string): string {
    const encrypted = this.crypto.encrypt(secret, connectionId)
    return [
      TOKEN_VERSION,
      encrypted.iv.toString('base64'),
      encrypted.authTag.toString('base64'),
      encrypted.ciphertext.toString('base64'),
    ].join(':')
  }

  decrypt(token: string, connectionId: string): string {
    const parts = token.split(':')
    const [version, ivB64, tagB64, ciphertextB64] = parts
    if (parts.length !== 4 || version !== TOKEN_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
      throw new Error('Malformed meeting recorder secret token')
    }

    return this.crypto
      .decrypt(
        {
          iv: Buffer.from(ivB64, 'base64'),
          authTag: Buffer.from(tagB64, 'base64'),
          ciphertext: Buffer.from(ciphertextB64, 'base64'),
        },
        connectionId,
      )
      .toString('utf8')
  }
}
