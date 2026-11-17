/**
 * CONTACT_IN_TEXT, the senior's full name: how the display name is cut into tokens. Split out of
 * resume-completeness.spec.ts (at the size cap).
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import { checkResumeCompleteness } from './resume-completeness'

const NOW = new Date('2026-11-10T00:00:00Z')
const FACTS: ResumeFacts = {
  headline: 'Senior Frontend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  experience: [
    {
      company: 'Acme',
      role: 'Engineer',
      location: 'Kyiv',
      start: '2020-01',
      end: '2023-06',
      current: false,
      technologies: ['React'],
      notes: ['Built the design system'],
    },
  ],
  education: [{ institution: 'KPI', degree: 'BSc', startYear: 2015, endYear: 2019 }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}
const flagged = [{ path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' }]
const noteIssues = (note: string, displayName: string) =>
  checkResumeCompleteness(
    { ...FACTS, experience: FACTS.experience.map((e) => ({ ...e, notes: [note] })) },
    { displayName, now: NOW },
  ).filter((i) => i.code === 'CONTACT_IN_TEXT')

describe('the display name, cut into tokens', () => {
  it('spaces around and inside the display name add no empty token', () => {
    const name = '  Jane   Doe '
    expect(noteIssues('Built by Jane Doe', name)).toEqual(flagged)
    expect(noteIssues('Built by Doe Jane', name)).toEqual(flagged)
    // An empty token would make a bare surname, or "word Doe", the full name.
    expect(noteIssues('Mr. Doe wrote it', name)).toEqual([])
    expect(noteIssues('Doe. Then more', name)).toEqual([])
  })

  it('a regex metacharacter in the name matches only itself', () => {
    const name = 'Jo.hn Do+e'
    expect(noteIssues('Built by Jo.hn Do+e', name)).toEqual(flagged)
    expect(noteIssues('Built by Joxhn Dooe', name)).toEqual([])
    expect(noteIssues('Built by John Doe', name)).toEqual([])
  })

  it('a display name of spaces only adds no name check', () => {
    expect(noteIssues('Built by Jane Doe', '   ')).toEqual([])
  })
})
