/**
 * PR #1416 (backlog 463), the timing half: the name patterns stay linear on adversarial stored names.
 *
 * A separate file because the assertions are CPU-time bounds, which a loaded box can miss on code
 * it does not test (PR #1416 round 3, finding 6: 69 ms against an 80 ms bound locally). It is
 * excluded from the default run and runs in the `Timing specs` CI job, alone on its runner:
 *
 *   TIMING_SPECS=1 pnpm --filter @crm/api exec vitest run src/resumes/verification/contact-scan.timing
 *
 * The outcome half (what is redacted, which source reads past the budget) stays in
 * `contact-scan.translit.spec.ts` and `contact-scan.name-parts.spec.ts` and gates every push. Each
 * bound is at least 5x the worst median measured on the fixed code (noted beside it); the shapes
 * took seconds to minutes before their fix. Every name here is invented.
 *
 * It calls `redactContacts`, the whole body of `redactAll`, not `redactAll` itself: `content-gates`
 * imports `@crm/inference`, which resolves only once built, and the `Timing specs` job builds
 * nothing (PR #1416 round 4, CR-H-1).
 */
import { describe, expect, it } from 'vitest'
import { checkResumeCompleteness, type ResumeFacts } from '@crm/shared'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'

const ctx = (fullName: string): ContactContext => ({ fullName, emails: [] })

/** Median CPU time of `fn` over `runs` runs, in ms: wall time would count a loaded box against the pattern. */
const medianCpuMs = (fn: () => void, runs = 5): number => {
  const times = Array.from({ length: runs }, () => {
    const start = process.cpuUsage()
    fn()
    const { user, system } = process.cpuUsage(start)
    return (user + system) / 1000
  }).sort((a, b) => a - b)
  return times[Math.floor(runs / 2)] as number
}

