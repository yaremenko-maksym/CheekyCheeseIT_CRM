import { describe, expect, it } from 'vitest'
import {
  MAX_STACK_KEYWORD_CHARS,
  MAX_STACK_KEYWORDS,
  STACK_ALIAS_FAMILIES,
  STACK_AMBIGUOUS_ALIASES,
  canonicalStackKeyword,
  canonicalStackKeywords,
  normalizeStackKeyword,
  stackMatchScore,
  stackTokens,
  textMentionsStackKeyword,
} from './stack-keywords'
import { jobSuggestionListSchema } from '../schemas/job-sourcing'

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

/**
 * Every alias in the table, pinned as a LITERAL pair.
 *
 * The named per-class tests above cover the families the task called out. The
 * table has more than that, and the mutation gate showed why it matters: a
 * spelling nobody asserts is not a rule, it is a hopeful string — delete it, or
 * empty a whole family's array, and every test still passed.
 *
 * The pairs are written out rather than looped over `STACK_ALIAS_FAMILIES`
 * ON PURPOSE. A test that iterates the table under test moves WITH it: blank an
 * alias and the loop simply stops checking that alias. These literals do not
 * move, so removing or renaming any entry — alias, canonical id or whole family
 * — turns into a failure here.
 */
describe('every alias in the table resolves to its canonical id', () => {
  const PAIRS: readonly (readonly [string, string])[] = [
    ['java', 'java'],
    ['javascript', 'javascript'],
    ['js', 'javascript'],
    ['ecmascript', 'javascript'],
    ['typescript', 'typescript'],
    ['ts', 'typescript'],
    ['csharp', 'csharp'],
    ['c sharp', 'csharp'],
    ['cplusplus', 'cplusplus'],
    ['cpp', 'cplusplus'],
    ['golang', 'golang'],
    ['go', 'golang'],
    ['nodejs', 'nodejs'],
    ['node', 'nodejs'],
    ['node js', 'nodejs'],
    ['react', 'react'],
    ['reactjs', 'react'],
    ['react native', 'react native'],
    ['reactnative', 'react native'],
    ['vue', 'vue'],
    ['vuejs', 'vue'],
    ['angular', 'angular'],
    ['angularjs', 'angular'],
    ['dotnet', 'dotnet'],
    ['dotnet core', 'dotnet'],
    ['net core', 'dotnet'],
    ['netcore', 'dotnet'],
    ['spring boot', 'spring boot'],
    ['springboot', 'spring boot'],
    ['postgresql', 'postgresql'],
    ['postgres', 'postgresql'],
    ['psql', 'postgresql'],
    ['mongodb', 'mongodb'],
    ['mongo', 'mongodb'],
    ['mongo db', 'mongodb'],
    ['elasticsearch', 'elasticsearch'],
    ['elastic search', 'elasticsearch'],
    ['elk', 'elasticsearch'],
    ['rabbitmq', 'rabbitmq'],
    ['rabbit mq', 'rabbitmq'],
    ['kubernetes', 'kubernetes'],
    ['k8s', 'kubernetes'],
    ['k8', 'kubernetes'],
    ['kube', 'kubernetes'],
    ['cicd', 'ci/cd'],
    ['ci cd', 'ci/cd'],
    ['aws', 'aws'],
    ['amazon web services', 'aws'],
    ['gcp', 'gcp'],
    ['google cloud', 'gcp'],
    ['google cloud platform', 'gcp'],
    ['azure', 'azure'],
    ['microsoft azure', 'azure'],
    ['rest api', 'rest api'],
    ['restful', 'rest api'],
    ['rest apis', 'rest api'],
    ['rest', 'rest api'],
    ['graphql', 'graphql'],
    ['graph ql', 'graphql'],
  ]

  for (const [alias, canonical] of PAIRS) {
    it(`«${alias}» → ${canonical}`, () => {
      expect(canonicalStackKeyword(alias)).toBe(canonical)
    })
  }

  it('the table contains exactly these families — a new one needs a test', () => {
    // Guards the other direction: adding a family without pinning it here would
    // otherwise ship an unverified rule. Written out rather than derived from
    // PAIRS, for the same reason PAIRS is written out. `java` is absent on
    // purpose — one spelling, handled by the fallback.
    expect(Object.keys(STACK_ALIAS_FAMILIES).sort()).toEqual([
      'angular',
      'aws',
      'azure',
      'ci/cd',
      'cplusplus',
      'csharp',
      'dotnet',
      'elasticsearch',
      'gcp',
      'golang',
      'graphql',
      'javascript',
      'kubernetes',
      'mongodb',
      'nodejs',
      'postgresql',
      'rabbitmq',
      'react',
      'react native',
      'rest api',
      'spring boot',
      'typescript',
      'vue',
    ])
  })

  it('the ambiguous set is exactly the spellings that are English words', () => {
    expect([...STACK_AMBIGUOUS_ALIASES].sort()).toEqual(['go', 'node', 'rest'])
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

/**
 * The pre-tokenisation rewrites, asserted on the TOKEN STREAM.
 *
 * Asserting them only through `canonicalStackKeyword` hides most of them: the
 * alias table independently maps the spaced spellings (`ci cd`), so a rewrite
 * could stop firing entirely and the canonical id would still come out right.
 * `stackTokens` is where the rewrite is the only thing that can produce the
 * result, which is why each one is pinned here as well.
 */
describe('symbol rewrites, pinned on the token stream', () => {
  it('`CI/CD` and its spaced/dashed spellings all become one `cicd` token', () => {
    expect(stackTokens('CI/CD')).toEqual(['cicd'])
    expect(stackTokens('CI / CD')).toEqual(['cicd'])
    expect(stackTokens('ci-cd')).toEqual(['cicd'])
    expect(stackTokens('ci - cd')).toEqual(['cicd'])
  })

  it('`R&D` becomes one `rnd` token, spaced or not', () => {
    expect(stackTokens('R&D team')).toEqual(['rnd', 'team'])
    expect(stackTokens('R & D team')).toEqual(['rnd', 'team'])
  })

  it('`F#` becomes `fsharp`', () => {
    expect(stackTokens('F# developer')).toEqual(['fsharp', 'developer'])
    expect(canonicalStackKeyword('F#')).toBe('fsharp')
  })

  it('`C#` and `C++` become their own tokens, distinct from a bare `c`', () => {
    expect(stackTokens('C# and C++ and C')).toEqual(['csharp', 'and', 'cplusplus', 'and', 'c'])
  })

  it('`.NET` becomes `dotnet`, and `ASP.NET` keeps both parts', () => {
    expect(stackTokens('.NET')).toEqual(['dotnet'])
    expect(stackTokens('ASP.NET Core')).toEqual(['asp', 'dotnet', 'core'])
  })

  it('the `X.js` convention folds for any framework, not a listed few', () => {
    expect(stackTokens('Node.js')).toEqual(['nodejs'])
    expect(stackTokens('Vue.js')).toEqual(['vuejs'])
    expect(stackTokens('Svelte.js')).toEqual(['sveltejs'])
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

  it('transliterates EVERY letter the Cyrillic map covers', () => {
    // One assertion over the whole alphabet, so a single wrong or deleted letter
    // mapping fails — the per-letter entries are otherwise unasserted strings
    // (the mutation gate flagged each one individually). `ъ` and `ь` map to
    // nothing on purpose, which is why the output is shorter than the input.
    expect(normalizeStackKeyword('абвгґдеёєжзиіїйклмнопрстуфхцчшщъыьэюя')).toBe(
      'abvggdeeezhziiiiklmnoprstufhcchshschyeiuia',
    )
  })

  it('folds the UPPER-CASE alphabet identically', () => {
    expect(normalizeStackKeyword('АБВГҐДЕЁЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')).toBe(
      normalizeStackKeyword('абвгґдеёєжзиіїйклмнопрстуфхцчшщъыьэюя'),
    )
  })

  it('folds a precomposed accent — the NFKD form is what makes it decompose', () => {
    // `ü` arrives as ONE codepoint; only NFKD splits it into `u` + a combining
    // mark for the strip below to remove. Without the decomposition it stays
    // `ü`, which is a letter and survives tokenisation intact.
    expect(normalizeStackKeyword('Zürich')).toBe('zurich')
    expect(stackTokens('Café Redis')).toEqual(['cafe', 'redis'])
  })

  it('strips stacked combining marks, not just a single one', () => {
    // `\p{M}+` vs `\p{M}`: with one mark per letter both behave the same, so the
    // quantifier is only observable on a letter carrying TWO marks.
    expect(normalizeStackKeyword('é̂lastic')).toBe('elastic')
  })

  it('returns an empty list for blank input', () => {
    expect(stackTokens('')).toEqual([])
    expect(stackTokens(null)).toEqual([])
  })

  it('returns an empty list — not a list holding one empty string — for punctuation', () => {
    // Non-empty input with no letters or digits is the only way to reach the
    // final `.filter(Boolean)`: the early return covers '' and null, so without
    // the filter this answers [''] and every caller counts one phantom keyword.
    expect(stackTokens('—')).toEqual([])
    expect(stackTokens('   ...   ')).toEqual([])
    expect(canonicalStackKeywords(['—', '...'])).toEqual([])
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

/**
 * Security review HIGH-1 — a long resume skill used to take the whole queue down.
 *
 * The resume layer allows 200 characters per skill and the AI extractor
 * truncates to exactly that; this wire contract allows 100; nothing in between
 * truncated. So `GET /job-sourcing/suggestions` failed its own outgoing
 * `.parse()` → 400, for the senior AND for the ADMIN/HR viewing them — on the
 * first filled-in resume, i.e. the first real user of the feature.
 *
 * The lengths below are not invented: 200 is the resume layer's OWN maximum
 * (`RESUME_LIMITS.shortText`). The Cyrillic case is separate on purpose — it is
 * the one a latin-only test cannot find.
 */
describe('keyword length is bounded where the canonical form is built (HIGH-1)', () => {
  it('CONTROL: an ordinary keyword is not truncated', () => {
    // Without this the whole block could pass by truncating everything to
    // nothing, which would "fix" the 400 by breaking matching instead.
    expect(canonicalStackKeyword('PostgreSQL')).toBe('postgresql')
    expect(canonicalStackKeyword('Spring Boot')).toBe('spring boot')
  })

  it('caps a keyword at the resume layer’s own maximum length (200 chars in)', () => {
    const canonical = canonicalStackKeyword('B'.repeat(200))
    expect(canonical).toHaveLength(MAX_STACK_KEYWORD_CHARS)
  })

  it('caps a CYRILLIC keyword — transliteration LENGTHENS the canonical form', () => {
    // `щ` → `sch`, so 40 characters of input become 120 of canonical form and
    // blow a 100-char cap that 40 latin characters would sail straight through.
    // This is why the latin case above is not sufficient on its own.
    expect(normalizeStackKeyword('щ'.repeat(40))).toHaveLength(120)
    expect(canonicalStackKeyword('щ'.repeat(40))).toHaveLength(MAX_STACK_KEYWORD_CHARS)
  })

  it('caps every keyword in a stack, not just the first', () => {
    const stack = canonicalStackKeywords(['Java', 'C'.repeat(150), 'ю'.repeat(90)])
    expect(stack.every((k) => k.length <= MAX_STACK_KEYWORD_CHARS)).toBe(true)
  })

  it('caps HOW MANY keywords a stored resume may contribute', () => {
    // The write path caps skills at 60, but this module reads the stored jsonb
    // column — data, not a promise that the write limit was ever applied.
    const tooMany = Array.from({ length: 200 }, (_, i) => `skill${i}`)
    expect(canonicalStackKeywords(tooMany)).toHaveLength(MAX_STACK_KEYWORDS)
  })

  it('the capped output satisfies the wire contract — the actual 400', () => {
    const stack = canonicalStackKeywords(['B'.repeat(200), 'щ'.repeat(40)])
    const parsed = jobSuggestionListSchema.safeParse({
      items: [],
      lowMatch: [],
      lowMatchCount: 0,
      total: 0,
      threshold: 0.2,
      stackKeywords: stack,
    })
    expect(parsed.success).toBe(true)
  })
})

/**
 * Backlog #55 — truncation collisions. Two DIFFERENT overlong skills that
 * share a common prefix used to truncate to the SAME canonical id, which is a
 * false match between two garbage strings that were never the same skill.
 * Only reachable for keywords already over MAX_STACK_KEYWORD_CHARS in
 * canonical form — i.e. already-known-bad data (see that constant's doc
 * comment) — so the fix must not get LOOSER for well-formed keywords; it only
 * has to stop two pieces of bad data from being treated as one.
 */
describe('truncation no longer collapses two different overlong skills (#55)', () => {
  it('CONTROL: a canonical form of EXACTLY the cap length is left untouched', () => {
    // Boundary case — proves the branch that adds the hash suffix is not
    // taken one character too early (or too late).
    const exact = 'z'.repeat(MAX_STACK_KEYWORD_CHARS)
    expect(canonicalStackKeyword(exact)).toBe(exact)
  })

  it('one character over the cap is hash-suffixed, not silently sliced', () => {
    const overByOne = 'z'.repeat(MAX_STACK_KEYWORD_CHARS + 1)
    const result = canonicalStackKeyword(overByOne)
    expect(result).toHaveLength(MAX_STACK_KEYWORD_CHARS)
    // A naive slice(0, 100) would just be 100 'z's — the fixed behaviour must
    // differ from that, or the collision this test guards against is back.
    expect(result).not.toBe('z'.repeat(MAX_STACK_KEYWORD_CHARS))
  })

  it('two overlong skills sharing a 100+ char prefix canonicalise to DIFFERENT ids', () => {
    const shared = 'x'.repeat(150)
    const skillA = `${shared}AAAA`
    const skillB = `${shared}BBBB`

    const canonicalA = canonicalStackKeyword(skillA)
    const canonicalB = canonicalStackKeyword(skillB)

    // Pre-fix behaviour: both slice(0, 100) to the same 100 x's — this is
    // exactly the false match the fix removes.
    expect(canonicalA).not.toBe(canonicalB)
    expect(canonicalA).toHaveLength(MAX_STACK_KEYWORD_CHARS)
    expect(canonicalB).toHaveLength(MAX_STACK_KEYWORD_CHARS)
  })

  it('the SAME overlong skill still canonicalises identically — dedup keeps working', () => {
    const longSkill = 'y'.repeat(140)
    expect(canonicalStackKeyword(longSkill)).toBe(canonicalStackKeyword(longSkill))
    expect(canonicalStackKeywords([longSkill, longSkill])).toHaveLength(1)
  })

  it('a senior stack with two DIFFERENT overlong skills keeps them as two entries', () => {
    const shared = 'q'.repeat(150)
    const stack = canonicalStackKeywords([`${shared}1111`, `${shared}2222`])
    expect(stack).toHaveLength(2)
  })

  it('pins the EXACT hash-suffixed output for a known input (kills off-by-one / wrong-pad-char / wrong-separator mutants)', () => {
    // Computed independently (not derived from the function under test) by
    // running the SAME documented FNV-1a algorithm over the canonical (lower-
    // cased, single-token) form of this input. A mutation to the hash loop's
    // bound, its pad character, or the separator constant changes this exact
    // string — a length-only or "differs from sibling" assertion would not
    // notice any of those, which is exactly what Stryker's own survivor scan
    // found before this test was added.
    const raw = `${'x'.repeat(150)}ZZZZ`
    expect(canonicalStackKeyword(raw)).toBe(`${'x'.repeat(91)}~6f2a0d1d`)
  })

  it('pins a hash that starts with a leading zero hex digit — exercises padStart, not just length', () => {
    // Without padStart, an 8-char hex hash whose leading byte is < 0x10 would
    // render as only 7 characters — this input's hash is exactly that case
    // (0d9a74ba), so a mutant that swaps the pad character for '' silently
    // shortens the suffix by one character. `toHaveLength` alone would still
    // pass (the slice point would just move by one to compensate its own
    // arithmetic); pinning the full string catches it.
    const raw = `${'q'.repeat(120)}300`
    expect(canonicalStackKeyword(raw)).toBe(`${'q'.repeat(91)}~0d9a74ba`)
  })

  it('the hash-suffixed id still satisfies the wire contract', () => {
    const shared = 'w'.repeat(150)
    const stack = canonicalStackKeywords([`${shared}AAAA`, `${shared}BBBB`])
    const parsed = jobSuggestionListSchema.safeParse({
      items: [],
      lowMatch: [],
      lowMatchCount: 0,
      total: 0,
      threshold: 0.2,
      stackKeywords: stack,
    })
    expect(parsed.success).toBe(true)
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
