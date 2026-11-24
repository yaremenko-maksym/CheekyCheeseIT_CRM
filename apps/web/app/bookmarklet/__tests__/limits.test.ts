import {
  DESCRIPTION_MD_MAX,
  externalHttpsUrlSchema,
  EXTERNAL_PAGE_TEXT_MAX,
  MANUAL_COMPANY_MAX,
  MANUAL_TITLE_MAX,
} from '@crm/shared'
import { describe, expect, it } from 'vitest'

import { PREFILL_HASH_MAX } from '@/lib/external-prefill'

import {
  COMPANY_MAX,
  DESCRIPTION_MAX,
  HASH_MAX,
  PAGE_TEXT_MAX,
  TITLE_MAX,
  URL_MAX,
} from '../limits'

describe('bookmarklet limits', () => {
  it('match the caps the CRM applies to the same payload', () => {
    expect(TITLE_MAX).toBe(MANUAL_TITLE_MAX)
    expect(COMPANY_MAX).toBe(MANUAL_COMPANY_MAX)
    expect(DESCRIPTION_MAX).toBe(DESCRIPTION_MD_MAX)
    expect(PAGE_TEXT_MAX).toBe(EXTERNAL_PAGE_TEXT_MAX)
    expect(HASH_MAX).toBe(PREFILL_HASH_MAX)
    const link = (n: number) => `https://a.example/${'x'.repeat(n - 18)}`
    expect(externalHttpsUrlSchema.safeParse(link(URL_MAX)).success).toBe(true)
    expect(externalHttpsUrlSchema.safeParse(link(URL_MAX + 1)).success).toBe(false)
  })
})
