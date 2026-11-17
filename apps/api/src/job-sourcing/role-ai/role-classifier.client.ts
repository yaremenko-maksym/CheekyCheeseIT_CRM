import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import type { TechnicalRole } from '@crm/shared'
import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import {
  type ClassifyRolesBody,
  classifyRolesInput,
  classifyRolesReplySchema,
  MAX_CLASSIFY_CATEGORIES,
  MAX_CLASSIFY_CATEGORY_CHARS,
  MAX_CLASSIFY_TITLE_CHARS,
} from '../../extraction-worker/link-contract'
import {
  callWorker,
  type Unavailable,
  unavailableReplySchema,
  workerTransport,
} from '../../resumes/verification/inference-clients'
import { stripContacts } from '../structuring/contact-strip'

/** The provider id a failed call logs: the worker route. */
export const ROLE_AI_PROVIDER = 'extraction-worker:/classify-roles'

export type RoleAiReply =
  { kind: 'ok'; roles: readonly TechnicalRole[]; confidence: number } | Unavailable

export type RoleClassifierInput = {
  title: string
  description: string
  categories: readonly string[]
}

const wireSchema = z.union([
  z.object({ kind: z.literal('ok'), ...classifyRolesReplySchema.shape }).strict(),
  unavailableReplySchema,
])

const strip = (text: string) => stripContacts(text).text

/**
 * The body the worker accepts, or null when there is no title to send. Contacts are stripped from
 * every field (public vacancy text only, no personal data); the title and categories are clamped to
 * the worker limits, and the description is cut to the longest prefix whose whole user message fits
 * under the cap, because the worker refuses an over-cap body. The fit is measured on the serialised
 * message, so an escaped character counts as JSON writes it.
 */
export function classifyRolesRequest(input: RoleClassifierInput): ClassifyRolesBody | null {
  const title = strip(input.title).slice(0, MAX_CLASSIFY_TITLE_CHARS)
  if (title.length === 0) return null
  const description = strip(input.description)
  const body: ClassifyRolesBody = {
    title,
    description: '',
    categories: input.categories
      .slice(0, MAX_CLASSIFY_CATEGORIES)
      .map((c) => strip(c).slice(0, MAX_CLASSIFY_CATEGORY_CHARS)),
  }
  const fits = (n: number) =>
    classifyRolesInput({ ...body, description: description.slice(0, n) }).length <=
    MAX_EXTRACTION_INPUT_CHARS
  // The longest description prefix that fits: a binary search, as an escape takes 2 to 6 chars.
  let lo = 0
  let hi = description.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  body.description = description.slice(0, lo)
  return body
}

/**
 * The AI role classifier over the worker's `/classify-roles`. Every failure is a coded
 * `unavailable`, never a throw; the reply is re-validated against the role enum, so one unknown id
 * makes the whole reply `INVALID_OUTPUT`. It never logs the vacancy text or the reply.
 */
@Injectable()
export class RoleClassifierClient {
  private readonly post = workerTransport()

  async classify(input: RoleClassifierInput): Promise<RoleAiReply> {
    const body = classifyRolesRequest(input)
    if (body === null) return { kind: 'unavailable', reason: 'INVALID_INPUT' }
    return callWorker(this.post, '/classify-roles', JSON.stringify(body), wireSchema)
  }
}
