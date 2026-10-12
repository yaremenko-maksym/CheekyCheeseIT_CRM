import { describe, expect, it } from 'vitest'

import { PRODUCTION_CSP_DIRECTIVES } from './csp'

describe('production CSP', () => {
  it('allows private R2 media playback without opening arbitrary HTTPS media', () => {
    expect(PRODUCTION_CSP_DIRECTIVES.mediaSrc).toContain('https://*.r2.cloudflarestorage.com')
    expect(PRODUCTION_CSP_DIRECTIVES.mediaSrc).not.toContain('https:')
    expect(PRODUCTION_CSP_DIRECTIVES.defaultSrc).toEqual(["'self'"])
  })
})
