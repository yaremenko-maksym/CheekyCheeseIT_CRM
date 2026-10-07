import { Injectable } from '@nestjs/common'
import { Webhook, WebhookVerificationError } from 'standardwebhooks'

export interface MeetingRecorderWebhookHeaders {
  'webhook-id': string
  'webhook-timestamp': string
  'webhook-signature': string
}

@Injectable()
export class MeetingRecorderWebhookVerifier {
  verify(rawBody: string, headers: MeetingRecorderWebhookHeaders, secret: string): boolean {
    try {
      new Webhook(secret).verify(rawBody, headers, { jsonParse: false })
      return true
    } catch (error: unknown) {
      if (error instanceof WebhookVerificationError) return false
      throw error
    }
  }
}
