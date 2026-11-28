import { toBase64Url } from '../lib/base64url'

import { extractVacancy } from './extract'
import { fitToHash } from './fit'
import { HASH_MAX } from './limits'

/**
 * The CRM page the bookmarklet opens: the queue with the vacancy read off `doc` in its hash. With an
 * encoded block map (`blocks`), the vacancy gets half the hash and the map rides along as `b`.
 */
export function crmTarget(
  origin: string,
  doc: Document,
  href: string,
  selection: string,
  blocks?: string,
): string {
  const read = extractVacancy(doc, href, selection)
  const payload =
    blocks === undefined ? fitToHash(read) : { ...fitToHash(read, HASH_MAX / 2), b: blocks }
  return `${origin}/job-queue#external=${toBase64Url(JSON.stringify(payload))}`
}
