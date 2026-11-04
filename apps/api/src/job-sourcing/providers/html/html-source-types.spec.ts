import { jobSourceTypeSchema } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import { HTML_SOURCE_TYPES, isHtmlSourceType } from './html-source-types'

describe('HTML_SOURCE_TYPES (C-03 drift gate)', () => {
  it('lists exactly the seven _HTML members of the shared source-type enum', () => {
    const fromEnum = jobSourceTypeSchema.options.filter((t) => t.endsWith('_HTML'))
    expect([...HTML_SOURCE_TYPES].sort()).toEqual([...fromEnum].sort())
    expect(HTML_SOURCE_TYPES).toHaveLength(7)
  })

  it('equals the manifest rows whose endpoint variant is html', () => {
    const fromManifest = MANIFEST_DEFINITIONS.filter((d) => d.endpointVariant === 'html').map(
      (d) => d.type,
    )
    expect([...HTML_SOURCE_TYPES].sort()).toEqual([...fromManifest].sort())
  })

  it('isHtmlSourceType accepts members and refuses everything else', () => {
    for (const type of HTML_SOURCE_TYPES) expect(isHtmlSourceType(type)).toBe(true)
    expect(isHtmlSourceType('DJINNI_RSS')).toBe(false)
    expect(isHtmlSourceType('WTTJ_html')).toBe(false)
    expect(isHtmlSourceType('')).toBe(false)
  })
})
