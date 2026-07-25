/**
 * Accept-Language best-match locale detection (task-infra-locale-edge).
 *
 * Source of truth: .claude/tasks/plan-landing-i18n-seo.md §2. Runs inside
 * nginx's bundled njs module (see the `load_module` comment in
 * nginx/nginx.conf for why njs rather than plain nginx `map`: real q-value
 * descending sort across an arbitrary number of comma-separated
 * Accept-Language tags, plus exact-then-base-language matching, needs real
 * arithmetic/loops that `map` (regex-only) cannot express).
 *
 * Full detection order (cookie > Accept-Language > CF-IPCountry > en),
 * the crawler-safety guarantees, and the emergency kill-switch are
 * documented in scripts/devops/locale-routing-runbook.md — read that before
 * changing anything here. Exported as a single `targetLocale(r)` used by
 * `js_set $target_locale locale.targetLocale;` in
 * nginx/conf.d/locale-detect.conf. The REST of the redirect logic (URI-
 * prefix detection, the merge-order file-existence guard, the kill-switch)
 * stays plain nginx `map`/`if` in that file and in nginx/conf.d/landing.conf
 * — this module's only job is producing one of: "en" | "uk" | "ru" | "es" |
 * "pt".
 *
 * SECURITY (security-review round 1, PR #423, HIGH-1 — fixed here):
 * `$target_locale` is computed for EVERY request that reaches `location /`
 * in landing.conf, including with the emergency kill-switch ON (the map
 * that folds the kill-switch in `locale-detect.conf` still needs this
 * variable's value to build its lookup key) — so this module is on the hot
 * path for the whole edge (landing AND, via the shared nginx process,
 * `app.cheekycheese.tech`/CRM `/api` proxying) regardless of feature state.
 * Treat `Accept-Language` as fully untrusted, unbounded, adversarial input:
 * hard length/count caps BEFORE any regex touches it (§ MAX_HEADER_LEN /
 * MAX_TAGS below), a non-backtracking q-value grammar (§ Q_RE — RFC 9110
 * §12.4.2, no overlapping quantifiers), and the whole exported handler
 * wrapped in try/catch so ANY unexpected exception degrades to a safe,
 * cheap, unlogged "en" rather than an uncaught njs stack trace on the hot
 * path (see runbook "ReDoS hardening" for the empirical before/after).
 */

const SUPPORTED = ['en', 'uk', 'ru', 'es', 'pt']

// A real Accept-Language header from any browser is well under 200 chars
// (a handful of language tags with q-values). 512 is a generous ceiling
// that no legitimate client will ever hit but that bounds worst-case work
// to a small, fixed amount regardless of what nginx's own
// `large_client_header_buffers` allows through (default up to 8 KB/line).
const MAX_HEADER_LEN = 512
// A real Accept-Language header very rarely lists more than 5-6 tags.
const MAX_TAGS = 20

// CF-IPCountry -> locale fallback, ONLY consulted when Accept-Language is
// absent or none of its tags matched a supported locale (plan §2 step 3).
const CF_COUNTRY_LOCALE = {
  UA: 'uk',
  RU: 'ru',
  BY: 'ru',
  KZ: 'ru',
  KG: 'ru',
  AM: 'ru',
  BR: 'pt',
  PT: 'pt',
  AO: 'pt',
  MZ: 'pt',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  CO: 'es',
  CL: 'es',
  PE: 'es',
  VE: 'es',
  EC: 'es',
  GT: 'es',
  CU: 'es',
  BO: 'es',
  DO: 'es',
  HN: 'es',
  PY: 'es',
  SV: 'es',
  NI: 'es',
  CR: 'es',
  PA: 'es',
  UY: 'es',
}

// RFC 9110 §12.4.2 qvalue grammar: `0[.0-3 digits]` | `1[.0-3 zeros]`.
// Deliberately NOT `[0-9]*\.?[0-9]+` (the original, vulnerable pattern) —
// that shape has two adjacent quantifiers ([0-9]* and [0-9]+) that can both
// match the same digit run, so a non-matching input (e.g. a long digit run
// followed by a non-digit) forces the engine to retry every possible split
// between them before giving up: classic CWE-1333 catastrophic
// backtracking. This grammar has NO overlapping quantifiers and a fixed
// {1,3} bound, so it cannot backtrack more than a constant amount
// regardless of input length — confirmed empirically: the same
// 7800-character pathological q-value that took 119-153 ms against the old
// regex takes < 0.01 ms against this one (see PR #423 security-review
// round 1 for the exact benchmark).
const Q_RE = /^q=(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?)$/

