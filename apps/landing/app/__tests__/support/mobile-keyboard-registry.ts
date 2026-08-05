/**
 * mobile-keyboard-registry.ts — task-mobile-keyboards.md taxonomy, encoded
 * for `apps/landing`. See `apps/web/app/__tests__/support/mobile-keyboard-registry.ts`
 * for the full doc — same inverted-classification contract, smaller surface
 * (two public marketing forms: contact + vacancy application).
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

export const EXEMPT_FIELDS = new Set<string>([
  // ---- contact-form.tsx — free text ----
  'app/components/marketing/contact-form.tsx#name:company',
  'app/components/marketing/contact-form.tsx#name:message', // Textarea
  'app/components/marketing/contact-form.tsx#name:website', // honeypot — not user-facing (display:none, tabIndex=-1)

  // ---- vacancy-apply-form.tsx — free text ----
  'app/components/marketing/vacancy-apply-form.tsx#name:cover', // Textarea
  'app/components/marketing/vacancy-apply-form.tsx#id:website', // honeypot — not user-facing (display:none, tabIndex=-1)

  // ---- ui/input.tsx + ui/textarea.tsx — base wrapper's own inner native
  // element forwards `type` dynamically from the caller, never a literal.
  'app/components/ui/input.tsx#1',
  'app/components/ui/textarea.tsx#1',
])