const FACTS: ResumeFacts = {
  headline: 'Backend Engineer',
  location: { city: 'Lviv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'React', 'Docker'],
  experience: [],
  education: [],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

const completeness = (text: string, displayName: string): void => {
  checkResumeCompleteness(
    { ...FACTS, headline: text },
    { displayName, now: new Date('2026-11-18T00:00:00Z') },
  )
}

/** The three paths a stored name reaches: the redaction, the gate scan, the shared completeness check. */
const PATHS: [string, (text: string, name: string) => void][] = [
  ['redactContacts', (text, name) => void redactContacts(text, [ctx(name)])],
  ['scanContacts', (text, name) => void scanContacts(text, ctx(name))],
  ['checkResumeCompleteness', completeness],
]

const ZWSP = '​'

describe('SR-H-3: a stored part that folds to nothing (round 3)', () => {
  // 8 empty parts + 40 spaces took 13 957 ms in redactContacts before the fix
  const marks = ['̈', '¨', '\\̈', '\u0085̈']
  const runs = [' '.repeat(40), '\\n'.repeat(40), `${' '.repeat(40)}ж`]
  it.each(PATHS)('%s stays linear', (_, path) => {
    for (const mark of marks) {
      const name = ['Ivan', ...Array.from({ length: 8 }, () => mark), 'Petrenko'].join(' ')
      for (const run of runs) {
        // measured worst median 0.6 ms
        expect(medianCpuMs(() => path(`Ivan${run}x`, name))).toBeLessThan(50)
      }
    }
  })
})

describe('finding 3: a ZWSP-split part ending in gap punctuation (round 3)', () => {
  const name = ['Ivan', ...Array.from({ length: 8 }, () => 'a.'), 'Ba'].join(ZWSP)
  it.each(PATHS)('%s stays linear on a 40 000-character run of `a.`', (_, path) => {
    for (const text of ['a.'.repeat(20_000), `${'a.'.repeat(20_000)} ж`, 'a. '.repeat(13_333)]) {
      // measured worst median 79 ms (linear: the text is a hit at every other character)
      expect(medianCpuMs(() => path(text, name), 3)).toBeLessThan(500)
    }
  })
})

describe('the reading budget (rounds 1-3)', () => {
  it('reads a part past the budget with its primary readings only', () => {
    const ms = medianCpuMs(() => redactContacts(`by ${'y'.repeat(60)}z`, ctx('ий'.repeat(16))))
    expect(ms).toBeLessThan(50) // measured median 0.2 ms
  })

  it('scans a many-part adversarial name against a long near-miss', () => {
    for (const parts of [4, 6, 8]) {
      const name = [...Array.from({ length: parts }, () => 'ййййий'), 'Фщ'].join(' ')
      const ms = medianCpuMs(() => redactContacts(`by ${'y'.repeat(40)} done`, ctx(name)))
      expect(ms).toBeLessThan(50) // measured median 0.6 ms
    }
  })

  it('redacts the worst name on the budget against a 40 000-character near-miss', () => {
    // SR-M-6's shape: 6 optional `й`, then `и Ба`, against a run of `y`
    const ms = medianCpuMs(() => redactContacts(`${'y'.repeat(40_000)} done`, [ctx('йййййии Ба')]))
    expect(ms).toBeLessThan(200) // measured median 16 ms
  })

  it('bounds each source by its own parts when the whole name is past the budget (finding 5)', () => {
    // three parts on the budget each: every lone part keeps its readings, the joined ones do not
    const part = `${'й'.repeat(6)}и`
    const name = [part, part, part].join(' ')
    const ms = medianCpuMs(() => redactContacts(`${'y'.repeat(40_000)} done`, [ctx(name)]))
    expect(ms).toBeLessThan(400) // measured median 11 ms
  })
})

describe('SR-H-2: escaped newlines against escape-shaped parts (round 2)', () => {
  const escapes = `${'\\n'.repeat(40)} ж`
  const adversarial = (part: string, parts: number, separator: string, last = 'Ба') =>
    [...Array.from({ length: parts }, () => part), last].join(separator)
  it.each(['\\n', '\\н', '\\nь'])('stored part %j', (part) => {
    for (const separator of [' ', ZWSP]) {
      for (const last of ['Ба', 'Ba']) {
        const name = adversarial(part, 10, separator, last)
        expect(medianCpuMs(() => redactContacts(escapes, [ctx(name)]))).toBeLessThan(50) // worst 0.6 ms
        expect(medianCpuMs(() => scanContacts(escapes, ctx(name)))).toBeLessThan(50) // worst 0.6 ms
      }
    }
  })
})

/** mulberry32: a fixed seed gives the same cases on every run. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

describe('property guard: adversarial names over the class alphabet (round 3)', () => {
  const ALPHABET = ['a', 'й', 'ь', '̈', ' ', '\\', 'n', 'N', '.', '-', ZWSP]
  const next = random(463)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  const cases = Array.from({ length: 300 }, () =>
    Array.from({ length: 4 + Math.floor(next() * 20) }, () => pick(ALPHABET)).join(''),
  )

  it('keeps redactContacts and scanContacts bounded on a 40 000-character near-miss of each', () => {
    let worst = 0
    let worstName = ''
    for (const name of cases) {
      // the name over and over, each copy one letter short: a near-miss at every start
      const unit = `${name.slice(0, -1)}ж `
      const text = unit.repeat(Math.ceil(40_000 / unit.length)).slice(0, 40_000)
      const gap = `${'\\n '.repeat(40)}${name}ж`
      for (const subject of [text, gap]) {
        const ms = medianCpuMs(() => {
          redactContacts(subject, [ctx(name)])
          scanContacts(subject, ctx(name))
        }, 1)
        if (ms > worst) [worst, worstName] = [ms, name]
      }
    }
    // measured worst 260 ms, linear in the text (a one-letter part such as `n` hits at every copy);
    // before the round-3 invariant a shape of this alphabet took seconds on 40 characters
    expect({ worst: worst < 2000, worstName }).toEqual({ worst: true, worstName })
  })
})
