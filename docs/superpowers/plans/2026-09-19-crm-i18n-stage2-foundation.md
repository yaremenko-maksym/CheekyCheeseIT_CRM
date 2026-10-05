# CRM i18n — stage 2 "Foundation" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble everything needed for any CRM module to migrate to `uk`/`en` in a single PR: Lingui, the shared catalog in `packages/shared`, the user and request locale, an error-code envelope with translation on the client, an ESLint warning about unwrapped strings, updated project rules and the four "before string extraction" fixes from the audit.

**Architecture:** One catalog `packages/shared/src/i18n/locales/{uk,en}/messages.po` for three consumers: web (React, macros via the Babel plugin in Vite and Vitest), API and shared (CommonJS, without macros — descriptors with `/* i18n */` and explicit ids, a separate `i18n` instance per request/recipient). API errors — `{ statusCode, code, params, message }`; the client translates by `code`. The locale: `users.locale` (enum `uk|en`, default `uk`) → `/auth/me` → `I18nProvider`; before login — cookie `pref_locale` → `navigator.language` → `uk`.

**Tech Stack:** Lingui **5.9.5** (owner decision 2026-09-19 after spikes 0b/0c; 6.x — see Global Constraints) (`@lingui/core`, `@lingui/react`, `@lingui/cli`, `@lingui/vite-plugin`, `@lingui/babel-plugin-lingui-macro`) + `eslint-plugin-lingui` 0.16.0, React 18 + Vite 6 + Vitest 4, NestJS 11 + Fastify, Drizzle, Zod 4, pnpm 7.32.4, **Node 22 LTS** (Task 0).

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` (stage 1 done: `docs/architecture/2026-09-19-crm-i18n-audit.md`).

## Global Constraints

- **Outcome of spikes 0b/0c (2026-09-19):** Lingui 6 is ESM-only; the runtime `require(esm)` under Node 22 works in shared and api, but `tsc` with `moduleResolution: Node` does not see its types (TS2307), and moving api/shared to `node16` is blocked by the dual-package types of `drizzle-orm@0.45.2` (57 errors in 10 files of the relational query-builder). **Owner decision: Lingui 5.9.5 for now** (`main: index.cjs`, the `require` condition, Node ≥ 20 — compatible without config edits; the same macros `@lingui/core/macro`/`@lingui/react/macro`); the upgrade to 6 — a separate backlog item with the condition "Drizzle publishes unified types, or api/shared on node16". Node 22 (Task 0) stays — the runtime and the future upgrade need it.
- All `@lingui/*` packages — **one version 5.9.5**, EXACT-pinned; a line in `version-pins.md` (Task 10, add it already in Task 1).
- Languages: `uk` (default, `sourceLocale`) and `en`. The source text in the code — Ukrainian; the id — a hash of the text (the Lingui default), explicit ids only for error codes and module descriptors in shared/api.
- Russian is removed from the product **by modules in stage 3** — in this stage new/changed strings are written in `uk` + `en` right away, existing Russian is not touched, except the ones listed in the tasks.
- API errors — codes + `params` without PII; `message` — an English fallback.
- Tests: anchors `data-testid`/roles, the text in assertions — from the `uk` catalog via `i18n._()` / a descriptor import, not a literal.
- DDL — only `apps/api/drizzle/manual/*.sql`, idempotent, three places in `deploy.yml`, `scripts/devops/check-prod-ddl-wiring.py` → `BROKEN WIRING: 0`.
- `git add` by an explicit list; `DATABASE_URL= git push`; without `--no-verify`; commits with `ac_verified:`.
- Zones: `.github/workflows/**` — DevOps (Task 9b); `.claude/rules/**`, `.claude/agents/**`, `CONTEXT.md` — Architect/Master (Task 10); everything else — Coder.

---

## File map

| File                                                                                                                                                                                             | Responsibility                                                           | Task |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---- |
| `lingui.config.ts` (root)                                                                                                                                                                        | Locales, the catalogs of the three packages, the `po` format             | 1    |
| `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`                                                                                                                                           | The Babel macro plugin + `lingui()`                                      | 1    |
| `packages/shared/src/i18n/locales.ts`                                                                                                                                                            | `LOCALES`, `Locale`, `DEFAULT_LOCALE`, `localeSchema`, `resolveLocale()` | 2    |
| `packages/shared/src/i18n/format.ts`                                                                                                                                                             | `formatDate`, `formatMoney`, `formatNumber`, `compareNames`              | 2    |
| `packages/shared/src/i18n/catalog.ts`                                                                                                                                                            | `createI18n(locale)` — an instance per request/recipient (Node, CJS)     | 2    |
| `packages/shared/src/i18n/locales/{uk,en}/messages.po`                                                                                                                                           | The single source of translations (committed)                            | 1, 2 |
| `packages/shared/src/schemas/api-errors.ts`                                                                                                                                                      | `API_ERROR_CODES`, `apiErrorEnvelopeSchema`, `API_ERROR_MESSAGES`        | 5    |
| `apps/api/src/common/api-error.ts`                                                                                                                                                               | `apiError(code, status, params?)` → `HttpException` with the envelope    | 5    |
| `apps/api/src/i18n/request-locale.ts`                                                                                                                                                            | `resolveRequestLocale(req)`, `@RequestLocale()`                          | 4    |
| `apps/api/drizzle/manual/2026-09-20_user_locale.sql`                                                                                                                                             | enum `user_locale` + the column `users.locale`                           | 3    |
| `apps/web/app/lib/i18n.ts`                                                                                                                                                                       | `i18n`, `activateLocale()`, `readPreLoginLocale()`, `useLocale()`        | 6    |
| `apps/web/app/components/user-profile/LanguageSection.tsx`                                                                                                                                       | The switcher in the profile (self-mode)                                  | 7    |
| `apps/web/app/lib/axios-utils.ts`                                                                                                                                                                | `getApiErrorMessage` — `code` first                                      | 5    |
| `apps/web/app/components/pending/PendingKindSection.tsx`                                                                                                                                         | `data-testid` from `kind`                                                | 8    |
| `apps/web/app/lib/documents-filter-sort.ts`                                                                                                                                                      | `compareNames(locale)` instead of `localeCompare(…, 'ru')`               | 8    |
| `apps/web/app/components/{layout/ImpersonationBanner,user-profile/UserProfileHeader,user-profile/tabs/TeamTab}.tsx`                                                                              | One role map `ROLE_LABELS` from `ui/role-select`                         | 8    |
| `apps/web/eslint.config.mjs`, `packages/shared/eslint.config.mjs`                                                                                                                                | `lingui/no-unlocalized-strings: warn`                                    | 9    |
| `.github/workflows/ci.yml`                                                                                                                                                                       | The "catalogs in sync" step (`lingui extract --clean` + `git diff`)      | 9b   |
| `.claude/rules/common/{russian-language,version-pins}.md`, `.claude/agents/copy-reviewer.md`, `.claude/skills/{copywriting,playwright-patterns}/SKILL.md`, `.claude/agents/workflow-registry.md` | Rules for two languages                                                  | 10   |

Order: 0 → 0b → 1 → 2 → (3, 4, 5 in parallel) → 6 → 7 → 8 → 9 → 9b → 10. Each task — its own PR (or 1+2 as one, 3+4 as one).

---

### Task 0 (DevOps): Node 22 LTS across the whole monorepo

**Files:**

- Modify: `.github/workflows/ci.yml` (all `node-version: '20'` → `'22'`), `.github/workflows/deploy.yml` and the other workflows with `setup-node` (`grep -rn "node-version" .github/workflows`)
- Modify: `apps/api/Dockerfile` (`FROM node:20-alpine` → `node:22-alpine`, both stages), the other Dockerfiles (`grep -rln "node:20" .`)
- Modify/Create: `.nvmrc` (`22`), the root `package.json` → `"engines": { "node": ">=22.19 <23", "pnpm": "7.32.4" }`
- Modify: `.claude/rules/common/version-pins.md` — "Node: 22 LTS (strictly; raised 2026-09-19 for Lingui 6)", `docs/runbooks/deployment.md` — the mentions of Node 20
- Test: CI green on this PR (all jobs), `docker build -f apps/api/Dockerfile .` passes locally, `pnpm install --frozen-lockfile` under Node 22 without `EBADENGINE`

- [ ] **Step 1: Find all the places**

```bash
grep -rn "node-version\|node:20\|nodejs 20\|Node 20" .github apps/*/Dockerfile Dockerfile* docs/runbooks .claude/rules/common/version-pins.md package.json 2>/dev/null
```

- [ ] **Step 2: Replace with 22, add `engines` and `.nvmrc`; check locally**

```bash
nvm install 22 && nvm use 22 && node -v   # ≥ v22.19
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
docker build -f apps/api/Dockerfile -t crm-api:node22 .
```

If some package breaks on Node 22 (the signal — `pnpm test` red where it is green on 20) — this is a finding of the task, not a reason to roll back: record it in the PR body and bump the package per `version-pins.md`.

- [ ] **Step 3: Commit and PR (the DevOps zone: workflows + Dockerfile)**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml apps/api/Dockerfile .nvmrc package.json .claude/rules/common/version-pins.md docs/runbooks/deployment.md
git commit -m "infra(node): Node 22 LTS in CI, Docker, engines and pins (prerequisite for Lingui 6)

ac_verified: 0"
```

