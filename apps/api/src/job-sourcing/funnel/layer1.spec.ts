import { describe, expect, it } from 'vitest'
import type { ObservedDate } from '../normalize/date-policy'
import {
  classifyLayer1,
  RULE_VERSION,
  SALARY_FLOOR_USD_MONTHLY,
  UnsupportedRuleVersionError,
  type Layer1Input,
} from './layer1'

const NOW = new Date('2026-10-20T12:00:00Z')

const base: Layer1Input = {
  title: 'Backend Developer',
  location: null,
  descriptionMd: '',
  remote: null,
  employmentType: null,
  seniorityHint: null,
  tags: [],
  dates: [],
}

const run = (over: Partial<Layer1Input> = {}, at: Date = NOW) =>
  classifyLayer1({ ...base, ...over }, { ruleVersion: RULE_VERSION, evaluationTime: at })

const ok = (semantics: ObservedDate['semantics'], iso: string): ObservedDate => ({
  semantics,
  contract: 'ISO_ZONED',
  raw: iso,
  status: 'OK',
  value: new Date(iso),
})

const ev = (source: string, field: string, excerpt: string, code: string, used = true) => ({
  source,
  field,
  excerpt,
  code,
  used,
})

/** The workplace value of a text placed in the location field (a structured source). */
const workplaceOf = (location: string) => run({ location }).workplace.value
/** The body-only reading of a text. */
const body = (descriptionMd: string) => run({ descriptionMd })

describe('layer1: shape and versioning', () => {
  it('exports a rule version and stamps it on every dimension', () => {
    expect(RULE_VERSION).toBe('l1.1')
    const r = run()
    expect(r.ruleVersion).toBe('l1.1')
    expect(r.evaluatedAt).toBe(NOW.toISOString())
    for (const d of [r.workplace, r.basis, r.schedule, r.duration, r.agency, r.roleFamily]) {
      expect(d.ruleVersion).toBe('l1.1')
    }
    for (const d of [r.seniority, r.leadership, r.geography, r.salary, r.freshness]) {
      expect(d.ruleVersion).toBe('l1.1')
    }
  })

  it('refuses a rule version it does not implement, naming both versions', () => {
    const call = () => classifyLayer1(base, { ruleVersion: 'l0.0' as never, evaluationTime: NOW })
    expect(call).toThrow(UnsupportedRuleVersionError)
    expect(call).toThrow('Layer 1 does not implement rule version "l0.0" (implements l1.1)')
    expect(call).toThrow(expect.objectContaining({ name: 'UnsupportedRuleVersionError' }))
  })

  it('is reproducible: same persisted input + rule version => structurally equal output', () => {
    const input: Layer1Input = {
      ...base,
      title: 'Senior Backend Engineer (Remote)',
      descriptionMd: 'Full-time. B2B or employment contract. 5+ years. No agencies.',
      salary: { min: 4000, max: 5000, currency: 'EUR', period: 'MONTH' },
      fxRate: { currency: 'EUR', usdPerUnit: 1.1, recordedAt: '2026-10-01T00:00:00Z' },
      dates: [ok('PUBLISHED', '2026-10-10T00:00:00Z')],
    }
    const a = classifyLayer1(input, { ruleVersion: RULE_VERSION, evaluationTime: NOW })
    const b = classifyLayer1(structuredClone(input), {
      ruleVersion: RULE_VERSION,
      evaluationTime: new Date(NOW),
    })
    expect(b).toEqual(a)
    expect(JSON.parse(JSON.stringify(a))).toEqual(a)
  })

  it('aggregates verdicts: REJECT beats WARN_UNKNOWN beats PASS, with names listed', () => {
    const rej = run({ title: 'Junior Developer', remote: true })
    expect(rej.verdict).toBe('REJECT')
    expect(rej.rejectedBy).toEqual(['seniority'])
    const warn = run({ title: 'Senior Developer' })
    expect(warn.verdict).toBe('WARN_UNKNOWN')
    expect(warn.unknown).toEqual(['workplace', 'basis', 'schedule', 'agency'])
    const pass = run({
      title: 'Senior Backend Developer',
      remote: true,
      employmentType: 'full_time',
      descriptionMd: 'B2B. Agencies are welcome.',
      dates: [ok('PUBLISHED', '2026-10-19T00:00:00Z')],
    })
    expect(pass.verdict).toBe('PASS')
    expect(pass.unknown).toEqual([])
    expect(pass.rejectedBy).toEqual([])
  })
})

describe('layer1: workplace phrases (one row per phrase)', () => {
  it.each([
    ['Remote', 'REMOTE'],
    ['Remotely', 'REMOTE'],
    ['Work from home', 'REMOTE'],
    ['Working from home', 'REMOTE'],
    ['WFH', 'REMOTE'],
    ['Telecommuting', 'REMOTE'],
    ['Fully distributed', 'REMOTE'],
    ['Віддалено', 'REMOTE'],
    ['Дистанційно', 'REMOTE'],
    ['Удаленно', 'REMOTE'],
    ['Удалённо', 'REMOTE'],
    ['Дистанционная работа', 'REMOTE'],
    ['Zdalnie', 'REMOTE'],
    ['Homeoffice', 'REMOTE'],
    ['Hybrid', 'HYBRID'],
    ['Partially remote', 'HYBRID'],
    ['Гібридний', 'HYBRID'],
    ['Гибридный', 'HYBRID'],
    ['Частково віддалена робота', 'HYBRID'],
    ['Onsite', 'ONSITE'],
    ['On-site', 'ONSITE'],
    ['In-office', 'ONSITE'],
    ['Office-based', 'ONSITE'],
    ['Work from office', 'ONSITE'],
    ['Work from the office', 'ONSITE'],
    ['Офісний формат', 'ONSITE'],
    ['Офисный формат', 'ONSITE'],
    ['Робота в офісі', 'ONSITE'],
    ['Работа в офисе', 'ONSITE'],
    ['Vor Ort', 'ONSITE'],
    ['1 day in the office', 'HYBRID'],
    ['4 days per week at the office', 'HYBRID'],
    ['3 days a week in office', 'HYBRID'],
    ['2 days weekly in the office', 'HYBRID'],
    ['5 days in the office', 'ONSITE'],
    ['5 days a week at office', 'ONSITE'],
    ['11 days in the office', 'UNKNOWN'],
    ['15 days per week in the office', 'UNKNOWN'],
    ['Berlin, Germany', 'UNKNOWN'],
    ['Remoteness', 'UNKNOWN'],
  ])('%s => %s', (text, expected) => {
    expect(workplaceOf(text)).toBe(expected)
  })

  it.each([
    ['REMOTE', 'PASS'],
    ['HYBRID', 'REJECT'],
    ['ONSITE', 'REJECT'],
  ])('verdict of %s is %s', (kind, verdict) => {
    const text = kind === 'REMOTE' ? 'Remote' : kind === 'HYBRID' ? 'Hybrid' : 'Onsite'
    expect(run({ location: text }).workplace.verdict).toBe(verdict)
  })

  it.each([
    'interview',
    'meeting',
    'event',
    'visit',
    'offsite',
    'training',
    'workshop',
    'onboarding',
  ])('"onsite %s" is not a workplace', (word) => {
    expect(workplaceOf(`Onsite ${word}`)).toBe('UNKNOWN')
  })

  it('"onsite" followed by another word, or by nothing, still counts', () => {
    expect(workplaceOf('On-site Berlin')).toBe('ONSITE')
    expect(workplaceOf('Onsite')).toBe('ONSITE')
  })

  it.each([
    'occasional',
    'optional',
    'rarely',
    'periodic',
    'quarterly',
    'annual',
    'sometimes',
    'епізодично',
    'іноді',
  ])('softened by "%s": an onsite or hybrid mention is not a workplace', (word) => {
    expect(workplaceOf(`${word} onsite`)).toBe('UNKNOWN')
    expect(workplaceOf(`${word} hybrid`)).toBe('UNKNOWN')
  })

  it('a softener counts within four words, not five', () => {
    expect(workplaceOf('occasional a b c onsite')).toBe('UNKNOWN')
    expect(workplaceOf('occasional a b c d onsite')).toBe('ONSITE')
  })

  it.each([
    'no',
    'not',
    'non',
    'without',
    'never',
    'neither',
    'nor',
    'не',
    'нет',
    'ні',
    'без',
    'kein',
    'keine',
    'nie',
    'brak',
    'bez',
    "isn't",
    "doesn't",
  ])('negator "%s" cancels an onsite / hybrid mention', (word) => {
    expect(workplaceOf(`${word} onsite`)).toBe('UNKNOWN')
    expect(workplaceOf(`${word} hybrid`)).toBe('UNKNOWN')
  })

  it('the typographic apostrophe is a contraction too', () => {
    expect(workplaceOf('isn’t onsite')).toBe('UNKNOWN')
  })

  it('a negator reaches five words back, not six', () => {
    expect(workplaceOf('not a b c d onsite')).toBe('UNKNOWN')
    expect(workplaceOf('not a b c d e onsite')).toBe('ONSITE')
  })

  it.each(['.', ';', '!', '?', ':', ','])('a "%s" ends the clause a negator reaches into', (c) => {
    expect(body(`Not great${c} onsite`).workplace.value).toBe('ONSITE')
  })

  it('a word that merely contains a negator ("knot", "notable") is not one', () => {
    expect(workplaceOf('knot onsite')).toBe('ONSITE')
    expect(workplaceOf('notable onsite')).toBe('ONSITE')
  })

  it('a negated remote is a NOT_REMOTE reading: UNKNOWN, never REMOTE', () => {
    const r = body('This position is not remote.')
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.workplace.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'This position is not remote.', 'NEGATED_REMOTE'),
    ])
  })

  it('negated onsite / hybrid statements leave a remote role remote', () => {
    for (const text of [
      'This is a remote role. No onsite presence is required.',
      'Remote role, not hybrid.',
      'Віддалена робота, не гібрид.',
    ]) {
      expect(body(text).workplace.value).toBe('REMOTE')
    }
  })

  it('"partially remote" is one hybrid phrase: its "remote" is not a second signal', () => {
    const r = body('Partially remote.')
    expect(r.workplace.value).toBe('HYBRID')
    expect(r.workplace.evidence).toHaveLength(1)
  })

  it('"2 days in the office" is one hybrid phrase: its "in office" is not onsite', () => {
    const r = body('2 days per week in office.')
    expect(r.workplace.value).toBe('HYBRID')
    expect(r.workplace.evidence).toHaveLength(1)
  })

  it('a negated or softened day count is not a signal', () => {
    expect(workplaceOf('not 2 days in the office')).toBe('UNKNOWN')
    expect(workplaceOf('occasionally 2 days in the office')).toBe('UNKNOWN')
    expect(workplaceOf('not 5 days in the office')).toBe('UNKNOWN')
  })

  it('hybrid or remote in one tier is a contradiction, not a guess', () => {
    const r = run({ location: 'Hybrid or remote' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
  })

  it('NUL, case and fullwidth letters are normalised before matching', () => {
    expect(workplaceOf('RE\u0000MOTE')).toBe('REMOTE')
    expect(workplaceOf('ＲＥＭＯＴＥ')).toBe('REMOTE')
  })
})

