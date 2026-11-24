import { toBase64Url } from '../lib/base64url'

import { extractVacancy } from './extract'
import { fitToHash } from './fit'

/** The CRM page the bookmarklet opens: the queue with the vacancy read off `doc` in its hash. */
export function crmTarget(origin: string, doc: Document, href: string, selection: string): string {
  const payload = fitToHash(extractVacancy(doc, href, selection))
  return `${origin}/job-queue#external=${toBase64Url(JSON.stringify(payload))}`
}
