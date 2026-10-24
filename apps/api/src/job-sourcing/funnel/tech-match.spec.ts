import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JobExclusionDto } from '@crm/shared'
import {
  matchTech,
  MAX_EVIDENCE_EXCERPT_CHARS,
  type SeniorTechProfile,
  type TechMatchInput,
  type TechMatchPosting,
  type TechMatchReady,
} from './tech-match'

/** The open r4 "techword" case, named in the repo (plan r5 C-25). */
const TECHWORD = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'techword.json'), 'utf8'),
) as {
  profiles: SeniorTechProfile[]
  postingBody: string
  expectedMatches: string[]
}

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const TEAM = '33333333-3333-4333-8333-333333333333'

const profile = (seniorId: string, techStack: string[], teamIds = [TEAM]): SeniorTechProfile => ({
  seniorId,
  teamIds,
  techStack,
})

const posting = (over: Partial<TechMatchPosting> = {}): TechMatchPosting => ({
  title: 'Software Engineer',
  companyName: 'Acme',
  tags: [],
  body: null,
  ...over,
})

function exclusion(over: Partial<JobExclusionDto>): JobExclusionDto {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    scope: 'SENIOR',
    seniorId: A,
    kind: 'COMPANY',
    value: 'Acme',
    normalizedValue: 'acme',
    origin: 'MANUAL',
    sourceLabel: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function run(
  p: Partial<TechMatchPosting>,
  profiles: SeniorTechProfile[],
  exclusions: JobExclusionDto[] = [],
  roster: string[] = profiles.map((x) => x.seniorId),
): TechMatchReady {
  const input: TechMatchInput = {
    posting: posting(p),
    rosterSeniorIds: roster,
    profiles,
    exclusions,
  }
  const result = matchTech(input)
  if (result.status !== 'READY') throw new Error(`not ready: ${JSON.stringify(result)}`)
  return result
}

const matched = (r: TechMatchReady, id: string) => {
  const s = r.seniors.find((x) => x.seniorId === id)
  if (!s || s.disposition !== 'MATCHABLE') throw new Error('not matchable')
  return s
}
const kw = (r: TechMatchReady) => r.rosterMatches.map((m) => m.keyword).sort()

describe('union beyond 60 — the techword fixture', () => {
  const r = run({ title: 'Engineer', body: TECHWORD.postingBody }, TECHWORD.profiles)
  const ids = TECHWORD.profiles.map((p) => p.seniorId)

  it('keeps the whole 150-keyword union, not 60', () => {
    expect(TECHWORD.profiles.map((p) => p.techStack.length)).toEqual([50, 50, 50])
    expect(r.rosterUnionSize).toBe(150)
  })

  it('finds techword149, techword0 and techword75, one per profile', () => {
    expect(kw(r)).toEqual(TECHWORD.expectedMatches)
    expect(matched(r, ids[0] ?? '').matches.map((m) => m.keyword)).toEqual(['techword0'])
    expect(matched(r, ids[1] ?? '').matches.map((m) => m.keyword)).toEqual(['techword75'])
    expect(matched(r, ids[2] ?? '').matches.map((m) => m.keyword)).toEqual(['techword149'])
  })

  it('records which seniors hold each roster keyword', () => {
    expect(r.rosterMatches.find((m) => m.keyword === 'techword75')?.seniorIds).toEqual([ids[1]])
  })
})

describe('per-profile cap', () => {
  it('keeps only the first 60 keywords of ONE profile', () => {
    const stack = Array.from({ length: 70 }, (_, i) => `kw${i}`)
    const r = run({ body: 'Requirements: kw59 kw60 kw69' }, [profile(A, stack)])
    expect(r.rosterUnionSize).toBe(60)
    const s = matched(r, A)
    expect(s.profileKeywordCount).toBe(60)
    expect(s.matches.map((m) => m.keyword)).toEqual(['kw59'])
  })

  it('counts a keyword shared by two profiles once in the union', () => {
    const r = run({ body: 'python' }, [profile(A, ['Python', 'Go']), profile(B, ['python'])])
    expect(r.rosterUnionSize).toBe(2)
    expect(r.rosterMatches[0]?.seniorIds).toEqual([A, B])
  })
})

describe('aliases and symbols', () => {
  const hit = (stack: string, body: string, title = 'Engineer') =>
    run({ title, body }, [profile(A, [stack])]).rosterMatches.length === 1

  it('C# is not C++ and not C', () => {
    expect(hit('C#', 'We write C# daily')).toBe(true)
    expect(hit('C#', 'We write C++ daily')).toBe(false)
    expect(hit('C++', 'We write C++ daily')).toBe(true)
    expect(hit('C', 'We write C++ and C# daily')).toBe(false)
  })

  it('.NET matches ASP.NET but not the word net', () => {
    expect(hit('.NET', 'ASP.NET Core services')).toBe(true)
    expect(hit('.NET', 'net revenue growth')).toBe(false)
  })

  it('Go counts in the title only', () => {
    expect(hit('Go', 'we go to market', 'Go Developer')).toBe(true)
    expect(hit('Go', 'we go to market')).toBe(false)
    expect(hit('Golang', 'Golang backend')).toBe(true)
  })

  it('R is not R&D, react or rust', () => {
    expect(hit('R', 'our R&D team uses react and rust')).toBe(false)
    expect(hit('R', 'statistics in R and python')).toBe(true)
  })

  it('Java does not match JavaScript, and JavaScript matches js', () => {
    expect(hit('Java', 'JavaScript and TypeScript')).toBe(false)
    expect(hit('Java', 'Java and Spring')).toBe(true)
    expect(hit('JavaScript', 'modern js tooling')).toBe(true)
  })

  it('reads tags as a structured surface', () => {
    const r = run({ tags: ['Rust', 'Go'] }, [profile(A, ['rust', 'golang'])])
    const ev = r.rosterMatches
    expect(ev.map((e) => [e.keyword, e.sources])).toEqual([
      ['rust', ['TAG']],
      ['golang', ['TAG']],
    ])
  })

  it('does not glue two tags into one phrase', () => {
    const r = run({ tags: ['react', 'native'] }, [profile(A, ['react native'])])
    expect(r.rosterMatches).toHaveLength(0)
  })
})

describe('negation, optional, core', () => {
  const strength = (body: string, stack = 'Java') =>
    run({ body }, [profile(A, [stack])]).rosterMatches.concat(
      run({ body }, [profile(A, [stack])]).rosterNegated,
    )[0]?.strength

  it('a plain requirement is CORE', () => {
    expect(strength('Strong Java experience.')).toBe('CORE')
  })

  it('leading negations are NEGATED, and not a match', () => {
    expect(strength('No Java experience needed.')).toBe('NEGATED')
    expect(strength('We work without Java.')).toBe('NEGATED')
    const r = run({ body: 'Python, no Java' }, [profile(A, ['Java'])])
    expect(r.rosterMatches).toHaveLength(0)
    expect(r.rosterNegated).toHaveLength(1)
    expect(matched(r, A).negated).toHaveLength(1)
    expect(matched(r, A).coreMatchCount).toBe(0)
  })

  it('a trailing "not required" negates', () => {
    expect(strength('Java is not required.')).toBe('NEGATED')
    expect(strength('Java is not welcome.')).toBe('CORE')
  })

  it('a negator more than 3 tokens away does not negate', () => {
    expect(strength('no one will ever ask about Java here')).toBe('CORE')
  })

  it('optional phrases make OPTIONAL', () => {
    expect(strength('Java is a plus.')).toBe('OPTIONAL')
    expect(strength('Nice to have: Java.')).toBe('OPTIONAL')
    expect(strength('Bonus points for Java.')).toBe('OPTIONAL')
  })

  it('a heading opens an optional section until a required heading', () => {
    const body = ['Requirements:', 'Python', 'Nice to have:', 'Java', 'Must have:', 'Rust'].join(
      '\n',
    )
    const r = run({ body }, [profile(A, ['python', 'java', 'rust'])])
    const byKw = Object.fromEntries(r.rosterMatches.map((m) => [m.keyword, m.strength]))
    expect(byKw).toEqual({ python: 'CORE', java: 'OPTIONAL', rust: 'CORE' })
  })

  it('markdown headings behave like colon headings', () => {
    const r = run({ body: '## Nice to have\nJava\n**Requirements**\nRust' }, [
      profile(A, ['java', 'rust']),
    ])
    const byKw = Object.fromEntries(r.rosterMatches.map((m) => [m.keyword, m.strength]))
    expect(byKw).toEqual({ java: 'OPTIONAL', rust: 'CORE' })
  })

  it('the strongest mention wins, and title beats an optional body mention', () => {
    const r = run({ title: 'Java Developer', body: 'Java is a plus.' }, [profile(A, ['java'])])
    expect(r.rosterMatches[0]).toMatchObject({ strength: 'CORE', sources: ['TITLE'] })
    const r2 = run({ body: 'Java is a plus.\nStrong Java required.' }, [profile(A, ['java'])])
    expect(r2.rosterMatches[0]).toMatchObject({ strength: 'CORE', sources: ['BODY'] })
    expect(r2.rosterMatches[0]?.excerpt).toBe('Strong Java required.')
  })

  it('an optional-only mention does not make a core mismatch to vanish', () => {
    const r = run({ body: 'Requirements: Python.\nJava is a plus.' }, [profile(A, ['java'])])
    const s = matched(r, A)
    expect(s.optionalMatchCount).toBe(1)
    expect(s.coreMatchCount).toBe(0)
    expect(s.coreMismatch).toBe(true)
  })

  it('cuts the excerpt at the evidence limit', () => {
    const long = `Java ${'x'.repeat(400)}`
    const r = run({ body: long }, [profile(A, ['java'])])
    expect(r.rosterMatches[0]?.excerpt).toHaveLength(MAX_EVIDENCE_EXCERPT_CHARS)
  })

  it('splits sentences but not Node.js', () => {
    const r = run({ body: 'We love Node.js. Java is a plus.' }, [profile(A, ['nodejs', 'java'])])
    const byKw = Object.fromEntries(r.rosterMatches.map((m) => [m.keyword, m.strength]))
    expect(byKw).toEqual({ nodejs: 'CORE', java: 'OPTIONAL' })
  })
})

describe('context cues, one by one', () => {
  const strengthOf = (body: string, stack = ['java']) => {
    const r = run({ body }, [profile(A, stack)])
    const found = [...r.rosterMatches, ...r.rosterNegated]
    return found[0]?.strength ?? 'NONE'
  }

  it.each(['no', 'not', 'without', 'excluding', 'except', 'non', 'never', 'nor'])(
    'the negator "%s" negates the keyword after it',
    (word) => {
      expect(strengthOf(`${word} Java`)).toBe('NEGATED')
    },
  )

  it.each(['required', 'needed', 'necessary', 'mandatory', 'expected'])(
    '"Java is not %s" negates',
    (word) => {
      expect(strengthOf(`Java is not ${word}`)).toBe('NEGATED')
    },
  )

  it.each([
    'nice to have',
    'good to have',
    'would be nice',
    'a plus',
    'bonus',
    'optional',
    'advantage',
    'desirable',
    'preferred',
  ])('the sentence cue "%s" makes OPTIONAL', (phrase) => {
    expect(strengthOf(`Java, ${phrase}`)).toBe('OPTIONAL')
  })

  it.each([
    'nice to have',
    'good to have',
    'would be nice',
    'a plus',
    'bonus',
    'optional',
    'advantage',
    'desirable',
    'preferred',
  ])('a heading "%s:" opens an optional section', (phrase) => {
    expect(strengthOf(`${phrase}:\nJava`)).toBe('OPTIONAL')
  })

  it.each(['requirements', 'requirement', 'qualifications', 'skills', 'stack', 'proficiency'])(
    'the marker "%s" counts as a requirements statement',
    (word) => {
      const r = run({ body: `${word} wanted` }, [profile(A, ['python'])])
      expect(r.evidenceSurfaces.requirements).toBe(true)
      expect(r.lowInformation).toBe(false)
    },
  )

  it('a negator 3 tokens before the keyword negates, 4 tokens before does not', () => {
    expect(strengthOf('no good strong Java')).toBe('NEGATED')
    expect(strengthOf('no very good strong Java')).toBe('CORE')
  })

  it('a trailing "not required" up to 4 tokens after negates, 5 does not', () => {
    expect(strengthOf('Java a b c not required')).toBe('NEGATED')
    expect(strengthOf('Java a b c d not required')).toBe('CORE')
    expect(strengthOf('Java not')).toBe('CORE')
  })

  it('a keyword that is itself a negator word is not negated by itself', () => {
    expect(strengthOf('nor', ['nor'])).toBe('CORE')
  })

  it('a negation does not leak into the next sentence', () => {
    expect(strengthOf('We have no budget. Java')).toBe('CORE')
  })

  it.each(['.', '!', '?', ';'])('a "%s" ends a sentence, so optionality stays in it', (mark) => {
    const r = run({ body: `Java is a plus${mark} Rust` }, [profile(A, ['java', 'rust'])])
    expect(Object.fromEntries(r.rosterMatches.map((m) => [m.keyword, m.strength]))).toEqual({
      java: 'OPTIONAL',
      rust: 'CORE',
    })
  })

  it('trims the excerpt after splitting on several spaces', () => {
    const r = run({ body: 'Go on.   Strong Rust.' }, [profile(A, ['rust'])])
    expect(r.rosterMatches[0]?.excerpt).toBe('Strong Rust.')
  })

  it('a heading of 8 tokens opens a section, one of 9 is plain text', () => {
    expect(strengthOf('nice to have a b c d e:\nJava')).toBe('OPTIONAL')
    expect(strengthOf('nice to have a b c d e f:\nJava')).toBe('CORE')
  })

  it('a heading with surrounding spaces is still a heading', () => {
    expect(strengthOf('  Nice to have:   \nJava')).toBe('OPTIONAL')
  })

  it('a section runs to the next heading, not to the end of the line count', () => {
    expect(strengthOf('Nice to have:\nPython\nMust have:\nJava', ['java'])).toBe('CORE')
  })

  it('# headings need a space and at most 6 hashes, and only at the line start', () => {
    expect(strengthOf('## nice to have\nJava')).toBe('OPTIONAL')
    expect(strengthOf('#nice to have\nJava')).toBe('CORE')
    expect(strengthOf('####### nice to have\nJava')).toBe('CORE')
    expect(strengthOf('We love ## nice to have\nJava')).toBe('CORE')
  })

  it('a whole-line bold phrase is a heading, bold inside a sentence is not', () => {
    expect(strengthOf('**Nice to have**\nJava')).toBe('OPTIONAL')
    expect(strengthOf('**Nice to have**:\nJava')).toBe('OPTIONAL')
    expect(strengthOf('Use **Java**')).toBe('CORE')
    expect(strengthOf('**Java** developers wanted')).toBe('CORE')
  })

  it('a null body and an empty body read as no body', () => {
    expect(strengthOf('')).toBe('NONE')
    const r = run({ body: null }, [profile(A, ['stryker'])])
    expect(r.rosterMatches).toEqual([])
  })

  it('tags are CORE and ambiguous aliases count in them', () => {
    const r = run({ tags: ['Go'] }, [profile(A, ['golang'])])
    expect(r.rosterMatches[0]).toMatchObject({ strength: 'CORE', sources: ['TAG'] })
  })

  it('blank tags are not evidence, a real tag is', () => {
    expect(run({ tags: ['', '  '] }, [profile(A, ['rust'])]).evidenceSurfaces.tags).toBe(false)
    expect(run({ tags: ['', 'remote'] }, [profile(A, ['rust'])]).evidenceSurfaces.tags).toBe(true)
    expect(run({ tags: ['remote'] }, [profile(A, ['rust'])]).evidenceSurfaces.tags).toBe(true)
  })

  it('lists title, tag and body sources in that order when all reach the same strength', () => {
    const r = run({ title: 'Java', tags: ['Java'], body: 'Java' }, [profile(A, ['java'])])
    expect(r.rosterMatches[0]?.sources).toEqual(['TITLE', 'TAG', 'BODY'])
  })

  it('the winning mention supplies the strength, the sources and the excerpt', () => {
    const optionalOverNegated = run({ body: 'No Java.\nJava is a plus.' }, [profile(A, ['java'])])
    expect(optionalOverNegated.rosterMatches[0]).toMatchObject({
      strength: 'OPTIONAL',
      excerpt: 'Java is a plus.',
    })
    expect(optionalOverNegated.rosterNegated).toEqual([])
    const coreOverBoth = run({ body: 'No Java.\nJava is a plus.\nStrong Java.' }, [
      profile(A, ['java']),
    ])
    expect(coreOverBoth.rosterMatches[0]).toMatchObject({
      strength: 'CORE',
      excerpt: 'Strong Java.',
    })
    const negatedOnly = run({ body: 'No Java. Not Java either.' }, [profile(A, ['java'])])
    expect(negatedOnly.rosterNegated[0]).toMatchObject({
      strength: 'NEGATED',
      excerpt: 'No Java.',
    })
  })

  it('a title mention carries no excerpt', () => {
    const r = run({ title: 'Java Developer' }, [profile(A, ['java'])])
    expect(r.rosterMatches[0]?.excerpt).toBeNull()
  })

  it('reports all three counts correctly for a mixed profile', () => {
    const body = 'Requirements: Python, Rust.\nGo is a plus.\nNo Java.'
    const r = run({ body }, [profile(A, ['python', 'rust', 'golang', 'java', 'cobol'])])
    const s = matched(r, A)
    expect(s.profileKeywordCount).toBe(5)
    expect(s.coreMatchCount).toBe(2)
    expect(s.optionalMatchCount).toBe(0)
    expect(s.negated.map((e) => e.keyword)).toEqual(['java'])
    const r2 = run({ title: 'Go', body: 'Requirements: Python.\nRust is a plus.\nNo Java.' }, [
      profile(A, ['python', 'rust', 'golang', 'java']),
    ])
    const s2 = matched(r2, A)
    expect(s2.matches.map((e) => e.keyword)).toEqual(['python', 'rust', 'golang'])
    expect(s2.coreMatchCount).toBe(2)
    expect(s2.optionalMatchCount).toBe(1)
    expect(s2.negated.map((e) => e.keyword)).toEqual(['java'])
    expect(r2.rosterNegated.map((e) => e.keyword)).toEqual(['java'])
  })

  it('coreMismatch: only a stated stack with no core hit', () => {
    const stated = 'Requirements: Python.'
    expect(matched(run({ body: stated }, [profile(A, ['rust'])]), A).coreMismatch).toBe(true)
    expect(matched(run({ body: stated }, [profile(A, ['python'])]), A).coreMismatch).toBe(false)
    expect(matched(run({ body: stated }, [profile(A, [])]), A).coreMismatch).toBe(false)
    expect(matched(run({ body: 'We are great.' }, [profile(A, ['rust'])]), A).coreMismatch).toBe(
      false,
    )
  })

  it('reports every evidence surface together', () => {
    const r = run({ title: 'Rust', tags: ['x'], body: 'Skills' }, [profile(A, ['rust'])])
    expect(r.evidenceSurfaces).toEqual({ tags: true, requirements: true, keywordHit: true })
    expect(r.lowInformation).toBe(false)
  })

  it('two matchable seniors who share a keyword list both as holders', () => {
    const r = run({ body: 'rust' }, [profile(A, ['rust']), profile(B, ['go', 'rust'])])
    expect(r.rosterMatches[0]?.seniorIds).toEqual([A, B])
    expect(r.rosterUnionSize).toBe(2)
  })
})

describe('evidence completeness replaces the 200-character cliff', () => {
  const stackProfile = [profile(A, ['python'])]
  const filler = (n: number) => 'x'.repeat(n)

  it('199 and 200 characters give identical results', () => {
    const base = 'Requirements: Python. '
    const r199 = run({ body: base + filler(199 - base.length) }, stackProfile)
    const r200 = run({ body: base + filler(200 - base.length) }, stackProfile)
    expect(r199.lowInformation).toBe(false)
    expect(r199).toEqual(r200)
    const e199 = run({ body: filler(199) }, stackProfile)
    const e200 = run({ body: filler(200) }, stackProfile)
    expect(e199).toEqual(e200)
    expect(e199.lowInformation).toBe(true)
  })

  it('a short requirements statement is complete, a long marketing page is not', () => {
    expect(run({ body: 'Requirements: Rust' }, stackProfile).lowInformation).toBe(false)
    const marketing = 'We are a vibrant and fast-growing family. '.repeat(500)
    const r = run({ body: marketing }, stackProfile)
    expect(r.lowInformation).toBe(true)
    expect(r.evidenceSurfaces).toEqual({ tags: false, requirements: false, keywordHit: false })
  })

  it('tags, or any keyword hit, are evidence', () => {
    expect(run({ tags: ['remote'] }, stackProfile).lowInformation).toBe(false)
    expect(run({ title: 'Python Engineer' }, stackProfile).lowInformation).toBe(false)
    expect(run({ body: 'No Python here' }, stackProfile).lowInformation).toBe(false)
  })

  it('a known core mismatch is not low information', () => {
    const r = run({ body: 'Requirements: Rust.' }, stackProfile)
    expect(r.lowInformation).toBe(false)
    expect(matched(r, A).coreMismatch).toBe(true)
  })

  it('no body, no title words: low information', () => {
    expect(run({ body: null }, stackProfile).lowInformation).toBe(true)
  })
})

describe('empty profiles', () => {
  it('an empty stack matches nothing and is never a core mismatch', () => {
    const r = run({ body: 'Requirements: Python' }, [profile(A, [])])
    const s = matched(r, A)
    expect(s.profileKeywordCount).toBe(0)
    expect(s.coreMismatch).toBe(false)
    expect(r.rosterUnionSize).toBe(0)
  })

  it('a roster with no profiles at all is ready, with nobody matchable and no triage', () => {
    const r = run({ body: null }, [])
    expect(r.matchableSeniorIds).toEqual([])
    expect(r.lowInformation).toBe(false)
  })
})

describe('exclusions run before matching', () => {
  it('an excluded profile does not touch union, counts or evidence', () => {
    const r = run(
      { body: 'Requirements: Rust and Python', companyName: 'Acme' },
      [profile(A, ['rust']), profile(B, ['python'])],
      [exclusion({ seniorId: A })],
    )
    expect(r.matchableSeniorIds).toEqual([B])
    expect(r.rosterUnionSize).toBe(1)
    expect(kw(r)).toEqual(['python'])
    const excluded = r.seniors.find((s) => s.seniorId === A)
    expect(excluded).toEqual({
      seniorId: A,
      disposition: 'EXCLUDED',
      exclusionId: '44444444-4444-4444-8444-444444444444',
      exclusionKind: 'COMPANY',
      exclusionScope: 'SENIOR',
    })
  })

  it('unknown stack at an excluded company is excluded, not a triage candidate', () => {
    const r = run({ body: null }, [profile(A, ['rust'])], [exclusion({})])
    expect(r.lowInformation).toBe(false)
    expect(r.matchableSeniorIds).toEqual([])
  })

  it('the same unknown stack at a clean company is a triage candidate', () => {
    expect(run({ body: null }, [profile(A, ['rust'])]).lowInformation).toBe(true)
  })

  it('mixed exclusions: only the senior who stop-listed the company loses it', () => {
    const r = run(
      { body: 'python' },
      [profile(A, ['python']), profile(B, ['python'])],
      [exclusion({ seniorId: B })],
    )
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.rosterMatches[0]?.seniorIds).toEqual([A])
  })

  it("another senior's exclusion does not apply", () => {
    const r = run({ body: 'python' }, [profile(A, ['python'])], [exclusion({ seniorId: B })])
    expect(r.matchableSeniorIds).toEqual([A])
  })

  it('a GLOBAL keyword exclusion excludes everyone, against title not description', () => {
    const global = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      kind: 'KEYWORD',
      value: 'php',
      normalizedValue: 'php',
    })
    const hitTitle = run(
      { title: 'PHP Developer' },
      [profile(A, ['php']), profile(B, ['php'])],
      [global],
    )
    expect(hitTitle.matchableSeniorIds).toEqual([])
    expect(hitTitle.seniors.every((s) => s.disposition === 'EXCLUDED')).toBe(true)
    const bodyOnly = run({ body: 'php legacy' }, [profile(A, ['php'])], [global])
    expect(bodyOnly.matchableSeniorIds).toEqual([A])
  })

  it('a senior KEYWORD exclusion applies to that senior', () => {
    const kwEx = exclusion({ kind: 'KEYWORD', value: 'engineer', normalizedValue: 'engineer' })
    const r = run({ body: 'python' }, [profile(A, ['python'])], [kwEx])
    expect(r.matchableSeniorIds).toEqual([])
  })

  it('a GLOBAL company exclusion is unused (A1g) and reported, not applied', () => {
    const g = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      id: '55555555-5555-4555-8555-555555555555',
    })
    const r = run({ body: 'python' }, [profile(A, ['python'])], [g])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.ignoredExclusionIds).toEqual(['55555555-5555-4555-8555-555555555555'])
    const noId = run({ body: 'python' }, [profile(A, ['python'])], [{ ...g, id: null }])
    expect(noId.ignoredExclusionIds).toEqual([])
  })

  it('lists only the unused GLOBAL company exclusions as ignored', () => {
    const globalCompany = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      id: '55555555-5555-4555-8555-555555555555',
    })
    const globalKeyword = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      kind: 'KEYWORD',
      value: 'cobol',
      normalizedValue: 'cobol',
      id: '66666666-6666-4666-8666-666666666666',
    })
    const own = exclusion({ seniorId: B, value: 'Other', normalizedValue: 'other' })
    const r = run({ body: 'python' }, [profile(A, ['python'])], [globalCompany, globalKeyword, own])
    expect(r.ignoredExclusionIds).toEqual(['55555555-5555-4555-8555-555555555555'])
  })

  it('reports the GLOBAL exclusion when a global and a personal one both match', () => {
    const globalKw = exclusion({
      scope: 'GLOBAL',
      seniorId: null,
      kind: 'KEYWORD',
      value: 'engineer',
      normalizedValue: 'engineer',
      id: '66666666-6666-4666-8666-666666666666',
    })
    const r = run({}, [profile(A, ['python'])], [exclusion({}), globalKw])
    expect(r.seniors[0]).toMatchObject({
      disposition: 'EXCLUDED',
      exclusionScope: 'GLOBAL',
      exclusionKind: 'KEYWORD',
      exclusionId: '66666666-6666-4666-8666-666666666666',
    })
  })

  it('exclusion wins over missing team access', () => {
    const r = run({}, [profile(A, ['python'], [])], [exclusion({})])
    expect(r.seniors[0]?.disposition).toBe('EXCLUDED')
  })
})

