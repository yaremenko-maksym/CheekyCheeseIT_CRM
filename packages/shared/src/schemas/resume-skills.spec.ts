import { describe, expect, it } from 'vitest'
import { SKILL_SYNONYM_GROUPS, canonicalSkill, mentionsSkill, mergeSkills } from './resume-skills'

describe('canonicalSkill', () => {
  it.each([
    ['nodejs', 'Node.js'],
    ['NodeJS', 'Node.js'],
    ['node', 'Node.js'],
    ['Node JS', 'Node.js'],
    ['node.js', 'Node.js'],
    ['aws', 'Amazon Web Services (AWS)'],
    ['Amazon Web Services', 'Amazon Web Services (AWS)'],
    ['gcp', 'Google Cloud Platform (GCP)'],
    ['k8s', 'Kubernetes'],
    ['postgres', 'PostgreSQL'],
    ['golang', 'Go'],
    ['ts', 'TypeScript'],
    ['js', 'JavaScript'],
    ['reactjs', 'React'],
    ['vue', 'Vue.js'],
    ['nextjs', 'Next.js'],
    ['dotnet', '.NET'],
    ['csharp', 'C#'],
    ['c#', 'C#'],
    ['cpp', 'C++'],
    ['ci-cd', 'CI/CD'],
    ['RESTful', 'REST'],
  ])('%s -> %s', (raw, expected) => {
    expect(canonicalSkill(raw)).toBe(expected)
  })

  it('passes an unknown skill through, trimmed', () => {
    expect(canonicalSkill('Elixir')).toBe('Elixir')
    expect(canonicalSkill('  Elixir  ')).toBe('Elixir')
  })

  it('collapses spaces, dots and hyphens in the lookup key', () => {
    expect(canonicalSkill('Type Script')).toBe('TypeScript')
    expect(canonicalSkill('Mongo-DB')).toBe('MongoDB')
    expect(canonicalSkill('React JS')).toBe('React')
    expect(canonicalSkill('vue-js')).toBe('Vue.js')
  })

  it('keeps symbols distinct: C, C#, C++ and Java, JavaScript are different skills', () => {
    expect(canonicalSkill('C')).toBe('C')
    expect(canonicalSkill('C#')).toBe('C#')
    expect(canonicalSkill('C++')).toBe('C++')
    expect(canonicalSkill('java')).toBe('Java')
    expect(canonicalSkill('javascript')).toBe('JavaScript')
  })

  it('returns every canonical unchanged', () => {
    for (const { canonical } of SKILL_SYNONYM_GROUPS) {
      expect(canonicalSkill(canonical)).toBe(canonical)
    }
  })
})

describe('SKILL_SYNONYM_GROUPS', () => {
  it('holds exactly the seed vocabulary and its aliases', () => {
    expect(SKILL_SYNONYM_GROUPS).toEqual([
      { canonical: 'JavaScript', aliases: ['JS', 'ECMAScript'] },
      { canonical: 'TypeScript', aliases: ['TS'] },
      { canonical: 'Python', aliases: ['Python3', 'Python 3'] },
      { canonical: 'Go', aliases: ['Golang'] },
      { canonical: 'Java', aliases: [] },
      { canonical: 'Kotlin', aliases: [] },
      { canonical: 'C#', aliases: ['C Sharp'] },
      { canonical: 'C++', aliases: ['CPP'] },
      { canonical: 'Node.js', aliases: ['Node', 'NodeJS', 'Node JS'] },
      { canonical: 'React', aliases: ['React.js', 'ReactJS'] },
      { canonical: 'Next.js', aliases: ['NextJS'] },
      { canonical: 'Vue.js', aliases: ['Vue', 'VueJS'] },
      { canonical: 'Angular', aliases: ['AngularJS', 'Angular.js'] },
      { canonical: '.NET', aliases: ['dotnet', 'dot net'] },
      { canonical: 'PostgreSQL', aliases: ['Postgres', 'psql'] },
      { canonical: 'MySQL', aliases: [] },
      { canonical: 'MongoDB', aliases: ['Mongo', 'Mongo DB'] },
      { canonical: 'Redis', aliases: [] },
      { canonical: 'Docker', aliases: [] },
      { canonical: 'Kubernetes', aliases: ['K8s', 'kube'] },
      { canonical: 'Amazon Web Services (AWS)', aliases: ['AWS', 'Amazon Web Services'] },
      {
        canonical: 'Google Cloud Platform (GCP)',
        aliases: ['GCP', 'Google Cloud', 'Google Cloud Platform'],
      },
      { canonical: 'Azure', aliases: ['Microsoft Azure'] },
      { canonical: 'Terraform', aliases: [] },
      { canonical: 'CI/CD', aliases: ['CICD', 'CI-CD', 'CI CD'] },
      { canonical: 'GraphQL', aliases: ['Graph QL'] },
      { canonical: 'REST', aliases: ['REST API', 'RESTful', 'RESTful API'] },
    ])
  })

  it('never lets one spelling belong to two groups', () => {
    const owners = new Map<string, string>()
    for (const { canonical, aliases } of SKILL_SYNONYM_GROUPS) {
      for (const spelling of [canonical, ...aliases]) {
        const owner = canonicalSkill(spelling)
        expect(owner, `${spelling} resolved to ${owner}, expected ${canonical}`).toBe(canonical)
        owners.set(spelling, canonical)
      }
    }
    expect(owners.size).toBeGreaterThan(SKILL_SYNONYM_GROUPS.length)
  })
})