describe('layer1: workplace sources and precedence', () => {
  it('structured remote flag => REMOTE / PASS with exact evidence', () => {
    const r = run({ remote: true })
    expect(r.workplace.value).toBe('REMOTE')
    expect(r.workplace.verdict).toBe('PASS')
    expect(r.workplace.evidence).toEqual([ev('STRUCTURED', 'remote', 'true', 'REMOTE_FLAG')])
    expect(run({ remote: false }).workplace.evidence).toEqual([
      ev('STRUCTURED', 'remote', 'false', 'REMOTE_FLAG_FALSE'),
    ])
  })

  it('no signal => UNKNOWN / WARN_UNKNOWN; a city alone is neither remote nor onsite', () => {
    const r = run({ location: 'Berlin' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.workplace.evidence).toEqual([])
  })

  it('conflicting remote flags (structured true vs title Onsite) => UNKNOWN + contradiction', () => {
    const r = run({ remote: true, title: 'Backend Developer (Onsite)' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
    expect(r.workplace.evidence).toEqual([
      ev('TITLE', 'title', 'Backend Developer (Onsite)', 'ONSITE_KEYWORD', false),
      ev('STRUCTURED', 'remote', 'true', 'REMOTE_FLAG', false),
      ev('POLICY', '', '', 'CONFLICTING_WORKPLACE_SIGNALS'),
    ])
  })

  it('remote=false against a Remote title is a conflict, not a rejection', () => {
    const r = run({ remote: false, title: 'Remote Backend Developer' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
  })

  it('remote=false alone does not prove onsite and is not a contradiction', () => {
    const r = run({ remote: false })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.flags).not.toContain('UNRESOLVED_CONTRADICTION')
  })

  it('remote=false agrees with an explicit hybrid / onsite signal of the SAME tier only', () => {
    const same = run({ remote: false, location: 'Hybrid' })
    expect(same.workplace.value).toBe('HYBRID')
    expect(same.flags).not.toContain('UNRESOLVED_CONTRADICTION')
    expect(run({ remote: false, tags: ['onsite'] }).workplace.value).toBe('ONSITE')
    // a body hybrid is a lower tier: the structured remote=false still decides, alone
    expect(run({ remote: false, descriptionMd: 'Hybrid role.' }).workplace.value).toBe('UNKNOWN')
    expect(run({ remote: false, location: 'Remote' }).workplace.value).toBe('UNKNOWN')
  })

  it('city + remote Europe: REMOTE, with a region limit that only warns', () => {
    const r = run({ location: 'Berlin, Germany (Remote - Europe)' })
    expect(r.workplace.value).toBe('REMOTE')
    expect(r.workplace.verdict).toBe('PASS')
    expect(r.geography.value).toEqual({ kind: 'REGION_LIMITED', regions: ['EUROPE'] })
    expect(r.geography.verdict).toBe('WARN_UNKNOWN')
  })

  it('a city alone neither restricts geography nor implies onsite', () => {
    const r = run({ location: 'Warsaw', remote: true })
    expect(r.workplace.value).toBe('REMOTE')
    expect(r.geography.value).toEqual({ kind: 'UNSTATED', regions: [] })
    expect(r.geography.verdict).toBe('PASS')
  })

  it('title, location and tags are workplace sources; employmentType and the hint are not', () => {
    expect(run({ title: 'Remote Dev' }).workplace.evidence).toEqual([
      ev('TITLE', 'title', 'Remote Dev', 'REMOTE_KEYWORD'),
    ])
    expect(run({ location: 'Remote' }).workplace.evidence[0]).toMatchObject({
      source: 'STRUCTURED',
      field: 'location',
    })
    expect(run({ tags: ['Remote'] }).workplace.evidence[0]).toMatchObject({
      source: 'STRUCTURED',
      field: 'tags',
    })
    expect(run({ employmentType: 'Remote', seniorityHint: 'Remote' }).workplace.value).toBe(
      'UNKNOWN',
    )
  })

  it('title/structured outrank the body; the overridden body signal stays on record, unused', () => {
    const r = run({ remote: true, descriptionMd: 'Our teams work on-site in Kyiv.' })
    expect(r.workplace.value).toBe('REMOTE')
    expect(r.workplace.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'Our teams work on-site in Kyiv.', 'ONSITE_KEYWORD', false),
      ev('STRUCTURED', 'remote', 'true', 'REMOTE_FLAG'),
    ])
  })

  it('the body decides when structured fields and the title are silent', () => {
    const r = body('This is a hybrid role.')
    expect(r.workplace.value).toBe('HYBRID')
    expect(r.workplace.verdict).toBe('REJECT')
  })

  it('a resolved workplace never raises the contradiction flag', () => {
    expect(run({ remote: true }).flags).not.toContain('UNRESOLVED_CONTRADICTION')
    expect(run({ location: 'Hybrid' }).flags).not.toContain('UNRESOLVED_CONTRADICTION')
    expect(run({ employmentType: 'full_time' }).flags).not.toContain('UNRESOLVED_CONTRADICTION')
  })
})

describe('layer1: sentences and excerpts', () => {
  it('markdown marks and extra whitespace are cleaned from the excerpt', () => {
    const r = body('## Remote  **role**\n* No agencies')
    expect(r.workplace.evidence[0]?.excerpt).toBe('Remote role')
    expect(r.agency.value).toBe('PROHIBITED')
  })

  it('an excerpt is the matched sentence only, cut at 160 characters', () => {
    expect(body('First one. Remote work.').workplace.evidence[0]?.excerpt).toBe('Remote work.')
    expect(body(`Remote ${'a'.repeat(300)}`).workplace.evidence[0]?.excerpt).toHaveLength(160)
    expect(body(`Remote ${'a'.repeat(153)}`).workplace.evidence[0]?.excerpt).toHaveLength(160)
    expect(body(`Remote ${'a'.repeat(152)}`).workplace.evidence[0]?.excerpt).toHaveLength(159)
  })

  it('blank lines produce no sentences', () => {
    expect(body('   \n  \n').workplace.evidence).toEqual([])
  })

  it('an underscore is read as a space: full_time is the phrase "full time"', () => {
    const r = run({ employmentType: 'full_time' })
    expect(r.schedule.value).toBe('FULL_TIME')
    expect(r.schedule.evidence[0]?.excerpt).toBe('full_time')
  })
})

describe('layer1: schedule', () => {
  it.each([
    ['Full-time', 'FULL_TIME'],
    ['Fulltime', 'FULL_TIME'],
    ['Повна зайнятість', 'FULL_TIME'],
    ['Повний робочий день', 'FULL_TIME'],
    ['Vollzeit', 'FULL_TIME'],
    ['Pełny etat', 'FULL_TIME'],
    ['Part-time', 'PART_TIME'],
    ['Parttime', 'PART_TIME'],
    ['Неповний робочий день', 'PART_TIME'],
    ['Парт-тайм', 'PART_TIME'],
    ['Teilzeit', 'PART_TIME'],
    ['Niepełny etat', 'PART_TIME'],
    ['Część etatu', 'PART_TIME'],
    ['Full-time or part-time', 'FLEXIBLE'],
    ['Flexible hours', 'UNKNOWN'],
  ])('%s => %s', (text, expected) => {
    expect(run({ employmentType: text }).schedule.value).toBe(expected)
  })

  it.each([
    ['FULL_TIME', 'PASS'],
    ['PART_TIME', 'REJECT'],
    ['FLEXIBLE', 'WARN_UNKNOWN'],
    ['UNKNOWN', 'WARN_UNKNOWN'],
  ])('verdict of %s is %s', (kind, verdict) => {
    const text = {
      FULL_TIME: 'Full-time',
      PART_TIME: 'Part-time',
      FLEXIBLE: 'Full-time or part-time',
      UNKNOWN: '',
    }
    expect(run({ employmentType: text[kind as keyof typeof text] }).schedule.verdict).toBe(verdict)
  })

  it.each([
    ['40 hours/week', 'FULL_TIME'],
    ['40 hour per week', 'FULL_TIME'],
    ['40 hrs a week', 'FULL_TIME'],
    ['40 hr/wk', 'FULL_TIME'],
    ['40 год в тиждень', 'FULL_TIME'],
    ['40 годин на тиждень', 'FULL_TIME'],
    ['40 hours per wk', 'FULL_TIME'],
    ['40hours per week', 'FULL_TIME'],
    ['35 hours per week', 'FULL_TIME'],
    ['34 hours per week', 'UNKNOWN'],
    ['31 hours per week', 'UNKNOWN'],
    ['30 hours per week', 'PART_TIME'],
    ['20 годин на тиж', 'PART_TIME'],
    ['8 hours per week', 'PART_TIME'],
    ['100 hours per week', 'UNKNOWN'],
  ])('hours: %s => %s', (text, expected) => {
    expect(body(text).schedule.value).toBe(expected)
    expect(body(text).schedule.evidence.map((e) => e.code)).toEqual(
      expected === 'UNKNOWN' ? [] : ['HOURS_PER_WEEK'],
    )
  })

  it('negated full-time / part-time is not a reading', () => {
    expect(body('This is not a part-time role.').schedule.value).toBe('UNKNOWN')
    expect(body('Not full-time.').schedule.value).toBe('UNKNOWN')
    expect(body('Part-time: no.').schedule.value).toBe('PART_TIME')
  })

  it('full-time vs part-time in different structured fields => contradiction with exact evidence', () => {
    const r = run({ employmentType: 'full_time', title: 'Part-time Dev' })
    expect(r.schedule.value).toBe('UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
    expect(r.schedule.evidence).toEqual([
      ev('TITLE', 'title', 'Part-time Dev', 'PART_TIME_KEYWORD', false),
      ev('STRUCTURED', 'employmentType', 'full_time', 'FULL_TIME_KEYWORD', false),
      ev('POLICY', '', '', 'CONFLICTING_SCHEDULE_SIGNALS'),
    ])
  })

  it('structured full-time outranks a body part-time sentence', () => {
    const r = run({ employmentType: 'Full-time', descriptionMd: 'Part-time options exist.' })
    expect(r.schedule.value).toBe('FULL_TIME')
  })

  it('FLEXIBLE evidence code, and each field is a source', () => {
    expect(run({ employmentType: 'Full-time or part-time' }).schedule.evidence[0]?.code).toBe(
      'FULL_OR_PART_TIME',
    )
    expect(run({ title: 'Part-time Dev' }).schedule.evidence[0]).toMatchObject({ field: 'title' })
    expect(run({ tags: ['Part-time'] }).schedule.value).toBe('PART_TIME')
    expect(run({ location: 'Part-time' }).schedule.value).toBe('UNKNOWN')
  })
})

describe('layer1: basis, duration', () => {
  it.each([
    ['B2B', 'B2B'],
    ['B-2-B', 'B2B'],
    ['ФОП', 'B2B'],
    ['JDG', 'B2B'],
    ['Sole proprietor', 'B2B'],
    ['Sole proprietorship', 'B2B'],
    ['Contractor', 'CONTRACTOR'],
    ['Freelancer', 'CONTRACTOR'],
    ['Freelance', 'CONTRACTOR'],
    ['Self-employed', 'CONTRACTOR'],
    ['1099', 'CONTRACTOR'],
    ['Договір підряду', 'CONTRACTOR'],
    ['Contract', 'CONTRACTOR'],
    ['Employment contract', 'EMPLOYEE'],
    ['Contract of employment', 'EMPLOYEE'],
    ['Permanent employment', 'EMPLOYEE'],
    ['Employee', 'EMPLOYEE'],
    ['W2', 'EMPLOYEE'],
    ['W-2', 'EMPLOYEE'],
    ['Трудовий договір', 'EMPLOYEE'],
    ['Umowa o pracę', 'EMPLOYEE'],
    ['Arbeitsvertrag', 'EMPLOYEE'],
    ['B2B or employment contract', 'EITHER'],
    ['Employee or contractor', 'EITHER'],
    ['B2B, contractor', 'B2B'],
    ['Employer', 'UNKNOWN'],
    ['Subcontracting', 'UNKNOWN'],
  ])('basis: %s => %s', (text, expected) => {
    expect(run({ employmentType: text }).basis.value).toBe(expected)
  })

  it.each(['B2B', 'Contractor', 'Employee'])('a negated "%s" is not a basis', (word) => {
    expect(body(`No ${word}.`).basis.value).toBe('UNKNOWN')
    expect(body(`Не ${word}.`).basis.value).toBe('UNKNOWN')
  })

  it('basis: verdicts, sources and evidence', () => {
    expect(run({ employmentType: 'B2B' }).basis.verdict).toBe('PASS')
    expect(run({}).basis).toMatchObject({ value: 'UNKNOWN', verdict: 'WARN_UNKNOWN', evidence: [] })
    expect(run({ title: 'B2B Dev' }).basis.value).toBe('B2B')
    expect(run({ tags: ['B2B'] }).basis.value).toBe('B2B')
    expect(run({ location: 'B2B' }).basis.value).toBe('UNKNOWN')
    expect(run({ employmentType: 'B2B' }).basis.evidence).toEqual([
      ev('STRUCTURED', 'employmentType', 'B2B', 'B2B_KEYWORD'),
    ])
    expect(run({ employmentType: 'W2' }).basis.evidence[0]?.code).toBe('EMPLOYMENT_KEYWORD')
    expect(run({ employmentType: 'Freelance' }).basis.evidence[0]?.code).toBe('CONTRACTOR_KEYWORD')
  })

  it('"employment contract" is EMPLOYEE only, with no contractor signal of its own', () => {
    expect(body('Employment contract.').basis.evidence.map((e) => e.code)).toEqual([
      'EMPLOYMENT_KEYWORD',
    ])
    // a real contractor mention elsewhere in the sentence still counts
    expect(body('Employment contract or contractor.').basis.value).toBe('EITHER')
  })

  it('only the deciding tier counts: structured Contract beats a body employment contract', () => {
    const r = run({ employmentType: 'Contract', descriptionMd: 'Employment contract.' })
    expect(r.basis.value).toBe('CONTRACTOR')
    expect(r.basis.evidence.map((e) => [e.code, e.used])).toEqual([
      ['CONTRACTOR_KEYWORD', true],
      ['EMPLOYMENT_KEYWORD', false],
    ])
    expect(body('Employment contract.').basis.value).toBe('EMPLOYEE')
  })

  it.each([
    ['Fixed-term', 'FIXED_TERM'],
    ['Temporary', 'FIXED_TERM'],
    ['Терміновий договір', 'FIXED_TERM'],
    ['Строковий договір', 'FIXED_TERM'],
    ['Befristet', 'FIXED_TERM'],
    ['12 month contract', 'FIXED_TERM'],
    ['6-month term', 'FIXED_TERM'],
    ['3 months engagement', 'FIXED_TERM'],
    ['2 month project', 'FIXED_TERM'],
    ['1 month contract', 'FIXED_TERM'],
    ['contract for 12 months', 'FIXED_TERM'],
    ['contract of 6 months', 'FIXED_TERM'],
    ['112 month contract', 'UNKNOWN'],
    ['6 months of experience', 'UNKNOWN'],
    ['Project-based', 'PROJECT'],
    ['Project basis', 'PROJECT'],
    ['One-off project', 'PROJECT'],
    ['Проєктна робота', 'PROJECT'],
    ['Проектная работа', 'PROJECT'],
    ['Permanent', 'PERMANENT'],
    ['Indefinite', 'PERMANENT'],
    ['Безстроково', 'PERMANENT'],
    ['Unbefristet', 'PERMANENT'],
    ['Permanent or fixed-term', 'UNKNOWN'],
  ])('duration: %s => %s', (text, expected) => {
    expect(run({ employmentType: text }).duration.value).toBe(expected)
  })

  it.each(['Fixed-term', 'Temporary', 'Project-based', 'Permanent'])(
    'a negated "%s" is not a duration',
    (word) => {
      expect(body(`Not ${word}.`).duration.value).toBe('UNKNOWN')
    },
  )

  it('duration never warns or rejects; evidence names the keyword', () => {
    expect(run({ employmentType: 'Fixed-term' }).duration).toMatchObject({
      value: 'FIXED_TERM',
      verdict: 'PASS',
    })
    expect(run({}).duration).toMatchObject({ value: 'UNKNOWN', verdict: 'PASS', evidence: [] })
    const conflict = run({ employmentType: 'Permanent or fixed-term' }).duration
    expect(conflict.verdict).toBe('PASS')
    expect(conflict.evidence.at(-1)).toEqual(ev('POLICY', '', '', 'CONFLICT'))
    expect(run({ title: 'Fixed-term Dev' }).duration.value).toBe('FIXED_TERM')
    expect(run({ tags: ['Fixed-term'] }).duration.value).toBe('FIXED_TERM')
    expect(
      ['Fixed-term', 'Project-based', 'Permanent'].map(
        (t) => run({ employmentType: t }).duration.evidence[0]?.code,
      ),
    ).toEqual(['FIXED_TERM_KEYWORD', 'PROJECT_KEYWORD', 'PERMANENT_KEYWORD'])
  })

  it('B2B full-time fixed-term together: nothing rejected', () => {
    const r = run({
      remote: true,
      title: 'Senior Developer',
      descriptionMd: 'B2B contract, full-time, 12-month contract.',
    })
    expect(r.basis.value).toBe('B2B')
    expect(r.schedule.value).toBe('FULL_TIME')
    expect(r.duration.value).toBe('FIXED_TERM')
    expect(r.rejectedBy).toEqual([])
  })
})

describe('layer1: agency acceptance', () => {
  it.each(['need not', 'should not', 'do not', "don't", 'please do not', 'not'])(
    '"Agencies %s contact us" is a prohibition',
    (p) => {
      expect(body(`Agencies ${p} contact us.`).agency.value).toBe('PROHIBITED')
      expect(body(`Recruiters ${p}`).agency.value).toBe('PROHIBITED')
    },
  )

  it.each(['No agencies', 'No agency', 'Without recruiters', 'No vendors', 'Not agencies'])(
    'negator before the noun: %s',
    (text) => {
      const r = body(text)
      expect(r.agency).toMatchObject({ value: 'PROHIBITED', verdict: 'REJECT' })
      expect(r.agency.evidence).toEqual([ev('BODY', 'descriptionMd', text, 'NO_AGENCY')])
    },
  )

  it('the negator is looked for four words back, not five', () => {
    expect(body('no a b c agencies').agency.value).toBe('PROHIBITED')
    expect(body('no a b c d agencies').agency.value).toBe('UNKNOWN')
    expect(body('No third party recruiters').agency.value).toBe('PROHIBITED')
  })

  it.each([
    'No third party',
    'Без посередників',
    'Без агенцій',
    'Без рекрутингових агенцій',
    'Без посредников',
  ])('prohibition phrase: %s', (text) => {
    expect(body(text).agency.value).toBe('PROHIBITED')
  })

  it.each([
    'Agencies welcome',
    'Agencies are accepted',
    'Recruiters encouraged',
    'Vendors are welcome',
    'Agency welcome',
    'Open to agencies',
    'Open to agency',
    'Open to recruitment agencies',
    'Open to recruitment agency',
    'We work with agency',
    'We work with agencies',
    'We work with recruitment agencies',
    'We work with staffing agencies',
    'We partner with agencies',
    'We partner with agency',
    'We partner with recruitment agencies',
    'We partner with staffing agencies',
  ])('acceptance: %s', (text) => {
    const r = body(text)
    expect(r.agency).toMatchObject({ value: 'ACCEPTED', verdict: 'PASS' })
    expect(r.agency.evidence[0]?.code).toBe('AGENCY_WELCOME')
  })

  it('anything else is unknown and warns; the statement is read from the body only', () => {
    expect(body('Acme is a recruitment agency.').agency).toMatchObject({
      value: 'UNKNOWN',
      verdict: 'WARN_UNKNOWN',
      evidence: [],
    })
    expect(body('Agencies are not welcome').agency.value).toBe('PROHIBITED')
    expect(run({ title: 'No agencies' }).agency.value).toBe('UNKNOWN')
    expect(run({ tags: ['No agencies'] }).agency.value).toBe('UNKNOWN')
    expect(body('No agencies.\nAgencies are welcome.').agency).toMatchObject({
      value: 'UNKNOWN',
      verdict: 'WARN_UNKNOWN',
    })
  })
})

describe('layer1: role family', () => {
  it.each([
    ['DevOps', 'DEVOPS'],
    ['SRE', 'DEVOPS'],
    ['Site Reliability Engineer', 'DEVOPS'],
    ['Platform Engineer', 'DEVOPS'],
    ['Infrastructure Engineer', 'DEVOPS'],
    ['Cloud Engineer', 'DEVOPS'],
    ['Data Scientist', 'DATA'],
    ['Data Engineer', 'DATA'],
    ['Data Analyst', 'DATA'],
    ['Machine Learning Engineer', 'DATA'],
    ['ML Engineer', 'DATA'],
    ['AI Engineer', 'DATA'],
    ['QA', 'QA'],
    ['Quality Assurance', 'QA'],
    ['SDET', 'QA'],
    ['Test Engineer', 'QA'],
    ['Tester', 'QA'],
    ['Designer', 'DESIGN'],
    ['UX', 'DESIGN'],
    ['UI', 'DESIGN'],
    ['Product Manager', 'PRODUCT'],
    ['Product Owner', 'PRODUCT'],
    ['Project Manager', 'PRODUCT'],
    ['Scrum Master', 'PRODUCT'],
    ['Delivery Manager', 'PRODUCT'],
    ['Developer', 'SOFTWARE'],
    ['Engineer', 'SOFTWARE'],
    ['Programmer', 'SOFTWARE'],
    ['Software', 'SOFTWARE'],
    ['Frontend', 'SOFTWARE'],
    ['Front-end', 'SOFTWARE'],
    ['Backend', 'SOFTWARE'],
    ['Back-end', 'SOFTWARE'],
    ['Fullstack', 'SOFTWARE'],
    ['Full-stack', 'SOFTWARE'],
    ['Розробник', 'SOFTWARE'],
    ['Програміст', 'SOFTWARE'],
    ['Разработчик', 'SOFTWARE'],
    ['Entwickler', 'SOFTWARE'],
    ['Recruiter', 'OTHER'],
    ['Sales', 'OTHER'],
    ['Marketing', 'OTHER'],
    ['Accountant', 'OTHER'],
    ['Support', 'OTHER'],
    ['HR', 'OTHER'],
    ['Legal', 'OTHER'],
    ['Wizard', 'UNKNOWN'],
    ['Quality', 'UNKNOWN'],
    ['Guidance', 'UNKNOWN'],
  ])('title %s => %s', (title, family) => {
    expect(run({ title }).roleFamily.value).toBe(family)
  })

  it('family order: QA beats design beats software for mixed titles', () => {
    expect(run({ title: 'QA Software Engineer' }).roleFamily.value).toBe('QA')
    expect(run({ title: 'UX Software Engineer' }).roleFamily.value).toBe('DESIGN')
    expect(run({ title: 'Platform Software Engineer' }).roleFamily.value).toBe('SOFTWARE')
  })

  it('title first; tags only when the title names no family; the body never', () => {
    expect(run({ title: 'Wizard', tags: ['QA'] }).roleFamily.evidence).toEqual([
      ev('STRUCTURED', 'tags', 'QA', 'FAMILY_QA'),
    ])
    expect(run({ title: 'Developer', tags: ['QA'] }).roleFamily.evidence).toEqual([
      ev('TITLE', 'title', 'Developer', 'FAMILY_SOFTWARE'),
    ])
    expect(run({ title: 'Developer' }).roleFamily.verdict).toBe('PASS')
    const none = run({ title: 'Wizard', descriptionMd: 'software engineer developer' })
    expect(none.roleFamily).toMatchObject({
      value: 'UNKNOWN',
      verdict: 'WARN_UNKNOWN',
      evidence: [],
    })
  })
})

describe('layer1: seniority and leadership', () => {
  it.each([
    ['Intern', 'INTERN'],
    ['Internship', 'INTERN'],
    ['Trainee', 'INTERN'],
    ['Стажер', 'INTERN'],
    ['Стажист', 'INTERN'],
    ['Junior', 'JUNIOR'],
    ['Jr.', 'JUNIOR'],
    ['Entry-level', 'JUNIOR'],
    ['Джуніор', 'JUNIOR'],
    ['Джуниор', 'JUNIOR'],
    ['Middle', 'MIDDLE'],
    ['Mid-level', 'MIDDLE'],
    ['Мідл', 'MIDDLE'],
    ['Миддл', 'MIDDLE'],
    ['Senior', 'SENIOR'],
    ['Sr.', 'SENIOR'],
    ['Сеніор', 'SENIOR'],
    ['Сеньор', 'SENIOR'],
    ['Синьор', 'SENIOR'],
    ['Staff Engineer', 'SENIOR'],
    ['Principal Engineer', 'SENIOR'],
    ['Distinguished Engineer', 'SENIOR'],
    ['Lead', 'LEAD'],
    ['Teamlead', 'LEAD'],
    ['Team Lead', 'LEAD'],
    ['Head of Platform', 'LEAD'],
    ['Engineering Manager', 'LEAD'],
    ['Development Manager', 'LEAD'],
    ['Тімлід', 'LEAD'],
    ['Тимлид', 'LEAD'],
    ['Тім лід', 'LEAD'],
    ['Тех лід', 'LEAD'],
    ['Director', 'EXECUTIVE'],
    ['VP', 'EXECUTIVE'],
    ['Vice President', 'EXECUTIVE'],
    ['CTO', 'EXECUTIVE'],
    ['Chief Architect', 'EXECUTIVE'],
    ['Директор', 'EXECUTIVE'],
    ['Techlead', 'UNKNOWN'],
    ['Internal', 'UNKNOWN'],
    ['Seniority', 'UNKNOWN'],
  ])('title "%s" => %s', (title, level) => {
    const r = run({ title }).seniority
    expect(r.value).toBe(level)
    expect(r.evidence.map((e) => e.field)).toEqual(level === 'UNKNOWN' ? [] : ['title'])
  })

  it.each([
    ['INTERN', 'REJECT'],
    ['JUNIOR', 'REJECT'],
    ['MIDDLE', 'PASS'],
    ['SENIOR', 'PASS'],
    ['LEAD', 'PASS'],
    ['EXECUTIVE', 'WARN_UNKNOWN'],
    ['UNKNOWN', 'WARN_UNKNOWN'],
  ])('verdict of %s is %s', (level, verdict) => {
    const title = {
      INTERN: 'Intern',
      JUNIOR: 'Junior',
      MIDDLE: 'Middle',
      SENIOR: 'Senior',
      LEAD: 'Lead',
      EXECUTIVE: 'Director',
      UNKNOWN: 'Dev',
    }[level]
    expect(run({ title }).seniority.verdict).toBe(verdict)
  })

  it('evidence codes per level family', () => {
    const codeOf = (title: string) => run({ title }).seniority.evidence.map((e) => e.code)
    expect(codeOf('Intern')).toEqual(['LEVEL_INTERN'])
    expect(codeOf('Junior')).toEqual(['LEVEL_JUNIOR'])
    expect(codeOf('Middle')).toEqual(['LEVEL_MIDDLE'])
    expect(codeOf('Senior')).toEqual(['LEVEL_SENIOR'])
    expect(codeOf('Staff')).toEqual(['LEVEL_STAFF_PRINCIPAL'])
    expect(codeOf('Lead')).toEqual(['LEVEL_LEAD'])
    expect(codeOf('CTO')).toEqual(['LEVEL_EXECUTIVE'])
  })

  it('the highest named level wins; the others stay on record, unused', () => {
    const mixed = run({ title: 'Junior Senior Lead' }).seniority
    expect(mixed.value).toBe('LEAD')
    expect(mixed.evidence.map((e) => [e.code, e.used])).toEqual([
      ['LEVEL_JUNIOR', false],
      ['LEVEL_SENIOR', false],
      ['LEVEL_LEAD', true],
    ])
    expect(run({ title: 'Junior/Middle Developer' }).seniority).toMatchObject({
      value: 'MIDDLE',
      verdict: 'PASS',
    })
  })

  it('the hint field is a level source; location and tags are not', () => {
    expect(run({ seniorityHint: 'Senior' }).seniority.evidence).toEqual([
      ev('STRUCTURED', 'seniorityHint', 'Senior', 'LEVEL_SENIOR'),
    ])
    expect(run({ location: 'Senior', tags: ['junior'] }).seniority.value).toBe('UNKNOWN')
  })

  it('a title level beats a body years statement', () => {
    expect(
      run({ title: 'Middle Developer', descriptionMd: '10 years of experience.' }).seniority.value,
    ).toBe('MIDDLE')
  })

  it.each([
    ['5+ years of experience', 'SENIOR', 'PASS'],
    ['5 years', 'SENIOR', 'PASS'],
    ['4 yrs', 'MIDDLE', 'PASS'],
    ['2 years', 'MIDDLE', 'PASS'],
    ['1 year', 'JUNIOR', 'WARN_UNKNOWN'],
    ['0 years', 'JUNIOR', 'WARN_UNKNOWN'],
    ['3 - 5 years', 'MIDDLE', 'PASS'],
    ['3+ years', 'MIDDLE', 'PASS'],
    ['10 yr', 'SENIOR', 'PASS'],
    ['5 роки', 'SENIOR', 'PASS'],
    ['5 років', 'SENIOR', 'PASS'],
    ['5 рік', 'SENIOR', 'PASS'],
    ['5 лет', 'SENIOR', 'PASS'],
    ['5 года', 'SENIOR', 'PASS'],
    ['5 Jahre', 'SENIOR', 'PASS'],
    ['5 lat', 'SENIOR', 'PASS'],
    ['5years', 'SENIOR', 'PASS'],
    ['5 yearsx', 'UNKNOWN', 'WARN_UNKNOWN'],
    ['1.5 years', 'UNKNOWN', 'WARN_UNKNOWN'],
    ['15 years', 'SENIOR', 'PASS'],
    ['no requirements', 'UNKNOWN', 'WARN_UNKNOWN'],
  ])('body "%s" => %s / %s', (text, level, verdict) => {
    const r = body(text).seniority
    expect([r.value, r.verdict]).toEqual([level, verdict])
  })

  it('body years: evidence, the largest figure wins, ties keep the first sentence', () => {
    expect(body('We need 3+ years in Go.\nMore text.').seniority.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'We need 3+ years in Go.', 'YEARS_3'),
    ])
    const two = body('1 year of Go. 6 years of Java.').seniority
    expect(two.evidence).toEqual([ev('BODY', 'descriptionMd', '6 years of Java.', 'YEARS_6')])
    expect(body('6 years of Java. 1 year of Go.').seniority.evidence[0]?.code).toBe('YEARS_6')
    const tie = body('4 years of Go.\n4 years of Java.').seniority
    expect(tie.evidence).toEqual([ev('BODY', 'descriptionMd', '4 years of Go.', 'YEARS_4')])
  })

  it('staff / principal => senior expertise with leadership UNKNOWN', () => {
    for (const title of [
      'Staff Software Engineer',
      'Principal Engineer',
      'Distinguished Engineer',
    ]) {
      const r = run({ title })
      expect(r.seniority).toMatchObject({ value: 'SENIOR', verdict: 'PASS' })
      expect(r.leadership.value).toBe('UNKNOWN')
    }
  })

  it('mentorship is neither leadership nor a level', () => {
    const r = run({
      title: 'Senior Developer',
      descriptionMd: 'We offer mentorship for juniors. You will mentor junior developers.',
    })
    expect(r.leadership.value).toBe('UNKNOWN')
    expect(r.seniority).toMatchObject({ value: 'SENIOR', verdict: 'PASS' })
  })

  it.each([
    'Lead',
    'Teamlead',
    'Head of QA',
    'Engineering Manager',
    'Development Manager',
    'Тімлід',
    'Тимлид',
    'Тім лід',
    'Тех лід',
  ])('leadership title "%s" leads people', (title) => {
    expect(run({ title }).leadership).toMatchObject({
      value: 'LEADS_PEOPLE',
      verdict: 'PASS',
      evidence: [ev('TITLE', 'title', title, 'LEAD_TITLE')],
    })
  })

  it('leadership from the seniority hint, or nothing', () => {
    expect(run({ title: 'Dev', seniorityHint: 'Team Lead' }).leadership.evidence).toEqual([
      ev('STRUCTURED', 'seniorityHint', 'Team Lead', 'LEAD_TITLE'),
    ])
    expect(run({}).leadership).toMatchObject({ value: 'UNKNOWN', verdict: 'PASS', evidence: [] })
  })

  it.each([
    ['People management.', 'LEADS_PEOPLE'],
    ['You manage a team of 5.', 'LEADS_PEOPLE'],
    ['You manage team of 5.', 'LEADS_PEOPLE'],
    ['One direct report.', 'LEADS_PEOPLE'],
    ['Several direct reports.', 'LEADS_PEOPLE'],
    ['Line management of engineers.', 'LEADS_PEOPLE'],
    ['Line managers wanted.', 'LEADS_PEOPLE'],
    ['Керувати командою.', 'LEADS_PEOPLE'],
    ['Управлять командой.', 'LEADS_PEOPLE'],
    ['An individual contributor role.', 'INDIVIDUAL_CONTRIBUTOR'],
    ['IC role.', 'INDIVIDUAL_CONTRIBUTOR'],
    ['Not a people manager.', 'UNKNOWN'],
  ])('leadership body "%s" => %s', (text, expected) => {
    const r = body(text).leadership
    expect(r.value).toBe(expected)
    expect(r.evidence.map((e) => e.code)).toEqual(
      expected === 'LEADS_PEOPLE' ? ['LEAD_BODY'] : expected === 'UNKNOWN' ? [] : ['IC_BODY'],
    )
  })

  it('body leadership: the first deciding sentence wins and is quoted', () => {
    const r = body('Intro.\nYou have direct reports.\nAn individual contributor role.').leadership
    expect(r.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'You have direct reports.', 'LEAD_BODY'),
    ])
  })
})

