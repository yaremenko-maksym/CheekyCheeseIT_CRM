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
