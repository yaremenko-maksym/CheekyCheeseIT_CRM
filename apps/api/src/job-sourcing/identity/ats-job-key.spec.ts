import { describe, expect, it } from 'vitest'
import { ATS_KEY_VERSION, atsJobKey, type AtsJobKey } from './ats-job-key'

const k = (url: string | null | undefined): AtsJobKey | null => atsJobKey(url)
const sig = (url: string) => {
  const r = k(url)
  return r === null ? null : `${r.provider}|${r.namespace}|${r.jobId}`
}

describe('atsJobKey: provider shapes', () => {
  it('Greenhouse board URLs (both hosts), path and embed forms', () => {
    expect(sig('https://boards.greenhouse.io/acme/jobs/4012345')).toBe('greenhouse|us:acme|4012345')
    expect(sig('https://job-boards.greenhouse.io/Acme/jobs/4012345?gh_src=abc')).toBe(
      'greenhouse|us:acme|4012345',
    )
    expect(sig('https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345')).toBe(
      'greenhouse|us:acme|4012345',
    )
    expect(sig('https://boards.eu.greenhouse.io/acme/jobs/4012345')).toBe(
      'greenhouse|eu:acme|4012345',
    )
  })

  it('Greenhouse gh_jid on an employer career page is scoped to that host', () => {
    const r = k('https://careers.acme.example/open-roles?gh_jid=4012345&utm_source=x')
    expect(r).toMatchObject({
      provider: 'greenhouse',
      namespace: 'careers.acme.example',
      jobId: '4012345',
      scope: 'EMPLOYER_HOST',
    })
  })

  it('Greenhouse hosted boards have scope ATS_HOSTED', () => {
    expect(k('https://boards.greenhouse.io/acme/jobs/1')?.scope).toBe('ATS_HOSTED')
  })

  it('rejects a non-numeric Greenhouse id', () => {
    expect(k('https://boards.greenhouse.io/acme/jobs/abc')).toBeNull()
    expect(k('https://careers.acme.example/x?gh_jid=12ab')).toBeNull()
  })

  it('Lever, with and without /apply, any region host', () => {
    const id = '5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
    expect(sig(`https://jobs.lever.co/acme/${id}`)).toBe(`lever|us:acme|${id}`)
    expect(sig(`https://jobs.lever.co/acme/${id}/apply?lever-source=x`)).toBe(`lever|us:acme|${id}`)
    expect(sig(`https://jobs.eu.lever.co/Acme/${id.toUpperCase()}`)).toBe(`lever|eu:acme|${id}`)
    expect(k('https://jobs.lever.co/acme')).toBeNull()
    expect(k('https://jobs.lever.co/acme/not-a-uuid')).toBeNull()
  })

  it('Ashby, with and without /application', () => {
    const id = '0a1b2c3d-1111-4222-8333-444455556666'
    expect(sig(`https://jobs.ashbyhq.com/acme/${id}`)).toBe(`ashby|acme|${id}`)
    expect(sig(`https://jobs.ashbyhq.com/acme/${id}/application`)).toBe(`ashby|acme|${id}`)
    expect(k('https://jobs.ashbyhq.com/acme')).toBeNull()
  })

  it('Workable shortcodes are case-folded to upper', () => {
    expect(sig('https://apply.workable.com/acme/j/ab12cd34ef/')).toBe('workable|acme|AB12CD34EF')
    expect(sig('https://apply.workable.com/acme/j/AB12CD34EF/apply/')).toBe(
      'workable|acme|AB12CD34EF',
    )
    expect(k('https://apply.workable.com/acme/')).toBeNull()
  })

  it('SmartRecruiters: numeric id before the slug', () => {
    expect(sig('https://jobs.smartrecruiters.com/Acme/743999876543-senior-engineer')).toBe(
      'smartrecruiters|acme|743999876543',
    )
    expect(sig('https://careers.smartrecruiters.com/acme/743999876543')).toBe(
      'smartrecruiters|acme|743999876543',
    )
    expect(k('https://jobs.smartrecruiters.com/Acme')).toBeNull()
    expect(k('https://jobs.smartrecruiters.com/Acme/senior-engineer')).toBeNull()
  })

  it('Recruitee: company subdomain + /o/ slug', () => {
    expect(sig('https://acme.recruitee.com/o/senior-engineer')).toBe(
      'recruitee|acme|senior-engineer',
    )
    expect(sig('https://acme.recruitee.com/o/senior-engineer/c/new')).toBe(
      'recruitee|acme|senior-engineer',
    )
    expect(k('https://acme.recruitee.com/')).toBeNull()
    expect(k('https://www.recruitee.com/o/senior-engineer')).toBeNull()
  })

  it('Personio: company subdomain + /job/<digits>, .de and .com', () => {
    expect(sig('https://acme.jobs.personio.de/job/1234567')).toBe('personio|de:acme|1234567')
    expect(sig('https://acme.jobs.personio.com/job/1234567?language=en')).toBe(
      'personio|com:acme|1234567',
    )
    expect(k('https://acme.jobs.personio.de/')).toBeNull()
    expect(k('https://acme.jobs.personio.de/job/abc')).toBeNull()
  })
})