describe('layer1: geography and work authorization', () => {
  it.each([
    ['Europe', ['EUROPE']],
    ['EU', ['EUROPE']],
    ['EMEA', ['EUROPE']],
    ['Європа', ['EUROPE']],
    ['Європі', ['EUROPE']],
    ['Европа', ['EUROPE']],
    ['Европе', ['EUROPE']],
    ['USA', ['US']],
    ['US', ['US']],
    ['United States', ['US']],
    ['США', ['US']],
    ['UK', ['UK']],
    ['United Kingdom', ['UK']],
    ['Canada', ['CANADA']],
    ['LATAM', ['LATAM']],
    ['Latin America', ['LATAM']],
    ['APAC', ['APAC']],
  ])('remote region %s => %j', (region, regions) => {
    const r = run({ location: `Remote - ${region}` }).geography
    expect(r.value).toEqual({ kind: 'REGION_LIMITED', regions })
    expect(r.verdict).toBe('WARN_UNKNOWN')
    expect(r.evidence).toEqual([ev('STRUCTURED', 'location', `Remote - ${region}`, 'REGION_LIMIT')])
    expect(run({ location: `${region} only` }).geography.value.regions).toEqual(regions)
    expect(run({ location: `must be based in ${region}` }).geography.value.regions).toEqual(regions)
  })

  it.each([
    ['Remote (EU)'],
    ['Remote in the USA'],
    ['Remote within United States'],
    ['Remote from Canada'],
    ['Remote: UK'],
    ['Remote, UK'],
    ['Remote LATAM'],
    ['must be located in Canada'],
    ['must reside in the EU'],
    ['must live in the UK'],
  ])('region phrasing "%s" limits the region', (location) => {
    expect(run({ location }).geography.value.kind).toBe('REGION_LIMITED')
  })

  it('worldwide / negated / glued region words do not restrict', () => {
    expect(run({ location: 'Remote worldwide' }).geography.value.kind).toBe('UNSTATED')
    expect(run({ location: 'not remote us only' }).geography.value.kind).toBe('UNSTATED')
    expect(run({ location: 'Remote Europeans' }).geography.value.kind).toBe('UNSTATED')
    expect(run({ location: 'Remote Eurasia' }).geography.value.kind).toBe('UNSTATED')
    expect(run({}).geography).toMatchObject({
      value: { kind: 'UNSTATED', regions: [] },
      verdict: 'PASS',
      evidence: [],
    })
  })

  it('regions are sorted and de-duplicated across sources', () => {
    const r = run({ location: 'Remote US', descriptionMd: 'Remote EU. Remote US.' })
    expect(r.geography.value).toEqual({ kind: 'REGION_LIMITED', regions: ['EUROPE', 'US'] })
  })

  it.each(['authorized', 'authorised', 'eligible', 'legally entitled', 'legal right'])(
    '"%s to work in the US" requires work authorization',
    (verb) => {
      const r = body(`You are ${verb} to work in the US.`).geography
      expect(r.value).toEqual({ kind: 'WORK_AUTHORIZATION_REQUIRED', regions: ['US'] })
      expect(r.verdict).toBe('WARN_UNKNOWN')
      expect(r.evidence.map((e) => e.code)).toEqual(['WORK_AUTHORIZATION'])
    },
  )

  it('authorization names its region, with or without "the"', () => {
    expect(body('authorized to work in Canada').geography.value.regions).toEqual(['CANADA'])
    expect(body('eligible to work in the EU').geography.value.regions).toEqual(['EUROPE'])
    expect(body('authorized to work in UK').geography.value.regions).toEqual(['UK'])
    expect(body('authorized to work in Mars').geography.value.kind).toBe('UNSTATED')
  })

  it.each([
    ['US work authorization', ['US']],
    ['US work authorisation', ['US']],
    ['US citizen', ['US']],
    ['US citizens only', ['US']],
    ['US citizenship needed', ['US']],
    ['Дозвіл на роботу в США', ['US']],
    ['Разрешение на работу в США', ['US']],
    ['Arbeitserlaubnis nötig', []],
  ])('authorization phrase "%s"', (text, regions) => {
    expect(body(text).geography.value).toEqual({ kind: 'WORK_AUTHORIZATION_REQUIRED', regions })
  })

  it('a negated authorization requirement is not a requirement', () => {
    expect(body('No US work authorization required.').geography.value.kind).toBe('UNSTATED')
    expect(body('Not authorized to work in the US.').geography.value.kind).toBe('UNSTATED')
    expect(body('No citizen needed. US citizen').geography.value.kind).toBe(
      'WORK_AUTHORIZATION_REQUIRED',
    )
  })

  it('authorization never rejects and outranks a region limit', () => {
    const r = run({
      remote: true,
      location: 'Remote - Europe',
      descriptionMd: 'Candidates must be authorized to work in the US.',
    })
    expect(r.geography.value).toEqual({
      kind: 'WORK_AUTHORIZATION_REQUIRED',
      regions: ['EUROPE', 'US'],
    })
    expect(r.rejectedBy).not.toContain('geography')
  })
})

