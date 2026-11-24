import type { ExternalVacancyPrefill } from '@crm/shared'

import { toBase64Url } from '../lib/base64url'

import { HASH_MAX } from './limits'

const fits = (p: ExternalVacancyPrefill): boolean =>
  toBase64Url(JSON.stringify(p)).length <= HASH_MAX

/** The longest prefix of `field` that still lets the payload fit (binary search on its length). */
function shrink(
  p: ExternalVacancyPrefill,
  field: 'pageText' | 'description',
): ExternalVacancyPrefill {
  // every other field is capped, so a payload still too big without its page text has a description
  // Stryker disable next-line StringLiteral: unreachable fallback (see above)
  const text = p[field] ?? ''
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits({ ...p, [field]: text.slice(0, mid) })) lo = mid
    else hi = mid - 1
  }
  return { ...p, [field]: text.slice(0, lo) }
}

/**
 * Cuts the payload until its encoded `#external=` hash fits the CRM's cap. A field cap alone does
 * not guarantee it: 15 000 Cyrillic characters encode to about 40 000. The raw page text goes
 * first; the description, which HR reads, is cut only when that is not enough.
 */
export function fitToHash(p: ExternalVacancyPrefill): ExternalVacancyPrefill {
  if (fits(p)) return p
  const withoutPageText = shrink(p, 'pageText')
  return fits(withoutPageText) ? withoutPageText : shrink(withoutPageText, 'description')
}
