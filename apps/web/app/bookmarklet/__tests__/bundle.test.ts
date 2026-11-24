// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildBookmarklet } from '../../../vite-bookmarklet'

describe('buildBookmarklet', () => {
  it('bundles the extractor into one small javascript: URL without zod or the app', async () => {
    const url = await buildBookmarklet()
    expect(url.startsWith('javascript:')).toBe(true)
    expect(url).not.toMatch(/\s/)
    const code = decodeURIComponent(url.slice('javascript:'.length))
    expect(code).toContain('__CRM_ORIGIN__')
    expect(code).toContain('#external=')
    expect(code).not.toMatch(/ZodError|zod/i)
    expect(code).not.toContain('import ')
    expect(url.length).toBeLessThan(20000)
    // The decoded script parses as plain JavaScript.
    expect(() => new Function(code)).not.toThrow()
  }, 30000)
})