describe('layer1: salary floor', () => {
  const usd = (n: number) => ({ min: n, max: n, currency: 'USD', period: 'MONTH' as const })
  const eur = { min: 3000, max: 3000, currency: 'EUR', period: 'MONTH' as const }
  const rate = (usdPerUnit: number, currency = 'EUR') => ({
    currency,
    usdPerUnit,
    recordedAt: '2026-10-01T00:00:00Z',
  })

  it('floor constant is 3500', () => {
    expect(SALARY_FLOOR_USD_MONTHLY).toBe(3500)
  })

  it('3499 USD rejects, 3500 USD passes (boundary), with exact evidence', () => {
    expect(run({ salary: usd(3499) }).salary).toMatchObject({
      value: { state: 'BELOW_FLOOR', monthlyUsd: 3499 },
      verdict: 'REJECT',
      evidence: [ev('POLICY', '', '3499', 'BELOW_FLOOR')],
    })
    expect(run({ salary: usd(3500) }).salary).toMatchObject({
      value: { state: 'ABOVE_FLOOR', monthlyUsd: 3500 },
      verdict: 'PASS',
      evidence: [ev('POLICY', '', '3500', 'AT_OR_ABOVE_FLOOR')],
    })
    expect(run({ salary: usd(3501) }).salary.verdict).toBe('PASS')
  })

  it('a range is judged by its top: 3000-4000 passes, 3000-3499 rejects, min-only is its min', () => {
    const range = (min: number | null, max: number | null) => ({
      min,
      max,
      currency: 'USD',
      period: 'MONTH' as const,
    })
    expect(run({ salary: range(3000, 4000) }).salary.verdict).toBe('PASS')
    expect(run({ salary: range(3000, 3499) }).salary.verdict).toBe('REJECT')
    expect(run({ salary: range(4000, null) }).salary.verdict).toBe('PASS')
    expect(run({ salary: range(3000, null) }).salary.verdict).toBe('REJECT')
    expect(run({ salary: range(null, 4000) }).salary.verdict).toBe('PASS')
  })

  it('converts with the RECORDED rate and echoes it as evidence', () => {
    const lo = run({ salary: eur, fxRate: rate(1.1666) })
    expect(lo.salary.value).toEqual({ state: 'BELOW_FLOOR', monthlyUsd: 3499.8 })
    expect(lo.salary.verdict).toBe('REJECT')
    expect(lo.salary.evidence).toEqual([
      ev('POLICY', '', 'EUR->USD 1.1666 @ 2026-10-01T00:00:00Z', 'RECORDED_RATE'),
      ev('POLICY', '', '3499.8', 'BELOW_FLOOR'),
    ])
    expect(run({ salary: eur, fxRate: rate(7 / 6) }).salary.value.state).toBe('ABOVE_FLOOR')
  })

  it('a rate recorded for USD itself is not echoed', () => {
    expect(run({ salary: usd(4000), fxRate: rate(2, 'USD') }).salary.evidence).toEqual([
      ev('POLICY', '', '4000', 'AT_OR_ABOVE_FLOOR'),
    ])
  })

  it('currency codes compare case-insensitively on both the figure and the rate', () => {
    const state = (c: string, rc: string) =>
      run({ salary: { ...eur, min: 9000, max: 9000, currency: c }, fxRate: rate(1, rc) }).salary
        .value.state
    expect(state('eur', 'EUR')).toBe('ABOVE_FLOOR')
    expect(state('EUR', 'eur')).toBe('ABOVE_FLOOR')
    expect(run({ salary: { ...usd(4000), currency: 'usd' } }).salary.value.state).toBe(
      'ABOVE_FLOOR',
    )
  })

  it('yearly and hourly figures are normalised to monthly', () => {
    const at = (amount: number, period: 'YEAR' | 'HOUR') =>
      run({ salary: { min: amount, max: amount, currency: 'USD', period } }).salary
    expect(at(42000, 'YEAR')).toMatchObject({ verdict: 'PASS', value: { monthlyUsd: 3500 } })
    expect(at(41988, 'YEAR').verdict).toBe('REJECT')
    expect(at(22, 'HOUR').value.monthlyUsd).toBe(3520)
    expect(at(21, 'HOUR').verdict).toBe('REJECT')
  })

  it('no matching recorded rate: unconvertible, warns, flagged, not rejected', () => {
    const big = { ...eur, min: 9000, max: 9000 }
    for (const fxRate of [null, undefined, rate(0.25, 'PLN')]) {
      const r = run({ salary: big, ...(fxRate === undefined ? {} : { fxRate }) })
      expect(r.salary).toMatchObject({
        value: { state: 'UNCONVERTIBLE', monthlyUsd: null },
        verdict: 'WARN_UNKNOWN',
        evidence: [ev('POLICY', '', 'EUR', 'NO_RECORDED_RATE')],
      })
      expect(r.flags).toContain('SALARY_UNCONVERTIBLE')
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(run({ salary: big, fxRate: rate(bad) }).salary.value.state).toBe('UNCONVERTIBLE')
    }
  })

  it('no salary => PASS with an explicit salary-unknown flag; the floor is not applied', () => {
    const empty = { min: null, max: null, currency: 'USD', period: 'MONTH' as const }
    for (const salary of [undefined, null, empty]) {
      const r = run(salary === undefined ? {} : { salary })
      expect(r.salary).toMatchObject({
        value: { state: 'UNKNOWN', monthlyUsd: null },
        verdict: 'PASS',
        evidence: [ev('POLICY', '', '', 'SALARY_UNKNOWN')],
      })
      expect(r.flags).toContain('SALARY_UNKNOWN')
    }
    expect(run({ salary: usd(5000) }).flags).not.toContain('SALARY_UNKNOWN')
  })

  it('zero, negative, NaN and Infinity figures are "no figure"', () => {
    for (const top of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const salary = { min: null, max: top, currency: 'USD', period: 'MONTH' as const }
      expect(run({ salary }).salary.value).toEqual({ state: 'UNKNOWN', monthlyUsd: null })
    }
  })
})

