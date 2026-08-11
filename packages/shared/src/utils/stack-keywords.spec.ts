import { describe, expect, it } from 'vitest'
import {
  canonicalStackKeyword,
  canonicalStackKeywords,
  normalizeStackKeyword,
  stackMatchScore,
  stackTokens,
  textMentionsStackKeyword,
} from './stack-keywords'

/**
 * task-vacancy-matching AC2: "Каждый класс нормализации закреплён отдельным
 * тестом, включая ОТРИЦАТЕЛЬНЫЕ: `Java` не совпадает с `JavaScript`."
 *
 * Same discipline as company-name.spec.ts and for the same reason: one lumped
 * "normalizes stack keywords" test goes green while a whole class silently
 * regresses. Here the stakes run BOTH ways — a class that stops folding costs
 * the senior a relevant vacancy, and a class that folds too eagerly buries their
 * queue under the junk this feature exists to remove. So every class gets a
 * named test, and the classes most likely to over-match get an explicit
 * negative twin.
 *
 * The spellings are not invented: they were mined from 250 real DOU postings
 * (10 categories, 2026-08-12) — see the module header for the occurrence counts.
 */

/** A posting that says `text` in its body and nothing in particular in its title. */
const body = (text: string) => ({ title: 'Developer', body: text })
/** A posting that says `text` in its title. */
const title = (text: string) => ({ title: text, body: '' })

describe('stack keyword normalization — one test per class (AC2)', () => {
  it('class: letter case', () => {
    expect(canonicalStackKeyword('DOCKER')).toBe(canonicalStackKeyword('docker'))
    expect(canonicalStackKeyword('PostgreSQL')).toBe(canonicalStackKeyword('postgresql'))
  })

  it('class: `Postgres` = `PostgreSQL` = `psql`', () => {
    const expected = canonicalStackKeyword('PostgreSQL')
    expect(canonicalStackKeyword('Postgres')).toBe(expected)
    expect(canonicalStackKeyword('postgres')).toBe(expected)
    expect(canonicalStackKeyword('psql')).toBe(expected)
  })

  it('class: `K8s` = `Kubernetes`', () => {
    const expected = canonicalStackKeyword('Kubernetes')
    expect(canonicalStackKeyword('K8s')).toBe(expected)
    expect(canonicalStackKeyword('k8s')).toBe(expected)
    expect(canonicalStackKeyword('kube')).toBe(expected)
  })

  it('class: `CI/CD` = `CICD` = `CI CD` = `CI-CD`', () => {
    const expected = canonicalStackKeyword('CI/CD')
    expect(canonicalStackKeyword('CICD')).toBe(expected)
    expect(canonicalStackKeyword('CI CD')).toBe(expected)
    expect(canonicalStackKeyword('CI-CD')).toBe(expected)
    expect(canonicalStackKeyword('ci / cd')).toBe(expected)
  })

  it('class: `Node` = `Node.js` = `NodeJS`', () => {
    const expected = canonicalStackKeyword('Node.js')
    expect(canonicalStackKeyword('Node')).toBe(expected)
    expect(canonicalStackKeyword('NodeJS')).toBe(expected)
    expect(canonicalStackKeyword('node js')).toBe(expected)
  })

  it('class: `JS` = `JavaScript`', () => {
    expect(canonicalStackKeyword('JS')).toBe(canonicalStackKeyword('JavaScript'))
    expect(canonicalStackKeyword('js')).toBe(canonicalStackKeyword('ECMAScript'))
  })

  it('class: `TS` = `TypeScript`', () => {
    expect(canonicalStackKeyword('TS')).toBe(canonicalStackKeyword('TypeScript'))
  })

  it('class: `.NET` = `dotnet` = `.NET Core`', () => {
    const expected = canonicalStackKeyword('.NET')
    expect(canonicalStackKeyword('dotnet')).toBe(expected)
    expect(canonicalStackKeyword('.NET Core')).toBe(expected)
    expect(canonicalStackKeyword('NET Core')).toBe(expected)
  })

  it('class: symbol-bearing names survive tokenisation (`C#`, `C++`)', () => {
    // Without the pre-tokenisation rewrite both fold to the bare letter `c`,
    // making C# and C++ the same keyword — and both equal to a stray "C".
    expect(canonicalStackKeyword('C#')).toBe(canonicalStackKeyword('C Sharp'))
    expect(canonicalStackKeyword('C++')).toBe(canonicalStackKeyword('cpp'))
    expect(canonicalStackKeyword('C#')).not.toBe(canonicalStackKeyword('C++'))
    expect(canonicalStackKeyword('C#')).not.toBe(canonicalStackKeyword('C'))
  })

  it('class: `Go` = `Golang`', () => {
    expect(canonicalStackKeyword('Go')).toBe(canonicalStackKeyword('Golang'))
  })

  it('class: `Mongo` = `MongoDB`', () => {
    expect(canonicalStackKeyword('Mongo')).toBe(canonicalStackKeyword('MongoDB'))
    expect(canonicalStackKeyword('mongo db')).toBe(canonicalStackKeyword('MongoDB'))
  })

  it('class: `React` = `React.js` = `ReactJS`', () => {
    const expected = canonicalStackKeyword('React')
    expect(canonicalStackKeyword('React.js')).toBe(expected)
    expect(canonicalStackKeyword('ReactJS')).toBe(expected)
  })

  it('class: cloud vendors (`GCP` = `Google Cloud`, `AWS` = `Amazon Web Services`)', () => {
    expect(canonicalStackKeyword('GCP')).toBe(canonicalStackKeyword('Google Cloud'))
    expect(canonicalStackKeyword('AWS')).toBe(canonicalStackKeyword('Amazon Web Services'))
  })

  it('class: punctuation and spacing noise', () => {
    expect(canonicalStackKeyword('  Node.js  ')).toBe(canonicalStackKeyword('Node.js'))
    expect(canonicalStackKeyword('Rabbit MQ')).toBe(canonicalStackKeyword('RabbitMQ'))
  })

  it('class: an unknown technology canonicalises to itself, never to nothing', () => {
    // The alias table folds competing SPELLINGS; it is not an allow-list of
    // technologies. A senior writing Terraform must still be matched on it.
    expect(canonicalStackKeyword('Terraform')).toBe('terraform')
    expect(canonicalStackKeyword('Snowflake')).toBe('snowflake')
  })

  it('class: input with no letters or digits normalises to empty', () => {
    expect(canonicalStackKeyword('—')).toBe('')
    expect(canonicalStackKeyword('   ')).toBe('')
    expect(canonicalStackKeyword(null)).toBe('')
    expect(canonicalStackKeyword(undefined)).toBe('')
  })
})

