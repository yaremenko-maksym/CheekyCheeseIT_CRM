import { EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { eligibilityOf } from './tailored-eligibility'

const content: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Backend engineer.',
  skills: ['TypeScript'],
  experience: [{ company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: ['Built APIs'] }],
  // never sent to a model, so a Cyrillic entry here does not block
  languages: [{ name: 'Українська', level: 'C2' }],
}
const ready = {
  base: { verificationStatus: 'VERIFIED', content },
  displayName: 'José Müller',
  detailPending: false,
}
const withContent = (over: Partial<ResumeContent>) => ({
  ...ready,
  base: { verificationStatus: 'VERIFIED', content: { ...content, ...over } },
})
const item = content.experience[0] as ResumeContent['experience'][number]

describe('eligibilityOf', () => {
  it('a VERIFIED Latin base with nothing pending → READY', () => {
    expect(eligibilityOf(ready)).toBe('READY')
  })

  it('no base → NO_VERIFIED_RESUME', () => {
    expect(eligibilityOf({ ...ready, base: null })).toBe('NO_VERIFIED_RESUME')
  })

  it('a base that is not VERIFIED → NO_VERIFIED_RESUME', () => {
    expect(eligibilityOf({ ...ready, base: { verificationStatus: 'DRAFT', content } })).toBe(
      'NO_VERIFIED_RESUME',
    )
  })

  it('Cyrillic display name → NON_LATIN_NAME, before any field check', () => {
    expect(
      eligibilityOf({ ...withContent({ summary: 'Інженер' }), displayName: 'Іван Петренко' }),
    ).toBe('NON_LATIN_NAME')
  })

  it.each([
    ['summary', { summary: 'Інженер.' }],
    ['skill', { skills: ['TypeScript', 'Розробка'] }],
    ['bullet', { experience: [{ ...item, bullets: ['Built APIs', 'Розробив API'] }] }],
    ['role', { experience: [{ ...item, role: 'Розробник' }] }],
    ['company', { experience: [{ ...item, company: 'Рога' }] }],
    ['period', { experience: [{ ...item, period: '2020 — наст. время' }] }],
  ] as const)('Cyrillic %s → NON_ENGLISH', (_, over) => {
    expect(eligibilityOf(withContent(over))).toBe('NON_ENGLISH')
  })

  it('detailPending with a queued DETAIL_FETCH → POSTING_PENDING', () => {
    expect(eligibilityOf({ ...ready, detailPending: true })).toBe('POSTING_PENDING')
  })

  it('a non-English base is reported before a pending posting', () => {
    expect(eligibilityOf({ ...withContent({ summary: 'Інженер.' }), detailPending: true })).toBe(
      'NON_ENGLISH',
    )
  })

  it('detailPending with nothing queued (open 404, manual card) → READY', () => {
    expect(eligibilityOf({ ...ready, detailPending: false })).toBe('READY')
  })
})