Check the deploy after merge as usual (`gh run list --workflow deploy.yml`, healthcheck) — the API image is rebuilt on the new base.

---

### Task 0b (spike, throwaway): the CJS build of API and shared with the ESM-only Lingui 6

**Files:**

- Create (temporarily, do not commit): `packages/shared/src/i18n/__spike__/esm-require.spec.ts`

- [ ] **Step 1: Install `@lingui/core@6.7.0` in `packages/shared` and write a test that imports it as in production code**

```ts
// packages/shared/src/i18n/__spike__/esm-require.spec.ts
import { describe, expect, it } from 'vitest'
import { setupI18n } from '@lingui/core'

describe('spike: @lingui/core 6 from the CommonJS build', () => {
  it('setupI18n works', () => {
    const i18n = setupI18n({ locale: 'uk', messages: { uk: { hello: 'Привіт' } } })
    expect(i18n._('hello')).toBe('Привіт')
  })
})
```

- [ ] **Step 2: Three checks, all three must be green**

```bash
pnpm --filter @crm/shared typecheck          # tsc with module=CommonJS resolves the types of @lingui/core (exports with the "import" condition)
pnpm --filter @crm/shared build && node -e "require('./packages/shared/dist/index.js')"   # require(esm) at runtime on Node 22
pnpm --filter @crm/api typecheck && pnpm --filter @crm/api build && node -e "require('./apps/api/dist/main.js')" 2>&1 | head -3   # the same for the API bundle
```

Expected: typecheck is clean, both `require` calls do not fail on `ERR_REQUIRE_ESM`/`ERR_PACKAGE_PATH_NOT_EXPORTED`.

- [ ] **Step 3: Conclusion**

All three green → delete `__spike__`, keep the dependency, go to Task 1. At least one red → `.claude/tasks/task-i18n-stage2.blocked.md` with the exact error text and two options: (a) Lingui 5.9.5 (CJS+ESM, the same macro API), (b) `module: node16` + the `"type"` layout for `packages/shared`/`apps/api`. The orchestrator decides.

---

### Task 1: Lingui in the monorepo — dependencies, config, build, a test run

**Files:**

- Modify: `package.json` (root: devDeps `@lingui/cli`, scripts `i18n:extract`, `i18n:compile`), do not touch `pnpm-workspace.yaml`
- Modify: `apps/web/package.json` (deps `@lingui/core`, `@lingui/react`; devDeps `@lingui/vite-plugin`, `@lingui/babel-plugin-lingui-macro`)
- Modify: `packages/shared/package.json`, `apps/api/package.json` (dep `@lingui/core`)
- Create: `lingui.config.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`
- Create: `packages/shared/src/i18n/locales/uk/messages.po`, `packages/shared/src/i18n/locales/en/messages.po` (empty headers — `lingui extract` will create them)
- Modify: `.gitignore` (the compiled `messages.ts`), `turbo.json` (the `i18n:compile` task)
- Modify: `.claude/rules/common/version-pins.md` (the pins line — see Task 10, here just add the line)
- Test: `apps/web/app/lib/__tests__/i18n-smoke.test.tsx`

**Interfaces:**

- Produces: the scripts `pnpm i18n:extract` (`lingui extract --clean`), `pnpm i18n:compile` (`lingui compile --typescript`); the catalog path `packages/shared/src/i18n/locales/<locale>/messages.po`; the compiled `…/messages.ts` (gitignored, generated by `i18n:compile`, which turbo runs before `build`, `test`, `typecheck`, `dev`).

- [ ] **Step 1: Install the dependencies at one version**

```bash
pnpm add -w -D @lingui/cli@5.9.5 @lingui/babel-plugin-lingui-macro@5.9.5
pnpm --filter @crm/web add @lingui/core@5.9.5 @lingui/react@5.9.5
pnpm --filter @crm/web add -D @lingui/vite-plugin@5.9.5
pnpm --filter @crm/shared add @lingui/core@5.9.5
pnpm --filter @crm/api add @lingui/core@5.9.5
```

In each `package.json` the version must be `"5.9.5"` without `^` (EXACT-pin, like the TanStack pair).

- [ ] **Step 2: The Lingui config in the root**

```ts
// lingui.config.ts
import type { LinguiConfig } from '@lingui/conf'

const config: LinguiConfig = {
  sourceLocale: 'uk',
  locales: ['uk', 'en'],
  format: 'po',
  catalogs: [
    {
      path: '<rootDir>/packages/shared/src/i18n/locales/{locale}/messages',
      include: [
        '<rootDir>/apps/web/app',
        '<rootDir>/apps/api/src',
        '<rootDir>/packages/shared/src',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/routeTree.gen.ts',
      ],
    },
  ],
  compileNamespace: 'ts',
}

export default config
```

- [ ] **Step 3: Scripts and turbo**

The root `package.json` → `scripts`:

```json
"i18n:extract": "lingui extract --clean",
"i18n:compile": "lingui compile --typescript"
```

`turbo.json` → `tasks`: add

```json
"i18n:compile": { "cache": false, "inputs": ["packages/shared/src/i18n/locales/**/*.po", "lingui.config.ts"] }
```

and in `build`, `typecheck`, `test`, `dev` add `"dependsOn": ["//#i18n:compile", ...existing]` (the root-task syntax `//#`). `.gitignore`: `packages/shared/src/i18n/locales/*/messages.ts`.

- [ ] **Step 4: Vite and Vitest — macros via Babel**

```ts
// apps/web/vite.config.ts — plugins
import { lingui } from '@lingui/vite-plugin'
// ...
plugins: [
  // TanStackRouterVite(...) as it was,
  react({ babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] } }),
  lingui(),
  // the rest as it was
]
```

The same `react({ babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] } })` in `apps/web/vitest.config.ts` (it has its own `react()`), plus `lingui()`.

- [ ] **Step 5: Empty catalogs and the first run**

```bash
pnpm i18n:extract && pnpm i18n:compile
git status --short packages/shared/src/i18n
```

Expected: two `messages.po` with headers (`Language: uk` / `Language: en`), `messages.ts` in `.gitignore`.

- [ ] **Step 6: A smoke test of the macros in Vitest (fails before configuration, passes after)**

```tsx
// apps/web/app/lib/__tests__/i18n-smoke.test.tsx
import { render, screen } from '@testing-library/react'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { describe, expect, it } from 'vitest'

describe('lingui macros are transformed in vitest', () => {
  it('renders the source-locale text when uk is active', () => {
    i18n.load('uk', {})
    i18n.activate('uk')
    render(
      <I18nProvider i18n={i18n}>
        <p data-testid="smoke">
          <Trans>Зберегти</Trans>
        </p>
      </I18nProvider>,
    )
    expect(screen.getByTestId('smoke')).toHaveTextContent('Зберегти')
  })
})
```

Run: `pnpm --filter @crm/web test -- app/lib/__tests__/i18n-smoke.test.tsx` → PASS (without the Babel plugin it would fail on `Trans is not a function`/`The macro you imported…`).

- [ ] **Step 7: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @crm/web test
git add package.json pnpm-lock.yaml lingui.config.ts turbo.json .gitignore apps/web/package.json apps/web/vite.config.ts apps/web/vitest.config.ts packages/shared/package.json apps/api/package.json packages/shared/src/i18n/locales/uk/messages.po packages/shared/src/i18n/locales/en/messages.po apps/web/app/lib/__tests__/i18n-smoke.test.tsx
git commit -m "infra(i18n): add Lingui 5.9.5 — config, catalogs, vite/vitest macro plugin, turbo compile step

