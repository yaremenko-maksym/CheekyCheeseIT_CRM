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
 *
 * The Task 15 routes are thin: they parse the body, pass the viewer through, and the staged PDF
 * goes out as a PDF attachment named by `resumeContentDisposition`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { resumeContentDisposition, SeniorResumesController } from './resumes.controller'
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

describe('SeniorResumesController — Task 15 routes', () => {
  const USER = 'a15e0000-0000-4000-8000-0000000000a1'
  const RUN = 'a15e0000-0000-4000-8000-000000000001'
  const viewer = { id: 'v', email: 'v@unit.spec', role: 'HR' } as SessionUser
  const service = {
    confirm: vi.fn(async (..._args: unknown[]) => 'confirmed'),
    editStagedField: vi.fn(async (..._args: unknown[]) => 'edited'),
    regenerateStagedField: vi.fn(async (..._args: unknown[]) => 'regenerated'),
    getStagedPdf: vi.fn(async (..._args: unknown[]) => ({
      pdfBuffer: Buffer.from('%PDF'),
      displayName: 'Jane Doe',
    })),
  }
  const controller = new SeniorResumesController(service as never)

  it('confirm, edit and regenerate parse the body and pass the viewer through', async () => {
    await expect(controller.confirm(USER, { runId: RUN, version: 3 }, viewer)).resolves.toBe(
      'confirmed',
    )
    expect(service.confirm).toHaveBeenCalledWith(viewer, USER, { runId: RUN, version: 3 })
    const edit = { runId: RUN, path: 'summary', text: 'New.' }
    await expect(controller.editStaged(USER, edit, viewer)).resolves.toBe('edited')
    expect(service.editStagedField).toHaveBeenCalledWith(viewer, USER, edit)
    const regen = { runId: RUN, path: 'summary' }
    await expect(controller.regenerateStaged(USER, regen, viewer)).resolves.toBe('regenerated')
    expect(service.regenerateStagedField).toHaveBeenCalledWith(viewer, USER, regen)
    expect(() => controller.confirm(USER, { runId: 'nope', version: 3 }, viewer)).toThrow()
  })

  it('staged-pdf is sent as a PDF attachment under the owner name', async () => {
    const headers: Record<string, string> = {}
    const reply = {
      header(name: string, value: string) {
        headers[name] = value
        return reply
      },
      send: vi.fn(async (_body: Buffer) => undefined),
    }
    await controller.getStagedPdf(USER, viewer, reply as never)
    expect(service.getStagedPdf).toHaveBeenCalledWith(viewer, USER)
    expect(headers).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': resumeContentDisposition('Jane Doe'),
    })
    expect(reply.send.mock.calls[0]?.[0]?.toString()).toBe('%PDF')
  })
})
