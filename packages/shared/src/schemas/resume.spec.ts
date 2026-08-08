import { describe, it, expect } from 'vitest'
import {
  EMPTY_RESUME_CONTENT,
  RESUME_LIMITS,
  isSafeResumeUrl,
  ingestResumeTextSchema,
  resumeContentSchema,
  resumeLinkSchema,
  updateResumeContentSchema,
} from './resume'

describe('isSafeResumeUrl (AC7 — injected content)', () => {
  it('accepts https and mailto', () => {
    expect(isSafeResumeUrl('https://example.com/cv')).toBe(true)
    expect(isSafeResumeUrl('mailto:a@b.co')).toBe(true)
    expect(isSafeResumeUrl('  https://example.com  ')).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'jAvAsCrIpT:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'http://example.com',
    'file:///etc/passwd',
    '//example.com',
    'example.com',
    '',
    '   ',
  ])('rejects %s', (raw) => {
    expect(isSafeResumeUrl(raw)).toBe(false)
  })

  it('rejects a scheme obfuscated with control characters', () => {
    // WHATWG URL strips ASCII tab/newline inside the scheme, so a regex-based
    // check would miss this; the parser-based check must still reject it
    // because the resulting protocol is `javascript:`, not `https:`.
    expect(isSafeResumeUrl('java\tscript:alert(1)')).toBe(false)
    expect(isSafeResumeUrl('java\nscript:alert(1)')).toBe(false)
  })

  /**
   * The two cases above reject with OR without the normalisation step (the
   * scheme regex simply fails to match `java<TAB>script:` either way), so they
   * pin nothing about it. These do: each one flips from true to false the
   * moment a piece of `normalizeUrlForSchemeCheck` is removed.
   */
  describe('normalisation is load-bearing, not decorative', () => {
    it('strips ASCII tab/CR/LF from the MIDDLE, exactly like the URL parser', () => {
      // Reachable as `https://example.com` by any browser — so it must be
      // judged by what it really resolves to.
      expect(isSafeResumeUrl('https:/\t/example.com')).toBe(true)
      expect(isSafeResumeUrl('https:/\r\n/example.com')).toBe(true)
    })

    it('trims leading C0 controls, not merely spaces', () => {
      // Built with fromCharCode so no control byte is ever a LITERAL in this
      // source file: a literal NUL makes git treat the spec as binary and the
      // diff stops being reviewable.
      const soh = String.fromCharCode(0x01)
      const nul = String.fromCharCode(0x00)
      expect(isSafeResumeUrl(`${soh}https://example.com`)).toBe(true)
      expect(isSafeResumeUrl(`${nul} https://example.com`)).toBe(true)
    })

    it('compares the scheme case-insensitively', () => {
      expect(isSafeResumeUrl('HTTPS://example.com')).toBe(true)
      expect(isSafeResumeUrl('MailTo:a@b.co')).toBe(true)
    })

    it('requires an actual address after mailto:', () => {
      expect(isSafeResumeUrl('mailto:')).toBe(false)
      expect(isSafeResumeUrl('mailto:a')).toBe(true)
    })
  })

  /**
   * Credentials in the authority are a phishing primitive: `https://github.com@evil.tld`
   * reads as "github.com" to anyone skimming, and the browser goes to `evil.tld`.
   * These links come out of an uploaded file and an LLM, i.e. from an attacker.
   */
  describe('credentials in the authority', () => {
    it.each([
      'https://github.com@evil.tld',
      'https://user:password@evil.tld',
      'https://user@evil.tld/cv.pdf',
    ])('rejects %s', (raw) => {
      expect(isSafeResumeUrl(raw)).toBe(false)
    })

    it('still accepts an @ that is part of the PATH, not the authority', () => {
      expect(isSafeResumeUrl('https://example.com/~user@home/cv.pdf')).toBe(true)
      expect(isSafeResumeUrl('https://example.com/?to=a@b.co')).toBe(true)
    })
  })

  it('rejects unsafe links at the schema level too', () => {
    expect(resumeLinkSchema.safeParse({ label: 'CV', url: 'javascript:alert(1)' }).success).toBe(
      false,
    )
    expect(resumeLinkSchema.safeParse({ label: 'CV', url: 'https://ok.dev' }).success).toBe(true)
  })
})

describe('resumeContentSchema', () => {
  it('accepts the canonical empty content', () => {
    expect(resumeContentSchema.parse(EMPTY_RESUME_CONTENT)).toEqual(EMPTY_RESUME_CONTENT)
  })

  it('accepts a filled resume', () => {
    const parsed = resumeContentSchema.parse({
      summary: 'Синьор-разработчик, 8 лет опыта',
      skills: ['TypeScript', 'NestJS'],
      experience: [
        {
          company: 'Acme',
          role: 'Team Lead',
          period: '2021 — наст. время',
          bullets: ['Вёл 5 человек'],
        },
      ],
      education: [{ institution: 'КПІ', degree: 'Магистр', period: '2012–2018' }],
      languages: [{ name: 'Английский', level: 'C1' }],
      links: [{ label: 'GitHub', url: 'https://github.com/x' }],
    })
    expect(parsed.experience[0]?.bullets).toEqual(['Вёл 5 человек'])
  })

  it('rejects over-long fields (bounded storage / bounded PDF)', () => {
    const tooLong = 'x'.repeat(RESUME_LIMITS.summary + 1)
    expect(
      resumeContentSchema.safeParse({ ...EMPTY_RESUME_CONTENT, summary: tooLong }).success,
    ).toBe(false)
  })

  it('rejects too many skills', () => {
    const skills = Array.from({ length: RESUME_LIMITS.skills + 1 }, (_, i) => `s${i}`)
    expect(resumeContentSchema.safeParse({ ...EMPTY_RESUME_CONTENT, skills }).success).toBe(false)
  })

  it('keeps markup as literal text (escaping is the renderer job, not stripping here)', () => {
    const parsed = resumeContentSchema.parse({
      ...EMPTY_RESUME_CONTENT,
      summary: '<img src=x onerror=alert(1)>',
    })
    expect(parsed.summary).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('write payloads', () => {
  it('updateResumeContentSchema requires a content object', () => {
    expect(updateResumeContentSchema.safeParse({}).success).toBe(false)
    expect(updateResumeContentSchema.safeParse({ content: EMPTY_RESUME_CONTENT }).success).toBe(
      true,
    )
  })

  it('ingestResumeTextSchema rejects text below the extractable minimum', () => {
    expect(ingestResumeTextSchema.safeParse({ text: 'короткий' }).success).toBe(false)
    expect(
      ingestResumeTextSchema.safeParse({ text: 'a'.repeat(RESUME_LIMITS.minExtractableChars) })
        .success,
    ).toBe(true)
  })
})