ac_verified: 1"
```

---

### Task 2: `packages/shared/src/i18n` — locales, formatting, the `i18n` instance for Node

**Files:**

- Create: `packages/shared/src/i18n/locales.ts`, `format.ts`, `catalog.ts`, `index.ts`
- Modify: `packages/shared/src/index.ts` (`export * from './i18n'`)
- Test: `packages/shared/src/i18n/locales.spec.ts`, `format.spec.ts`, `catalog.spec.ts`

**Interfaces:**

- Produces:
  - `LOCALES = ['uk','en'] as const`, `type Locale`, `DEFAULT_LOCALE: Locale = 'uk'`, `localeSchema = z.enum(LOCALES)`, `resolveLocale(candidates: ReadonlyArray<string | null | undefined>): Locale` — the first valid by BCP-47 prefix (`en-US` → `en`, `uk-UA` → `uk`), otherwise `uk`.
  - `formatDate(value: Date | string, locale: Locale, style?: 'short' | 'long'): string`, `formatMoney(amount: number | string, currency: 'USDT'|'USD'|'EUR'|'UAH', locale: Locale): string`, `formatNumber(n: number, locale: Locale): string`, `compareNames(locale: Locale): (a: string, b: string) => number`.
  - `createI18n(locale: Locale): I18n` — a new `setupI18n` instance with the compiled catalog loaded (CJS `require`), for API email/PDF in the recipient's locale and for the server in general (no global `activate` in the API).

- [ ] **Step 1: Locale tests**

```ts
// packages/shared/src/i18n/locales.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, localeSchema, resolveLocale } from './locales'

