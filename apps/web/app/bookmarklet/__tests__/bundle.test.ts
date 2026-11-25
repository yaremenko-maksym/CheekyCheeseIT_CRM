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
    // it reads the page only: no request, no cookie, no storage
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|cookie|localStorage|sessionStorage/)
    // 24042 with the main-first block cap (Task 6c); a bookmark holds far more, the bound catches a runaway import
    expect(url.length).toBeLessThan(24100)
    // The decoded script parses as plain JavaScript.
    expect(() => new Function(code)).not.toThrow()
  }, 30000)
})