describe('layer1: freshness is a rank, not a cutoff', () => {
  const fresh = (iso: string) => run({ dates: [ok('PUBLISHED', iso)] }).freshness.value

  it('buckets and ranks by the newest usable date', () => {
    expect(fresh('2026-10-20T12:00:00Z')).toEqual({ bucket: 'FRESH', ageDays: 0, rank: 1 })
    expect(fresh('2026-10-13T12:00:00Z')).toMatchObject({ bucket: 'FRESH', ageDays: 7 })
    expect(fresh('2026-10-12T12:00:00Z')).toMatchObject({ bucket: 'RECENT', ageDays: 8 })
    expect(fresh('2026-09-20T12:00:00Z')).toMatchObject({ bucket: 'RECENT', ageDays: 30 })
    expect(fresh('2026-09-19T12:00:00Z')).toMatchObject({ bucket: 'AGING', ageDays: 31 })
    expect(fresh('2026-07-22T12:00:00Z')).toMatchObject({ bucket: 'AGING', ageDays: 90 })
    expect(fresh('2026-07-21T12:00:00Z')).toMatchObject({ bucket: 'OLD', ageDays: 91 })
    expect(fresh('2026-10-10T12:00:00Z').rank).toBe(1 / 11)
    expect(fresh('2026-10-19T13:00:00Z').ageDays).toBe(0)
  })

  it('an old active vacancy is not rejected and not flagged (no 30-day cutoff)', () => {
    const r = run({ remote: true, dates: [ok('PUBLISHED', '2025-01-01T00:00:00Z')] })
    expect(r.freshness.verdict).toBe('PASS')
    expect(r.freshness.value.bucket).toBe('OLD')
    expect(r.rejectedBy).not.toContain('freshness')
    expect(r.flags).toEqual(['SALARY_UNKNOWN'])
  })

  it('the newest usable date wins whatever the order or semantics', () => {
    const a = run({
      dates: [ok('PUBLISHED', '2025-01-01T00:00:00Z'), ok('UPDATED', '2026-10-19T12:00:00Z')],
    })
    expect(a.freshness.value).toMatchObject({ bucket: 'FRESH', ageDays: 1 })
    const b = run({
      dates: [ok('PUBLISHED', '2026-10-19T12:00:00Z'), ok('UPDATED', '2026-10-01T12:00:00Z')],
    })
    expect(b.freshness.value.ageDays).toBe(1)
    const c = run({ dates: [ok('RELEASED', '2026-10-19T12:00:00Z')] })
    expect(c.freshness.evidence).toEqual([
      ev('STRUCTURED', 'date.RELEASED', '2026-10-19T12:00:00Z', 'DATED'),
    ])
  })

  it('no usable date => UNKNOWN bucket, rank 0, still PASS', () => {
    const r = run()
    expect(r.freshness.value).toEqual({ bucket: 'UNKNOWN', ageDays: null, rank: 0 })
    expect(r.freshness.verdict).toBe('PASS')
  })

  it('future and uncertain dates are ignored and flagged, never making a posting fresher', () => {
    const odd = (status: 'FUTURE' | 'INVALID' | 'MISSING_ZONE', raw: string): ObservedDate => ({
      semantics: 'UPDATED',
      contract: 'ISO_ZONED',
      raw,
      status,
      value: null,
    })
    const r = run({
      dates: [
        odd('FUTURE', 'r1'),
        odd('INVALID', 'r2'),
        odd('MISSING_ZONE', 'r3'),
        ok('EXPIRY', '2026-01-01T00:00:00Z'),
        ok('PUBLISHED', '2026-12-01T00:00:00Z'),
        ok('RELEASED', '2026-10-19T12:00:00Z'),
      ],
    })
    expect(r.freshness.evidence).toEqual([
      ev('STRUCTURED', 'date.UPDATED', 'r1', 'FUTURE_DATE', false),
      ev('STRUCTURED', 'date.UPDATED', 'r2', 'DATE_INVALID', false),
      ev('STRUCTURED', 'date.UPDATED', 'r3', 'DATE_MISSING_ZONE', false),
      ev('STRUCTURED', 'date.EXPIRY', '2026-01-01T00:00:00Z', 'EXPIRED'),
      ev('STRUCTURED', 'date.PUBLISHED', '2026-12-01T00:00:00Z', 'FUTURE_DATE', false),
      ev('STRUCTURED', 'date.RELEASED', '2026-10-19T12:00:00Z', 'DATED'),
    ])
    expect(r.flags).toEqual(['DATE_UNCERTAIN', 'FUTURE_DATE_IGNORED', 'SALARY_UNKNOWN'])
    expect(r.freshness.value.ageDays).toBe(1)
  })

  it('a valid instant more than 24h past evaluationTime is ignored; exactly 24h is tolerated', () => {
    expect(fresh('2026-10-21T12:00:00Z')).toMatchObject({ bucket: 'FRESH', ageDays: 0 })
    expect(fresh('2026-10-21T12:00:00.001Z').bucket).toBe('UNKNOWN')
    expect(run({ dates: [ok('PUBLISHED', '2026-10-22T00:00:00Z')] }).flags).toContain(
      'FUTURE_DATE_IGNORED',
    )
    expect(run({ dates: [ok('PUBLISHED', '2026-10-21T11:00:00Z')] }).flags).not.toContain(
      'FUTURE_DATE_IGNORED',
    )
  })

  it('a passed EXPIRY date is the source closing the posting => REJECT; a future one is not', () => {
    const exp = run({ dates: [ok('EXPIRY', '2026-10-20T12:00:00Z')] })
    expect(exp.freshness.verdict).toBe('REJECT')
    expect(exp.rejectedBy).toContain('freshness')
    const later = run({ dates: [ok('EXPIRY', '2026-10-20T12:00:00.001Z')] })
    expect(later.freshness.verdict).toBe('PASS')
    expect(later.freshness.evidence).toEqual([])
  })
})