describe('resolveLocale', () => {
  it('takes the first supported candidate by language prefix', () => {
    expect(resolveLocale(['fr-FR', 'en-US', 'uk'])).toBe('en')
  })
  it('falls back to uk when nothing matches', () => {
    expect(resolveLocale([undefined, null, 'de'])).toBe(DEFAULT_LOCALE)
  })
  it('localeSchema rejects ru', () => {
    expect(localeSchema.safeParse('ru').success).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL (`Cannot find module './locales'`)**

Run: `pnpm --filter @crm/shared test -- src/i18n/locales.spec.ts`

- [ ] **Step 3: Implementation**

```ts
// packages/shared/src/i18n/locales.ts
import { z } from 'zod'

export const LOCALES = ['uk', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'uk'
export const localeSchema = z.enum(LOCALES)
export const LOCALE_COOKIE_NAME = 'pref_locale'

function toLocale(candidate: string): Locale | null {
  const prefix = candidate.trim().toLowerCase().split(/[-_]/)[0]
  return (LOCALES as readonly string[]).includes(prefix) ? (prefix as Locale) : null
}

/** First supported candidate wins (`en-US` → `en`); nothing supported → `uk`. */
export function resolveLocale(candidates: ReadonlyArray<string | null | undefined>): Locale {
  for (const c of candidates) {
    if (!c) continue
    const found = toLocale(c)
    if (found) return found
  }
  return DEFAULT_LOCALE
}
```

- [ ] **Step 4: Formatting tests (the values — from `Intl`, not from memory)**

```ts
// packages/shared/src/i18n/format.spec.ts
import { describe, expect, it } from 'vitest'
import { compareNames, formatDate, formatMoney, formatNumber } from './format'

describe('format', () => {
  it('formats the same date differently per locale', () => {
    const d = new Date(Date.UTC(2026, 8, 19))
    expect(formatDate(d, 'uk')).toBe(
      new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC' }).format(d),
    )
    expect(formatDate(d, 'en')).toBe(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' }).format(d),
    )
  })
  it('formats money with the currency code, two decimals', () => {
    expect(formatMoney('1234.5', 'USDT', 'en')).toBe('1,234.50 USDT')
    expect(formatMoney(1234.5, 'UAH', 'uk')).toContain('1 234,50')
  })
  it('compareNames orders Ukrainian letters correctly', () => {
    const sorted = ['Яків', 'Ірина', 'Євген', 'Андрій'].sort(compareNames('uk'))
    expect(sorted).toEqual(['Андрій', 'Євген', 'Ірина', 'Яків'])
  })
  it('formatNumber uses locale separators', () => {
    expect(formatNumber(1000000, 'en')).toBe('1,000,000')
  })
})
```

- [ ] **Step 5: Run → FAIL, then implementation**

```ts
// packages/shared/src/i18n/format.ts
import type { Locale } from './locales'

const INTL_TAG: Record<Locale, string> = { uk: 'uk-UA', en: 'en-GB' }

export function formatDate(
  value: Date | string,
  locale: Locale,
  style: 'short' | 'long' = 'short',
): string {
  const d = typeof value === 'string' ? new Date(value) : value
  const opts: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
      : { timeZone: 'UTC' }
  return new Intl.DateTimeFormat(INTL_TAG[locale], opts).format(d)
}

export function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_TAG[locale]).format(n)
}

/** Money is always `<amount> <CODE>` — USDT has no Intl currency, so the code is appended uniformly. */
export function formatMoney(
  amount: number | string,
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH',
  locale: Locale,
): string {
  const n = typeof amount === 'string' ? Number(amount) : amount
  const body = new Intl.NumberFormat(INTL_TAG[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
  return `${body} ${currency}`
}

export function compareNames(locale: Locale): (a: string, b: string) => number {
  const collator = new Intl.Collator(INTL_TAG[locale], { sensitivity: 'base' })
  return (a, b) => collator.compare(a, b)
}
```

A note for the implementer: if the existing `apps/web/app/lib/format-amount.ts` formats differently (space vs comma), do **not** change it in this task — the modules will move to `formatMoney` in stage 3.

- [ ] **Step 6: `createI18n` and a test**

```ts
// packages/shared/src/i18n/catalog.ts
import { setupI18n, type I18n } from '@lingui/core'
import type { Locale } from './locales'

/** Compiled by `lingui compile --typescript` into `./locales/<locale>/messages.ts` (gitignored). */
function loadMessages(locale: Locale): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS build; catalogs are generated files
  const mod = require(`./locales/${locale}/messages`) as { messages: Record<string, unknown> }
  return mod.messages
}

/** One instance per request / per recipient — never activate a global singleton on the server. */
export function createI18n(locale: Locale): I18n {
  const i18n = setupI18n({ locale, messages: { [locale]: loadMessages(locale) } })
  return i18n
}
```

```ts
// packages/shared/src/i18n/catalog.spec.ts
import { describe, expect, it } from 'vitest'
import { createI18n } from './catalog'

describe('createI18n', () => {
  it('returns independent instances with their own locale', () => {
    const uk = createI18n('uk')
    const en = createI18n('en')
    expect(uk.locale).toBe('uk')
    expect(en.locale).toBe('en')
    expect(uk._(/* i18n */ { id: 'smoke.hello', message: 'Привіт' })).toBe('Привіт')
  })
})
```

Run: `pnpm i18n:compile && pnpm --filter @crm/shared test -- src/i18n` → PASS. Note: in `packages/shared/vitest.config` (or `tsconfig`) `require` is available, the package is CommonJS; if Vitest fails on `require` — enable `deps.interopDefault`/keep the `createRequire(import.meta.url)` variant — pick one and record it in the PR body.

- [ ] **Step 7: Export and commit**

`packages/shared/src/i18n/index.ts`: `export * from './locales'; export * from './format'; export * from './catalog'`; in `packages/shared/src/index.ts` add `export * from './i18n'`. Check that `packages/shared/src/public.ts` (the public landing bundle) does **not** export `catalog.ts` (it has `require`).

```bash
pnpm --filter @crm/shared typecheck && pnpm --filter @crm/shared lint && pnpm --filter @crm/shared test
git add packages/shared/src/i18n packages/shared/src/index.ts
git commit -m "feat(shared): i18n foundation — locales, Intl formatting, per-request i18n instance

ac_verified: 2"
```

---

### Task 3: `users.locale` — the column, DDL, `/auth/me`, `PATCH /users/me`, the creation wizard

**Files:**

- Modify: `apps/api/src/database/schema.ts` (enum `userLocaleEnum`, the column `locale`)
- Create: `apps/api/drizzle/manual/2026-09-20_user_locale.sql`
- Modify: `.github/workflows/deploy.yml` — **the DevOps zone**: three places (the preflight list, SCP, psql); the coder leaves `.blocked.md` only if DevOps is unavailable; in this plan the step is done by the same PR with the note "the DevOps lines — additive wiring modeled on `2026-09-19_notification_email_skip_stale.sql`"
- Modify: `packages/shared/src/schemas/auth.ts` (`sessionUserSchema.locale`), `packages/shared/src/schemas/users.ts` (`updateProfileSchema.locale`, `createUserSchema.locale`)
- Modify: `apps/api/src/auth/auth.controller.ts` (`/me` → `locale`), `apps/api/src/users/users.service.ts` (`updateProfile` writes `locale`; `create` accepts `locale`), `apps/api/src/users/users.controller.ts` (no changes, the schema is extended)
- Modify: `apps/web/app/components/users/UserDialog.tsx` — the "Data" step of the wizard: a `Select` "Мова інтерфейсу / Interface language" (`uk` by default)
- Test: `packages/shared/src/schemas/auth.spec.ts`, `apps/api/src/users/users-locale.integration.spec.ts`, `apps/api/src/database/user-locale-migration.integration.spec.ts` (DDL idempotency, modeled on `notification-email-migrations.integration.spec.ts`), `apps/web/app/components/users/__tests__/UserDialog.create-wizard.test.tsx` (the locale field)

**Interfaces:**

- Produces: `sessionUserSchema` gets `locale: localeSchema` (required); `SessionUser.locale`; `updateProfileSchema.locale?: Locale`; `createUserSchema.locale?: Locale` (the default `uk` in the service); DDL `user_locale` enum + `users.locale NOT NULL DEFAULT 'uk'`.

- [ ] **Step 1: A schema test (fails: the field is absent)**

```ts
// packages/shared/src/schemas/auth.spec.ts (add)
it('sessionUserSchema requires a supported locale', () => {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'a@b.c',
    displayName: 'A',
    avatarUrl: null,
    role: 'JUNIOR',
    seniorSharePercent: 0,
    legalFullName: null,
    impersonating: false,
  }
  expect(sessionUserSchema.safeParse({ ...base, locale: 'en' }).success).toBe(true)
  expect(sessionUserSchema.safeParse({ ...base, locale: 'ru' }).success).toBe(false)
  expect(sessionUserSchema.safeParse(base).success).toBe(false)
})
```

- [ ] **Step 2: Schemas**

```ts
// packages/shared/src/schemas/auth.ts — inside sessionUserSchema
locale: localeSchema,
// packages/shared/src/schemas/users.ts
export const updateProfileSchema = z.object({ /* …as it was… */ locale: localeSchema.optional() })
// createUserSchema: add locale: localeSchema.optional()
```

(`import { localeSchema } from '../i18n/locales'`.)

- [ ] **Step 3: Drizzle + DDL**

```ts
// apps/api/src/database/schema.ts (next to roleEnum)
export const userLocaleEnum = pgEnum('user_locale', ['uk', 'en'])
// in users: after role
locale: userLocaleEnum('locale').notNull().default('uk'),
```

```sql
-- apps/api/drizzle/manual/2026-09-20_user_locale.sql
-- CRM i18n stage 2 (spec docs/superpowers/specs/2026-09-19-crm-i18n-design.md §4.1):
-- interface language per user. Idempotent; no data rewritten (every existing user gets 'uk').
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_locale') THEN
    CREATE TYPE user_locale AS ENUM ('uk', 'en');
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS locale user_locale NOT NULL DEFAULT 'uk';

-- VERIFY: SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name = 'users' AND column_name = 'locale';
```

`deploy.yml`: add the file in three places modeled on the previous DDL; `python3 scripts/devops/check-prod-ddl-wiring.py` → `BROKEN WIRING: 0`.

- [ ] **Step 4: `/auth/me` and `updateProfile`**

In both branches of `auth.controller.ts` `/me`: `locale: fresh.locale` (in the fallback branch — `'uk'`). In `users.service.ts` `updateProfile(id, data: { …; locale?: 'uk' | 'en' })` — include `locale` in `set({...})`. In `create` — `locale: input.locale ?? 'uk'`.

- [ ] **Step 5: Integration test (a real Postgres, `skipIf(!hasDatabaseUrl())` like the neighbors)**

```ts
// apps/api/src/users/users-locale.integration.spec.ts — the gist of the cases
it('PATCH /users/me {locale:"en"} is reflected by GET /auth/me', async () => {
  await request(app).patch('/api/users/me').set(auth(junior)).send({ locale: 'en' }).expect(200)
  const me = await request(app).get('/api/auth/me').set(auth(junior)).expect(200)
  expect(me.body.locale).toBe('en')
})
it('rejects an unsupported locale with 400', async () => {
  await request(app).patch('/api/users/me').set(auth(junior)).send({ locale: 'ru' }).expect(400)
})
it('new users default to uk', async () => {
  const created = await request(app)
    .post('/api/users')
    .set(auth(admin))
    .send(validCreateBody())
    .expect(201)
  expect(created.body.locale).toBe('uk')
})
```

Run on a scratch database: `DATABASE_URL=postgres://…/crm_scratch_i18n pnpm --filter @crm/api test -- users-locale` → PASS.

- [ ] **Step 6: The creation wizard — the locale field**

In the "Data" step of `UserDialog.tsx` (the create wizard) — a `Select` with two options (`uk` — "Українська", `en` — "English"), `data-testid="user-locale-select"`, the default value `uk`, `locale` in the payload. The test in `UserDialog.create-wizard.test.tsx`: picking `en` → `api.post` called with `locale: 'en'`.

- [ ] **Step 7: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @crm/shared test && pnpm --filter @crm/web test && DATABASE_URL=postgres://postgres:postgres@localhost:5432/crm_scratch_i18n pnpm --filter @crm/api test -- integration   # own scratch base, inline
python3 scripts/devops/check-prod-ddl-wiring.py
git add apps/api/src/database/schema.ts apps/api/drizzle/manual/2026-09-20_user_locale.sql .github/workflows/deploy.yml packages/shared/src/schemas/auth.ts packages/shared/src/schemas/users.ts packages/shared/src/schemas/auth.spec.ts apps/api/src/auth/auth.controller.ts apps/api/src/users/users.service.ts apps/api/src/users/users-locale.integration.spec.ts apps/api/src/database/user-locale-migration.integration.spec.ts apps/web/app/components/users/UserDialog.tsx apps/web/app/components/users/__tests__/UserDialog.create-wizard.test.tsx
git commit -m "feat(users): interface locale per user — users.locale (uk|en), /auth/me, PATCH /users/me, create wizard

ac_verified: 3"
```

---

### Task 4: The request locale on the API — `resolveRequestLocale` and `@RequestLocale()`

**Files:**

- Create: `apps/api/src/i18n/request-locale.ts`
- Test: `apps/api/src/i18n/request-locale.spec.ts`

**Interfaces:**

- Consumes: `resolveLocale`, `LOCALE_COOKIE_NAME` from `@crm/shared`; `request.user` (`SessionUser` with `locale`) from `JwtAuthGuard`.
- Produces: `resolveRequestLocale(req: { user?: { locale?: string }; cookies?: Record<string,string>; headers: { 'accept-language'?: string } }): Locale` — the order: `user.locale` → cookie `pref_locale` → the first language of `Accept-Language` → `uk`; the param decorator `RequestLocale` (`createParamDecorator`).

- [ ] **Step 1: Test**

```ts
// apps/api/src/i18n/request-locale.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveRequestLocale } from './request-locale'

describe('resolveRequestLocale', () => {
  it('prefers the authenticated user locale', () => {
    expect(
      resolveRequestLocale({
        user: { locale: 'en' },
        cookies: { pref_locale: 'uk' },
        headers: { 'accept-language': 'uk' },
      }),
    ).toBe('en')
  })
  it('then the pref_locale cookie', () => {
    expect(
      resolveRequestLocale({
        cookies: { pref_locale: 'en' },
        headers: { 'accept-language': 'uk-UA,uk;q=0.9' },
      }),
    ).toBe('en')
  })
  it('then Accept-Language, ignoring unsupported languages', () => {
    expect(
      resolveRequestLocale({ headers: { 'accept-language': 'de-DE,de;q=0.9,en-US;q=0.8' } }),
    ).toBe('en')
  })
  it('defaults to uk', () => {
    expect(resolveRequestLocale({ headers: {} })).toBe('uk')
  })
})
```

- [ ] **Step 2: Run → FAIL; implementation**

```ts
// apps/api/src/i18n/request-locale.ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import { LOCALE_COOKIE_NAME, resolveLocale, type Locale } from '@crm/shared'

export interface LocaleSource {
  user?: { locale?: string | null }
  cookies?: Record<string, string | undefined>
  headers: { 'accept-language'?: string }
}

function acceptLanguageCandidates(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter(Boolean)
}

export function resolveRequestLocale(req: LocaleSource): Locale {
  return resolveLocale([
    req.user?.locale ?? null,
    req.cookies?.[LOCALE_COOKIE_NAME] ?? null,
    ...acceptLanguageCandidates(req.headers['accept-language']),
  ])
}

export const RequestLocale = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Locale => {
    return resolveRequestLocale(ctx.switchToHttp().getRequest<LocaleSource>())
  },
)
```

Check that the Fastify cookie parser is already connected (`@fastify/cookie` — the JWT auth-cookie uses it); if `request.cookies` is absent — read the `cookie` header manually in `resolveRequestLocale` (add a case to the test).

- [ ] **Step 3: Run → PASS; commit**

```bash
pnpm --filter @crm/api typecheck && pnpm --filter @crm/api lint && pnpm --filter @crm/api test -- request-locale
git add apps/api/src/i18n/request-locale.ts apps/api/src/i18n/request-locale.spec.ts
git commit -m "feat(api): request locale resolver — user, pref_locale cookie, Accept-Language, uk

ac_verified: 4"
```

---

### Task 5: The error-code envelope — the registry in shared, `apiError()` on the API, translation on the client, the first six codes

**Files:**

- Create: `packages/shared/src/schemas/api-errors.ts`, `apps/api/src/common/api-error.ts`
- Modify: `apps/web/app/lib/axios-utils.ts` (`getApiErrorMessage`: priority 0 — `code`), `apps/web/app/lib/i18n.ts` (see Task 6 — here the `i18n` from `@lingui/core` is used; before Task 6 the global `i18n` with `uk` loaded is enough)
- Modify (the first codes): `apps/api/src/contracts/employee-contracts.service.ts` (2 × `No active contract template` → `CONTRACT_TEMPLATE_MISSING`), `apps/api/src/contracts/signed-contracts.service.ts`, `apps/api/src/tos/tos.service.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/notifications/notifications.controller.ts`, `apps/api/src/users/users.service.ts` (approve/reject share), `apps/api/src/projects/projects.service.ts` (approve/reject) — all `*_IMPERSONATION` → `apiError`
- Modify: `apps/web/app/components/user-profile/contract/ContractTab.tsx`, `apps/web/app/components/users/UserDialog.tsx` — branching by `code`
- Test: `packages/shared/src/schemas/api-errors.spec.ts`, `apps/api/src/common/api-error.spec.ts`, `apps/web/app/lib/__tests__/axios-utils.spec.ts` (extend), update the service specs to the `{ code }` shape

**Interfaces:**

- Produces:
  - `API_ERROR_CODES = ['GENERIC','CONTRACT_TEMPLATE_MISSING','CONTRACT_SIGN_IMPERSONATION','TOS_ACCEPT_IMPERSONATION','INVOICE_SIGN_IMPERSONATION','NOTIFICATION_PREFERENCES_IMPERSONATION','SHARE_DECISION_IMPERSONATION','PROJECT_DECISION_IMPERSONATION'] as const`, `type ApiErrorCode`.
  - `apiErrorEnvelopeSchema = z.object({ statusCode: z.number().int(), code: z.enum(API_ERROR_CODES), params: z.record(z.string(), z.union([z.string(), z.number()])).optional(), message: z.string() })`.
  - `API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor>` — Ukrainian texts with explicit ids `api-error.<code>`, marked `/* i18n */`.
  - `apiError(code: ApiErrorCode, status: HttpStatus, params?: Record<string,string|number>): HttpException` — the body `{ statusCode, code, params, message }`, `message` — an English fallback from `API_ERROR_FALLBACK_EN`.
  - `getApiErrorMessage(err, fallback?)`: if the response body passes `apiErrorEnvelopeSchema` → `i18n._(API_ERROR_MESSAGES[code], params)`; otherwise the former logic.

- [ ] **Step 1: A registry test**

```ts
// packages/shared/src/schemas/api-errors.spec.ts
import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES, API_ERROR_MESSAGES, apiErrorEnvelopeSchema } from './api-errors'

describe('api-errors', () => {
  it('every code has a message descriptor with an explicit id', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_MESSAGES[code].id).toBe(`api-error.${code}`)
      expect(API_ERROR_MESSAGES[code].message?.length ?? 0).toBeGreaterThan(0)
    }
  })
  it('envelope accepts params without PII types', () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        statusCode: 403,
        code: 'TOS_ACCEPT_IMPERSONATION',
        message: 'x',
      }).success,
    ).toBe(true)
    expect(
      apiErrorEnvelopeSchema.safeParse({ statusCode: 403, code: 'NOPE', message: 'x' }).success,
    ).toBe(false)
  })
})
```

- [ ] **Step 2: The registry implementation**

```ts
// packages/shared/src/schemas/api-errors.ts
import { z } from 'zod'
import type { MessageDescriptor } from '@lingui/core'

