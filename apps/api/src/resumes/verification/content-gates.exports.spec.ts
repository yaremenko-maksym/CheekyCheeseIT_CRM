/**
 * The content-gate primitives the tailored resume reuses (tailored-resume plan Task 7), and the
 * feedback line order fix carried from the PR 1/2 reviews. `content-gates.spec.ts` keeps the VBR
 * behaviour; it is at its size cap, so these cases live here.
 */
import { describe, expect, it } from 'vitest'
import type { ContactContext } from './contact-scan'
import { cleaner, feedbackLine, gateTexts, toFeedback } from './content-gates'
import type { EntailmentClaim } from './inference-clients'

const CONTACTS: ContactContext[] = [{ fullName: 'Jane Doe', emails: ['jane.doe@unit.spec'] }]

describe('toFeedback line breaks before redaction', () => {
  it('redacts a name split by NEL, LS, PS, VT or FF: the break becomes a space first', () => {
    for (const brk of ['\u0085', ' ', ' ', '\x0B', '\x0C', '\r\n']) {
      const [line] = toFeedback(
        'Bullet',
        [{ index: 0, reason: 'UNGROUNDED', detail: `mentions Jane${brk}Doe` }],
        CONTACTS,
      )
      expect(line).toBe('Bullet 1: mentions [REDACTED].')
    }
  })
})

describe('feedbackLine', () => {
  it('one line, redacted, at most 1000 chars', () => {
    expect(feedbackLine('a b jane.doe@unit.spec', CONTACTS)).toBe('a b [REDACTED]')
    expect(feedbackLine('y'.repeat(1500), [])).toHaveLength(1000)
  })

  it('a run of line breaks becomes one space', () => {
    expect(feedbackLine('One\r\n\u2028Two', [])).toBe('One Two')
  })
})

describe('gateTexts (exported for the tailored resume)', () => {
  const fake = (score: number) => {
    const seen: EntailmentClaim[][] = []
    const deps = {
      entailment: {
        score: async (claims: EntailmentClaim[]) => {
          seen.push(claims)
          return new Map(claims.map((c) => [c.id, score]))
        },
      },
      beforeModelCall: async () => undefined,
    }
    return { seen, deps }
  }
  const source = { text: 'Built APIs\nRan Postgres', skills: [] }

  it('judges text i against sources(i) when sources is a function', async () => {
    const { seen, deps } = fake(1)
    const failures = await gateTexts(
      ['Built APIs', 'Ran Postgres'],
      source,
      (i) => [`source of ${i}`],
      { contacts: CONTACTS },
      deps,
    )
    expect(failures).toEqual([])
    expect(seen).toEqual([
      [
        { id: 'c0', text: 'Built APIs', sources: ['source of 0'] },
        { id: 'c1', text: 'Ran Postgres', sources: ['source of 1'] },
      ],
    ])
  })

  it('still takes one array for every text (the VBR callers)', async () => {
    const { seen, deps } = fake(0.5)
    const failures = await gateTexts(['Built APIs'], source, ['all'], { contacts: CONTACTS }, deps)
    expect(seen[0]?.[0]?.sources).toEqual(['all'])
    expect(failures).toEqual([
      { index: 0, reason: 'NOT_SUPPORTED', detail: 'FACTS do not support it' },
    ])
  })

  it('fails a text with the senior name before any model call', async () => {
    const { seen, deps } = fake(1)
    const failures = await gateTexts(
      ['Jane Doe built APIs'],
      source,
      [],
      { contacts: CONTACTS },
      deps,
    )
    expect(failures.map((f) => f.reason)).toEqual(['CONTACT_IN_TEXT'])
    expect(seen).toEqual([])
  })
})

describe('cleaner (exported for the tailored resume)', () => {
  it('normalises to NFC, drops glyphs outside the font and collapses whitespace', () => {
    const clean = cleaner('classic')
    expect(clean('  Café \n APIs \u{1F680} ')).toBe('Café APIs')
  })
})
