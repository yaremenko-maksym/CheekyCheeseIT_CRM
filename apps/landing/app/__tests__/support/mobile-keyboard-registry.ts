/**
 * mobile-keyboard-registry.ts — task-mobile-keyboards.md taxonomy, encoded
 * for `apps/landing`. See `apps/web/app/__tests__/support/mobile-keyboard-registry.ts`
 * for the full doc — same inverted-classification contract, smaller surface
 * (two public marketing forms: contact + vacancy application).
 *
 * `EXEMPT_FIELDS` is a `key -> reason` map, and a key that looks money/
 * contact-shaped by name is refused without an explicit acknowledged
 * override — same PR #481 review round 2 mitigation as the web registry.
 */

export type Category = 'EMAIL' | 'URL' | 'HANDLE' | 'PERSON_NAME'

interface Requirement {
  describe: string
  check(attrs: import('./input-scan').ScannedAttrs): boolean
}

const ANTI_AUTOCORRECT: Requirement[] = [
  { describe: 'autoCapitalize="off"', check: (a) => a.has('autoCapitalize', 'off') },
  { describe: 'autoCorrect="off"', check: (a) => a.has('autoCorrect', 'off') },
  { describe: 'spellCheck={false}', check: (a) => a.boolValue('spellCheck') === false },
]

function typeIncludes(value: string): Requirement {
  return { describe: `type includes "${value}"`, check: (a) => a.has('type', value) }
}

export const CATEGORY_REQUIREMENTS: Record<Category, Requirement[]> = {
  EMAIL: [
    typeIncludes('email'),
    { describe: 'autoComplete="email"', check: (a) => a.has('autoComplete', 'email') },
    ...ANTI_AUTOCORRECT,
  ],
  URL: [typeIncludes('url'), ...ANTI_AUTOCORRECT],
  HANDLE: [
    { describe: 'autoCapitalize="off"', check: (a) => a.has('autoCapitalize', 'off') },
    { describe: 'autoCorrect="off"', check: (a) => a.has('autoCorrect', 'off') },
  ],
  PERSON_NAME: [
    { describe: 'autoCapitalize="words"', check: (a) => a.has('autoCapitalize', 'words') },
    {
      describe: 'autoComplete is name/given-name/family-name',
      check: (a) =>
        a.has('autoComplete', 'name') ||
        a.has('autoComplete', 'given-name') ||
        a.has('autoComplete', 'family-name'),
    },
  ],
}

/**
 * Both forms are the VISITOR entering THEIR OWN data (unlike apps/web's
 * admin-on-behalf-of-someone-else cases) — real autofill is correct UX
 * here, so plain EMAIL/PERSON_NAME (not the *_NO_AUTOFILL variants) apply.
 */
export const FIELD_CATEGORIES: Record<string, Category> = {
  // ---- marketing/contact-form.tsx ----
  'app/components/marketing/contact-form.tsx#name:name': 'PERSON_NAME',
  'app/components/marketing/contact-form.tsx#name:email': 'EMAIL',

  // ---- marketing/vacancy-apply-form.tsx ----
  'app/components/marketing/vacancy-apply-form.tsx#name:name': 'PERSON_NAME',
  'app/components/marketing/vacancy-apply-form.tsx#name:email': 'EMAIL',
  'app/components/marketing/vacancy-apply-form.tsx#name:telegram': 'HANDLE',
  'app/components/marketing/vacancy-apply-form.tsx#name:linkedin': 'URL',
  'app/components/marketing/vacancy-apply-form.tsx#name:github': 'URL',
}

export const EXEMPT_FIELDS: Record<string, string> = {
  // ---- contact-form.tsx — free text ----
  'app/components/marketing/contact-form.tsx#name:company':
    'Free-text company name the visitor types about themselves — optional, no taxonomy class applies.',
  'app/components/marketing/contact-form.tsx#name:message':
    'Free-text inquiry message (Textarea) — arbitrary prose by definition.',
  'app/components/marketing/contact-form.tsx#name:website':
    'Anti-bot honeypot field — visually hidden (display:none, tabIndex=-1), never seen or filled by a real visitor, so no mobile keyboard concern applies.',

  // ---- vacancy-apply-form.tsx — free text ----
  'app/components/marketing/vacancy-apply-form.tsx#name:cover':
    'Free-text cover-letter message (Textarea) — arbitrary prose by definition.',
  'app/components/marketing/vacancy-apply-form.tsx#id:website':
    'Anti-bot honeypot field — same as contact-form.tsx#name:website, visually hidden and never filled by a real visitor.',

  // ---- ui/input.tsx + ui/textarea.tsx — base wrapper's own inner native
  // element forwards `type` dynamically from the caller, never a literal.
  'app/components/ui/input.tsx#1':
    "The base Input wrapper's OWN inner native <input> — its `type` is forwarded dynamically from whatever caller renders <Input>, never a literal, so this node itself can never satisfy a category; every call site is scanned separately.",
  'app/components/ui/textarea.tsx#1':
    "Same as ui/input.tsx#1 — the base Textarea wrapper's own inner native <textarea>, props forwarded dynamically from the caller.",
}

/**
 * Money/contact-data-shaped substrings — see web registry's identically
 * named export for the full rationale (PR #481 review round 2).
 */
export const SENSITIVE_KEYWORDS = [
  'amount',
  'wallet',
  'iban',
  'phone',
  'email',
  'hash',
  'password',
  'salary',
] as const

/**
 * No landing EXEMPT_FIELDS key currently matches SENSITIVE_KEYWORDS — kept
 * as an empty, typed export so the guard spec can import it unconditionally
 * and so a future override has an obvious place to land.
 */
export const ACKNOWLEDGED_SENSITIVE_EXEMPTIONS: Record<string, string> = {}
