import { describe, expect, it } from 'vitest'
import { sanitizeFilename, thumbnailKeyFor } from './document-key.util'

describe('sanitizeFilename', () => {
  it('keeps letters, digits, dot, dash and underscore untouched', () => {
    expect(sanitizeFilename('AZaz09.x-y_z')).toBe('AZaz09.x-y_z')
  })

  it('collapses a run of unsafe characters into a single underscore', () => {
    expect(sanitizeFilename('Report   2024.pdf')).toBe('Report_2024.pdf')
    expect(sanitizeFilename('a!@#b')).toBe('a_b')
  })

  it('strips path separators so the name cannot escape its key segment', () => {
    const out = sanitizeFilename('../../etc/passwd')
    expect(out).toBe('.._.._etc_passwd')
    expect(out).not.toContain('/')
    expect(sanitizeFilename('a\\b/c')).toBe('a_b_c')
  })

  it('trims leading and trailing underscores independently', () => {
    expect(sanitizeFilename('___a___')).toBe('a')
    expect(sanitizeFilename('__a')).toBe('a')
    expect(sanitizeFilename('a__')).toBe('a')
    expect(sanitizeFilename(' a ')).toBe('a')
  })

  it('keeps inner underscores', () => {
    expect(sanitizeFilename('a__b')).toBe('a__b')
  })

  it('NFKD-decomposes: accents become separators, compatibility forms fold to ASCII', () => {
    expect(sanitizeFilename('résumé.pdf')).toBe('re_sume_.pdf')
    expect(sanitizeFilename('ＡＢＣ.pdf')).toBe('ABC.pdf')
    expect(sanitizeFilename('ﬁle.txt')).toBe('file.txt')
  })

  it('reduces a fully non-ASCII stem to just the extension', () => {
    expect(sanitizeFilename('договір.pdf')).toBe('.pdf')
  })

  it('falls back to "file" when nothing survives', () => {
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename('!!!')).toBe('file')
    expect(sanitizeFilename('договір')).toBe('file')
  })

  it('caps the result at exactly 200 characters', () => {
    expect(sanitizeFilename('a'.repeat(250))).toBe('a'.repeat(200))
    expect(sanitizeFilename('a'.repeat(200))).toHaveLength(200)
    expect(sanitizeFilename('a'.repeat(199))).toHaveLength(199)
  })

  it('trims before capping (cap may leave a trailing underscore)', () => {
    expect(sanitizeFilename(`${'a'.repeat(199)} b`)).toBe(`${'a'.repeat(199)}_`)
  })
})

describe('thumbnailKeyFor', () => {
  it('replaces the extension with -thumb.jpg', () => {
    expect(thumbnailKeyFor('documents/RESUME/owner/id-photo.png')).toBe(
      'documents/RESUME/owner/id-photo-thumb.jpg',
    )
  })

  it('strips only the last extension', () => {
    expect(thumbnailKeyFor('a.b.png')).toBe('a.b-thumb.jpg')
  })

  it('handles a one-letter extension and a key with no extension', () => {
    expect(thumbnailKeyFor('doc.x')).toBe('doc-thumb.jpg')
    expect(thumbnailKeyFor('documents/SCAN/o/id-file')).toBe('documents/SCAN/o/id-file-thumb.jpg')
  })
})
