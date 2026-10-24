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

  it('refuses a rule version it does not implement', () => {
    expect(() =>
      classifyLayer1(base, { ruleVersion: 'l0.0' as never, evaluationTime: NOW }),
    ).toThrow(UnsupportedRuleVersionError)
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
    expect(warn.unknown).toContain('workplace')
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

describe('layer1: workplace', () => {
  it('structured remote flag => REMOTE / PASS', () => {
    const r = run({ remote: true })
    expect(r.workplace.value).toBe('REMOTE')
    expect(r.workplace.verdict).toBe('PASS')
    expect(r.workplace.evidence[0]).toMatchObject({
      source: 'STRUCTURED',
      field: 'remote',
      used: true,
    })
  })

  it('no signal => UNKNOWN / WARN_UNKNOWN, not a rejection', () => {
    const r = run({ location: 'Berlin' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
  })

  it('conflicting remote flags (structured true vs title Onsite) => UNKNOWN + contradiction flag', () => {
    const r = run({ remote: true, title: 'Backend Developer (Onsite)' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
    expect(
      r.workplace.evidence.every((e) => e.code === 'CONFLICTING_WORKPLACE_SIGNALS' || !e.used),
    ).toBe(true)
  })

  it('remote=false against a Remote title is a conflict, not a rejection', () => {
    const r = run({ remote: false, title: 'Remote Backend Developer' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
  })

  it('remote=false alone does not prove onsite', () => {
    const r = run({ remote: false })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
    expect(r.flags).not.toContain('UNRESOLVED_CONTRADICTION')
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

  it.each([
    ['Hybrid - Berlin', 'HYBRID'],
    ['On-site, Kyiv', 'ONSITE'],
    ['3 days per week in the office', 'HYBRID'],
    ['5 days a week in the office', 'ONSITE'],
    ['Гібридний формат', 'HYBRID'],
    ['Робота в офісі', 'ONSITE'],
  ])('strong explicit %s => %s / REJECT', (location, expected) => {
    const r = run({ location })
    expect(r.workplace.value).toBe(expected)
    expect(r.workplace.verdict).toBe('REJECT')
  })

  it.each([['Віддалена робота'], ['Удалённо'], ['Zdalnie'], ['Fully remote'], ['Work from home']])(
    'localized remote "%s" => REMOTE',
    (location) => {
      expect(run({ location }).workplace.value).toBe('REMOTE')
    },
  )

  it('negated requirements are not positives: "no onsite", "not hybrid", "не гібрид"', () => {
    for (const body of [
      'This is a remote role. No onsite presence is required.',
      'Remote role, not hybrid.',
      'Віддалена робота, не гібрид.',
    ]) {
      const r = run({ descriptionMd: body })
      expect(r.workplace.value).toBe('REMOTE')
      expect(r.workplace.verdict).toBe('PASS')
    }
  })

  it('"not remote" alone yields UNKNOWN (cannot tell hybrid from onsite), never REMOTE', () => {
    const r = run({ descriptionMd: 'This position is not remote.' })
    expect(r.workplace.value).toBe('UNKNOWN')
    expect(r.workplace.verdict).toBe('WARN_UNKNOWN')
  })

  it('occasional onsite meetups and onsite interviews do not make a remote role onsite', () => {
    const r = run({
      remote: true,
      descriptionMd: 'Occasional onsite team meetups. Final stage is an onsite interview in Lviv.',
    })
    expect(r.workplace.value).toBe('REMOTE')
  })

  it('title/structured outrank the body; the overridden body signal stays on record unused', () => {
    const r = run({ remote: true, descriptionMd: 'Our teams work on-site in Kyiv.' })
    expect(r.workplace.value).toBe('REMOTE')
    const body = r.workplace.evidence.find((e) => e.source === 'BODY')
    expect(body).toMatchObject({ code: 'ONSITE_KEYWORD', used: false })
  })

  it('body decides when structured and title are silent', () => {
    const r = run({ descriptionMd: 'This is a hybrid role.' })
    expect(r.workplace.value).toBe('HYBRID')
    expect(r.workplace.verdict).toBe('REJECT')
  })

  it('"partially remote" is hybrid, not remote', () => {
    const r = run({ descriptionMd: 'Partially remote.' })
    expect(r.workplace.value).toBe('HYBRID')
  })
})

describe('layer1: US authorization and geography', () => {
  it('US work authorization => WORK_AUTHORIZATION_REQUIRED, warns, never rejects', () => {
    const r = run({
      remote: true,
      descriptionMd: 'Candidates must be authorized to work in the US.',
    })
    expect(r.geography.value).toEqual({ kind: 'WORK_AUTHORIZATION_REQUIRED', regions: ['US'] })
    expect(r.geography.verdict).toBe('WARN_UNKNOWN')
    expect(r.rejectedBy).not.toContain('geography')
  })

  it('negated authorization requirement is not a requirement', () => {
    const r = run({ descriptionMd: 'No US work authorization required.' })
    expect(r.geography.value.kind).toBe('UNSTATED')
  })
})

describe('layer1: basis / schedule / duration', () => {
  it('B2B, full-time, fixed-term together: nothing rejected', () => {
    const r = run({
      remote: true,
      title: 'Senior Developer',
      descriptionMd: 'B2B contract, full-time, 12-month contract.',
    })
    expect(r.basis.value).toBe('B2B')
    expect(r.basis.verdict).toBe('PASS')
    expect(r.schedule.value).toBe('FULL_TIME')
    expect(r.duration.value).toBe('FIXED_TERM')
    expect(r.rejectedBy).toEqual([])
  })

  it('"employment contract" is EMPLOYEE, not CONTRACTOR', () => {
    expect(run({ descriptionMd: 'Employment contract.' }).basis.value).toBe('EMPLOYEE')
  })

  it('structured contract type => CONTRACTOR; B2B or employment => EITHER', () => {
    expect(run({ employmentType: 'Contract' }).basis.value).toBe('CONTRACTOR')
    expect(run({ descriptionMd: 'B2B or employment contract.' }).basis.value).toBe('EITHER')
  })

  it('unknown basis warns; permanent is a duration', () => {
    const r = run({ employmentType: 'Permanent' })
    expect(r.basis.value).toBe('UNKNOWN')
    expect(r.basis.verdict).toBe('WARN_UNKNOWN')
    expect(r.duration.value).toBe('PERMANENT')
  })

  it('project-based work is a PROJECT duration', () => {
    expect(run({ descriptionMd: 'Project-based engagement.' }).duration.value).toBe('PROJECT')
  })

  it('"6 months of experience" is not a fixed-term contract', () => {
    expect(run({ descriptionMd: '6 months of experience with Go.' }).duration.value).toBe('UNKNOWN')
  })

  it('part-time (structured, localized, hours) => REJECT', () => {
    expect(run({ employmentType: 'part_time' }).schedule).toMatchObject({
      value: 'PART_TIME',
      verdict: 'REJECT',
    })
    expect(run({ descriptionMd: 'Неповний робочий день.' }).schedule.value).toBe('PART_TIME')
    expect(run({ descriptionMd: '20 hours per week.' }).schedule.value).toBe('PART_TIME')
    expect(run({ descriptionMd: '40 hours per week.' }).schedule.value).toBe('FULL_TIME')
    expect(run({ descriptionMd: '32 hours per week.' }).schedule.value).toBe('UNKNOWN')
  })

  it('"full-time or part-time" is FLEXIBLE and warns; "not part-time" is not part-time', () => {
    expect(run({ descriptionMd: 'Full-time or part-time.' }).schedule).toMatchObject({
      value: 'FLEXIBLE',
      verdict: 'WARN_UNKNOWN',
    })
    expect(run({ descriptionMd: 'This is not a part-time role.' }).schedule.value).toBe('UNKNOWN')
  })

  it('full-time vs part-time in different structured fields => contradiction', () => {
    const r = run({ employmentType: 'full_time', title: 'Part-time Developer' })
    expect(r.schedule.value).toBe('UNKNOWN')
    expect(r.flags).toContain('UNRESOLVED_CONTRADICTION')
  })

  it('structured full-time outranks a body part-time sentence', () => {
    const r = run({ employmentType: 'Full-time', descriptionMd: 'Part-time options exist.' })
    expect(r.schedule.value).toBe('FULL_TIME')
  })
})

describe('layer1: agency acceptance', () => {
  it.each([
    'No agencies please.',
    'We do not accept recruitment agencies. Agencies should not contact us.',
    'No third-party recruiters.',
    'Без посередників.',
  ])('prohibits: %s', (body) => {
    const r = run({ descriptionMd: body })
    expect(r.agency.value).toBe('PROHIBITED')
    expect(r.agency.verdict).toBe('REJECT')
  })

  it('accepts when agencies are welcome; unknown otherwise warns', () => {
    expect(run({ descriptionMd: 'Agencies are welcome.' }).agency).toMatchObject({
      value: 'ACCEPTED',
      verdict: 'PASS',
    })
    expect(run({ descriptionMd: 'Acme is a recruitment agency.' }).agency).toMatchObject({
      value: 'UNKNOWN',
      verdict: 'WARN_UNKNOWN',
    })
  })
})

describe('layer1: seniority, leadership, role family', () => {
  it.each([
    ['Intern Developer', 'INTERN', 'REJECT'],
    ['Junior Developer', 'JUNIOR', 'REJECT'],
    ['Middle Developer', 'MIDDLE', 'PASS'],
    ['Senior Developer', 'SENIOR', 'PASS'],
    ['Team Lead, Backend', 'LEAD', 'PASS'],
    ['Director of Engineering', 'EXECUTIVE', 'WARN_UNKNOWN'],
    ['Мідл розробник', 'MIDDLE', 'PASS'],
    ['Тімлід Node.js', 'LEAD', 'PASS'],
  ])('title "%s" => %s / %s', (title, value, verdict) => {
    const r = run({ title })
    expect(r.seniority.value).toBe(value)
    expect(r.seniority.verdict).toBe(verdict)
  })

  it('the highest level named wins ("Junior/Middle" is in range)', () => {
    expect(run({ title: 'Junior/Middle Developer' }).seniority).toMatchObject({
      value: 'MIDDLE',
      verdict: 'PASS',
    })
  })

  it('staff / principal => senior expertise with leadership UNKNOWN', () => {
    for (const title of ['Staff Software Engineer', 'Principal Engineer']) {
      const r = run({ title })
      expect(r.seniority.value).toBe('SENIOR')
      expect(r.seniority.verdict).toBe('PASS')
      expect(r.leadership.value).toBe('UNKNOWN')
    }
  })

  it('leadership comes from lead titles or explicit people management, not from staff', () => {
    expect(run({ title: 'Tech Lead' }).leadership.value).toBe('LEADS_PEOPLE')
    expect(run({ descriptionMd: 'You will manage a team of 6.' }).leadership.value).toBe(
      'LEADS_PEOPLE',
    )
    expect(run({ descriptionMd: 'An individual contributor role.' }).leadership.value).toBe(
      'INDIVIDUAL_CONTRIBUTOR',
    )
  })

  it('mentorship is neither leadership nor a level', () => {
    const r = run({
      title: 'Senior Developer',
      descriptionMd: 'We offer mentorship for juniors. You will mentor junior developers.',
    })
    expect(r.leadership.value).toBe('UNKNOWN')
    expect(r.seniority.value).toBe('SENIOR')
    expect(r.seniority.verdict).toBe('PASS')
  })

  it('a title level beats a body years statement; body years are used only without a hint', () => {
    expect(
      run({ title: 'Middle Developer', descriptionMd: '10 years of experience.' }).seniority.value,
    ).toBe('MIDDLE')
    expect(run({ seniorityHint: 'Senior' }).seniority.value).toBe('SENIOR')
    const body = (text: string) => run({ descriptionMd: text }).seniority
    expect(body('5+ years of experience')).toMatchObject({ value: 'SENIOR', verdict: 'PASS' })
    expect(body('2-4 years of experience')).toMatchObject({ value: 'MIDDLE', verdict: 'PASS' })
    expect(body('1 year of experience')).toMatchObject({ value: 'JUNIOR', verdict: 'WARN_UNKNOWN' })
    expect(body('no requirements')).toMatchObject({ value: 'UNKNOWN', verdict: 'WARN_UNKNOWN' })
    expect(body('4 років досвіду').value).toBe('MIDDLE')
  })

  it('role family: title first, tags as fallback, body never', () => {
    expect(run({ title: 'DevOps Engineer' }).roleFamily.value).toBe('DEVOPS')
    expect(run({ title: 'Data Engineer' }).roleFamily.value).toBe('DATA')
    expect(run({ title: 'QA Engineer' }).roleFamily.value).toBe('QA')
    expect(run({ title: 'UX Designer' }).roleFamily.value).toBe('DESIGN')
    expect(run({ title: 'Product Manager' }).roleFamily.value).toBe('PRODUCT')
    expect(run({ title: 'React Developer' }).roleFamily.value).toBe('SOFTWARE')
    expect(run({ title: 'Recruiter' }).roleFamily.value).toBe('OTHER')
    expect(run({ title: 'Wizard', tags: ['QA'] }).roleFamily.value).toBe('QA')
    const none = run({ title: 'Wizard', descriptionMd: 'software engineer developer' })
    expect(none.roleFamily).toMatchObject({ value: 'UNKNOWN', verdict: 'WARN_UNKNOWN' })
  })
})

describe('layer1: salary floor', () => {
  const usd = (n: number) => ({ min: n, max: n, currency: 'USD', period: 'MONTH' as const })

  it('floor constant is 3500', () => {
    expect(SALARY_FLOOR_USD_MONTHLY).toBe(3500)
  })

  it('3499 USD rejects, 3500 USD passes (boundary)', () => {
    expect(run({ salary: usd(3499) }).salary).toMatchObject({
      value: { state: 'BELOW_FLOOR', monthlyUsd: 3499 },
      verdict: 'REJECT',
    })
    expect(run({ salary: usd(3500) }).salary).toMatchObject({
      value: { state: 'ABOVE_FLOOR', monthlyUsd: 3500 },
      verdict: 'PASS',
    })
  })

  it('a range is judged by its top: 3000-4000 passes, 3000-3499 rejects', () => {
    const range = (min: number, max: number) => ({
      min,
      max,
      currency: 'USD',
      period: 'MONTH' as const,
    })
    expect(run({ salary: range(3000, 4000) }).salary.verdict).toBe('PASS')
    expect(run({ salary: range(3000, 3499) }).salary.verdict).toBe('REJECT')
    expect(run({ salary: { ...range(0, 0), min: 4000, max: null } }).salary.verdict).toBe('PASS')
  })

  it('converts with the RECORDED rate, and echoes it as evidence', () => {
    const eur = { min: 3000, max: 3000, currency: 'EUR', period: 'MONTH' as const }
    const at = (usdPerUnit: number) => ({
      currency: 'EUR',
      usdPerUnit,
      recordedAt: '2026-10-01T00:00:00Z',
    })
    const lo = run({ salary: eur, fxRate: at(1.1666) })
    expect(lo.salary.value).toEqual({ state: 'BELOW_FLOOR', monthlyUsd: 3499.8 })
    expect(lo.salary.verdict).toBe('REJECT')
    const hi = run({ salary: eur, fxRate: at(7 / 6) })
    expect(hi.salary.value.state).toBe('ABOVE_FLOOR')
    expect(
      lo.salary.evidence.some((e) => e.code === 'RECORDED_RATE' && e.excerpt.includes('1.1666')),
    ).toBe(true)
  })

  it('yearly and hourly figures are normalised to monthly', () => {
    expect(
      run({ salary: { min: 42000, max: 42000, currency: 'USD', period: 'YEAR' } }).salary.verdict,
    ).toBe('PASS')
    expect(
      run({ salary: { min: 41988, max: 41988, currency: 'USD', period: 'YEAR' } }).salary.verdict,
    ).toBe('REJECT')
    expect(
      run({ salary: { min: 22, max: 22, currency: 'USD', period: 'HOUR' } }).salary.value
        .monthlyUsd,
    ).toBe(3520)
  })

  it('a non-USD figure with no matching recorded rate is unconvertible: warns, flagged, not rejected', () => {
    const eur = { min: 9000, max: 9000, currency: 'EUR', period: 'MONTH' as const }
    for (const fxRate of [
      null,
      undefined,
      { currency: 'PLN', usdPerUnit: 0.25, recordedAt: 'x' },
    ]) {
      const r = run({ salary: eur, ...(fxRate === undefined ? {} : { fxRate }) })
      expect(r.salary).toMatchObject({
        value: { state: 'UNCONVERTIBLE', monthlyUsd: null },
        verdict: 'WARN_UNKNOWN',
      })
      expect(r.flags).toContain('SALARY_UNCONVERTIBLE')
    }
  })

  it('no salary => PASS with an explicit salary-unknown flag; floor not applied', () => {
    for (const salary of [
      undefined,
      null,
      { min: null, max: null, currency: 'USD', period: 'MONTH' as const },
    ]) {
      const r = run(salary === undefined ? {} : { salary })
      expect(r.salary).toMatchObject({
        value: { state: 'UNKNOWN', monthlyUsd: null },
        verdict: 'PASS',
      })
      expect(r.flags).toContain('SALARY_UNKNOWN')
    }
    expect(run({ salary: usd(5000) }).flags).not.toContain('SALARY_UNKNOWN')
  })
})

describe('layer1: freshness is a rank, not a cutoff', () => {
  it('buckets and ranks by the newest usable date', () => {
    const at = (iso: string) => run({ dates: [ok('PUBLISHED', iso)] }).freshness.value
    expect(at('2026-10-20T12:00:00Z')).toEqual({ bucket: 'FRESH', ageDays: 0, rank: 1 })
    expect(at('2026-10-13T12:00:00Z')).toMatchObject({ bucket: 'FRESH', ageDays: 7 })
    expect(at('2026-10-12T12:00:00Z')).toMatchObject({ bucket: 'RECENT', ageDays: 8 })
    expect(at('2026-09-20T12:00:00Z')).toMatchObject({ bucket: 'RECENT', ageDays: 30 })
    expect(at('2026-09-19T12:00:00Z')).toMatchObject({ bucket: 'AGING', ageDays: 31 })
    expect(at('2026-07-22T12:00:00Z')).toMatchObject({ bucket: 'AGING', ageDays: 90 })
    expect(at('2026-07-21T12:00:00Z')).toMatchObject({ bucket: 'OLD', ageDays: 91 })
    expect(at('2026-10-10T12:00:00Z').rank).toBe(1 / 11)
  })

  it('an old active vacancy is not rejected and not flagged (no 30-day cutoff)', () => {
    const r = run({ remote: true, dates: [ok('PUBLISHED', '2025-01-01T00:00:00Z')] })
    expect(r.freshness.verdict).toBe('PASS')
    expect(r.freshness.value.bucket).toBe('OLD')
    expect(r.rejectedBy).not.toContain('freshness')
  })

  it('an UPDATED date refreshes an old PUBLISHED date', () => {
    const r = run({
      dates: [ok('PUBLISHED', '2025-01-01T00:00:00Z'), ok('UPDATED', '2026-10-19T12:00:00Z')],
    })
    expect(r.freshness.value).toMatchObject({ bucket: 'FRESH', ageDays: 1 })
  })

  it('no usable date => UNKNOWN bucket, rank 0, still PASS', () => {
    const r = run()
    expect(r.freshness.value).toEqual({ bucket: 'UNKNOWN', ageDays: null, rank: 0 })
    expect(r.freshness.verdict).toBe('PASS')
  })

  it('future dates are ignored with a flag and never make the posting fresher', () => {
    const future: ObservedDate = {
      semantics: 'PUBLISHED',
      contract: 'ISO_ZONED',
      raw: '2027-01-01T00:00:00Z',
      status: 'FUTURE',
      value: null,
    }
    const r = run({ dates: [future, ok('PUBLISHED', '2026-09-01T00:00:00Z')] })
    expect(r.flags).toContain('FUTURE_DATE_IGNORED')
    expect(r.freshness.value.ageDays).toBe(49)
    // A valid instant past evaluationTime + 24h is ignored too; within tolerance it clamps to 0.
    const late = run({ dates: [ok('PUBLISHED', '2026-10-22T00:00:00Z')] })
    expect(late.freshness.value.bucket).toBe('UNKNOWN')
    expect(late.flags).toContain('FUTURE_DATE_IGNORED')
    const skew = run({ dates: [ok('PUBLISHED', '2026-10-21T11:00:00Z')] })
    expect(skew.freshness.value).toMatchObject({ bucket: 'FRESH', ageDays: 0 })
    expect(skew.flags).not.toContain('FUTURE_DATE_IGNORED')
  })

  it('uncertain dates are flagged, not used', () => {
    const bad: ObservedDate = {
      semantics: 'PUBLISHED',
      contract: 'ISO_ZONED',
      raw: '2026-10-01T10:00:00',
      status: 'MISSING_ZONE',
      value: null,
    }
    const r = run({ dates: [bad] })
    expect(r.flags).toContain('DATE_UNCERTAIN')
    expect(r.freshness.value.bucket).toBe('UNKNOWN')
  })

  it('a passed EXPIRY date is the source closing the posting => REJECT; a future one is not', () => {
    const exp = run({ dates: [ok('EXPIRY', '2026-10-20T12:00:00Z')] })
    expect(exp.freshness.verdict).toBe('REJECT')
    expect(exp.rejectedBy).toContain('freshness')
    expect(run({ dates: [ok('EXPIRY', '2026-10-21T00:00:00Z')] }).freshness.verdict).toBe('PASS')
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
    const other = run({
      evidence: [{ field: 'title', kind: 'DISPLAY_TRUNCATED', detail: 'x' }],
    })
    expect(other.flags).toEqual(['SALARY_UNKNOWN'])
  })
})

const ev = (source: string, field: string, excerpt: string, code: string, used = true) => ({
  source,
  field,
  excerpt,
  code,
  used,
})

describe('layer1: evidence is exact (source, field, excerpt, code, used)', () => {
  it('reads every structured field and tags, each tagged with its own field name', () => {
    const r = run({
      title: 'Remote Dev',
      location: 'Hybrid',
      employmentType: 'onsite',
      tags: ['hybrid'],
      seniorityHint: 'Senior',
    })
    expect(r.workplace.evidence).toEqual([
      ev('TITLE', 'title', 'Remote Dev', 'REMOTE_KEYWORD', false),
      ev('STRUCTURED', 'location', 'Hybrid', 'HYBRID_KEYWORD', false),
      ev('STRUCTURED', 'tags', 'hybrid', 'HYBRID_KEYWORD', false),
      ev('POLICY', '', '', 'CONFLICTING_WORKPLACE_SIGNALS'),
    ])
    expect(r.workplace.value).toBe('UNKNOWN')
  })

  it('seniority hint is read from the hint field only; location/tags are not level sources', () => {
    expect(run({ seniorityHint: 'Senior' }).seniority.evidence).toEqual([
      ev('STRUCTURED', 'seniorityHint', 'Senior', 'LEVEL_SENIOR'),
    ])
    expect(run({ title: 'Dev', location: 'Senior', tags: ['junior'] }).seniority.value).toBe(
      'UNKNOWN',
    )
  })

  it('title evidence for each level code', () => {
    const codeOf = (title: string) => run({ title }).seniority.evidence.map((e) => e.code)
    expect(codeOf('Intern')).toEqual(['LEVEL_INTERN'])
    expect(codeOf('Junior')).toEqual(['LEVEL_JUNIOR'])
    expect(codeOf('Middle')).toEqual(['LEVEL_MIDDLE'])
    expect(codeOf('Staff Engineer')).toEqual(['LEVEL_STAFF_PRINCIPAL'])
    expect(codeOf('Team Lead')).toEqual(['LEVEL_LEAD'])
    expect(codeOf('CTO')).toEqual(['LEVEL_EXECUTIVE'])
    const mixed = run({ title: 'Junior Senior Lead' }).seniority
    expect(mixed.value).toBe('LEAD')
    expect(mixed.evidence.map((e) => [e.code, e.used])).toEqual([
      ['LEVEL_JUNIOR', false],
      ['LEVEL_SENIOR', false],
      ['LEVEL_LEAD', true],
    ])
  })

  it('body years evidence', () => {
    expect(
      run({ descriptionMd: 'We need 3+ years in Go.\nMore text.' }).seniority.evidence,
    ).toEqual([ev('BODY', 'descriptionMd', 'We need 3+ years in Go.', 'YEARS_3')])
    const two = run({ descriptionMd: '1 year of Go. 6 years of Java.' }).seniority
    expect(two.value).toBe('SENIOR')
    expect(two.evidence[0]).toMatchObject({ code: 'YEARS_6', excerpt: '6 years of Java.' })
    // a larger number first, then a smaller: the larger stays
    expect(
      run({ descriptionMd: '6 years of Java. 1 year of Go.' }).seniority.evidence[0],
    ).toMatchObject({
      code: 'YEARS_6',
    })
    expect(run({ descriptionMd: 'Experience: 0 years' }).seniority.value).toBe('JUNIOR')
    expect(run({ descriptionMd: '2 years' }).seniority.value).toBe('MIDDLE')
    expect(run({ descriptionMd: '5 years' }).seniority.value).toBe('SENIOR')
    expect(run({ descriptionMd: '1 year' }).seniority.value).toBe('JUNIOR')
    expect(run({ descriptionMd: '4 yrs' }).seniority.value).toBe('MIDDLE')
    expect(run({ descriptionMd: '3 роки' }).seniority.value).toBe('MIDDLE')
    expect(run({ descriptionMd: '7 лет' }).seniority.value).toBe('SENIOR')
    expect(run({ descriptionMd: '12 jahre' }).seniority.value).toBe('SENIOR')
    expect(run({ descriptionMd: '6 lat' }).seniority.value).toBe('SENIOR')
    expect(run({ descriptionMd: 'version 3.5 years' }).seniority.value).toBe('UNKNOWN')
  })

  it('leadership evidence', () => {
    expect(run({ title: 'Head of Engineering' }).leadership.evidence).toEqual([
      ev('TITLE', 'title', 'Head of Engineering', 'LEAD_TITLE'),
    ])
    expect(run({ title: 'Dev', seniorityHint: 'Team Lead' }).leadership.evidence).toEqual([
      ev('STRUCTURED', 'seniorityHint', 'Team Lead', 'LEAD_TITLE'),
    ])
    expect(run({ descriptionMd: 'You have direct reports.' }).leadership.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'You have direct reports.', 'LEAD_BODY'),
    ])
    expect(run({ descriptionMd: 'An individual contributor role.' }).leadership.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'An individual contributor role.', 'IC_BODY'),
    ])
    expect(run({ descriptionMd: 'Line management of engineers.' }).leadership.value).toBe(
      'LEADS_PEOPLE',
    )
    expect(run({ descriptionMd: 'People management.' }).leadership.value).toBe('LEADS_PEOPLE')
    expect(run({}).leadership.evidence).toEqual([])
    expect(run({}).leadership.verdict).toBe('PASS')
  })

  it('role family evidence names its source and code', () => {
    expect(run({ title: 'SRE' }).roleFamily.evidence).toEqual([
      ev('TITLE', 'title', 'SRE', 'FAMILY_DEVOPS'),
    ])
    expect(run({ title: 'x', tags: ['designer'] }).roleFamily.evidence).toEqual([
      ev('STRUCTURED', 'tags', 'designer', 'FAMILY_DESIGN'),
    ])
    expect(run({ title: 'x' }).roleFamily.evidence).toEqual([])
  })

  it('geography evidence', () => {
    expect(run({ location: 'Remote, US only' }).geography.evidence).toEqual([
      ev('STRUCTURED', 'location', 'Remote, US only', 'REGION_LIMIT'),
    ])
    expect(run({ descriptionMd: 'You are authorized to work in the UK.' }).geography).toMatchObject(
      {
        value: { kind: 'WORK_AUTHORIZATION_REQUIRED', regions: ['UK'] },
        evidence: [
          ev(
            'BODY',
            'descriptionMd',
            'You are authorized to work in the UK.',
            'WORK_AUTHORIZATION',
          ),
        ],
      },
    )
    expect(run({}).geography.evidence).toEqual([])
  })

  it('salary evidence', () => {
    expect(run({}).salary.evidence).toEqual([ev('POLICY', '', '', 'SALARY_UNKNOWN')])
    expect(
      run({ salary: { min: 1, max: 1, currency: 'PLN', period: 'MONTH' } }).salary.evidence,
    ).toEqual([ev('POLICY', '', 'PLN', 'NO_RECORDED_RATE')])
    expect(
      run({ salary: { min: 4000, max: 4000, currency: 'usd', period: 'MONTH' } }).salary.evidence,
    ).toEqual([ev('POLICY', '', '4000', 'AT_OR_ABOVE_FLOOR')])
    expect(
      run({ salary: { min: 100, max: 100, currency: 'USD', period: 'MONTH' } }).salary.evidence,
    ).toEqual([ev('POLICY', '', '100', 'BELOW_FLOOR')])
  })

  it('salary guards: zero, negative, NaN and Infinity figures are "unknown"; bad rates unusable', () => {
    for (const top of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        run({ salary: { min: null, max: top, currency: 'USD', period: 'MONTH' } }).salary.value,
      ).toEqual({ state: 'UNKNOWN', monthlyUsd: null })
    }
    expect(
      run({ salary: { min: 5000, max: null, currency: 'USD', period: 'MONTH' } }).salary.value,
    ).toEqual({ state: 'ABOVE_FLOOR', monthlyUsd: 5000 })
    const eur = { min: 9000, max: 9000, currency: 'EUR', period: 'MONTH' as const }
    for (const usdPerUnit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        run({ salary: eur, fxRate: { currency: 'EUR', usdPerUnit, recordedAt: 'x' } }).salary.value
          .state,
      ).toBe('UNCONVERTIBLE')
    }
    expect(
      run({ salary: eur, fxRate: { currency: 'eur', usdPerUnit: 1, recordedAt: 'x' } }).salary.value
        .state,
    ).toBe('ABOVE_FLOOR')
    expect(
      run({
        salary: { ...eur, currency: 'eur' },
        fxRate: { currency: 'EUR', usdPerUnit: 1, recordedAt: 'x' },
      }).salary.value.state,
    ).toBe('ABOVE_FLOOR')
  })

  it('date evidence', () => {
    const fut: ObservedDate = {
      semantics: 'UPDATED',
      contract: 'ISO_ZONED',
      raw: 'r1',
      status: 'FUTURE',
      value: null,
    }
    const inv: ObservedDate = {
      semantics: 'PUBLISHED',
      contract: 'ISO_ZONED',
      raw: 'r2',
      status: 'INVALID',
      value: null,
    }
    const r = run({
      dates: [
        fut,
        inv,
        ok('EXPIRY', '2026-01-01T00:00:00Z'),
        ok('PUBLISHED', '2026-12-01T00:00:00Z'),
        ok('RELEASED', '2026-10-19T12:00:00Z'),
      ],
    })
    expect(r.freshness.evidence).toEqual([
      ev('STRUCTURED', 'date.UPDATED', 'r1', 'FUTURE_DATE', false),
      ev('STRUCTURED', 'date.PUBLISHED', 'r2', 'DATE_INVALID', false),
      ev('STRUCTURED', 'date.EXPIRY', '2026-01-01T00:00:00Z', 'EXPIRED'),
      ev('STRUCTURED', 'date.PUBLISHED', '2026-12-01T00:00:00Z', 'FUTURE_DATE', false),
      ev('STRUCTURED', 'date.RELEASED', '2026-10-19T12:00:00Z', 'DATED'),
    ])
    expect(r.flags).toEqual(['DATE_UNCERTAIN', 'FUTURE_DATE_IGNORED', 'SALARY_UNKNOWN'])
    // exactly now + 24h is still tolerated; one millisecond more is not
    expect(run({ dates: [ok('PUBLISHED', '2026-10-21T12:00:00Z')] }).freshness.value.bucket).toBe(
      'FRESH',
    )
    expect(
      run({ dates: [ok('PUBLISHED', '2026-10-21T12:00:00.001Z')] }).freshness.value.bucket,
    ).toBe('UNKNOWN')
    // the NEWEST usable date wins regardless of order
    const newest = run({
      dates: [ok('PUBLISHED', '2026-10-19T12:00:00Z'), ok('UPDATED', '2026-10-01T12:00:00Z')],
    })
    expect(newest.freshness.value.ageDays).toBe(1)
  })

  it('agency evidence and mixed signals', () => {
    expect(run({ descriptionMd: 'Agencies are welcome.' }).agency.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'Agencies are welcome.', 'AGENCY_WELCOME'),
    ])
    expect(run({ descriptionMd: 'No agencies.' }).agency.evidence).toEqual([
      ev('BODY', 'descriptionMd', 'No agencies.', 'NO_AGENCY'),
    ])
    const mixed = run({ descriptionMd: 'No agencies.\nAgencies are welcome.' }).agency
    expect(mixed).toMatchObject({ value: 'UNKNOWN', verdict: 'WARN_UNKNOWN' })
    // agency statements only count in the body
    expect(run({ title: 'No agencies' }).agency.value).toBe('UNKNOWN')
  })

  it('conflict evidence is kept unused, with a policy note', () => {
    const r = run({ employmentType: 'full_time', title: 'Part-time Dev' })
    expect(r.schedule.evidence).toEqual([
      ev('TITLE', 'title', 'Part-time Dev', 'PART_TIME_KEYWORD', false),
      ev('STRUCTURED', 'employmentType', 'full time', 'FULL_TIME_KEYWORD', false),
      ev('POLICY', '', '', 'CONFLICTING_SCHEDULE_SIGNALS'),
    ])
    const w = run({ remote: true, title: 'Onsite' })
    expect(w.workplace.evidence.at(-1)).toEqual(
      ev('POLICY', '', '', 'CONFLICTING_WORKPLACE_SIGNALS'),
    )
    const d = run({ descriptionMd: 'Permanent role. Fixed-term role.' }).duration
    expect(d).toMatchObject({ value: 'UNKNOWN', verdict: 'PASS' })
    expect(d.evidence.at(-1)).toEqual(ev('POLICY', '', '', 'CONFLICT'))
  })

  it('basis evidence: used only for the deciding tier', () => {
    const r = run({ employmentType: 'Contract', descriptionMd: 'Employment contract.' })
    expect(r.basis.value).toBe('CONTRACTOR')
    expect(r.basis.evidence.map((e) => [e.code, e.used])).toEqual([
      ['CONTRACTOR_KEYWORD', true],
      ['EMPLOYMENT_KEYWORD', false],
    ])
    expect(
      run({ title: 'x', descriptionMd: 'Sole proprietor welcome. Self-employed.' }).basis.value,
    ).toBe('B2B')
    expect(run({ descriptionMd: 'Freelance, 1099.' }).basis.value).toBe('CONTRACTOR')
    expect(run({ descriptionMd: 'W-2 employee.' }).basis.value).toBe('EMPLOYEE')
    expect(run({ descriptionMd: 'No B2B, no contractors.' }).basis.value).toBe('UNKNOWN')
    expect(run({ descriptionMd: 'Не B2B.' }).basis.value).toBe('UNKNOWN')
    expect(run({ descriptionMd: 'Умова: ФОП.' }).basis.value).toBe('B2B')
    expect(run({ descriptionMd: 'Трудовий договір.' }).basis.value).toBe('EMPLOYEE')
    expect(run({ descriptionMd: 'B2B, employee or contractor' }).basis.value).toBe('EITHER')
  })
})

describe('layer1: keyword families (each alternative is a distinct behaviour)', () => {
  it.each([
    ['Fully remote', 'REMOTE'],
    ['remote-first', 'REMOTE'],
    ['remotely', 'REMOTE'],
    ['working from home', 'REMOTE'],
    ['WFH', 'REMOTE'],
    ['telecommute', 'REMOTE'],
    ['fully distributed', 'REMOTE'],
    ['дистанційно', 'REMOTE'],
    ['дистанционная работа', 'REMOTE'],
    ['homeoffice', 'REMOTE'],
    ['hybrid', 'HYBRID'],
    ['гибридный', 'HYBRID'],
    ['частково віддалено', 'HYBRID'],
    ['2 days a week in the office', 'HYBRID'],
    ['4 days weekly at the office', 'HYBRID'],
    ['onsite', 'ONSITE'],
    ['on site', 'ONSITE'],
    ['in-office', 'ONSITE'],
    ['office-based', 'ONSITE'],
    ['work from the office', 'ONSITE'],
    ['5 days per week in the office', 'ONSITE'],
    ['офісний формат', 'ONSITE'],
    ['офисный формат', 'ONSITE'],
    ['работа в офисе', 'ONSITE'],
    ['vor Ort', 'ONSITE'],
  ])('%s => %s', (text, expected) => {
    expect(run({ location: text }).workplace.value).toBe(expected)
  })

  it.each([
    ['onsite interview'],
    ['onsite meeting'],
    ['onsite event'],
    ['onsite training'],
    ['occasional hybrid days'],
    ['optionally in-office'],
    ['rarely on-site'],
    ['quarterly onsite'],
    ['annual onsite'],
    ['sometimes onsite'],
    ['from time to time onsite'],
    ['періодично onsite'.replace('періодично', 'periodic')],
    ['епізодично onsite'],
    ['іноді onsite'],
  ])('softened/irrelevant "%s" is not a workplace signal', (text) => {
    expect(run({ location: text }).workplace.value).toBe('UNKNOWN')
  })

  it.each([
    ['no remote', 'UNKNOWN'],
    ['without hybrid', 'UNKNOWN'],
    ['never onsite', 'UNKNOWN'],
    ['neither hybrid nor onsite', 'UNKNOWN'],
    ['non-onsite', 'UNKNOWN'],
    ['kein onsite', 'UNKNOWN'],
    ['не onsite', 'UNKNOWN'],
    ['нет onsite', 'UNKNOWN'],
    ['без onsite', 'UNKNOWN'],
    ['ні onsite', 'UNKNOWN'],
    ['brak onsite', 'UNKNOWN'],
    ['bez onsite', 'UNKNOWN'],
    ["isn't onsite", 'UNKNOWN'],
    ['no travel or onsite', 'UNKNOWN'],
  ])('negated "%s" yields no positive', (text, expected) => {
    expect(run({ location: text }).workplace.value).toBe(expected)
  })

  it('negation does not leak across a clause break or beyond four words', () => {
    expect(run({ descriptionMd: 'No agencies. On-site in Kyiv.' }).workplace.value).toBe('ONSITE')
    expect(run({ descriptionMd: 'Not great, on-site' }).workplace.value).toBe('ONSITE')
    expect(run({ descriptionMd: 'Not a, b, c, d, e, on-site' }).workplace.value).toBe('ONSITE')
    expect(run({ descriptionMd: 'not one two three four five onsite' }).workplace.value).toBe(
      'ONSITE',
    )
    expect(run({ descriptionMd: 'not one two three four onsite' }).workplace.value).toBe('UNKNOWN')
    expect(run({ descriptionMd: 'knot onsite' }).workplace.value).toBe('ONSITE')
    expect(run({ descriptionMd: 'x'.repeat(60) + ' not onsite' }).workplace.value).toBe('UNKNOWN')
    expect(run({ descriptionMd: 'not ' + 'x'.repeat(60) + ' onsite' }).workplace.value).toBe(
      'ONSITE',
    )
  })

  it('markdown, NUL and line breaks: sentences are split and cleaned', () => {
    const r = run({ descriptionMd: '## Remote\u0000 **role**\n* No agencies' })
    expect(r.workplace.evidence[0]).toMatchObject({ excerpt: 'Remote role' })
    expect(r.agency.value).toBe('PROHIBITED')
    const long = run({ descriptionMd: `Remote ${'a'.repeat(300)}` })
    expect(long.workplace.evidence[0]?.excerpt).toHaveLength(160)
    expect(run({ descriptionMd: 'First one. Remote work.' }).workplace.evidence[0]?.excerpt).toBe(
      'Remote work.',
    )
    expect(run({ descriptionMd: '   \n  \n' }).workplace.evidence).toEqual([])
  })

  it.each([
    ['Remote (EU)', ['EUROPE']],
    ['Remote - EMEA', ['EUROPE']],
    ['Remote: Європа', ['EUROPE']],
    ['Remote in the USA', ['US']],
    ['Remote within United States', ['US']],
    ['Remote, UK', ['UK']],
    ['Remote from Canada', ['CANADA']],
    ['Remote LATAM', ['LATAM']],
    ['Remote - Latin America', ['LATAM']],
    ['APAC only', ['APAC']],
    ['Europe-only', ['EUROPE']],
    ['must be located in Canada', ['CANADA']],
    ['must reside in the EU', ['EUROPE']],
    ['must live in the UK', ['UK']],
    ['must be based in USA', ['US']],
  ])('region limit "%s" => %j', (location, regions) => {
    const g = run({ location }).geography
    expect(g.value).toEqual({ kind: 'REGION_LIMITED', regions })
  })

  it('worldwide / negated region limits do not restrict; regions are sorted and de-duplicated', () => {
    expect(run({ location: 'Remote worldwide' }).geography.value.kind).toBe('UNSTATED')
    expect(run({ location: 'not remote us only' }).geography.value.kind).toBe('UNSTATED')
    expect(
      run({ location: 'Remote US', descriptionMd: 'Remote EU. Remote US.' }).geography.value,
    ).toEqual({
      kind: 'REGION_LIMITED',
      regions: ['EUROPE', 'US'],
    })
  })

  it.each([
    ['eligible to work in the EU', ['EUROPE']],
    ['legally entitled to work in Canada', ['CANADA']],
    ['legal right to work in the United States', ['US']],
    ['US work authorization is required', ['US']],
    ['US citizens only', ['US']],
    ['Потрібен дозвіл на роботу в США', ['US']],
    ['Нужно разрешение на работу в США', ['US']],
  ])('work authorization "%s"', (text, regions) => {
    expect(run({ descriptionMd: text }).geography.value).toEqual({
      kind: 'WORK_AUTHORIZATION_REQUIRED',
      regions,
    })
  })

  it('arbeitserlaubnis requires authorization with no region', () => {
    expect(run({ descriptionMd: 'Arbeitserlaubnis nötig.' }).geography.value).toEqual({
      kind: 'WORK_AUTHORIZATION_REQUIRED',
      regions: [],
    })
  })

  it.each([
    ['Intern', 'INTERN'],
    ['Internship', 'INTERN'],
    ['Trainee', 'INTERN'],
    ['Стажер', 'INTERN'],
    ['Jr. Developer', 'JUNIOR'],
    ['Entry-level', 'JUNIOR'],
    ['Джуніор', 'JUNIOR'],
    ['Mid-level Dev', 'MIDDLE'],
    ['Mid Dev', 'MIDDLE'],
    ['Sr. Dev', 'SENIOR'],
    ['Сеніор', 'SENIOR'],
    ['Сеньор', 'SENIOR'],
    ['Distinguished Engineer', 'SENIOR'],
    ['Tech Lead', 'LEAD'],
    ['Technical Lead', 'LEAD'],
    ['Teamlead', 'LEAD'],
    ['Engineering Manager', 'LEAD'],
    ['Development Manager', 'LEAD'],
    ['Тімлід', 'LEAD'],
    ['Тимлид', 'LEAD'],
    ['VP Engineering', 'EXECUTIVE'],
    ['Vice President', 'EXECUTIVE'],
    ['Chief Architect', 'EXECUTIVE'],
    ['Директор', 'EXECUTIVE'],
  ])('level keyword "%s" => %s', (title, level) => {
    expect(run({ title }).seniority.value).toBe(level)
  })

  it.each([
    ['QA', 'QA'],
    ['Quality Assurance', 'QA'],
    ['SDET', 'QA'],
    ['Test Engineer', 'QA'],
    ['Tester', 'QA'],
    ['Site Reliability Engineer', 'DEVOPS'],
    ['Platform Engineer', 'DEVOPS'],
    ['Cloud Engineer', 'DEVOPS'],
    ['Infrastructure Engineer', 'DEVOPS'],
    ['Data Scientist', 'DATA'],
    ['Data Analyst', 'DATA'],
    ['Machine Learning Engineer', 'DATA'],
    ['ML Engineer', 'DATA'],
    ['AI Engineer', 'DATA'],
    ['UI Designer', 'DESIGN'],
    ['Product Owner', 'PRODUCT'],
    ['Project Manager', 'PRODUCT'],
    ['Scrum Master', 'PRODUCT'],
    ['Delivery Manager', 'PRODUCT'],
    ['Programmer', 'SOFTWARE'],
    ['Software Tester Dev', 'QA'],
    ['Frontend', 'SOFTWARE'],
    ['Back-end', 'SOFTWARE'],
    ['Fullstack', 'SOFTWARE'],
    ['Full Stack', 'SOFTWARE'],
    ['Розробник', 'SOFTWARE'],
    ['Програміст', 'SOFTWARE'],
    ['Разработчик', 'SOFTWARE'],
    ['Entwickler', 'SOFTWARE'],
    ['Sales', 'OTHER'],
    ['Marketing', 'OTHER'],
    ['Accountant', 'OTHER'],
    ['Support', 'OTHER'],
    ['HR', 'OTHER'],
    ['Legal', 'OTHER'],
  ])('role family "%s" => %s', (title, family) => {
    expect(run({ title }).roleFamily.value).toBe(family)
  })

  it.each([
    ['fulltime', 'FULL_TIME'],
    ['Повна зайнятість', 'FULL_TIME'],
    ['Vollzeit', 'FULL_TIME'],
    ['pełny etat', 'FULL_TIME'],
    ['parttime', 'PART_TIME'],
    ['Part Time', 'PART_TIME'],
    ['парт-тайм', 'PART_TIME'],
    ['Teilzeit', 'PART_TIME'],
    ['niepełny etat', 'PART_TIME'],
    ['część etatu', 'PART_TIME'],
    ['35 hours/week', 'FULL_TIME'],
    ['30 hrs a week', 'PART_TIME'],
    ['34 hours per week', 'UNKNOWN'],
    ['31 hours per week', 'UNKNOWN'],
    ['40 годин на тиждень', 'FULL_TIME'],
  ])('schedule keyword "%s" => %s', (text, expected) => {
    expect(run({ descriptionMd: text }).schedule.value).toBe(expected)
  })

  it.each([
    ['fixed term', 'FIXED_TERM'],
    ['temporary', 'FIXED_TERM'],
    ['6 month contract', 'FIXED_TERM'],
    ['3-months engagement', 'FIXED_TERM'],
    ['2 month project', 'FIXED_TERM'],
    ['contract for 12 months', 'FIXED_TERM'],
    ['contract of 6 months', 'FIXED_TERM'],
    ['befristet', 'FIXED_TERM'],
    ['строковий договір', 'FIXED_TERM'],
    ['project basis', 'PROJECT'],
    ['one-off project', 'PROJECT'],
    ['проєктна робота', 'PROJECT'],
    ['проектная работа', 'PROJECT'],
    ['indefinite', 'PERMANENT'],
    ['безстроково', 'PERMANENT'],
    ['unbefristet', 'PERMANENT'],
    ['not permanent', 'UNKNOWN'],
    ['no temporary work', 'UNKNOWN'],
    ['not project-based', 'UNKNOWN'],
  ])('duration keyword "%s" => %s', (text, expected) => {
    expect(run({ descriptionMd: text }).duration.value).toBe(expected)
  })

  it.each([
    ['Agencies need not apply', 'PROHIBITED'],
    ['agency do not contact', 'PROHIBITED'],
    ['No third-party', 'PROHIBITED'],
    ['without recruiters', 'PROHIBITED'],
    ['no vendors', 'PROHIBITED'],
    ['Без агенцій', 'PROHIBITED'],
    ['Без рекрутингових агенцій', 'PROHIBITED'],
    ['Без посредников', 'PROHIBITED'],
    ['recruiters are accepted', 'ACCEPTED'],
    ['vendors encouraged', 'ACCEPTED'],
    ['open to recruitment agencies', 'ACCEPTED'],
    ['we work with staffing agencies', 'ACCEPTED'],
    ['we partner with agencies', 'ACCEPTED'],
  ])('agency phrase "%s" => %s', (text, expected) => {
    expect(run({ descriptionMd: text }).agency.value).toBe(expected)
  })

  it('verdict table for leadership / levels at the edges', () => {
    expect(run({ title: 'Senior', descriptionMd: 'Not a people manager.' }).leadership.value).toBe(
      'UNKNOWN',
    )
  })
})