describe('team access', () => {
  it('a senior with no active team is skipped and contributes nothing', () => {
    const r = run({ body: 'Requirements: Rust Python' }, [
      profile(A, ['rust'], []),
      profile(B, ['python']),
    ])
    expect(r.seniors.find((s) => s.seniorId === A)).toEqual({
      seniorId: A,
      disposition: 'NO_TEAM_ACCESS',
    })
    expect(r.matchableSeniorIds).toEqual([B])
    expect(r.rosterUnionSize).toBe(1)
  })

  it('profiles outside the roster are ignored', () => {
    const r = run({ body: 'python' }, [profile(A, ['python']), profile(B, ['python'])], [], [A])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.seniors).toHaveLength(1)
  })
})

describe('readiness', () => {
  it('a roster senior without a profile is a typed issue, not an empty result', () => {
    const result = matchTech({
      posting: posting(),
      rosterSeniorIds: [A, B, B],
      profiles: [profile(A, ['x'])],
      exclusions: [],
    })
    expect(result).toEqual({
      status: 'READINESS_ISSUE',
      issues: [{ code: 'MISSING_ROSTER_PROFILES', seniorIds: [B] }],
    })
  })

  it('a profile repeated three times is reported once', () => {
    const result = matchTech({
      posting: posting(),
      rosterSeniorIds: [A],
      profiles: [profile(A, []), profile(A, []), profile(A, [])],
      exclusions: [],
    })
    expect(result).toEqual({
      status: 'READINESS_ISSUE',
      issues: [{ code: 'DUPLICATE_PROFILES', seniorIds: [A] }],
    })
  })

  it('duplicate profiles are a typed issue, reported together with missing ones', () => {
    const result = matchTech({
      posting: posting(),
      rosterSeniorIds: [A, B],
      profiles: [profile(A, ['x']), profile(A, ['y'])],
      exclusions: [],
    })
    expect(result).toEqual({
      status: 'READINESS_ISSUE',
      issues: [
        { code: 'MISSING_ROSTER_PROFILES', seniorIds: [B] },
        { code: 'DUPLICATE_PROFILES', seniorIds: [A] },
      ],
    })
  })
})

describe('throughput guard', () => {
  // The CPU budget is NOT measured here: it is to be frozen from MP-05. This
  // bound is deliberately generous and only catches an accidental blow-up
  // (for example per-keyword re-tokenisation of the posting).
  it('matches a 20 000-character posting against a 150-keyword union in well under 2 s', () => {
    const body =
      `Requirements: techword149. ${'We build great products every day. '.repeat(600)}`.slice(
        0,
        20_000,
      )
    const started = performance.now()
    for (let i = 0; i < 20; i += 1) run({ body }, TECHWORD.profiles)
    const perRun = (performance.now() - started) / 20
    expect(perRun).toBeLessThan(100)
  })
})