export const API_ERROR_CODES = [
  'GENERIC',
  'CONTRACT_TEMPLATE_MISSING',
  'CONTRACT_SIGN_IMPERSONATION',
  'TOS_ACCEPT_IMPERSONATION',
  'INVOICE_SIGN_IMPERSONATION',
  'NOTIFICATION_PREFERENCES_IMPERSONATION',
  'SHARE_DECISION_IMPERSONATION',
  'PROJECT_DECISION_IMPERSONATION',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export const apiErrorEnvelopeSchema = z.object({
  statusCode: z.number().int(),
  code: z.enum(API_ERROR_CODES),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  message: z.string(),
})
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>

/** Ukrainian source text; `en` lives in the catalog. Explicit ids so extraction is stable without macros. */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor> = {
  GENERIC: /* i18n */ {
    id: 'api-error.GENERIC',
    message: 'Не вдалося виконати дію. Спробуйте ще раз',
  },
  CONTRACT_TEMPLATE_MISSING: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_MISSING',
    message: 'Немає активного шаблону контракту для ролі {role}',
  },
  CONTRACT_SIGN_IMPERSONATION: /* i18n */ {
    id: 'api-error.CONTRACT_SIGN_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, підписати його контракт не можна — це має зробити він сам',
  },
  TOS_ACCEPT_IMPERSONATION: /* i18n */ {
    id: 'api-error.TOS_ACCEPT_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, прийняти умови використання за нього не можна — це має зробити він сам',
  },
  INVOICE_SIGN_IMPERSONATION: /* i18n */ {
    id: 'api-error.INVOICE_SIGN_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, підписати його рахунок не можна — це має зробити він сам',
  },
  NOTIFICATION_PREFERENCES_IMPERSONATION: /* i18n */ {
    id: 'api-error.NOTIFICATION_PREFERENCES_IMPERSONATION',
    message:
      'Налаштування сповіщень змінює сам співробітник — під «увійти як» вони лише для перегляду',
  },
  SHARE_DECISION_IMPERSONATION: /* i18n */ {
    id: 'api-error.SHARE_DECISION_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, вирішити щодо його частки не можна — це має зробити він сам',
  },
  PROJECT_DECISION_IMPERSONATION: /* i18n */ {
    id: 'api-error.PROJECT_DECISION_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, вирішити щодо проєкту за нього не можна — це має зробити він сам',
  },
}