describe('layer1: flags', () => {
  it('flags a truncated description from persisted evidence; flags are sorted and unique', () => {
    const r = run({
      evidence: [
        { field: 'description', kind: 'DISPLAY_TRUNCATED', detail: 'exceeds display limit' },
      ],
    })
    expect(r.flags).toEqual(['DESCRIPTION_TRUNCATED', 'SALARY_UNKNOWN'])
    expect(
      run({ evidence: [{ field: 'title', kind: 'DISPLAY_TRUNCATED', detail: 'x' }] }).flags,
    ).toEqual(['SALARY_UNKNOWN'])
    expect(
      run({ evidence: [{ field: 'description', kind: 'DATE_UNCERTAIN', detail: 'x' }] }).flags,
    ).toEqual(['SALARY_UNKNOWN'])
  })

  it('unresolved contradictions raise one flag whichever dimension they come from', () => {
    const both = run({
      remote: true,
      title: 'Onsite Part-time Dev',
      employmentType: 'Full-time',
    })
    expect(both.flags.filter((f) => f === 'UNRESOLVED_CONTRADICTION')).toHaveLength(1)
    const schedOnly = run({ employmentType: 'Full-time', title: 'Part-time Dev' })
    expect(schedOnly.flags).toContain('UNRESOLVED_CONTRADICTION')
  })
})

