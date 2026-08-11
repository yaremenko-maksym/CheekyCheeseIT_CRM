/**
 * Filename reduction on both directions of travel.
 *
 * A resume filename crosses this module twice: INWARD as the uploaded file's
 * name (`sanitizeFileName`, stored and later echoed in a presigned download)
 * and OUTWARD as the rendered PDF's name, built from the user's display name
 * (`resumeContentDisposition`). Those were two different reductions — the
 * inward one dropped path separators and capped the length, the outward one
 * only stripped quotes and newlines — so the very same string was defused going
 * in and passed through intact coming out. Now there is one definition, and
 * these tests hold both ends to it.
 */
import { describe, expect, it } from 'vitest'
import { resumeContentDisposition } from './resumes.controller'
import { sanitizeFileName } from './resumes.service'

describe('sanitizeFileName', () => {
  it('keeps an ordinary name, Cyrillic included', () => {
    expect(sanitizeFileName('резюме-иванова.pdf')).toBe('резюме-иванова.pdf')
  })

  it.each([
    ['../../etc/passwd.pdf', 'passwd.pdf'],
    ['..\\..\\windows\\system32\\config.pdf', 'config.pdf'],
    ['/absolute/path/cv.docx', 'cv.docx'],
  ])('reduces %s to its bare filename', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected)
  })

  it('drops control characters', () => {
    const withControls = `cv${String.fromCharCode(0x00)}${String.fromCharCode(0x0d)}.pdf`
    expect(sanitizeFileName(withControls)).toBe('cv.pdf')
  })

  it('caps the length', () => {
    expect(sanitizeFileName(`${'x'.repeat(500)}.pdf`)).toHaveLength(180)
  })

  it('falls back to a name rather than returning nothing', () => {
    expect(sanitizeFileName('')).toBe('resume')
    expect(sanitizeFileName('   ')).toBe('resume')
    expect(sanitizeFileName('/')).toBe('resume')
  })
})

describe('resumeContentDisposition', () => {
  it('carries the real Cyrillic name in the UTF-8 slot and an ASCII fallback', () => {
    const header = resumeContentDisposition('Иван Петров')
    expect(header).toMatch(/^attachment; filename="[^"]*\.pdf"; filename\*=UTF-8''/)
    expect(decodeURIComponent(header.split("UTF-8''")[1] ?? '')).toBe('Резюме — Иван Петров.pdf')
  })

  /**
   * MUTATION: point this back at its own inline `replace(/["\\\r\n]/g, '')` —
   * this goes red, because `../../etc/passwd.pdf` reaches the header untouched
   * while the identical string is defused on the upload path.
   */
  it('applies the SAME reduction as the upload path to a path-shaped display name', () => {
    const header = resumeContentDisposition('../../etc/passwd.pdf')
    expect(header).not.toContain('..')
    expect(header).not.toContain('/etc/')
    expect(header).toContain('passwd.pdf')
  })

  /**
   * The order of the two steps matters. Stripping the backslash FIRST removed
   * the very character `sanitizeFileName` uses to find the last path segment,
   * so a Windows-shaped name collapsed into one run of text instead of
   * reducing to its bare filename the way the upload path does.
   *
   * MUTATION: swap the order back (`sanitizeFileName(name.replace(/["\\]/g, ''))`)
   * and this goes red.
   */
  it('reduces a WINDOWS path the same way the upload path does', () => {
    const header = resumeContentDisposition('..\\..\\windows\\system32\\config.pdf')
    expect(header).toContain('config.pdf')
    expect(header).not.toContain('windows')
    expect(header).not.toContain('system32')
  })

  it('cannot break out of the quoted ASCII parameter', () => {
    const header = resumeContentDisposition('evil" ; attachment; filename="pwned')
    // Exactly one quoted filename parameter, and no stray quote inside it.
    const ascii = /filename="([^"]*)"/.exec(header)?.[1] ?? ''
    expect(ascii).not.toContain('"')
    expect(header.match(/filename="/g)).toHaveLength(1)
  })

  it('never emits a raw newline (header splitting)', () => {
    const header = resumeContentDisposition('Иван\r\nX-Injected: 1')
    expect(header).not.toMatch(/[\r\n]/)
  })

  it('falls back for a display name that reduces to nothing', () => {
    expect(resumeContentDisposition('   ')).toContain('resume.pdf')
  })
})
