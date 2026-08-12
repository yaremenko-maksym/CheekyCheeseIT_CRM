/**
 * Stack-keyword normalization + matching — task-vacancy-matching §2.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vacancy selection used to be pure SUBTRACTION: collect everything DOU
 * publishes, drop what an exclusion forbids, show the rest newest-first. There
 * was no positive half at all — a senior's actual stack never entered the
 * decision. This module is that positive half: does THIS posting talk about the
 * technologies THIS senior works with?
 *
 * It is deliberately built in the same shape as `company-name.ts` (fold the
 * spelling, then match on TOKENS, never on substrings), for the same reason:
 * the API ranks with it and the web explains the ranking with it, so there is
 * one implementation and one set of tests, and no drift between what the
 * backend decided and what the UI claims it decided.
 *
 * THE VOCABULARY IS MEASURED, NOT INVENTED
 * ----------------------------------------
 * Every alias below was mined from 250 REAL vacancies pulled from
 * `jobs.dou.ua/vacancies/feeds/` across 10 categories (Java, JavaScript, DevOps,
 * Python, Node.js, .NET, QA Automation, Golang, Fullstack, Data Engineer) on
 * 2026-08-12. Occurrence counts in that corpus are quoted next to each family —
 * they are the evidence that both spellings are real and worth folding, not a
 * guess about what people "probably" write:
 *
 *     postgresql 119 / postgres 6      kubernetes 112 / k8s 9
 *     ci/cd 195                        node.js 101 / node 7 / nodejs 1
 *     js 217 / javascript 109          typescript 131 / ts 7
 *     .net 120 / asp.net 24            c# 46            c++ 14
 *     react 134 / react.js 15 / reactjs 13 / react native 13
 *     vue 22 / vue.js 19               golang 36 / go 71
 *     mongodb 35                       gcp 55 / google cloud 10
 *
 * ONLY AMBIGUOUS FAMILIES ARE LISTED
 * ----------------------------------
 * The table holds families whose spellings genuinely DIFFER. A technology with
 * one spelling (`docker`, `redis`, `kafka`, `python`, `terraform`) needs no
 * entry: an unrecognised keyword canonicalises to itself and still matches
 * literally. That keeps the table small enough to stay correct instead of
 * growing into a half-maintained technology encyclopedia.
 *
 * SUBSTRING MATCHING IS THE ENEMY (the whole reason for the token rule)
 * --------------------------------------------------------------------
 * `'JavaScript'.includes('Java')` is `true`. A senior who writes Java would be
 * offered every JavaScript vacancy on the board — the precise "мусорные
 * вакансии" the owner asked us to stop showing. So matching compares TOKEN
 * PHRASES for equality: `java` never equals `javascript`, and `r` never equals
 * `react`, `ruby` or `rust`. Both directions are pinned by tests.
 *
 * SYMBOL-BEARING NAMES ARE REWRITTEN BEFORE TOKENISATION
 * ------------------------------------------------------
 * `.` `#` `+` `/` `&` are separators in the folding pipeline, which would
 * destroy exactly the names that depend on them: `C++` and `C#` would both
 * collapse to `c`, and `.NET` would collapse to `net` — colliding with the
 * ordinary English word in "net revenue". So a small set of rewrites runs on the
 * lowercased string FIRST, turning those spellings into single safe tokens
 * (`cplusplus`, `csharp`, `dotnet`). This is strictly more precise than folding
 * them away: bare `net` no longer matches `.NET` at all.
 */

/**
 * Hard ceiling on ONE canonical keyword, and the single number the wire schema
 * caps `stackKeywords` / `matchedKeywords` at (`schemas/job-sourcing.ts` imports
 * it rather than repeating `100`).
 *
 * WHY THE CEILING LIVES HERE, AT THE POINT THE CANONICAL FORM IS BUILT
 * -------------------------------------------------------------------
 * Security review HIGH-1, and it was a live 400 rather than a theoretical one.
 * The layers disagreed about how long a "skill" may be:
 *
 *     resume content schema   200 chars per skill (RESUME_LIMITS.shortText)
 *     AI extraction           truncates to exactly that 200
 *     this wire contract      100
 *
 * …with nothing in between. So the first senior whose resume carried a long
 * skill made `GET /job-sourcing/suggestions` fail its own outgoing `.parse()`
 * → ZodExceptionFilter → 400, for that senior AND for the ADMIN/HR looking at
 * their queue. Measured before fixing, with a control:
 *
 *     ordinary stack        → parses
 *     108 latin chars       → 400
 *     200 latin chars       → 400
 *     40 CYRILLIC chars     → 400 — canonical length 120
 *
 * The Cyrillic row is the one a latin-only test never finds: transliteration
 * LENGTHENS (`щ`→`sch`, `ю`→`iu`), so 40 characters of input become 120 of
 * canonical form and blow a 100-char cap that 40 latin characters would sail
 * through. Both are pinned by their own test.
 *
 * Capping here rather than at the wire is what makes the guarantee total: every
 * canonical keyword the module can produce — the senior's stack, the matched
 * ids, anything a future caller derives — is bounded by construction, so no new
 * call site can re-open the hole by forgetting to truncate.
 */