/** English fallback carried in the response body for logs and clients without a catalog. */
export const API_ERROR_FALLBACK_EN: Record<ApiErrorCode, string> = {
  GENERIC: 'The action could not be completed',
  CONTRACT_TEMPLATE_MISSING: 'No active contract template for role {role}',
  CONTRACT_SIGN_IMPERSONATION: 'Contract signing is not allowed while impersonating',
  TOS_ACCEPT_IMPERSONATION: 'Accepting the terms is not allowed while impersonating',
  INVOICE_SIGN_IMPERSONATION: 'Invoice signing is not allowed while impersonating',
  NOTIFICATION_PREFERENCES_IMPERSONATION:
    'Notification preferences are read-only while impersonating',
  SHARE_DECISION_IMPERSONATION: 'Share decisions are not allowed while impersonating',
  PROJECT_DECISION_IMPERSONATION: 'Project decisions are not allowed while impersonating',
}
```

The Ukrainian texts — the coder's draft; `copy-reviewer` checks both languages (en — in `messages.po`). After the edit: `pnpm i18n:extract` → eight records appear in `uk/messages.po`; fill `en` there.

- [ ] **Step 3: `apiError` on the API + a test**

```ts
// apps/api/src/common/api-error.ts
import { HttpException, type HttpStatus } from '@nestjs/common'
import { API_ERROR_FALLBACK_EN, type ApiErrorCode, type ApiErrorEnvelope } from '@crm/shared'

function interpolate(template: string, params?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key] ?? `{${key}}`))
}

export function apiError(
  code: ApiErrorCode,
  status: HttpStatus,
  params?: Record<string, string | number>,
): HttpException {
  const body: ApiErrorEnvelope = {
    statusCode: status,
    code,
    params,
    message: interpolate(API_ERROR_FALLBACK_EN[code], params),
  }
  return new HttpException(body, status)
}
```

```ts
// apps/api/src/common/api-error.spec.ts
it('builds an HttpException whose body is the envelope', () => {
  const e = apiError('CONTRACT_TEMPLATE_MISSING', HttpStatus.NOT_FOUND, { role: 'SENIOR' })
  expect(e.getStatus()).toBe(404)
  expect(e.getResponse()).toEqual({
    statusCode: 404,
    code: 'CONTRACT_TEMPLATE_MISSING',
    params: { role: 'SENIOR' },
    message: 'No active contract template for role SENIOR',
  })
})
```

- [ ] **Step 4: The first codes on the API**

`employee-contracts.service.ts`: both `throw new NotFoundException(\`No active contract template for role ${user.role}\`)`→`throw apiError('CONTRACT_TEMPLATE_MISSING', HttpStatus.NOT_FOUND, { role: user.role })`. Five `ForbiddenException(<the impersonation literal>)`→`apiError('<CODE>\_IMPERSONATION', HttpStatus.FORBIDDEN)`. The `\*\_IMPERSONATION_MESSAGE` literals in shared **stay** until stage 3 (the client banner reads them), but the server text is now an English fallback — update the service/controller and integration specs (`expect(res.body.code).toBe('…')` instead of the text).

- [ ] **Step 5: Client — `getApiErrorMessage` by code + the branchings**

```ts
// apps/web/app/lib/axios-utils.ts — at the start of getApiErrorMessage after the null/object checks
const envelope = apiErrorEnvelopeSchema.safeParse(
  (err as { response?: { data?: unknown } }).response?.data,
)
if (envelope.success) {
  return i18n._(API_ERROR_MESSAGES[envelope.data.code], envelope.data.params)
}
```

(`i18n` — from `@/lib/i18n`, Task 6; before it — `import { i18n } from '@lingui/core'` with the `uk` catalog loaded in `client.tsx`.) Add `export function getApiErrorCode(err: unknown): ApiErrorCode | null`.

`ContractTab.tsx`: `const isNoTemplate = getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'` (remove `includes('no active contract template')`). `UserDialog.tsx`: `includes('template')` → `getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'`. The tests of both components: an error mock with an envelope body → the empty state shown; an error with prose and no code → **not** shown.

- [ ] **Step 6: `axios-utils` tests**

```ts
it('translates an API error envelope by code via the catalog', () => {
  const err = {
    response: {
      status: 403,
      data: { statusCode: 403, code: 'TOS_ACCEPT_IMPERSONATION', message: 'fallback' },
    },
  }
  expect(getApiErrorMessage(err)).toBe(i18n._(API_ERROR_MESSAGES.TOS_ACCEPT_IMPERSONATION))
})
it('interpolates params', () => {
  const err = {
    response: {
      status: 404,
      data: {
        statusCode: 404,
        code: 'CONTRACT_TEMPLATE_MISSING',
        params: { role: 'SENIOR' },
        message: 'x',
      },
    },
  }
  expect(getApiErrorMessage(err)).toContain('SENIOR')
})
```

- [ ] **Step 7: Gates, the mutation gate, commit**

```bash
pnpm i18n:extract && pnpm i18n:compile && pnpm typecheck && pnpm lint && pnpm test
node scripts/devops/mutation-gate.mjs --changed
git add packages/shared/src/schemas/api-errors.ts packages/shared/src/schemas/api-errors.spec.ts packages/shared/src/schemas/index.ts packages/shared/src/i18n/locales/uk/messages.po packages/shared/src/i18n/locales/en/messages.po apps/api/src/common/api-error.ts apps/api/src/common/api-error.spec.ts apps/api/src/contracts/employee-contracts.service.ts apps/api/src/contracts/signed-contracts.service.ts apps/api/src/tos/tos.service.ts apps/api/src/invoices/invoices.service.ts apps/api/src/notifications/notifications.controller.ts apps/api/src/users/users.service.ts apps/api/src/projects/projects.service.ts apps/api/src/contracts/signed-contracts.service.spec.ts apps/api/src/contracts/employee-contracts.service.spec.ts apps/api/src/tos/tos-accept-impersonation.integration.spec.ts apps/api/src/invoices/invoice-sign-impersonation.integration.spec.ts apps/api/src/notifications/notifications.controller.spec.ts apps/api/src/notifications/notification-preferences.rbac.integration.spec.ts apps/api/src/onboarding/onboarding-contract.integration.spec.ts apps/web/app/lib/axios-utils.ts apps/web/app/lib/__tests__/axios-utils.spec.ts apps/web/app/components/user-profile/contract/ContractTab.tsx apps/web/app/components/users/UserDialog.tsx apps/web/app/components/user-profile/contract/__tests__/ContractTab.test.tsx apps/web/app/components/users/__tests__/UserDialog.test.tsx
git commit -m "feat(api,web,shared): API error envelope with codes translated on the client; first eight codes

ac_verified: 5"
```

security-reviewer is mandatory (auth paths).

---

### Task 6: Web — `I18nProvider`, activating the locale from `/auth/me` and before login

**Files:**

- Create: `apps/web/app/lib/i18n.ts`
- Modify: `apps/web/app/routes/__root.tsx` (wrap in `I18nProvider`), `apps/web/app/context/auth.tsx` (an effect: `user.locale` → `activateLocale`), `apps/web/app/client.tsx` (the start activation before the render), `apps/web/index.html` (`lang="uk"`)
- Test: `apps/web/app/lib/__tests__/i18n.test.tsx`

**Interfaces:**

- Consumes: `LOCALES`, `DEFAULT_LOCALE`, `LOCALE_COOKIE_NAME`, `resolveLocale` from `@crm/shared`.
- Produces: `i18n` (the global `@lingui/core` instance for the browser), `activateLocale(locale: Locale): Promise<void>` (a dynamic import of `@crm/shared/src/i18n/locales/${locale}/messages.po` through the Vite plugin → `i18n.loadAndActivate`, `document.documentElement.lang = locale`, the cookie `pref_locale` for a year), `readPreLoginLocale(): Locale` (cookie → `navigator.language` → `uk`), `useLocale(): Locale` (from `useLingui`).

- [ ] **Step 1: Test**

```tsx
// apps/web/app/lib/__tests__/i18n.test.tsx
import { describe, expect, it, beforeEach } from 'vitest'
import { activateLocale, i18n, readPreLoginLocale } from '../i18n'

describe('i18n runtime', () => {
  beforeEach(() => {
    document.cookie = 'pref_locale=; Max-Age=0'
  })
  it('readPreLoginLocale prefers the cookie, then navigator.language, then uk', () => {
    document.cookie = 'pref_locale=en'
    expect(readPreLoginLocale()).toBe('en')
    document.cookie = 'pref_locale=; Max-Age=0'
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true })
    expect(readPreLoginLocale()).toBe('uk')
  })
  it('activateLocale switches the active locale, <html lang> and the cookie', async () => {
    await activateLocale('en')
    expect(i18n.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.cookie).toContain('pref_locale=en')
  })
})
```

- [ ] **Step 2: Implementation**

```ts
// apps/web/app/lib/i18n.ts
import { i18n } from '@lingui/core'
import { useLingui } from '@lingui/react'
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, resolveLocale, type Locale } from '@crm/shared'

export { i18n }

export function readPreLoginLocale(): Locale {
  const cookie = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${LOCALE_COOKIE_NAME}=`))
    ?.split('=')[1]
  return resolveLocale([cookie, navigator.language])
}