describe('layer1: a company saying what it is, not who may apply, is not an agency ban', () => {
  it.each([
    'We are not an agency',
    'Not a recruitment agency',
    "We aren't an agency",
    "This isn't a recruitment agency",
    'We are not an agency, we are a product company',
  ])('%s => no agency signal, nothing rejected', (text) => {
    const r = body(text)
    expect(r.agency).toMatchObject({ value: 'UNKNOWN', verdict: 'WARN_UNKNOWN', evidence: [] })
    expect(r.rejectedBy).not.toContain('agency')
  })

  it('a real ban next to such a sentence still rejects', () => {
    expect(body('We are not an agency. No agencies please.').agency.value).toBe('PROHIBITED')
    expect(body('We are not hiring through agencies').agency.value).toBe('PROHIBITED')
  })
})

describe('layer1: timezone mentions are evidence and a flag, never a verdict', () => {
  it.each([
    'utc',
    'gmt',
    'cest',
    'eet',
    'eest',
    'edt',
    'cdt',
    'pst',
    'pdt',
    'mdt',
    'msk',
    'time zone',
    'timezone',
  ])('"%s" is recorded without changing the geography verdict', (phrase) => {
    const text = `Core hours in ${phrase}`
    const r = body(text)
    expect(r.flags).toContain('TIMEZONE_MENTIONED')
    expect(r.geography.value).toEqual({ kind: 'UNSTATED', regions: [] })
    expect(r.geography.verdict).toBe('PASS')
    expect(r.geography.evidence).toEqual([ev('BODY', 'descriptionMd', text, 'TIMEZONE_MENTION')])
    expect(r.rejectedBy).toEqual([])
  })

  it.each(['CET', 'EST', 'CST', 'MST'])('the upper-case abbreviation %s is recorded', (abbr) => {
    const text = `Core hours in ${abbr}`
    expect(body(text).geography.evidence).toEqual([
      ev('BODY', 'descriptionMd', text, 'TIMEZONE_MENTION'),
    ])
    expect(body(text).flags).toContain('TIMEZONE_MENTIONED')
    expect(body(text).geography.verdict).toBe('PASS')
  })

  it.each([
    'Est. 2015',
    'Elle est ici, cet été',
    'est',
    'cet',
    'Core hours in est',
    'Cst and Mst are names',
  ])('"%s" is ordinary text, not a timezone', (text) => {
    expect(body(text).flags).not.toContain('TIMEZONE_MENTIONED')
    expect(body(text).geography.evidence).toEqual([])
  })

  it('an abbreviation inside a longer word or number is not a timezone', () => {
    expect(body('ESTONIA').flags).not.toContain('TIMEZONE_MENTIONED')
    expect(body('XCET').flags).not.toContain('TIMEZONE_MENTIONED')
    expect(body('CET1').flags).not.toContain('TIMEZONE_MENTIONED')
  })

  it.each([
    'UTC+2',
    'GMT-5',
    'Time zones: Europe',
    'Timezones: Europe',
    'Overlap with US hours',
    'Overlap of 1 hour',
    'overlap with CET hours',
  ])('%s is recorded', (text) => {
    expect(body(text).flags).toContain('TIMEZONE_MENTIONED')
  })

  it('other geography evidence raises no timezone flag', () => {
    const r = run({ location: 'Remote - Europe' })
    expect(r.geography.evidence).toHaveLength(1)
    expect(r.flags).not.toContain('TIMEZONE_MENTIONED')
  })

  it('reads a title and a structured location too', () => {
    expect(run({ title: 'Developer (UTC+2)' }).flags).toContain('TIMEZONE_MENTIONED')
    expect(run({ location: 'CET' }).geography.evidence).toEqual([
      ev('STRUCTURED', 'location', 'CET', 'TIMEZONE_MENTION'),
    ])
  })

  it.each([
    'Best team in town',
    'Overlap with the team',
    'Overlap with the team; hours vary',
    'Overlap with the team. Hours vary',
    'Overlap with our users hourly',
  ])('%s is not a timezone mention', (text) => {
    expect(body(text).flags).not.toContain('TIMEZONE_MENTIONED')
  })

  it('an overlap window further than 60 characters (the gap includes both spaces) from its hours is not read as one', () => {
    const far = `Overlap with ${'x'.repeat(59)} hours`
    expect(body(far).flags).not.toContain('TIMEZONE_MENTIONED')
    expect(body(`Overlap with ${'x'.repeat(58)} hours`).flags).toContain('TIMEZONE_MENTIONED')
  })
})

