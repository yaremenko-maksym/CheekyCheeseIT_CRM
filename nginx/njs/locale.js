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
 */

const SUPPORTED = ['en', 'uk', 'ru', 'es', 'pt']

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

/**
 * Parses a raw `Accept-Language` header into `{ tag, q }` entries, sorted
 * descending by q-value (RFC 9110 §12.5.4: default q = 1 when omitted).
 * Ties (equal q, including the extremely common "no explicit q anywhere"
 * case) keep the ORIGINAL left-to-right order — real-world browsers already
 * list tags in preference order even without explicit q values, so a
 * stable sort here is exactly the right tie-break, not an approximation.
 */
function parseAcceptLanguage(header) {
  if (!header) {
    return []
  }
  return header
    .split(',')
    .map(function (part, index) {
      const bits = part.trim().split(';')
      const tag = bits[0].trim().toLowerCase()
      let q = 1
      for (let i = 1; i < bits.length; i++) {
        const match = bits[i].trim().match(/^q=([0-9]*\.?[0-9]+)$/)
        if (match) {
          q = parseFloat(match[1])
        }
      }
      return { tag: tag, q: isNaN(q) ? 0 : q, index: index }
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
function targetLocale(r) {
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

export default { targetLocale }