export async function activateLocale(locale: Locale): Promise<void> {
  const { messages } = await import(
    `../../../../packages/shared/src/i18n/locales/${locale}/messages.po`
  )
  i18n.loadAndActivate({ locale, messages })
  document.documentElement.lang = locale
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`
}

export function useLocale(): Locale {
  const { i18n: instance } = useLingui()
  return (instance.locale as Locale) ?? DEFAULT_LOCALE
}
```

Refine the dynamic import path by the alias (`vite-tsconfig-paths` + the `@crm/shared` `source` export) — the Lingui Vite plugin compiles `.po` on import; in Vitest the same plugin is connected in Task 1.

`client.tsx`: before `createRoot(...).render(...)` — `await activateLocale(readPreLoginLocale())`. `__root.tsx`: `<I18nProvider i18n={i18n}>` around `TelemetryProvider`. `auth.tsx`: `useEffect(() => { if (data?.locale && data.locale !== i18n.locale) void activateLocale(data.locale) }, [data?.locale])`.

- [ ] **Step 3: Run → PASS; an E2E smoke**

`apps/e2e`: the existing login spec passes; add one case to the `auth-nav` shard: `<html lang>` equals `uk` after login with a `/auth/me` mock of `locale: 'uk'` and `en` — with `locale: 'en'` (extend `mockAuthAs` with a `locale` field).

- [ ] **Step 4: Commit**

```bash
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test && pnpm --filter @crm/e2e test -- auth-nav
git add apps/web/app/lib/i18n.ts apps/web/app/lib/__tests__/i18n.test.tsx apps/web/app/routes/__root.tsx apps/web/app/context/auth.tsx apps/web/app/client.tsx apps/web/index.html apps/e2e/tests/auth-nav/login-locale.spec.ts
git commit -m "feat(web): I18nProvider, locale activation from /auth/me and pre-login cookie

ac_verified: 6"
```

---

### Task 7: The language switcher in the profile (self-mode)

**Files:**

- Create: `apps/web/app/components/user-profile/LanguageSection.tsx`
- Modify: `apps/web/app/components/user-profile/tabs/OverviewTab.tsx` (render the section only when `mode === 'self'`)
- Modify: `apps/web/app/hooks/use-user-profile.ts` (the mutation `PATCH /users/me { locale }` + `invalidate` of the auth query) — or the existing profile-update hook
- Test: `apps/web/app/components/user-profile/__tests__/LanguageSection.test.tsx`

**Interfaces:**

- Consumes: `activateLocale`, `useLocale` (Task 6); `updateProfileSchema.locale` (Task 3).
- Produces: `LanguageSection` — two radio buttons `uk`/`en` (`data-testid="locale-option-uk|en"`), the title `<Trans>Мова інтерфейсу</Trans>`; on selection: `PATCH /api/users/me { locale }` → `activateLocale(locale)` → `invalidate()`; an error → a toast via `getApiErrorMessage`.

- [ ] **Step 1: Test**

```tsx
it('PATCHes the locale and activates it', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  render(<LanguageSection current="uk" />, { wrapper: Providers })
  await userEvent.click(screen.getByTestId('locale-option-en'))
  expect(patch).toHaveBeenCalledWith('/users/me', { locale: 'en' })
  await waitFor(() => expect(i18n.locale).toBe('en'))
})
it('is not rendered for another user profile', () => {
  render(<OverviewTab mode="other" user={other} />, { wrapper: Providers })
  expect(screen.queryByTestId('locale-option-en')).toBeNull()
})
```

- [ ] **Step 2: Implementation**

```tsx
// apps/web/app/components/user-profile/LanguageSection.tsx
import { Trans } from '@lingui/react/macro'
import { LOCALES, type Locale } from '@crm/shared'
import { activateLocale } from '@/lib/i18n'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/axios-utils'

const LABELS: Record<Locale, string> = { uk: 'Українська', en: 'English' } // language names stay in their own language, not translated

export function LanguageSection({ current }: { current: Locale }) {
  const { invalidate } = useAuth()
  async function choose(locale: Locale) {
    if (locale === current) return
    try {
      await api.patch('/users/me', { locale })
      await activateLocale(locale)
      invalidate()
    } catch (err) {
      toast.error(getApiErrorMessage(err))
    }
  }
  return (
    <section aria-labelledby="language-section-title" className="space-y-2">
      <h3 id="language-section-title" className="text-sm font-medium">
        <Trans>Мова інтерфейсу</Trans>
      </h3>
      <div role="radiogroup" className="flex gap-2">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={l === current}
            data-testid={`locale-option-${l}`}
            onClick={() => choose(l)}
            className="rounded-md border px-3 py-2 text-sm aria-checked:border-primary"
          >
            {LABELS[l]}
          </button>
        ))}
      </div>
    </section>
  )
}
```

Styles — like the neighboring sections of `OverviewTab` (design-gate Tier 3; conformance by the designer against the screenshots 320/1440 in both languages).

- [ ] **Step 3: Run → PASS; commit**

```bash
git add apps/web/app/components/user-profile/LanguageSection.tsx apps/web/app/components/user-profile/tabs/OverviewTab.tsx apps/web/app/hooks/use-user-profile.ts apps/web/app/components/user-profile/__tests__/LanguageSection.test.tsx
git commit -m "feat(web): interface language switcher in the profile overview (self only)

ac_verified: 7"
```

---

### Task 8: The "before string extraction" fixes (audit §2, cross-cutting)

**Files:**

- Modify: `apps/web/app/components/pending/PendingKindSection.tsx` (the prop `kind`, `data-testid` from `kind`), `apps/web/app/routes/_authenticated/pending/index.tsx` (pass `kind`; the focus selector by `kind`), the tests `pending/__tests__/index.test.tsx`, the pending E2E spec (selectors `pending-kind-heading-<zone>-<KIND>`)
- Modify: `apps/web/app/lib/documents-filter-sort.ts` (`compareNames(locale)` instead of `localeCompare(…, 'ru')`; the locale — a parameter of the sort function, the caller passes `useLocale()`), the tests
- Modify: `apps/web/app/components/layout/ImpersonationBanner.tsx`, `apps/web/app/components/user-profile/UserProfileHeader.tsx`, `apps/web/app/components/user-profile/tabs/TeamTab.tsx` — remove the local maps, import `ROLE_LABELS` from `@/components/ui/role-select`
- Test: update the tests of the three components (a drop's profile shows "Дроп", not `DROP`)

**Interfaces:**

- Produces: `PendingKindSectionProps.kind: PendingItemKind | 'OTHER'`; the testid `pending-kind-heading-${zone}-${kind}` and `pending-kind-section-${zone}-${kind}`; `sortDocuments(items, sort, locale: Locale)`.

- [ ] **Step 1: Tests (fail)**

```tsx
// pending/__tests__/index.test.tsx — replace the selectors
'[data-testid="pending-kind-heading-mine-PROJECT_APPROVAL"]'
// a new case
it('heading testid does not depend on the visible title', () => {
  render(
    <PendingKindSection kind="SHARE_APPROVAL" title="Будь-який текст" zone="mine" items={[]} />,
  )
  expect(screen.getByTestId('pending-kind-heading-mine-SHARE_APPROVAL')).toBeInTheDocument()
})
```

```ts
// documents-filter-sort.spec.ts
it('sorts names by the given locale collation', () => {
  const out = sortDocuments([doc('Ірина'), doc('Андрій'), doc('Євген')], 'name-asc', 'uk').map(
    resolveDisplayName,
  )
  expect(out).toEqual(['Андрій', 'Євген', 'Ірина'])
})
```

```tsx
// UserProfileHeader.test.tsx
it('shows the DROP role label from the shared map', () => {
  render(<UserProfileHeader user={{ ...user, role: 'DROP' }} />)
  expect(screen.getByText('Дроп')).toBeInTheDocument()
})
```

- [ ] **Step 2: Implementation**

`PendingKindSection.tsx`: add `kind` to the props, `data-testid={\`pending-kind-heading-${zone}-${kind}\`}`and for the`<ul>`. In `pending/index.tsx`: `sectionKindOf(item)`instead of`sectionTitleOf`for the focus selector (`OTHER`for unknown ones).`documents-filter-sort.ts`: the signature with `locale`, `compareNames(locale)`. The three role maps → `import { ROLE_LABELS } from '@/components/ui/role-select'`.

- [ ] **Step 3: Run → PASS, pending E2E on a live stand, commit**

```bash
pnpm --filter @crm/web test && pnpm --filter @crm/e2e test -- pending
git add apps/web/app/components/pending/PendingKindSection.tsx apps/web/app/routes/_authenticated/pending/index.tsx apps/web/app/routes/_authenticated/pending/__tests__/index.test.tsx apps/web/app/components/pending/__tests__/PendingKindSection.test.tsx apps/e2e/tests/misc/pending.spec.ts apps/web/app/lib/documents-filter-sort.ts apps/web/app/lib/__tests__/documents-filter-sort.spec.ts apps/web/app/components/layout/ImpersonationBanner.tsx apps/web/app/components/user-profile/UserProfileHeader.tsx apps/web/app/components/user-profile/tabs/TeamTab.tsx apps/web/app/components/user-profile/__tests__/UserProfileHeader.test.tsx
git commit -m "refactor(web): pre-i18n fixes — testids from kind, locale-aware name sort, single role label map

ac_verified: 8"
```

---

### Task 9: ESLint — `lingui/no-unlocalized-strings` in warning mode

**Files:**

- Modify: `apps/web/eslint.config.mjs`, `packages/shared/eslint.config.mjs`, `package.json` (devDep `eslint-plugin-lingui`)
- Test: `pnpm --filter @crm/web lint` finishes with code 0 and prints warnings (not errors)

- [ ] **Step 1: Install and enable**

```bash
pnpm add -w -D eslint-plugin-lingui@0.16.0
```

```js
// apps/web/eslint.config.mjs — a new block after the main one
import pluginLingui from 'eslint-plugin-lingui'
// ...
{
  files: ['app/**/*.{ts,tsx}'],
  ignores: ['app/**/*.{spec,test}.{ts,tsx}', 'app/**/__tests__/**'],
  plugins: { lingui: pluginLingui },
  rules: {
    'lingui/no-unlocalized-strings': ['warn', {
      ignore: ['^(?![A-ZА-ЯЁІЇЄҐ])\\S+$', '^[A-Z0-9_-]+$', '^[^а-яёіїєґА-ЯЁІЇЄҐ]*$'],
      ignoreNames: [{ regex: { pattern: 'className', flags: 'i' } }, 'data-testid', 'src', 'href', 'type', 'id', 'key', 'variant', 'size', 'role'],
      ignoreFunctions: ['cn', 'cva', 'console.*', 'Error', '*.includes', '*.startsWith', '*.endsWith', 'vi.*', 'expect', 'describe', 'it', 'test'],
    }],
  },
}
```

The third `ignore` (no Cyrillic — stay silent) deliberately narrows the rule at this stage to strings with Cyrillic: the goal of the stage is to see how much Russian/Ukrainian text is still unwrapped, not to make noise on English technical strings. In stage 6 `ignore` narrows and the mode → `error`.

- [ ] **Step 2: A run and the warning count in the PR body**

```bash
pnpm --filter @crm/web lint 2>&1 | grep -c 'no-unlocalized-strings'
```

Record the number (thousands, expected) in the PR body as a baseline for stage 3.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml apps/web/eslint.config.mjs packages/shared/eslint.config.mjs
git commit -m "infra(lint): eslint-plugin-lingui no-unlocalized-strings as a warning (baseline for the module waves)

ac_verified: 9"
```

---

### Task 9b (DevOps): CI — the catalogs are in sync with the code

**Files:**

- Modify: `.github/workflows/ci.yml` — in the job `Typecheck · Lint · Unit Tests` after installing the dependencies

- [ ] **Step 1: The step**

```yaml
- name: i18n catalogs are in sync (lingui extract --clean)
  run: |
    pnpm i18n:extract
    git diff --exit-code -- packages/shared/src/i18n/locales || {
      echo "::error::Run 'pnpm i18n:extract' and commit the updated .po catalogs"; exit 1; }
- name: i18n compile
  run: pnpm i18n:compile
```

The `i18n compile` step must stand **before** `typecheck`/`test` in this job and in all jobs where web/api is built (E2E build, the mutation gate) — otherwise `messages.ts` is absent. Check the `turbo` `dependsOn` from Task 1: if turbo already runs `//#i18n:compile`, the explicit step is not needed — leave only the sync check.

- [ ] **Step 2: Check**

Open a PR with a deliberately stale `.po` (don't run `extract` locally) → the job is red with a message; fix → green. `scripts/devops/tests/` — adding a guard test is not required (the step is not a hook).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(i18n): fail when .po catalogs are out of sync; compile catalogs before typecheck/test

ac_verified: 9b"
```

---

### Task 10 (Architect/Master, docs-only): project rules for two languages

**Files:**

- Modify: `.claude/rules/common/russian-language.md` — Russian stays the language of communication with the owner, of PR discussions and agent reports; the **product** (the `apps/web` UI, emails, invoice PDFs) — `uk` (default) and `en`; the ban on Ukrainian in the product is lifted; logs — English. Reword the "Reviewer → BLOCK" rule: BLOCK on Russian text in a **migrated** module and on any new visible text without a Lingui wrapper.
- Modify: `.claude/rules/common/version-pins.md` — the "i18n" block: `@lingui/*` **5.9.5** EXACT at one version; `eslint-plugin-lingui 0.16.0`; why not 6 (ESM-only + `moduleResolution: Node` in api/shared + the dual types of drizzle on node16) and the upgrade condition.
- Modify: `.claude/agents/copy-reviewer.md`, `.claude/skills/copywriting/SKILL.md` — the CRM is now bilingual: a verdict on `uk` and `en` separately; "two originals" applies to the CRM; the `CONTEXT.md` glossary — the source of terms.
- Modify: `.claude/skills/playwright-patterns/SKILL.md` — the rule: the text in assertions from the catalog (`i18n._()` of a descriptor) or a testid/role, literals are forbidden for migrated modules.
- Modify: `.claude/agents/workflow-registry.md` №8 — after stage 6 the workflow becomes a catalog-coverage audit.
- Modify: `CONTEXT.md` — a note in the glossary header: the terms get `uk`/`en` columns in the first PR of stage 3 (`web-core`), for now — Russian as the glossary language.

- [ ] **Step 1: The fixes by the list, `prettier --write`, a docs-only PR**

```bash
git add .claude/rules/common/russian-language.md .claude/rules/common/version-pins.md .claude/agents/copy-reviewer.md .claude/skills/copywriting/SKILL.md .claude/skills/playwright-patterns/SKILL.md .claude/agents/workflow-registry.md CONTEXT.md
git commit -m "docs(rules): CRM product language is uk/en; Lingui pins; copy and E2E rules for two languages

ac_verified: n/a (docs-only rules update)"
```

---

## What this stage does NOT do (and where it will be)

- Migrating the existing Russian strings by modules — stage 3 (the waves `web-core` → `web-people` → `web-projects` → `web-finance` → `web-docs-notify`).
- `EXPENSE_CATEGORIES` as keys in `transactions.receiver_label` — stage 3, the `web-finance` wave (+ a data migration on the API).
- The three legacy notification types in `NOTIFICATION_TITLES`, rendering the titles by `type` + `data`, emails by the recipient's locale — stage 4.
- 289 Russian + 214 English exceptions → codes — stage 4 (the registry and `apiError` are ready here).
- Invoice PDFs by locale — stage 5. The Russian-letters guard and the `error` mode of ESLint — stage 6.

## Stage readiness check

- `pnpm i18n:extract` and `pnpm i18n:compile` pass locally and in CI; the sync step is red on a stale `.po`.
- A user with `locale = en` after login sees `<html lang="en">`, the switcher in the profile changes the language without a reload, the choice is saved in `users.locale`.
- The error `CONTRACT_TEMPLATE_MISSING` arrives as an envelope with a code; `ContractTab` shows the empty state by the code, not by the text.
- The five 403s under "log in as" return a code; the client shows the Ukrainian text from the catalog.
- `PendingKindSection` testid does not contain visible text; document sorting accepts a locale; the role map is one.
- `pnpm --filter @crm/web lint` prints a baseline of `no-unlocalized-strings` warnings, return code 0.