describe('atsJobKey: what is NOT an identity', () => {
  it('returns null for homepages, tracking redirects, other hosts and garbage', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not a url',
      'https://example.com/',
      'https://acme.example/careers',
      'https://click.tracker.example/r?u=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F1',
      'https://boards.greenhouse.io/',
      'https://boards.greenhouse.io/acme',
      'https://boards.greenhouse.io/acme/jobs/',
      'http://boards.greenhouse.io/acme/jobs/1',
      'https://user:pw@boards.greenhouse.io/acme/jobs/1',
      'https://169.254.169.254/acme/jobs/1',
    ]) {
      expect(k(bad), String(bad)).toBeNull()
    }
  })

  it('does not match a lookalike host (suffix/prefix tricks)', () => {
    expect(k('https://boards.greenhouse.io.evil.example/acme/jobs/1')).toBeNull()
    expect(k('https://evilgreenhouse.io/acme/jobs/1')).toBeNull()
    expect(
      k('https://notjobs.lever.co.evil.example/acme/5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'),
    ).toBeNull()
  })

  it('does not follow or decode redirects: an embedded ATS URL in a query is ignored', () => {
    expect(k('https://tracker.example/go?to=https://boards.greenhouse.io/acme/jobs/1')).toBeNull()
    expect(k('https://tracker.example/go/boards.greenhouse.io/acme/jobs/1')).toBeNull()
  })

  it('a tracking-only query on an ATS URL does not change the key', () => {
    expect(k('https://boards.greenhouse.io/acme/jobs/1?utm_source=a')?.key).toBe(
      k('https://boards.greenhouse.io/acme/jobs/1?utm_source=b&ref=z')?.key,
    )
  })
})

