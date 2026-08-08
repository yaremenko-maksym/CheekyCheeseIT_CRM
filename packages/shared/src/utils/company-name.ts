/**
 * Company-name normalization + matching — task-job-sourcing-slice1 §3.
 *
 * WHY THIS EXISTS
 * ---------------
 * The per-senior exclusion filter must stop a SENIOR from ever being offered a
 * vacancy at the company they already work for (their own client, via the
 * legend). A naive `a === b` (or even `a.toLowerCase() === b.toLowerCase()`)
 * comparison misses most real-world spellings of the SAME company:
 *
 *     EPAM · epam · EPAM Systems · Epam Systems Inc. · ЕПАМ · ТОВ «ЕПАМ»
 *
 * A filter that silently fails to catch these is WORSE than no filter at all —
 * the whole feature rests on the promise "you will never see your own employer
 * here", and both HR and the senior rely on that promise. So the matcher
 * deliberately errs toward MORE matches (a missed opportunity is recoverable;
 * showing a vacancy at the senior's own client is not).
 *
 * NORMALIZATION PIPELINE (`normalizeCompanyName`)
 * ----------------------------------------------
 *   1. Unicode NFKD + strip combining marks  → `Zürich` = `Zurich`
 *   2. lowercase                              → `EPAM`   = `epam`
 *   3. Cyrillic → Latin transliteration       → `ЕПАМ`   = `epam`
 *   4. every non-alphanumeric char → space    → `E-P.A,M` = `e p a m`
 *      (kills «», “”, ‘’, &, ·, –, —, (), ., etc. in one rule)
 *   5. drop legal-form tokens (inc/llc/ltd/тов/ооо/...) — LEADING (`ТОВ Ромашка`)
 *      and TRAILING (`Ромашка ТОВ`, `Epam Systems Inc.`) alike, since Ukrainian
 *      and English put the legal form on opposite ends
 *   6. collapse whitespace
 *
 * MATCHING (`companyNamesMatch`)
 * ------------------------------
 * Token-WINDOW comparison, not substring comparison:
 *   match ⇔ some contiguous window of A's tokens joins (without spaces) to
 *           exactly B's joined tokens, or vice versa.
 *
 * That single rule covers three separate real cases at once:
 *   - `EPAM` ↔ `EPAM Systems Ukraine`  (window `[epam]`)
 *   - `SoftServe` ↔ `Soft Serve`       (window `[soft,serve]` joins to `softserve`)
 *   - `EPAM` ↔ `Epamos`                → NO match (window `[epamos]` ≠ `epam`)
 * — the last one is why this is not `String.includes`: a plain substring test
 * would match `epam` inside `epamos` and silently hide an unrelated company.
 *
 * Names shorter than `MIN_CONTAINMENT_LEN` chars (e.g. `IT`, `X`) only ever
 * match on FULL equality — otherwise a two-letter exclusion would swallow half
 * the feed.
 *
 * KNOWN LIMITATION (pinned by a test, not a surprise)
 * ---------------------------------------------------
 * Latin `c` spells BOTH Cyrillic `с` (/s/) and `к` (/k/), so `Citicor` ↔
 * `Сітікор` cannot be collapsed by any single letter mapping. Brands in that
 * shape need a second exclusion entry with the other spelling. Everything else
 * (`ЕПАМ`↔`EPAM`, `Ромашка`↔`Romashka`) folds correctly.
 *
 * This module lives in `@crm/shared` on purpose: the API filters with it and the
 * web explains "excluded because …" with the same rules. One implementation,
 * one set of tests, no drift.
 */

/**
 * Cyrillic (uk/ru) → Latin. Chosen for MATCHING, not for display: the goal is
 * that a Latin and a Cyrillic spelling of the same brand collapse onto the same
 * string, so ambiguous letters map to the spelling brands actually use
 * (`х → h`, as in `Харків`→`harkiv` and `Hosting`→`hosting`, both `h`).
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
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

/**
 * Legal-form tokens stripped from either end of a company name. Latin and
 * Cyrillic forms are both listed in their POST-transliteration spelling (step 3
 * runs before this list is consulted): `ТОВ` → `tov`, `ООО` → `ooo`,
 * `ПП` → `pp`, `АТ` → `at`, `ФОП` → `fop`.
 */
