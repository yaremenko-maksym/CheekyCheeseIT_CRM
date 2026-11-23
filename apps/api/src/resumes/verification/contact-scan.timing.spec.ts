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
  }, 300_000)
})

/** CPU time this process spent, in ms. A ReDoS burns CPU; a loaded machine only stretches the
 * wall clock, so a wall-clock bound fails on load and says nothing about the pattern. */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** The time budget. Under Stryker it is unbounded: instrumenting every expression stretches the
 * clock with no change to a pattern, and a mutant that makes one super-linear is still caught
 * there by Stryker's own timeout. Every other run (unit, pre-push, CI) holds the 500 ms. */
const BUDGET_MS =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? 500 : Number.POSITIVE_INFINITY

/** The shortest arm of a CPU-ratio test: under ~20 ms one scheduler tick or GC pause moves the
 * ratio past its limit (backlog 454: the part-count arms took 2-4 ms on CI). */
const MIN_ARM_MS = 20
/** Run-bound arm ratios (per scan, against one part): measured absent8 1.6-1.8x, present8 13.5-18x,
 * present16 2.2-2.7x; the in-text filter off makes absent8 as costly as present8, the 16-part bound
 * builds 2^15 subsets. */
const RATIO_ABSENT = 4
const RATIO_PRESENT = 64

/** The first of 1, 2, 4, \u{2026} 64 repeats at which `arm(repeats)` costs `MIN_ARM_MS` or more, so a fast
 * machine runs a longer window instead of a noisier ratio. The last one is returned unmeasured.
 * Each step takes the faster of two runs: one GC pause or JIT tier-up in a single run once read
 * 20 ms where the timed run then took 6.6 ms. */
const armRepeats = (arm: (repeats: number) => number): number => {
  let repeats = 1
  while (repeats < 64 && Math.min(arm(repeats), arm(repeats)) < MIN_ARM_MS) repeats *= 2
  return repeats
}

const defaultCtx: ContactContext = { fullName: 'Mark Levin', emails: ['mark.levin@example.com'] }

