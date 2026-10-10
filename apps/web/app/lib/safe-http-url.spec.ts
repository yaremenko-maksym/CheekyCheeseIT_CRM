import { describe, expect, it } from 'vitest'
import { safeHttpUrl } from './safe-http-url'

describe('safeHttpUrl', () => {
  it.each(['https://meet.google.com/abc-defg-hij', 'http://example.test/room?x=1'])(
    'passes %s through',
    (url) => {
      expect(safeHttpUrl(url)).toBe(url)
    },
  )

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.test/file',
    'not a url',
    '//example.test/path',
    '',
  ])('rejects %j', (url) => {
    expect(safeHttpUrl(url)).toBeNull()
  })
})
