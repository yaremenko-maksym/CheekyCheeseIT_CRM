import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JobExclusionDto } from '@crm/shared'
import {
  forViewer,
  matchTech,
  MAX_BODY_CHARS,
  MAX_BODY_TOKENS,
  MAX_EVIDENCE_EXCERPT_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
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

/** Records every string the module hands to the tokeniser, passing the call through. */
const tokeniser = vi.hoisted(() => ({ inputs: [] as string[] }))
vi.mock('@crm/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crm/shared')>()
  return {
    ...actual,
    stackTokens: (raw: string | null | undefined) => {
      tokeniser.inputs.push(raw ?? '')
      return actual.stackTokens(raw)
    },
  }
})

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
  if (!s) throw new Error('not matchable')
  return s
}
const kw = (r: TechMatchReady) => r.rosterMatches.map((m) => m.keyword).sort()

describe('union beyond 60 — the techword fixture', () => {
  const result = () => run({ title: 'Engineer', body: TECHWORD.postingBody }, TECHWORD.profiles)
  const ids = TECHWORD.profiles.map((p) => p.seniorId)

  it('keeps the whole 150-keyword union, not 60', () => {
    expect(TECHWORD.profiles.map((p) => p.techStack.length)).toEqual([50, 50, 50])
    expect(result().rosterUnionSize).toBe(150)
  })

  it('finds techword149, techword0 and techword75, one per profile', () => {
    const r = result()
    expect(kw(r)).toEqual(TECHWORD.expectedMatches)
    expect(matched(r, ids[0] ?? '').matches.map((m) => m.keyword)).toEqual(['techword0'])
    expect(matched(r, ids[1] ?? '').matches.map((m) => m.keyword)).toEqual(['techword75'])
    expect(matched(r, ids[2] ?? '').matches.map((m) => m.keyword)).toEqual(['techword149'])
  })

  it('records which seniors hold each roster keyword', () => {
    expect(result().rosterMatches.find((m) => m.keyword === 'techword75')?.seniorIds).toEqual([
      ids[1],
    ])
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

  it.each(['no', 'not', 'without', 'excluding', 'except', 'never', 'nor'])(
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

  it('a follower word without a "not" before it negates nothing', () => {
    expect(strengthOf('Java is strictly required')).toBe('CORE')
    expect(strengthOf('Java is a must, needed')).toBe('CORE')
  })

  it('a title mention and a body mention both carry the excerpt of the body one', () => {
    const r = run({ title: 'Java', body: 'Java' }, [profile(A, ['java'])])
    expect(r.rosterMatches[0]).toMatchObject({ sources: ['TITLE', 'BODY'], excerpt: 'Java' })
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

  it('heading length counts words, however many spaces separate them', () => {
    expect(strengthOf('nice to  have   a b c d e:\nJava')).toBe('OPTIONAL')
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
    expect(r.seniors.map((s) => s.seniorId)).toEqual([B])
    expect(r.audit.excluded).toEqual([
      {
        seniorId: A,
        exclusionId: '44444444-4444-4444-8444-444444444444',
        exclusionKind: 'COMPANY',
        exclusionScope: 'SENIOR',
      },
    ])
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
    expect(hitTitle.seniors).toEqual([])
    expect(hitTitle.audit.excluded.map((e) => e.seniorId)).toEqual([A, B])
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
    expect(r.audit.ignoredExclusionIds).toEqual(['55555555-5555-4555-8555-555555555555'])
    const noId = run({ body: 'python' }, [profile(A, ['python'])], [{ ...g, id: null }])
    expect(noId.audit.ignoredExclusionIds).toEqual([])
  })

  it('a malformed GLOBAL company exclusion that carries a senior id still does not apply', () => {
    const odd = exclusion({ scope: 'GLOBAL', seniorId: A })
    const r = run({ body: 'python' }, [profile(A, ['python'])], [odd])
    expect(r.matchableSeniorIds).toEqual([A])
  })

  it("a senior's KEYWORD exclusion is not promoted to a global one", () => {
    const mine = exclusion({
      seniorId: B,
      kind: 'KEYWORD',
      value: 'engineer',
      normalizedValue: 'engineer',
    })
    const r = run({ body: 'python' }, [profile(A, ['python']), profile(B, ['python'])], [mine])
    expect(r.matchableSeniorIds).toEqual([A])
    expect(r.seniors.map((s) => s.seniorId)).toEqual([A])
    expect(r.audit.excluded.map((e) => e.seniorId)).toEqual([B])
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
    expect(r.audit.ignoredExclusionIds).toEqual(['55555555-5555-4555-8555-555555555555'])
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
    expect(r.audit.excluded[0]).toMatchObject({
      exclusionScope: 'GLOBAL',
      exclusionKind: 'KEYWORD',
      exclusionId: '66666666-6666-4666-8666-666666666666',
    })
  })

  it('exclusion wins over missing team access', () => {
    const r = run({}, [profile(A, ['python'], [])], [exclusion({})])
    expect(r.audit.excluded.map((e) => e.seniorId)).toEqual([A])
    expect(r.audit.noTeamAccess).toEqual([])
  })
})

describe('team access', () => {
  it('a senior with no active team is skipped and contributes nothing', () => {
    const r = run({ body: 'Requirements: Rust Python' }, [
      profile(A, ['rust'], []),
      profile(B, ['python']),
    ])
    expect(r.audit.noTeamAccess).toEqual([A])
    expect(r.seniors.map((s) => s.seniorId)).toEqual([B])
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

describe('single tokenisation (the deterministic throughput guard)', () => {
  it('hands each character of title, tags and body to the tokeniser at most once', () => {
    const title = 'Java Developer'
    const tags = ['Kotlin', 'remote']
    const body = ['Requirements:', 'Strong Java, Kotlin and Spring.', 'Nice to have: Docker.'].join(
      '\n',
    )
    tokeniser.inputs.length = 0
    run({ title, tags, body }, [profile(A, ['java', 'kotlin', 'docker'])])
    const seen = tokeniser.inputs.filter((s) => s.length > 0)
    const budget = title.length + tags.join('').length + body.length
    expect(seen.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(budget)
    expect(seen.filter((s) => s === title)).toHaveLength(1)
    expect(seen.filter((s) => s === 'Kotlin')).toHaveLength(1)
    expect(seen.filter((s) => s === 'Requirements:')).toHaveLength(1)
    expect(seen.join('|')).toContain('Strong Java')
    expect(seen.join('|')).toContain('Docker.')
  })

  it('a posting of N lines costs N tokeniser inputs per surface, not 2N', () => {
    const body = Array.from({ length: 50 }, (_, i) => `Line ${i} about java`).join('\n')
    tokeniser.inputs.length = 0
    run({ title: 'x', body }, [profile(A, ['java'])])
    expect(tokeniser.inputs.filter((s) => s.startsWith('Line ')).length).toBe(50)
  })
})

describe('input bounds are flagged, never silent', () => {
  const flag = (p: Partial<TechMatchPosting>) => run(p, [profile(A, ['java'])]).inputTruncated

  it('100k repeated tokens finish in well under a second and are flagged', () => {
    const started = performance.now()
    const r = run({ body: 'java '.repeat(100_000) }, [profile(A, ['java'])])
    expect(performance.now() - started).toBeLessThan(1000)
    expect(r.inputTruncated).toBe(true)
    expect(r.rosterMatches[0]?.keyword).toBe('java')
  })

  it('a body of exactly MAX_BODY_CHARS is not truncated, one more character is', () => {
    expect(MAX_BODY_CHARS).toBe(20_000)
    expect(flag({ body: 'a'.repeat(MAX_BODY_CHARS) })).toBe(false)
    expect(flag({ body: 'a'.repeat(MAX_BODY_CHARS + 1) })).toBe(true)
    expect(flag({ body: null })).toBe(false)
  })

  it('characters beyond MAX_BODY_CHARS are not read', () => {
    const body = `${'x'.repeat(MAX_BODY_CHARS)} java`
    const r = run({ body }, [profile(A, ['java'])])
    expect(r.rosterMatches).toEqual([])
    expect(r.inputTruncated).toBe(true)
  })

  it('the token budget is shared across clauses and sentences', () => {
    const half = MAX_BODY_TOKENS / 2
    const fits = `${'x '.repeat(half)}, ${'x '.repeat(half - 1)}java`
    const r = run({ body: fits }, [profile(A, ['java'])])
    expect(r.inputTruncated).toBe(false)
    expect(r.rosterMatches).toHaveLength(1)
    const over = `${'x '.repeat(half)}, ${'x '.repeat(half)}java`
    const cut = run({ body: over }, [profile(A, ['java'])])
    expect(cut.inputTruncated).toBe(true)
    expect(cut.rosterMatches).toEqual([])
    const sentences = `${'x '.repeat(half)}. ${'x '.repeat(half)}. java`
    expect(run({ body: sentences }, [profile(A, ['java'])]).inputTruncated).toBe(true)
  })

  it('exactly MAX_BODY_TOKENS tokens are read, the next one is cut and flagged', () => {
    expect(MAX_BODY_TOKENS).toBe(8000)
    const fits = run({ body: `${'x '.repeat(MAX_BODY_TOKENS - 1)}java` }, [profile(A, ['java'])])
    expect(fits.inputTruncated).toBe(false)
    expect(fits.rosterMatches).toHaveLength(1)
    const exact = run({ body: 'x '.repeat(MAX_BODY_TOKENS) }, [profile(A, ['java'])])
    expect(exact.inputTruncated).toBe(false)
    const over = run({ body: `${'x '.repeat(MAX_BODY_TOKENS)}java` }, [profile(A, ['java'])])
    expect(over.inputTruncated).toBe(true)
    expect(over.rosterMatches).toEqual([])
  })

  it('a title over MAX_TITLE_CHARS is cut and flagged', () => {
    expect(flag({ title: 'a'.repeat(MAX_TITLE_CHARS) })).toBe(false)
    expect(flag({ title: 'a'.repeat(MAX_TITLE_CHARS + 1) })).toBe(true)
    const cut = run({ title: `${'a'.repeat(MAX_TITLE_CHARS)} java` }, [profile(A, ['java'])])
    expect(cut.rosterMatches).toEqual([])
  })

  it('more than MAX_TAGS tags, or a tag over MAX_TAG_CHARS, is cut and flagged', () => {
    const many = (n: number) => Array.from({ length: n }, () => 'a')
    expect(flag({ tags: many(MAX_TAGS) })).toBe(false)
    expect(flag({ tags: many(MAX_TAGS + 1) })).toBe(true)
    expect(flag({ tags: ['a'.repeat(MAX_TAG_CHARS)] })).toBe(false)
    expect(flag({ tags: ['a'.repeat(MAX_TAG_CHARS + 1)] })).toBe(true)
    const lastTag = [...many(MAX_TAGS), 'java']
    expect(run({ tags: lastTag }, [profile(A, ['java'])]).rosterMatches).toEqual([])
    const longTag = run({ tags: [`${'a'.repeat(MAX_TAG_CHARS)} java`] }, [profile(A, ['java'])])
    expect(longTag.rosterMatches).toEqual([])
  })
})

describe('inherited object keys in a profile (SR-H-1)', () => {
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'prototype'])(
    'a profile keyword "%s" neither throws nor pollutes',
    (name) => {
      const r = run({ body: 'plain text' }, [profile(A, [name, 'java'])])
      expect(r.rosterMatches).toEqual([])
      const hit = run({ body: `we use ${name} daily` }, [profile(A, [name])])
      expect(hit.rosterMatches).toHaveLength(1)
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
      expect(Object.keys(Object.prototype)).toEqual([])
    },
  )
})

describe('Requirements heading and clause-bounded cues', () => {
  it('a Requirements heading with unrelated bullets is a core mismatch, not low information', () => {
    const r = run({ body: 'Requirements:\n- Free lunch\n- A ping-pong table' }, [
      profile(A, ['python']),
    ])
    expect(r.evidenceSurfaces.requirements).toBe(true)
    expect(r.lowInformation).toBe(false)
    expect(matched(r, A).coreMismatch).toBe(true)
  })

  it('a heading that names no stack is not a requirements statement', () => {
    const r = run({ body: 'About us:\nFree lunch' }, [profile(A, ['python'])])
    expect(r.evidenceSurfaces.requirements).toBe(false)
    expect(r.lowInformation).toBe(true)
  })

  const strengths = (body: string, stack: string[]) => {
    const r = run({ body }, [profile(A, stack)])
    return Object.fromEntries(
      [...r.rosterMatches, ...r.rosterNegated].map((m) => [m.keyword, m.strength]),
    )
  }

  it('a negation stops at the comma', () => {
    expect(strengths('No degree required, Python, Java', ['python', 'java'])).toEqual({
      python: 'CORE',
      java: 'CORE',
    })
    expect(strengths('No travel, Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('without Java', ['java'])).toEqual({ java: 'NEGATED' })
  })

  it('a negation stops at a comma or colon with no following space', () => {
    expect(strengths('No travel,Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('No travel,Java,Python', ['java', 'python'])).toEqual({
      java: 'CORE',
      python: 'CORE',
    })
    expect(strengths('No relocation:Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('no Rust,Java', ['java', 'rust'])).toEqual({ java: 'CORE', rust: 'NEGATED' })
    expect(strengths('Java,Python', ['java', 'python'])).toEqual({ java: 'CORE', python: 'CORE' })
  })

  it('numbers with a comma or colon and URLs do not change keyword hits', () => {
    expect(strengths('No travel 3,5 years Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('no 10:30 shift,Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('https://x.io/a,b Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('3,5 years Java, 1,000 users Python', ['java', 'python'])).toEqual({
      java: 'CORE',
      python: 'CORE',
    })
  })

  it('a negation stops at a colon, a bullet glyph and a newline', () => {
    expect(strengths('No relocation: Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('• no Rust • Java', ['java', 'rust'])).toEqual({
      java: 'CORE',
      rust: 'NEGATED',
    })
    expect(strengths('no\nJava', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('no Rust; Java', ['java', 'rust'])).toEqual({ java: 'CORE', rust: 'NEGATED' })
  })

  it('"non-trivial Python" is a requirement, not a negation', () => {
    expect(strengths('non-trivial Python', ['python'])).toEqual({ python: 'CORE' })
  })

  it('a trailing "not required" does not reach into the next clause', () => {
    expect(strengths('Java, not required', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('Java is not required, Rust', ['java', 'rust'])).toEqual({
      java: 'NEGATED',
      rust: 'CORE',
    })
  })

  it('only a "not" AFTER the keyword counts as trailing', () => {
    expect(strengths('not required x y Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('Java required not', ['java'])).toEqual({ java: 'CORE' })
  })

  it('optionality covers every clause of its sentence', () => {
    expect(strengths('Nice to have: Docker, K8s', ['docker', 'kubernetes'])).toEqual({
      docker: 'OPTIONAL',
      kubernetes: 'OPTIONAL',
    })
    expect(strengths('Docker, K8s are a plus', ['docker', 'kubernetes'])).toEqual({
      docker: 'OPTIONAL',
      kubernetes: 'OPTIONAL',
    })
  })

  it('Ukrainian negation and optional cues read as CORE (documented fail-open)', () => {
    expect(strengths('Без Java', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('Java буде перевагою', ['java'])).toEqual({ java: 'CORE' })
    expect(strengths('Java не потрібна', ['java'])).toEqual({ java: 'CORE' })
  })
})

describe('forViewer — no excluded senior or exclusion identifier leaks (SR-M-2)', () => {
  const C = '77777777-7777-4777-8777-777777777777'
  const D = '88888888-8888-4888-8888-888888888888'
  const EXCLUSION_ID = '99999999-9999-4999-8999-999999999999'
  const build = () =>
    run(
      { body: 'Requirements: Python, Rust', companyName: 'Acme' },
      [
        profile(A, ['python']),
        profile(B, ['rust']),
        profile(C, ['python'], []),
        profile(D, ['cobol']),
      ],
      [exclusion({ seniorId: B, id: EXCLUSION_ID })],
    )

  it('the full result keeps who was excluded under audit only', () => {
    const r = build()
    expect(r.audit.excluded.map((e) => e.seniorId)).toEqual([B])
    expect(r.audit.noTeamAccess).toEqual([C])
    expect(JSON.stringify(r.seniors)).not.toContain(B)
    expect(JSON.stringify(r.seniors)).not.toContain(EXCLUSION_ID)
  })

  it('the viewer shape has no audit and nothing about excluded or inaccessible seniors', () => {
    const view = forViewer(build(), { visibleSeniorIds: [A, B, C] })
    const text = JSON.stringify(view)
    expect('audit' in view).toBe(false)
    for (const secret of [B, C, EXCLUSION_ID, 'exclusion', 'noTeamAccess', 'audit']) {
      expect(text).not.toContain(secret)
    }
    expect(view.matchableSeniorIds).toEqual([A])
    expect(view.seniors.map((s) => s.seniorId)).toEqual([A])
  })

  it('shows only the given seniors and recomputes the aggregates from them', () => {
    const r = build()
    const view = forViewer(r, { visibleSeniorIds: [D] })
    expect(view.seniors.map((s) => s.seniorId)).toEqual([D])
    expect(view.rosterMatches).toEqual([])
    expect(view.rosterUnionSize).toBe(1)
    expect(JSON.stringify(view)).not.toContain(A)
    expect(view.seniors[0]?.coreMismatch).toBe(true)
    expect(forViewer(r, { visibleSeniorIds: [A] }).rosterMatches[0]?.seniorIds).toEqual([A])
    expect(forViewer(r, { visibleSeniorIds: [A, D] }).rosterUnionSize).toBe(2)
  })

  it('low information is judged for the viewer, not for the whole roster', () => {
    const r = run({ body: 'Chatting.', title: 'Dev' }, [profile(A, ['python']), profile(B, ['x'])])
    const withHit = run({ title: 'Python' }, [profile(A, ['python']), profile(B, ['rust'])])
    expect(r.lowInformation).toBe(true)
    expect(withHit.lowInformation).toBe(false)
    expect(forViewer(withHit, { visibleSeniorIds: [B] }).lowInformation).toBe(true)
    expect(forViewer(withHit, { visibleSeniorIds: [A] }).lowInformation).toBe(false)
    expect(forViewer(withHit, { visibleSeniorIds: [] }).lowInformation).toBe(false)
  })

  it('a visible matched hit and a visible negated hit together are a keyword hit', () => {
    const r = run({ body: 'No Rust.\nPython' }, [profile(A, ['rust']), profile(B, ['python'])])
    const view = forViewer(r, { visibleSeniorIds: [A, B] })
    expect(view.evidenceSurfaces.keywordHit).toBe(true)
    expect(view.lowInformation).toBe(false)
  })

  it('coreMismatch is recomputed per viewer in every case', () => {
    const r = run({ body: 'Requirements: Python' }, [
      profile(A, ['python']),
      profile(B, ['cobol']),
      profile(C, []),
    ])
    const view = forViewer(r, { visibleSeniorIds: [A, B, C] })
    const byId = Object.fromEntries(view.seniors.map((s) => [s.seniorId, s.coreMismatch]))
    expect(byId).toEqual({ [A]: false, [B]: true, [C]: false })
    const low = run({ body: 'Chatting.' }, [profile(A, ['rust'])])
    expect(forViewer(low, { visibleSeniorIds: [A] }).seniors[0]?.coreMismatch).toBe(false)
    const withHit = run({ title: 'Python' }, [profile(A, ['python']), profile(B, ['rust'])])
    expect(withHit.seniors.find((s) => s.seniorId === B)?.coreMismatch).toBe(true)
    expect(forViewer(withHit, { visibleSeniorIds: [B] }).seniors[0]?.coreMismatch).toBe(false)
  })

  it('passes the posting-level facts through unchanged', () => {
    const r = run({ tags: ['x'], body: 'Skills', title: 'Python' }, [profile(A, ['python'])])
    const view = forViewer(r, { visibleSeniorIds: [A] })
    expect(view.evidenceSurfaces).toEqual({ tags: true, requirements: true, keywordHit: true })
    expect(view.inputTruncated).toBe(false)
    expect(view.status).toBe('READY')
    expect(
      forViewer(run({ body: 'a'.repeat(MAX_BODY_CHARS + 1) }, [profile(A, ['x'])]), {
        visibleSeniorIds: [A],
      }).inputTruncated,
    ).toBe(true)
  })

  it('a viewer sees negated keywords of visible seniors and none of hidden ones', () => {
    const r = run({ body: 'No Rust.\nPython' }, [profile(A, ['rust']), profile(B, ['python'])])
    expect(forViewer(r, { visibleSeniorIds: [A] }).rosterNegated.map((m) => m.keyword)).toEqual([
      'rust',
    ])
    expect(forViewer(r, { visibleSeniorIds: [B] }).rosterNegated).toEqual([])
  })
})

describe('throughput guard — secondary wall-clock bound', () => {
  // The deterministic guard is the tokeniser-call test above. The CPU budget is
  // NOT measured here: it is to be frozen from MP-05.
  it('matches a 20 000-character posting against a 150-keyword union at under 100 ms per run', () => {
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