export const MAX_STACK_KEYWORD_CHARS = 100

/**
 * Hard ceiling on HOW MANY canonical keywords one stack may contribute.
 *
 * Mirrors `RESUME_LIMITS.skills` (60), which is what the resume WRITE path
 * enforces — but this module reads the stored `jsonb` column, and a stored
 * value is data, not a promise. Same reasoning as the per-keyword cap: bound it
 * where the list is built, not where it is serialised.
 */
export const MAX_STACK_KEYWORDS = 60

/**
 * Rewrites applied to the lower-cased string BEFORE anything is tokenised.
 *
 * Order matters only in that each pattern must not eat a longer one's input;
 * the families below do not overlap. Every replacement is padded with spaces so
 * it can never fuse with a neighbouring word.
 */
const SYMBOL_REWRITES: readonly (readonly [RegExp, string])[] = [
  // `C++` / `C#` / `F#` — the symbol IS the name. Without this both `c++` and
  // `c#` fold to the single letter `c` and become indistinguishable from each
  // other and from a stray "C".
  [/\bc\+\+/g, ' cplusplus '],
  [/\bc#/g, ' csharp '],
  [/\bf#/g, ' fsharp '],
  // `.NET` (120 hits) and `ASP.NET` (24). The leading dot is the whole signal:
  // rewriting it to `dotnet` means the English word "net" ("net revenue") can
  // never be read as the framework. `asp.net` becomes `asp dotnet`, so a senior
  // whose stack says `.NET` still matches an ASP.NET vacancy.
  [/\.net\b/g, ' dotnet '],
  // `CI/CD` (195 hits — the dominant spelling by far), `CI-CD`, `CI CD`.
  [/\bci\s*[/\-]\s*cd\b/g, ' cicd '],
  // `R&D` is NOT the R language. Without this rewrite the token stream is
  // `[r, d]`, which contains the one-token phrase `[r]` — so a senior with `R`
  // in their stack would match every vacancy that mentions an R&D department.
  [/\br\s*&\s*d\b/g, ' rnd '],
  // `node.js` → `nodejs`, `vue.js` → `vuejs`, `react.js` → `reactjs`. One rule
  // for the whole `X.js` convention rather than an entry per framework.
  [/([a-z0-9]+)\.js\b/g, ' $1js '],
]

/**
 * Canonical id → every spelling that means it. The canonical id is arbitrary
 * but stable; it is what the API stores in `matchedKeywords` and what the UI
 * shows, so it is written the way a human would read it back.
 *
 * Each alias is given in its RAW form and folded through the same pipeline as
 * the text, so `Node.js` here and `Node.js` in a vacancy body normalise
 * identically by construction.
 */
const ALIAS_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  // --- languages ------------------------------------------------------------
  // `java` is listed with NO extra alias on purpose: the entry documents that
  // `javascript` is deliberately NOT one of them (see the file header).
  java: ['java'],
  javascript: ['javascript', 'js', 'ecmascript'],
  typescript: ['typescript', 'ts'],
  csharp: ['csharp', 'c sharp'],
  cplusplus: ['cplusplus', 'cpp'],
  golang: ['golang', 'go'],
  // --- runtimes / frameworks ------------------------------------------------
  nodejs: ['nodejs', 'node', 'node js'],
  react: ['react', 'reactjs'],
  'react native': ['react native', 'reactnative'],
  vue: ['vue', 'vuejs'],
  angular: ['angular', 'angularjs'],
  // `.NET Core` normalises to `dotnet core` (the `.net` rewrite fires first),
  // while the older `NET Core` spelling normalises to `net core` — both are the
  // same framework and both appear in the corpus.
  dotnet: ['dotnet', 'dotnet core', 'net core', 'netcore'],
  'spring boot': ['spring boot', 'springboot'],
  // --- data -----------------------------------------------------------------
  postgresql: ['postgresql', 'postgres', 'psql'],
  mongodb: ['mongodb', 'mongo', 'mongo db'],
  elasticsearch: ['elasticsearch', 'elastic search', 'elk'],
  rabbitmq: ['rabbitmq', 'rabbit mq'],
  // --- platform / infra -----------------------------------------------------
  kubernetes: ['kubernetes', 'k8s', 'k8', 'kube'],
  'ci/cd': ['cicd', 'ci cd'],
  aws: ['aws', 'amazon web services'],
  gcp: ['gcp', 'google cloud', 'google cloud platform'],
  azure: ['azure', 'microsoft azure'],
  // --- API styles -----------------------------------------------------------
  'rest api': ['rest api', 'restful', 'rest apis', 'rest'],
  graphql: ['graphql', 'graph ql'],
}

/**
 * Aliases that are ALSO ordinary English words, and therefore only counted when
 * they appear in the vacancy TITLE (where "Go Developer" is a stack statement)
 * rather than anywhere in the body (where "go to market", "worker node" and
 * "the rest of the team" are not).
 *
 * Measured, not theorised: the corpus above matched `\bgo\b` 71 times while
 * `golang` appears 36 — i.e. most bare "go" in a vacancy body is English. A
 * canonical still matches body text through any of its UNAMBIGUOUS spellings
 * (`golang`, `nodejs`, `rest api`), so this narrows false positives without
 * losing the real ones.
 */
const AMBIGUOUS_ALIASES: ReadonlySet<string> = new Set(['go', 'node', 'rest'])

/**
 * Cyrillic → Latin, identical in purpose to the map in `company-name.ts`:
 * vacancy bodies on DOU are frequently Ukrainian, and a stack term written in
 * Cyrillic must fold onto the same string as its Latin spelling.
 */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'iu',
  я: 'ia',
}

