import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import {
  tailorBodySchema,
  tailorReplySchema,
  tailorWorkerInput,
  type TailorBody,
  type TailorReply,
} from '../extraction-worker/link-contract'
import {
  callWorker,
  unavailableReplySchema,
  workerTransport,
  type Unavailable,
} from '../resumes/verification/inference-clients'

export type { TailorBody, TailorReply }

/** The provider id a failed run logs (FR-A-2): the worker route. */
export const TAILOR_PROVIDER = 'extraction-worker:/resume-tailor'

const tailorWireSchema = z.union([
  tailorReplySchema.extend({ kind: z.literal('ok') }).strict(),
  unavailableReplySchema,
])
export type TailorWireReply = ({ kind: 'ok' } & TailorReply) | Unavailable

/**
 * The tailoring writer over the worker's `/resume-tailor` (plan D2).
 *
 * Precondition (R19): the caller has redacted the senior's contacts from every field of `payload`
 * and `feedback`, and stripped contact shapes from the posting; this client does not. The body is
 * checked against the worker's own schema before anything is sent (`INVALID_INPUT`). It never logs
 * the body or the reply text.
 */
@Injectable()
export class TailorWriterClient {
  private readonly post = workerTransport()

  async tailor(body: TailorBody): Promise<TailorWireReply> {
    // The worker's own two checks: its body schema, and its cap on the built input (over it, the
    // worker answers 400, which would read here as a generic PROVIDER_ERROR).
    if (
      !tailorBodySchema.safeParse(body).success ||
      tailorWorkerInput(body).length > MAX_EXTRACTION_INPUT_CHARS
    ) {
      return { kind: 'unavailable', reason: 'INVALID_INPUT' }
    }
    return callWorker(this.post, '/resume-tailor', JSON.stringify(body), tailorWireSchema)
  }
}