describe('NEGATIVE classes — substring bleed must not happen (AC2)', () => {
  it('`Java` is NOT `JavaScript` (the headline false positive)', () => {
    expect(canonicalStackKeyword('Java')).not.toBe(canonicalStackKeyword('JavaScript'))
    // …and the matcher agrees, which is the half that actually ships.
    expect(textMentionsStackKeyword('java', body('Strong JavaScript and TypeScript'))).toBe(false)
    expect(textMentionsStackKeyword('java', title('Senior JavaScript Engineer'))).toBe(false)
  })

  it('`JavaScript` is NOT `Java` (the same bleed, other direction)', () => {
    expect(textMentionsStackKeyword('javascript', body('Strong Java 17 and Spring'))).toBe(false)
  })

  it('`Java` DOES match a real Java posting (the fold must not over-correct)', () => {
    expect(textMentionsStackKeyword('java', body('Java 17, Spring Boot, Hibernate'))).toBe(true)
    expect(textMentionsStackKeyword('java', title('Senior Java Developer'))).toBe(true)
  })

  it('`R` matches nothing it merely prefixes — React, Ruby, Rust, Redis', () => {
    expect(textMentionsStackKeyword('r', body('React, Ruby, Rust and Redis'))).toBe(false)
    expect(textMentionsStackKeyword('r', title('React Native Developer'))).toBe(false)
  })

  it('`R` does not match an R&D department', () => {
    // `R&D` tokenises to [r, d] without the rewrite, which CONTAINS the
    // one-token phrase [r] — so every vacancy mentioning an R&D team would
    // score a point for a senior who knows R.
    expect(textMentionsStackKeyword('r', body('Join our R&D team'))).toBe(false)
    expect(textMentionsStackKeyword('r', body('R & D department'))).toBe(false)
  })

  it('`R` still matches a genuine standalone mention', () => {
    expect(textMentionsStackKeyword('r', body('Statistics in R and Python'))).toBe(true)
  })

  it('`.NET` is not the English word "net"', () => {
    expect(textMentionsStackKeyword('dotnet', body('improve net revenue and net margin'))).toBe(
      false,
    )
    expect(textMentionsStackKeyword('dotnet', body('Experience with .NET 8'))).toBe(true)
    expect(textMentionsStackKeyword('dotnet', body('ASP.NET Core services'))).toBe(true)
  })

  it('`C#` is not matched by a bare letter C, and vice versa', () => {
    expect(textMentionsStackKeyword('csharp', body('C and assembly experience'))).toBe(false)
    expect(textMentionsStackKeyword('csharp', body('C# and .NET'))).toBe(true)
  })

  it('a keyword is not matched by a longer word that contains it', () => {
    expect(textMentionsStackKeyword('go', body('ongoing projects and good English'))).toBe(false)
    expect(textMentionsStackKeyword('vue', body('revue of the architecture'))).toBe(false)
    expect(textMentionsStackKeyword('kubernetes', body('kubernetesque tooling'))).toBe(false)
  })
})