/** Cheap pre-test: is there anything for `transliterate` to actually do? */
const CYRILLIC_RE = /[Ѐ-ӿ]/

function transliterate(value: string): string {
  // The loop below is character-by-character string concatenation over the whole
  // text, which for a 20 KB vacancy description is the single most expensive
  // thing this module does. A great many descriptions are pure Latin, and for
  // those the entire pass is wasted work — one native regex test skips it.
  // Measured on the queue benchmark, not assumed (see MED-3 in the PR).
  if (!CYRILLIC_RE.test(value)) return value

  let out = ''
  for (const char of value) {
    const mapped = CYRILLIC_TO_LATIN[char]
    out += mapped === undefined ? char : mapped
  }
  return out
}

/**
 * Canonical token list for any stack text — a keyword, a title or a whole
 * description. NFKD-folded, de-accented, lower-cased, symbol-rewritten, then
 * split on everything that is not a letter or a digit.
 */
export function stackTokens(raw: string | null | undefined): string[] {
  if (!raw) return []

  let folded = transliterate(
    raw
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase(),
  )

  for (const [pattern, replacement] of SYMBOL_REWRITES) {
    folded = folded.replace(pattern, replacement)
  }

  return folded
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** Space-joined canonical form of one keyword (`Node.js` → `nodejs`). */
export function normalizeStackKeyword(raw: string | null | undefined): string {
  return stackTokens(raw).join(' ')
}

/**
 * Reverse index: normalised alias phrase → canonical id. Built once at module
 * load, so the alias table stays the only place a spelling is written down.
 */
const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>()
  for (const [canonical, aliases] of Object.entries(ALIAS_FAMILIES)) {
    for (const alias of aliases) {
      const normalized = normalizeStackKeyword(alias)
      if (normalized.length > 0) index.set(normalized, canonical)
    }
  }
  return index
})()

/**
 * The canonical id a raw keyword denotes.
 *
 * An UNKNOWN keyword canonicalises to its own normalised form rather than being
 * dropped — a senior who writes `Terraform` or `Snowflake` must still be matched
 * on it, and the alias table is only there to collapse competing spellings, not
 * to act as an allow-list of technologies we have heard of.
 *
 * Returns `''` for input that carries no letters or digits at all.
 */
export function canonicalStackKeyword(raw: string | null | undefined): string {
  const normalized = normalizeStackKeyword(raw)
  if (normalized.length === 0) return ''
  // Alias lookup happens on the FULL normalised form — every alias is short, so
  // truncating first could only ever lose a match. The cap is applied to the
  // result (see MAX_STACK_KEYWORD_CHARS for the 400 this prevents).
  const canonical = ALIAS_TO_CANONICAL.get(normalized) ?? normalized
  return canonical.length > MAX_STACK_KEYWORD_CHARS
    ? canonical.slice(0, MAX_STACK_KEYWORD_CHARS)
    : canonical
}

