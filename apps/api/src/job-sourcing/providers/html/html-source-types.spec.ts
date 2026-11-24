import { jobSourceTypeSchema } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { MANIFEST_DEFINITIONS } from '../manifest.definitions'
import { HTML_SOURCE_TYPES, isHtmlSourceType } from './html-source-types'

describe('HTML_SOURCE_TYPES (C-03 drift gate)', () => {
  it('lists exactly the thirteen _HTML members of the shared source-type enum', () => {
    const fromEnum = jobSourceTypeSchema.options.filter((t) => t.endsWith('_HTML'))
    expect([...HTML_SOURCE_TYPES].sort()).toEqual([...fromEnum].sort())
    expect(HTML_SOURCE_TYPES).toHaveLength(13)
  })

  it('equals the manifest rows whose endpoint variant is html, plus the ones with an adapter', () => {
    const fromManifest = MANIFEST_DEFINITIONS.filter((d) => d.endpointVariant === 'html').map(
      (d) => d.type,
    )
    // Tasks sources-12 and sources-13: these boards have their own adapter (sitemap + JSON-LD), so
    // their rows name that endpoint, not the generic html placeholder.
    const withAdapter = MANIFEST_DEFINITIONS.filter(
      (d) => d.type.endsWith('_HTML') && d.endpointVariant !== 'html',
    ).map((d) => [d.type, d.endpointVariant])
    const SITEMAP_TYPES = [
      'JUSTJOIN_HTML',
      'LANDINGJOBS_HTML',
      'NEXTLEVELJOBS_HTML',
      'THEHUB_HTML',
      'WORKABLEJOBS_HTML',
      'RELOCATEME_HTML',
      'REACTJOBS_HTML',
      'REMOTEIO_HTML',
      'REMOTEFIRSTJOBS_HTML',
      'JOBSPRESSO_HTML',
    ]
    expect(withAdapter).toEqual([
      ['JUSTJOIN_HTML', 'jobs-sitemap'],
      ['NOFLUFF_HTML', 'category-listing'],
      ['LANDINGJOBS_HTML', 'jobs-sitemap'],
      ['NEXTLEVELJOBS_HTML', 'jobs-sitemap'],
      ['DICE_HTML', 'jobs-listing'],
      ['THEHUB_HTML', 'jobs-sitemap'],
      ['WORKABLEJOBS_HTML', 'jobs-sitemap'],
      ['RELOCATEME_HTML', 'jobs-sitemap'],
      ['REACTJOBS_HTML', 'jobs-sitemap'],
      ['REMOTEIO_HTML', 'jobs-sitemap'],
      ['REMOTEFIRSTJOBS_HTML', 'jobs-sitemap'],
      ['JOBSPRESSO_HTML', 'jobs-sitemap'],
    ])
    expect([...HTML_SOURCE_TYPES].sort()).toEqual(
      [...fromManifest, ...SITEMAP_TYPES, 'NOFLUFF_HTML', 'DICE_HTML'].sort(),
    )
  })

  it('isHtmlSourceType accepts members and refuses everything else', () => {
    for (const type of HTML_SOURCE_TYPES) expect(isHtmlSourceType(type)).toBe(true)
    expect(isHtmlSourceType('DJINNI_RSS')).toBe(false)
    expect(isHtmlSourceType('WTTJ_html')).toBe(false)
    expect(isHtmlSourceType('')).toBe(false)
  })
})