/**
 * Parses a raw `Accept-Language` header into `{ tag, q }` entries, sorted
 * descending by q-value (RFC 9110 §12.5.4: default q = 1 when omitted).
 * Ties (equal q, including the extremely common "no explicit q anywhere"
 * case) keep the ORIGINAL left-to-right order — real-world browsers already
 * list tags in preference order even without explicit q values, so a
 * stable sort here is exactly the right tie-break, not an approximation.
 *
 * Hard caps applied BEFORE any per-tag work: the header is truncated to
 * MAX_HEADER_LEN characters and the tag list to MAX_TAGS entries. Both are
 * generous relative to any real client (see the constants above) and exist
 * purely to bound worst-case CPU work against adversarial input — this is
 * defense-in-depth on top of Q_RE, not a substitute for it (a single
 * MAX_HEADER_LEN-sized pathological value is still cheap against Q_RE, but
 * costly-if-not-impossible against the old vulnerable regex).
 *
 * security-review round 2 (PR #423, LOW-1): a tag whose `q=` parameter is
 * PRESENT but does NOT match the RFC 9110 grammar (`q=abc`, `q=-1`, `q=2`,
 * `q=0.0000` — that last one is out of grammar too, `{1,3}` fractional
 * digits max) used to silently fall back to the DEFAULT q=1 (full
 * priority) instead of being rejected — so `Accept-Language: ru;q=0.0000`
 * incorrectly won outright. Not a security hole (the final locale is still
 * constrained by the SUPPORTED allow-list either way — see `matchLocale`),
 * but wrong ranking. Fixed: a `q=` parameter that fails Q_RE now marks the
 * WHOLE TAG invalid (q forced to 0), which the existing `entry.q > 0`
 * filter below already excludes — same mechanism RFC 9110 uses for an
 * explicit `q=0` ("not acceptable"), just extended to "not parseable
 * as a valid qvalue" too. Any OTHER `;`-separated extension that isn't a
 * `q=` parameter (e.g. an `Accept-Language: da;level=1`-style accept-ext)
 * is still silently ignored, unchanged from before — only `q=` specifically
 * is now grammar-checked.
 */
function parseAcceptLanguage(header) {
  if (!header) {
    return []
  }
  if (header.length > MAX_HEADER_LEN) {
    header = header.substring(0, MAX_HEADER_LEN)
  }
  return header
    .split(',')
    .slice(0, MAX_TAGS)
    .map(function (part, index) {
      const bits = part.trim().split(';')
      const tag = bits[0].trim().toLowerCase()
      let q = 1
      let invalid = false
      for (let i = 1; i < bits.length; i++) {
        const bit = bits[i].trim()
        const match = bit.match(Q_RE)
        if (match) {
          q = parseFloat(match[0].slice(2))
        } else if (/^q=/i.test(bit)) {
          invalid = true
        }
      }
      const finalQ = invalid ? 0 : q
      return { tag: tag, q: isNaN(finalQ) ? 0 : finalQ, index: index }
    })
    .filter(function (entry) {
      return entry.tag.length > 0 && entry.q > 0
    })
    .sort(function (a, b) {
      if (b.q !== a.q) {
        return b.q - a.q
      }
      return a.index - b.index
    })
}

/**
 * Per plan §2 step 2: for a single tag, try an EXACT match against the
 * supported locale codes first, then fall back to the base language (the
 * part before the first "-"). Our supported set is base-language-only
 * (no regional codes), so in practice this reduces to "does the tag's base
 * language equal one of the 5?" — but the exact-first order is kept
 * faithful to the spec wording in case a regional supported locale is ever
 * added later (e.g. a hypothetical "pt-BR" as its own locale).
 */
function matchLocale(tag) {
  if (SUPPORTED.indexOf(tag) !== -1) {
    return tag
  }
  const base = tag.split('-')[0]
  if (SUPPORTED.indexOf(base) !== -1) {
    return base
  }
  return ''
}

function bestAcceptLanguageLocale(header) {
  const tags = parseAcceptLanguage(header)
  for (let i = 0; i < tags.length; i++) {
    const matched = matchLocale(tags[i].tag)
    if (matched) {
      return matched
    }
  }
  return ''
}

/**
 * Full priority chain: cookie `pref_locale` > Accept-Language best-match >
 * CF-IPCountry > "en". `r.variables.cookie_pref_locale` is nginx's built-in
 * embedded variable (auto-parses the named cookie out of the Cookie header
 * — no custom cookie-parsing needed here).
 */
function resolveTargetLocale(r) {
  const cookie = (r.variables.cookie_pref_locale || '').toLowerCase()
  if (SUPPORTED.indexOf(cookie) !== -1) {
    return cookie
  }

  const acceptLanguageMatch = bestAcceptLanguageLocale(r.headersIn['Accept-Language'])
  if (acceptLanguageMatch) {
    return acceptLanguageMatch
  }

  const country = (r.headersIn['CF-IPCountry'] || '').toUpperCase()
  if (Object.prototype.hasOwnProperty.call(CF_COUNTRY_LOCALE, country)) {
    return CF_COUNTRY_LOCALE[country]
  }

  return 'en'
}

/**
 * Exported entry point (`js_set $target_locale locale.targetLocale;`).
 * Wraps the ENTIRE resolution chain in try/catch: this runs on every
 * request to the shared nginx process (landing + CRM `/api` proxying share
 * one nginx), so ANY unexpected exception here — a future edge case in
 * njs's regex engine, a malformed header njs itself can't parse, etc. —
 * must degrade to a safe, cheap default rather than surface as an uncaught
 * njs stack trace (previously ~489 bytes/request logged to an unbounded
 * docker log, see runbook "ReDoS hardening"). "en" is the correct default
 * here: it is the same fallback the priority chain itself uses when
 * nothing matches, so callers cannot distinguish "no signal" from "an
 * exception happened" — both mean "just show English", which is always a
 * safe, valid, indexable response.
 */
function targetLocale(r) {
  try {
    return resolveTargetLocale(r)
  } catch (e) {
    return 'en'
  }
}

export default { targetLocale }