/** Every spelling that should be looked for when hunting a canonical id. */
function spellingsOf(canonical: string): string[] {
  const aliases = ALIAS_FAMILIES[canonical]
  if (aliases) return aliases.map((alias) => normalizeStackKeyword(alias)).filter(Boolean)
  return [canonical]
}

/**
 * True when `phrase` (already normalised, space-separated) occurs in `tokens`
 * as a CONTIGUOUS run of whole tokens.
 *
 * Whole tokens is the load-bearing part: `['javascript']` does not contain the
 * phrase `java`, whereas any substring test would say it does.
 */
function containsPhrase(tokens: readonly string[], phrase: string): boolean {
  const needle = phrase.split(' ').filter(Boolean)
  if (needle.length === 0 || needle.length > tokens.length) return false

  for (let i = 0; i + needle.length <= tokens.length; i += 1) {
    let hit = true
    for (let j = 0; j < needle.length; j += 1) {
      if (tokens[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/** The two text surfaces a posting exposes to matching. */
export interface StackMatchText {
  title: string | null | undefined
  /** Description / body. Ambiguous aliases are NOT honoured here. */
  body?: string | null | undefined
}

export interface StackMatchResult {
  /**
   * Fraction of the senior's distinct canonical keywords the posting mentions,
   * `0..1`. `0` when the stack is empty — the CALLER decides what an empty stack
   * means (see JobSourcingService: it disables ranking rather than scoring
   * everything zero).
   */
  score: number
  /** Canonical ids found, in stack order — the "why" behind the score. */
  matched: string[]
  /** Distinct canonical keywords in the senior's stack (the denominator). */
  total: number
}

/**
 * Distinct canonical keywords for a senior's raw stack list, order preserved.
 * Exported because both the matcher and the API's "your stack is empty" check
 * need exactly this notion of "how many keywords does this senior really have".
 */
export function canonicalStackKeywords(raw: readonly string[] | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const canonical = canonicalStackKeyword(entry)
    if (canonical.length === 0 || seen.has(canonical)) continue
    seen.add(canonical)
    out.push(canonical)
    // Bounded by construction — the stored jsonb this reads is data, not a
    // promise that the write-time limit was ever applied.
    if (out.length >= MAX_STACK_KEYWORDS) break
  }
  return out
}

/**
 * True when a posting mentions one canonical keyword.
 *
 * Unambiguous spellings are hunted in title AND body; the handful of spellings
 * that are also English words (`AMBIGUOUS_ALIASES`) only count in the title.
 */
export function textMentionsStackKeyword(canonical: string, text: StackMatchText): boolean {
  const titleTokens = stackTokens(text.title)
  const bodyTokens = stackTokens(text.body)

  for (const spelling of spellingsOf(canonical)) {
    const ambiguous = AMBIGUOUS_ALIASES.has(spelling)
    if (containsPhrase(titleTokens, spelling)) return true
    if (!ambiguous && containsPhrase(bodyTokens, spelling)) return true
  }
  return false
}

/**
 * Score one posting against one senior's stack.
 *
 * The denominator is the senior's OWN keyword count, which is constant across
 * their queue — so ranking inside a queue is unaffected by how long their skill
 * list is. (It does affect the absolute score, and therefore the threshold,
 * which is exactly why the threshold is a setting and not a constant: a studio
 * whose seniors list 40 skills tunes it lower than one whose seniors list 8.)
 */
export function stackMatchScore(
  text: StackMatchText,
  stack: readonly string[] | null | undefined,
): StackMatchResult {
  const canonicalKeywords = canonicalStackKeywords(stack)
  if (canonicalKeywords.length === 0) return { score: 0, matched: [], total: 0 }

  // Tokenise ONCE per posting rather than per keyword — a description is a few
  // KB and a stack is up to 60 entries.
  const titleTokens = stackTokens(text.title)
  const bodyTokens = stackTokens(text.body)

  const matched: string[] = []
  for (const canonical of canonicalKeywords) {
    for (const spelling of spellingsOf(canonical)) {
      const ambiguous = AMBIGUOUS_ALIASES.has(spelling)
      if (
        containsPhrase(titleTokens, spelling) ||
        (!ambiguous && containsPhrase(bodyTokens, spelling))
      ) {
        matched.push(canonical)
        break
      }
    }
  }

  return {
    score: matched.length / canonicalKeywords.length,
    matched,
    total: canonicalKeywords.length,
  }
}

/** Exported for tests + docs: the alias families this build folds. */
export const STACK_ALIAS_FAMILIES = ALIAS_FAMILIES
/** Exported for tests: spellings honoured only in a title. */
export const STACK_AMBIGUOUS_ALIASES = AMBIGUOUS_ALIASES