describe('ambiguous spellings are honoured in a title, not in prose', () => {
  it('`Go Developer` in the title counts as Golang', () => {
    expect(textMentionsStackKeyword('golang', title('Senior Go Developer'))).toBe(true)
  })

  it('"go to market" in the body does NOT count as Golang', () => {
    expect(textMentionsStackKeyword('golang', body('help us go to market faster, on the go'))).toBe(
      false,
    )
  })

  it('the unambiguous spelling still matches anywhere in the body', () => {
    expect(textMentionsStackKeyword('golang', body('our backend is written in Golang'))).toBe(true)
  })

  it('`node` in "worker node" prose does not count, `Node.js` does', () => {
    expect(textMentionsStackKeyword('nodejs', body('drain the worker node before upgrade'))).toBe(
      false,
    )
    expect(textMentionsStackKeyword('nodejs', body('backend on Node.js and Express'))).toBe(true)
  })

  it('`rest` in "the rest of the team" does not count, `REST API` does', () => {
    expect(textMentionsStackKeyword('rest api', body('the rest of the team is remote'))).toBe(false)
    expect(textMentionsStackKeyword('rest api', body('design REST APIs for partners'))).toBe(true)
  })
})

describe('stackTokens / normalizeStackKeyword', () => {
  it('splits on punctuation but keeps rewritten symbol names whole', () => {
    expect(stackTokens('C++, C#, .NET')).toEqual(['cplusplus', 'csharp', 'dotnet'])
  })

  it('folds a Cyrillic spelling onto the Latin one', () => {
    expect(normalizeStackKeyword('Пайтон')).toBe('paiton')
    expect(stackTokens('Досвід з Docker')).toContain('docker')
  })

  it('returns an empty list for blank input', () => {
    expect(stackTokens('')).toEqual([])
    expect(stackTokens(null)).toEqual([])
  })
})

describe('canonicalStackKeywords — the senior stack, de-duplicated', () => {
  it('collapses different spellings of one technology into one keyword', () => {
    expect(canonicalStackKeywords(['Node.js', 'NodeJS', 'node'])).toHaveLength(1)
    expect(canonicalStackKeywords(['Postgres', 'PostgreSQL'])).toHaveLength(1)
  })

  it('preserves the order the senior listed them in', () => {
    expect(canonicalStackKeywords(['Docker', 'Java', 'K8s'])).toEqual([
      'docker',
      'java',
      'kubernetes',
    ])
  })

  it('drops entries that carry no letters or digits', () => {
    expect(canonicalStackKeywords(['Docker', '—', '   ', 'Java'])).toEqual(['docker', 'java'])
  })

  it('returns an empty list for a missing stack', () => {
    expect(canonicalStackKeywords(null)).toEqual([])
    expect(canonicalStackKeywords([])).toEqual([])
  })
})

describe('stackMatchScore — the ranking signal (AC1)', () => {
  const stack = ['Java', 'Spring Boot', 'PostgreSQL', 'Docker']

  it('scores a posting that names most of the stack near 1', () => {
    const result = stackMatchScore(
      {
        title: 'Senior Java Developer',
        body: 'Spring Boot, PostgreSQL, Docker, Kubernetes',
      },
      stack,
    )
    expect(result.score).toBe(1)
    expect(result.total).toBe(4)
    expect(result.matched).toEqual(['java', 'spring boot', 'postgresql', 'docker'])
  })

  it('scores an unrelated posting 0 — this is what pushes junk down the queue', () => {
    const result = stackMatchScore(
      { title: 'Middle PHP Developer', body: 'Laravel, MySQL, jQuery' },
      stack,
    )
    expect(result.score).toBe(0)
    expect(result.matched).toEqual([])
  })

  it('a JavaScript posting does not score for a Java senior', () => {
    const result = stackMatchScore(
      { title: 'Senior JavaScript Engineer', body: 'React, Node.js, TypeScript' },
      stack,
    )
    expect(result.score).toBe(0)
  })

  it('scores partial overlap proportionally', () => {
    const result = stackMatchScore(
      { title: 'Backend Engineer', body: 'PostgreSQL and Docker, some Go' },
      stack,
    )
    expect(result.score).toBe(0.5)
    expect(result.matched).toEqual(['postgresql', 'docker'])
  })

  it('recognises the alternative spellings, not just the exact ones the senior typed', () => {
    // Senior wrote `PostgreSQL`; the vacancy says `Postgres`. Same keyword.
    const result = stackMatchScore(
      { title: 'Backend', body: 'Postgres, Kubernetes via k8s manifests' },
      ['PostgreSQL', 'Kubernetes'],
    )
    expect(result.score).toBe(1)
  })

  it('reports total 0 and score 0 for an empty stack — the caller decides what that means', () => {
    const result = stackMatchScore({ title: 'Anything', body: 'Anything' }, [])
    expect(result).toEqual({ score: 0, matched: [], total: 0 })
  })

  it('counts a duplicated skill once, so the score cannot exceed 1', () => {
    const result = stackMatchScore({ title: 'Java', body: 'Java Java Java' }, [
      'Java',
      'java',
      'JAVA',
    ])
    expect(result.score).toBe(1)
    expect(result.total).toBe(1)
  })
})