describe('layer1: mutation kills (boundaries, evidence codes, text normalisation)', () => {
  it('a hit that starts exactly where a hybrid span ends is not inside that span', () => {
    // "гібрид*" is a stem, so it ends where the digit starts; the 5-day office phrase is onsite. "at office" is no onsite phrase, so only the days entry speaks.
    const r = run({ location: 'гібрид5 days at office' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
  })

  it('a clause that begins at the very start of the text still scopes negation to itself', () => {
    const r = run({ location: ', not remote' })
    expect(r.workplace.evidence).toEqual([
      ev('STRUCTURED', 'location', ', not remote', 'NEGATED_REMOTE'),
    ])
  })

  it('markdown marks are replaced by a space, not deleted', () => {
    const r = body('work*from*home')
    expect(r.workplace.value).toBe('REMOTE')
    expect(r.workplace.evidence[0]?.excerpt).toBe('work from home')
  })

  it('names the evidence code of each workplace signal', () => {
    expect(run({ location: 'Hybrid' }).workplace.evidence).toEqual([
      ev('STRUCTURED', 'location', 'Hybrid', 'HYBRID_KEYWORD'),
    ])
    expect(run({ location: 'Not remote' }).workplace.evidence).toEqual([
      ev('STRUCTURED', 'location', 'Not remote', 'NEGATED_REMOTE'),
    ])
  })

  it('a negated remote beside an onsite signal does not turn into a conflict', () => {
    expect(run({ location: 'Onsite, not remote' }).workplace.value).toBe('ONSITE')
  })

  it('a schedule conflict leaves the value UNKNOWN, with the contradiction recorded', () => {
    const r = run({ employmentType: 'Full-time', title: 'Part-time Dev' })
    expect(r.schedule.value).toBe('UNKNOWN')
    expect(r.schedule.verdict).toBe('WARN_UNKNOWN')
    expect(r.schedule.evidence.at(-1)).toEqual(ev('POLICY', '', '', 'CONFLICTING_SCHEDULE_SIGNALS'))
  })

  it('a stem phrase needs its whole stem: a shorter prefix is not a match', () => {
    expect(run({ employmentType: 'неповага' }).schedule.value).toBe('UNKNOWN')
    expect(run({ employmentType: 'неповний день' }).schedule.value).toBe('PART_TIME')
  })

  it('"are" is dropped only when it directly follows the agency noun', () => {
    expect(body('Agencies are not welcome').agency.value).toBe('PROHIBITED')
    expect(body('Agencies do are not hiring').agency.value).toBe('UNKNOWN')
  })

  it('an acceptance word counts only right after the agency noun, not at the end of the clause', () => {
    expect(body('Agencies welcome').agency.value).toBe('ACCEPTED')
    expect(body('Agencies, contact recruiting welcome').agency.value).toBe('UNKNOWN')
  })

  it('names the leadership value and code for a body that states an individual contributor role', () => {
    const r = body('This is an individual contributor role')
    expect(r.leadership.value).toBe('INDIVIDUAL_CONTRIBUTOR')
    expect(r.leadership.evidence[0]?.code).toBe('IC_BODY')
    expect(r.leadership.verdict).toBe('PASS')
    const leads = body('You will have direct reports').leadership
    expect(leads.value).toBe('LEADS_PEOPLE')
    expect(leads.verdict).toBe('PASS')
  })

  it('a work-authorization phrase that carries its own region is recorded as such', () => {
    const r = body('US citizens only')
    expect(r.geography.value).toEqual({ kind: 'WORK_AUTHORIZATION_REQUIRED', regions: ['US'] })
    expect(r.geography.evidence.map((e) => e.code)).toContain('WORK_AUTHORIZATION')
  })

  it('a rate that is not finite is as unusable as a missing one', () => {
    const r = run({
      salary: { min: 100, max: 100, currency: 'EUR', period: 'MONTH' },
      fxRate: { currency: 'EUR', usdPerUnit: Number.POSITIVE_INFINITY, recordedAt: '2026-10-01' },
    })
    expect(r.salary.value).toEqual({ state: 'UNCONVERTIBLE', monthlyUsd: null })
    expect(r.flags).toContain('SALARY_UNCONVERTIBLE')
  })

  it('raises no salary flag when the salary is usable', () => {
    const r = run({ salary: { min: 5000, max: 5000, currency: 'USD', period: 'MONTH' } })
    expect(r.flags).toEqual([])
  })

  it('flags truncation when ANY evidence item is the truncated description', () => {
    const r = run({
      evidence: [
        { field: 'description', kind: 'DISPLAY_TRUNCATED', detail: 'x' },
        { field: 'title', kind: 'DISPLAY_TRUNCATED', detail: 'y' },
      ],
    })
    expect(r.flags).toContain('DESCRIPTION_TRUNCATED')
  })
})
