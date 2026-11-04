import type { ClassifiedChatResult } from '../classified-chat'

/**
 * One hand-written provider response (5.4c-0 §7 error-format table): status, headers, a minimal
 * redacted body. No prompt, page, key or account id; recorded traffic never becomes a fixture.
 */
export type ProviderFixture = {
  name: string
  status: number
  headers?: Record<string, string>
  body: string
  expected: ClassifiedChatResult
}

/** Marker standing in for any provider-controlled text; it must never reach a result. */
export const BODY_MARKER = 'BODY-MARKER-7f3a'