const LEGAL_FORM_TOKENS = new Set([
  // Latin / international
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'llp',
  'lp',
  'plc',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'ug',
  'ag',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'oy',
  'oyj',
  'ab',
  'aps',
  'sp',
  'zoo',
  'kft',
  'pte',
  'pty',
  'pllc',
  // Ukrainian / Russian legal forms, transliterated
  'tov',
  'ooo',
  'zat',
  'pat',
  'vat',
  'at',
  'pp',
  'fop',
  'chp',
  'dp',
  'kp',
])

/** Below this length a name matches only on full equality (see file header). */
const MIN_CONTAINMENT_LEN = 3

function transliterate(value: string): string {
  let out = ''
  for (const char of value) {
    const mapped = CYRILLIC_TO_LATIN[char]
    out += mapped === undefined ? char : mapped
  }
  return out
}

/**
 * Canonical token list for a company name. Exported so the API can persist a
 * pre-normalized value (cheap DB-side comparison + a stable uniqueness key for
 * the exclusion list) and so tests can assert the pipeline directly.
 */
export function companyNameTokens(raw: string | null | undefined): string[] {
  if (!raw) return []

  const folded = transliterate(
    raw
      .normalize('NFKD')
      // Strip the combining marks NFKD just split off (ü → u + ¨).
      .replace(/\p{M}+/gu, '')
      .toLowerCase(),
  )

  const tokens = folded
    // Everything that is not a letter/digit is a separator. `\p{L}` keeps any
    // alphabet we did NOT transliterate (Greek, CJK) intact rather than
    // deleting it — such a name still normalizes consistently with itself.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (tokens.length === 0) return []

  // Strip legal forms from both ends (`ТОВ Ромашка` / `Ромашка ТОВ` /
  // `Epam Systems Inc. Ltd`), never from the middle — a middle token is far
  // more likely to be part of the actual name.
  let start = 0
  let end = tokens.length
  while (start < end && LEGAL_FORM_TOKENS.has(tokens[start]!)) start += 1
  while (end > start && LEGAL_FORM_TOKENS.has(tokens[end - 1]!)) end -= 1

  // A name made up ENTIRELY of legal-form tokens keeps them — dropping them
  // would produce an empty key that matches everything.
  const stripped = tokens.slice(start, end)
  return stripped.length > 0 ? stripped : tokens
}

/**
 * Canonical, space-separated form of a company name — the value persisted in
 * `job_exclusion_filters.normalized_value` and compared against postings.
 * Returns `''` for empty/blank input.
 */
export function normalizeCompanyName(raw: string | null | undefined): string {
  return companyNameTokens(raw).join(' ')
}

/** True when some contiguous window of `tokens` joins to exactly `needle`. */
function hasTokenWindow(tokens: string[], needle: string): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i < tokens.length; i += 1) {
    let window = ''
    for (let j = i; j < tokens.length; j += 1) {
      window += tokens[j]!
      if (window.length > needle.length) break
      if (window === needle) return true
    }
  }
  return false
}

/**
 * True when `a` and `b` denote the same company under the normalization rules
 * described in the file header. Symmetric: `match(a, b) === match(b, a)`.
 */
export function companyNamesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const aTokens = companyNameTokens(a)
  const bTokens = companyNameTokens(b)
  if (aTokens.length === 0 || bTokens.length === 0) return false

  const aJoined = aTokens.join('')
  const bJoined = bTokens.join('')
  if (aJoined === bJoined) return true

  // Short names (`IT`, `X`) never match by containment — see file header.
  if (bJoined.length >= MIN_CONTAINMENT_LEN && hasTokenWindow(aTokens, bJoined)) return true
  if (aJoined.length >= MIN_CONTAINMENT_LEN && hasTokenWindow(bTokens, aJoined)) return true

  return false
}

/**
 * Free-text stop-word matching (the `KEYWORD` exclusion kind).
 *
 * Runs the SAME folding pipeline as company names (case / diacritics /
 * Cyrillic / punctuation), then matches on a WORD-START boundary — so
 * `gambling` matches `Gambling` and `gamblings`, but `casino` does NOT match
 * `Anticasino`. Multi-word keywords (`online casino`) are matched as a phrase.
 */
export function textMatchesKeyword(
  text: string | null | undefined,
  keyword: string | null | undefined,
): boolean {
  const keywordTokens = companyNameTokens(keyword)
  const textTokens = companyNameTokens(text)
  if (keywordTokens.length === 0 || textTokens.length === 0) return false

  const haystack = ` ${textTokens.join(' ')}`
  const needle = ` ${keywordTokens.join(' ')}`
  return haystack.includes(needle)
}