describe('wall-clock and stopwatch assertions (moved from contact-scan.spec.ts)', () => {
  it.each([
    ['a.', 'a.'.repeat(25_000)],
    ['a-.', 'a-.'.repeat(16_667)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (SR-L-3, R91)', (_, text) => {
    const started = cpuMs()
    redactContacts(text, defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it.each([
    ['\u{0442}\u{0433} - ', '\u{0442}\u{0433} - '.repeat(10_000)],
    ['Telegram @', 'Telegram @'.repeat(5_000)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (R91)', (_, input) => {
    const started = cpuMs()
    redactContacts(input, defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it('a 10k-character Cyrillic host repeat is redacted in under 500 ms (R91)', () => {
    const started = cpuMs()
    redactContacts('\u{043F}\u{0440}\u{0438}\u{043C}\u{0435}\u{0440}.'.repeat(1_429), defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it('notes of Cyrillic characters in 63-letter labels are redacted in time linear in their length (SR3-M-1)', () => {
    const run = (count: number, length: number): number => {
      const note = `${'\u{043F}'.repeat(63)}.`.repeat(Math.ceil(length / 64)).slice(0, length)
      const started = cpuMs()
      for (let i = 0; i < count; i++) redactContacts(note, defaultCtx)
      return cpuMs() - started
    }
    run(60, 500)
    const repeats = armRepeats((k) => run(600 * k, 500))
    const short = run(600 * repeats, 500)
    const long = run(75 * repeats, 4000)
    expect(short).toBeGreaterThanOrEqual(MIN_ARM_MS * 0.5)
    expect(long / short).toBeLessThan(3)
    expect(short).toBeLessThan(BUDGET_MS * 10)
  })

  it('a stored name of many invisible-separated parts is scanned in time linear in its part count (PR #1351 round 9, Addendum A)', () => {
    const parts = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => ['Li', 'Yu', 'Bo'][i % 3] ?? '')
    const stored = (count: number): ContactContext => ({
      fullName: `Ivan ${parts(count).join('\u200B')}`,
      emails: [],
    })
    const text = 'Senior engineer in Kyiv since 2020, led an API migration. '.repeat(12)
    const run = (count: number, repeats = 1): number => {
      const started = cpuMs()
      for (let i = 0; i < 20 * repeats; i++) scanContacts(text, stored(count))
      return cpuMs() - started
    }
    run(20)
    const repeats = armRepeats((k) => run(20, k))
    const short = run(20, repeats)
    const long = run(160, repeats)
    expect(short).toBeGreaterThanOrEqual(MIN_ARM_MS * 0.5)
    expect(long / short).toBeLessThan(16)
    expect(long / repeats).toBeLessThan(BUDGET_MS * 10)
  })

  it('the gate at its run bound stays bounded and the in-text filter keeps absent parts free (PR #1362 fix 1)', () => {
    const pool = [
      'Qa',
      'Jx',
      'Vq',
      'Zk',
      'Fj',
      'Pw',
      'Hv',
      'Mq',
      'Gx',
      'Tz',
      'Kq',
      'Wj',
      'Yq',
      'Xz',
      'Bq',
      'Dv',
    ]
    const base = 'Senior engineer in Kyiv since 2020, led an API migration. '.repeat(12)
    const timed = (text: string, name: string, repeats: number): number => {
      const started = cpuMs()
      for (let i = 0; i < 20 * repeats; i++) scanContacts(text, { fullName: name, emails: [] })
      return cpuMs() - started
    }
    const perScan = (text: string, name: string): number => {
      const repeats = armRepeats((k) => timed(text, name, k))
      return timed(text, name, repeats) / (20 * repeats)
    }
    const zwsp = String.fromCharCode(0x200b)
    const name = (count: number): string => ['Ivan', ...pool.slice(0, count - 1)].join(zwsp)
    const withParts = (count: number): string => `${base} ${pool.slice(0, count - 1).join(' ')}`
    const ref = perScan(base, 'Ivan')
    const absent8 = perScan(base, name(8))
    const present8 = perScan(withParts(8), name(8))
    const present16 = perScan(withParts(16), name(16))
    expect(absent8 / ref).toBeLessThan(RATIO_ABSENT)
    expect(present8 / ref).toBeLessThan(RATIO_PRESENT)
    expect(present16 / ref).toBeLessThan(RATIO_PRESENT)
  })

  it('notes of one cluster full of invisibles are redacted in time linear in their length (PR #1351 round 4, CR-M-2)', () => {
    const shapes = ['\u200B\u0301', '\u1100\u200B\u1161']
    const run = (count: number, length: number): number => {
      const notes = shapes.map((shape) =>
        `q${shape.repeat(Math.ceil(length / shape.length))}`.slice(0, length),
      )
      const started = cpuMs()
      for (let i = 0; i < count; i++) for (const note of notes) redactContacts(note, defaultCtx)
      return cpuMs() - started
    }
    run(60, 500)
    const short = run(600, 500)
    const long = run(75, 4000)
    expect(long / short).toBeLessThan(3)
    expect(short).toBeLessThan(BUDGET_MS * 10)
  })

  it('50k spaces are redacted in under 500 ms (SR3-L-3)', () => {
    const started = cpuMs()
    redactContacts(' '.repeat(50_000), defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it.each([
    ['a@b.co-', 'a@b.co-'.repeat(7_143)],
    ['a@', 'a@'.repeat(25_000)],
    ['a.a@b.', 'a.a@b.'.repeat(8_334)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (SR4-M-1)', (_, input) => {
    const started = cpuMs()
    redactContacts(input, defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it.each([
    '\u{1D41A}@b.com',
    '\u{1D41A}@b.com-\u{1D41C}@d.com',
    'x \u{1D41A}\u{1D41B}@b.com y',
    '\u{10000}@b.com-\u{10000}@d.com',
  ])('an email starting with an astral letter, %j, scan ends within budget (SR5-H-1)', (text) => {
    const started = cpuMs()
    redactContacts(text, [])
    scanContacts(text, defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it('50k characters of "1," are redacted in under 500 ms (SR4-L-1)', () => {
    const started = cpuMs()
    redactContacts('1,'.repeat(25_000), defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it('50k characters of "Telegram handle" are redacted in under 500 ms (SO7-5)', () => {
    const started = cpuMs()
    redactContacts('Telegram handle'.repeat(3_334), defaultCtx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })
})