describe('mergeSkills', () => {
  it('merges skills and per-job technologies in first-seen order, deduplicated', () => {
    expect(mergeSkills(['React', 'react'], [['TypeScript', 'Node JS']])).toEqual([
      'React',
      'TypeScript',
      'Node.js',
    ])
  })

  it('deduplicates across lists and aliases, canonicalising the first occurrence', () => {
    expect(
      mergeSkills(['nodejs', 'Elixir'], [['Node.js', 'elixir'], ['AWS'], ['aws', 'Go']]),
    ).toEqual(['Node.js', 'Elixir', 'Amazon Web Services (AWS)', 'Go'])
  })

  it('drops blank entries', () => {
    expect(mergeSkills(['', '  ', 'Redis'], [['   ']])).toEqual(['Redis'])
  })

  it('returns an empty list for empty input', () => {
    expect(mergeSkills([], [])).toEqual([])
  })
})

describe('mentionsSkill', () => {
  it('does not match a skill inside a longer token', () => {
    expect(mentionsSkill('JavaScript developer', 'Java')).toBe(false)
    expect(mentionsSkill('wrote C++ services', 'C')).toBe(false)
    expect(mentionsSkill('wrote C# services', 'C')).toBe(false)
    expect(mentionsSkill('TypeScript only', 'Type')).toBe(false)
  })

  it('treats # + . as part of the token', () => {
    expect(mentionsSkill('used C# daily', 'C#')).toBe(true)
    expect(mentionsSkill('on .NET 8', '.NET')).toBe(true)
    expect(mentionsSkill('modern C++ code', 'C++')).toBe(true)
    expect(mentionsSkill('used C# daily', 'C++')).toBe(false)
  })

  it('matches a standalone token, case-insensitively, next to punctuation', () => {
    expect(mentionsSkill('Java, Kotlin.', 'java')).toBe(true)
    expect(mentionsSkill('C++ and C.', 'C')).toBe(true)
    expect(mentionsSkill('(Python)', 'Python')).toBe(true)
  })

  it('matches any spelling of the skill group', () => {
    expect(mentionsSkill('deployed on AWS', 'Amazon Web Services (AWS)')).toBe(true)
    expect(mentionsSkill('built APIs in NodeJS', 'Node.js')).toBe(true)
    expect(mentionsSkill('ran k8s clusters', 'Kubernetes')).toBe(true)
    expect(mentionsSkill('ran k8s clusters', 'kube')).toBe(true)
  })

  it('matches a multi-word skill only as a contiguous phrase', () => {
    expect(mentionsSkill('Amazon Web Services', 'aws')).toBe(true)
    expect(mentionsSkill('Amazon sells; Web Services elsewhere', 'aws')).toBe(false)
  })

  it('returns false for an unrelated text, an empty text or a blank skill', () => {
    expect(mentionsSkill('Python and Django', 'Ruby')).toBe(false)
    expect(mentionsSkill('', 'Python')).toBe(false)
    expect(mentionsSkill('', '')).toBe(false)
    expect(mentionsSkill('Python', '   ')).toBe(false)
  })
})