describe('atsJobKey: key stability and separation', () => {
  it('posting and application URL of the same job give the same key', () => {
    const id = '5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
    expect(k(`https://jobs.lever.co/acme/${id}`)?.key).toBe(
      k(`https://jobs.lever.co/acme/${id}/apply`)?.key,
    )
  })

  it('different job, board or provider = different key', () => {
    const a = k('https://boards.greenhouse.io/acme/jobs/1')?.key
    expect(a).toBeDefined()
    expect(k('https://boards.greenhouse.io/acme/jobs/2')?.key).not.toBe(a)
    expect(k('https://boards.greenhouse.io/other/jobs/1')?.key).not.toBe(a)
    expect(k('https://acme.jobs.personio.de/job/1')?.key).not.toBe(a)
  })

  it('the key is a versioned JSON tuple (no delimiter ambiguity)', () => {
    expect(k('https://boards.greenhouse.io/acme/jobs/42')?.key).toBe(
      '["ats1","greenhouse","ATS_HOSTED","us:acme","42"]',
    )
  })

  it('an EMPLOYER_HOST key can never equal an ATS_HOSTED key (scope is part of the key)', () => {
    // A dotless host is a legal URL host; it must not impersonate the board slug "acme".
    const hostile = k('https://acme/open-roles?gh_jid=4012345')
    const board = k('https://boards.greenhouse.io/acme/jobs/4012345')
    expect(board).not.toBeNull()
    expect(hostile === null || hostile.key !== board?.key).toBe(true)
  })

  it('an EMPLOYER_HOST namespace must be a real dotted host', () => {
    expect(k('https://acme/open-roles?gh_jid=4012345')).toBeNull()
    expect(k('https://localhost/x?gh_jid=1')).toBeNull()
  })

  it('same employer host + id keeps one key; the scope is in the tuple', () => {
    const e = k('https://careers.acme.example/a?gh_jid=9')
    expect(e?.key).toBe('["ats1","greenhouse","EMPLOYER_HOST","careers.acme.example","9"]')
    expect(k('https://boards.greenhouse.io/acme/jobs/9')?.key).toBe(
      '["ats1","greenhouse","ATS_HOSTED","us:acme","9"]',
    )
  })

  it('every shape is anchored and strict: junk before, after or inside the id/account is rejected', () => {
    const U = '5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
    const bad = [
      // greenhouse
      'https://boards.greenhouse.io/x/acme/jobs/1',
      'https://boards.greenhouse.io/acme/jobs/12abc',
      'https://boards.greenhouse.io/-acme/jobs/1',
      'https://boards.greenhouse.io/ac.me/jobs/1',
      'https://boards.greenhouse.io/acme/jobs/1x/y',
      'https://boards.greenhouse.io/embed/job_app/extra?for=acme&token=1',
      'https://boards.greenhouse.io/x/embed/job_app?for=acme&token=1',
      'https://boards.greenhouse.io/embed/job_app?for=-acme&token=1',
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=1a',
      'https://boards.greenhouse.io/embed/job_app?for=acme',
      'https://boards.greenhouse.io/embed/job_app?token=1',
      'https://xboards.greenhouse.io/acme/jobs/1',
      'https://boards.xgreenhouse.io/acme/jobs/1',
      // lever
      `https://jobs.lever.co/x/acme/${U}`,
      `https://jobs.lever.co/acme/${U}/x`,
      `https://jobs.lever.co/acme/${U}0`,
      `https://jobs.lever.co/acme/x${U}`,
      `https://jobs.lever.co/-acme/${U}`,
      `https://jobs.lever.co/ac.me/${U}`,
      `https://jobs.lever.co/acme/${U.replace('-aaaa-', '-aaa-')}`,
      `https://xjobs.lever.co/acme/${U}`,
      `https://jobs.lever.com/acme/${U}`,
      // ashby
      `https://jobs.ashbyhq.com/acme/${U}/apply`,
      `https://jobs.ashbyhq.com/x/acme/${U}`,
      `https://jobs.ashbyhq.com/-acme/${U}`,
      `https://jobs.ashbyhq.com/acme/${U}0`,
      `https://xjobs.ashbyhq.com/acme/${U}`,
      `https://jobs.ashbyhq.com.example/acme/${U}`,
      // workable
      'https://apply.workable.com/x/acme/j/AB12CD34EF',
      'https://apply.workable.com/acme/j/AB12C',
      'https://apply.workable.com/acme/j/AB12CD34EF56GH78IJ90K',
      'https://apply.workable.com/acme/j/AB12CD34EF/x',
      'https://apply.workable.com/acme/x/AB12CD34EF',
      'https://apply.workable.com/-acme/j/AB12CD34EF',
      'https://apply.workable.com/acme/j/AB12-D34EF',
      'https://xapply.workable.com/acme/j/AB12CD34EF',
      // smartrecruiters
      'https://jobs.smartrecruiters.com/x/Acme/743999876543',
      'https://jobs.smartrecruiters.com/Acme/743999876543/x',
      'https://jobs.smartrecruiters.com/-Acme/743999876543',
      'https://jobs.smartrecruiters.com/Acme/x743999876543',
      'https://xjobs.smartrecruiters.com/Acme/743999876543',
      'https://jobs.smartrecruiters.com.example/Acme/743999876543',
      // recruitee
      'https://acme.recruitee.com/x/o/engineer',
      'https://acme.recruitee.com/p/engineer',
      'https://acme.recruitee.com/o/',
      'https://acme.recruitee.com/o/-engineer',
      'https://-acme.recruitee.com/o/engineer',
      'https://acme.recruitee.com.example/o/engineer',
      'https://recruitee.com/o/engineer',
      // personio
      'https://acme.jobs.personio.de/x/job/1',
      'https://acme.jobs.personio.de/job/1/x',
      'https://acme.jobs.personio.de/job/1a',
      'https://-acme.jobs.personio.de/job/1',
      'https://acme.jobs.personio.org/job/1',
      'https://acme.jobs.personio.de.example/job/1',
      'https://jobs.personio.de/job/1',
    ]
    for (const u of bad) expect(k(u), u).toBeNull()
  })

  it('accepts the documented optional tails, trailing slashes and name characters', () => {
    const U = '5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
    expect(sig('https://boards.greenhouse.io/ac_me-1/jobs/7/')).toBe('greenhouse|us:ac_me-1|7')
    expect(sig('https://boards.greenhouse.io/acme/jobs/7/extra')).toBe('greenhouse|us:acme|7')
    expect(sig('https://boards.greenhouse.io/embed/job_app/?for=acme&token=7')).toBe(
      'greenhouse|us:acme|7',
    )
    expect(sig('https://job-boards.eu.greenhouse.io/acme/jobs/7')).toBe('greenhouse|eu:acme|7')
    expect(sig(`https://jobs.lever.co/ac_me-1/${U}/`)).toBe(`lever|us:ac_me-1|${U}`)
    expect(sig(`https://jobs.lever.co/acme/${U.toUpperCase()}/apply/`)).toBe(`lever|us:acme|${U}`)
    expect(sig(`https://jobs.ashbyhq.com/ac_me/${U}/application/`)).toBe(`ashby|ac_me|${U}`)
    expect(sig('https://apply.workable.com/acme/j/abcdef/')).toBe('workable|acme|ABCDEF')
    expect(sig('https://apply.workable.com/acme/j/abcdefghij0123456789')).toBe(
      'workable|acme|ABCDEFGHIJ0123456789',
    )
    expect(sig('https://jobs.smartrecruiters.com/Acme/7439-senior-dev/')).toBe(
      'smartrecruiters|acme|7439',
    )
    expect(sig('https://jobs.smartrecruiters.com/Acme/7439/')).toBe('smartrecruiters|acme|7439')
    expect(sig('https://acme.recruitee.com/o/senior-dev/')).toBe('recruitee|acme|senior-dev')
    expect(sig('https://ac_me.recruitee.com/o/Senior-Dev')).toBe('recruitee|ac_me|senior-dev')
    expect(sig('https://acme.jobs.personio.de/job/55/')).toBe('personio|de:acme|55')
    expect(sig('https://acme.jobs.personio.com/job/55')).toBe('personio|com:acme|55')
  })

  it('gh_jid: digits only, non-empty, any other host needs a dot', () => {
    expect(k('https://careers.acme.example/x?gh_jid=')).toBeNull()
    expect(k('https://careers.acme.example/x?gh_jid=1x')).toBeNull()
    expect(k('https://careers.acme.example/x?gh_jid=x1')).toBeNull()
    expect(k('https://careers.acme.example/x')).toBeNull()
    expect(sig('https://careers.acme.example/x?gh_jid=12')).toBe(
      'greenhouse|careers.acme.example|12',
    )
  })

  it('a rejected hosted URL does not fall through to gh_jid on the vendor host', () => {
    for (const u of [
      'https://boards.greenhouse.io/acme?gh_jid=1',
      'https://jobs.lever.co/acme?gh_jid=1',
      'https://jobs.ashbyhq.com/acme?gh_jid=1',
      'https://apply.workable.com/acme?gh_jid=1',
      'https://jobs.smartrecruiters.com/acme?gh_jid=1',
      'https://acme.recruitee.com/?gh_jid=1',
      'https://acme.jobs.personio.de/?gh_jid=1',
    ]) {
      expect(k(u), u).toBeNull()
    }
  })

  it('every hosted shape is ATS_HOSTED and says so inside its key', () => {
    const U = '5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
    const urls = [
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=1',
      `https://jobs.lever.co/acme/${U}`,
      `https://jobs.ashbyhq.com/acme/${U}`,
      'https://apply.workable.com/acme/j/ABCDEF',
      'https://jobs.smartrecruiters.com/acme/1',
      'https://acme.recruitee.com/o/dev',
      'https://acme.jobs.personio.de/job/1',
    ]
    for (const u of urls) {
      const r = k(u)
      expect(r?.scope, u).toBe('ATS_HOSTED')
      expect(r?.key.includes('"ATS_HOSTED"'), u).toBe(true)
    }
  })

  it('embed parameters are validated as whole values and the vendor host is exact', () => {
    expect(k('https://boards.greenhouse.io/embed/job_app?for=acme.x&token=1')).toBeNull()
    expect(k('https://boards.greenhouse.io/embed/job_app?for=acme&token=1.5')).toBeNull()
    expect(k('https://apply.workable.com.example/acme/j/ABCDEF')).toBeNull()
  })

  it('the same slug in different regions never collides (SR-M-1)', () => {
    const U = '5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
    const pairs = [
      ['https://boards.greenhouse.io/acme/jobs/1', 'https://boards.eu.greenhouse.io/acme/jobs/1'],
      [
        'https://job-boards.greenhouse.io/acme/jobs/1',
        'https://job-boards.eu.greenhouse.io/acme/jobs/1',
      ],
      [
        'https://boards.greenhouse.io/embed/job_app?for=acme&token=1',
        'https://boards.eu.greenhouse.io/embed/job_app?for=acme&token=1',
      ],
      [`https://jobs.lever.co/acme/${U}`, `https://jobs.eu.lever.co/acme/${U}`],
      ['https://acme.jobs.personio.de/job/1', 'https://acme.jobs.personio.com/job/1'],
    ] as const
    for (const [x, y] of pairs) {
      expect(k(x)?.key, x).toBeDefined()
      expect(k(x)?.key, `${x} vs ${y}`).not.toBe(k(y)?.key)
    }
  })

  it('boards.greenhouse.io and job-boards.greenhouse.io are one deployment', () => {
    expect(k('https://boards.greenhouse.io/acme/jobs/1')?.key).toBe(
      k('https://job-boards.greenhouse.io/acme/jobs/1')?.key,
    )
    expect(k('https://boards.eu.greenhouse.io/acme/jobs/1')?.key).toBe(
      k('https://job-boards.eu.greenhouse.io/acme/jobs/1')?.key,
    )
  })

  it('exports the key layout version', () => {
    expect(ATS_KEY_VERSION).toBe('ats1')
  })
})
