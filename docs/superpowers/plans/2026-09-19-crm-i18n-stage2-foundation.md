# CRM i18n — этап 2 «Фундамент» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать всё, что нужно, чтобы любой модуль CRM мог мигрировать на `uk`/`en` одним PR: Lingui, общий каталог в `packages/shared`, локаль пользователя и запроса, конверт кодов ошибок с переводом на клиенте, ESLint-предупреждение о необёрнутых строках, обновлённые правила проекта и четыре правки «до извлечения строк» из аудита.

**Architecture:** Один каталог `packages/shared/src/i18n/locales/{uk,en}/messages.po` на трёх потребителей: веб (React, макросы через Babel-плагин в Vite и Vitest), API и shared (CommonJS, без макросов — дескрипторы с `/* i18n */` и явными id, отдельный экземпляр `i18n` на запрос/получателя). Ошибки API — `{ statusCode, code, params, message }`; клиент переводит по `code`. Локаль: `users.locale` (enum `uk|en`, дефолт `uk`) → `/auth/me` → `I18nProvider`; до входа — cookie `pref_locale` → `navigator.language` → `uk`.

**Tech Stack:** Lingui **6.7.0** (`@lingui/core`, `@lingui/react`, `@lingui/cli`, `@lingui/vite-plugin`, `@lingui/babel-plugin-lingui-macro`) + `eslint-plugin-lingui` 0.16.0, React 18 + Vite 6 + Vitest 4, NestJS 11 + Fastify, Drizzle, Zod 4, pnpm 7.32.4, **Node 22 LTS** (Task 0).

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` (этап 1 выполнен: `docs/architecture/2026-09-19-crm-i18n-audit.md`).

## Global Constraints

- Lingui 6 требует **Node ≥ 22.19** и поставляется **только ESM**. Владелец 2026-09-19 разрешил поднять Node: Task 0 (DevOps) переводит CI, Dockerfile, `.nvmrc`, `engines` и `version-pins.md` на Node 22 LTS **до** Task 1. `apps/api` и `packages/shared` собираются tsc в CommonJS — Node ≥ 22.12 умеет `require()` ESM-модулей без top-level await, но это надо **доказать спайком** (Task 0b), а не предполагать; спайк красный → `.blocked.md` оркестратору с двумя выходами (Lingui 5.9.5 либо перевод api/shared на `module: node16`), не самовольный выбор.
- Все пакеты `@lingui/*` — **одной версией 6.7.0**, EXACT-пин; строка в `version-pins.md` (Task 10, добавить уже в Task 1).
- Языки: `uk` (дефолт, `sourceLocale`) и `en`. Исходный текст в коде — украинский; id — хеш от текста (дефолт Lingui), явные id только у кодов ошибок и модульных дескрипторов в shared/api.
- Русский из продукта убирается **по модулям на этапе 3** — в этом этапе новые/изменённые строки пишутся сразу `uk` + `en`, существующие русские не трогаются, кроме перечисленных в задачах.
- Ошибки API — коды + `params` без PII; `message` — английский fallback.
- Тесты: якоря `data-testid`/роли, текст в ассертах — из каталога `uk` через `i18n._()` / импорт дескриптора, не литералом.
- DDL — только `apps/api/drizzle/manual/*.sql`, идемпотентно, три места в `deploy.yml`, `scripts/devops/check-prod-ddl-wiring.py` → `BROKEN WIRING: 0`.
- `git add` явным списком; `DATABASE_URL= git push`; без `--no-verify`; коммиты с `ac_verified:`.
- Зоны: `.github/workflows/**` — DevOps (Task 9b); `.claude/rules/**`, `.claude/agents/**`, `CONTEXT.md` — Architect/Master (Task 10); остальное — Coder.

---

## Карта файлов

| Файл                                                                                                                                                                                             | Ответственность                                                          | Задача |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------ |
| `lingui.config.ts` (корень)                                                                                                                                                                      | Локали, каталоги трёх пакетов, формат `po`                               | 1      |
| `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`                                                                                                                                           | Babel-макро-плагин + `lingui()`                                          | 1      |
| `packages/shared/src/i18n/locales.ts`                                                                                                                                                            | `LOCALES`, `Locale`, `DEFAULT_LOCALE`, `localeSchema`, `resolveLocale()` | 2      |
| `packages/shared/src/i18n/format.ts`                                                                                                                                                             | `formatDate`, `formatMoney`, `formatNumber`, `compareNames`              | 2      |
| `packages/shared/src/i18n/catalog.ts`                                                                                                                                                            | `createI18n(locale)` — экземпляр на запрос/получателя (Node, CJS)        | 2      |
| `packages/shared/src/i18n/locales/{uk,en}/messages.po`                                                                                                                                           | Единственный источник переводов (коммитится)                             | 1, 2   |
| `packages/shared/src/schemas/api-errors.ts`                                                                                                                                                      | `API_ERROR_CODES`, `apiErrorEnvelopeSchema`, `API_ERROR_MESSAGES`        | 5      |
| `apps/api/src/common/api-error.ts`                                                                                                                                                               | `apiError(code, status, params?)` → `HttpException` с конвертом          | 5      |
| `apps/api/src/i18n/request-locale.ts`                                                                                                                                                            | `resolveRequestLocale(req)`, `@RequestLocale()`                          | 4      |
| `apps/api/drizzle/manual/2026-09-20_user_locale.sql`                                                                                                                                             | enum `user_locale` + колонка `users.locale`                              | 3      |
| `apps/web/app/lib/i18n.ts`                                                                                                                                                                       | `i18n`, `activateLocale()`, `readPreLoginLocale()`, `useLocale()`        | 6      |
| `apps/web/app/components/user-profile/LanguageSection.tsx`                                                                                                                                       | Переключатель в профиле (self-mode)                                      | 7      |
| `apps/web/app/lib/axios-utils.ts`                                                                                                                                                                | `getApiErrorMessage` — сначала `code`                                    | 5      |
| `apps/web/app/components/pending/PendingKindSection.tsx`                                                                                                                                         | `data-testid` из `kind`                                                  | 8      |
| `apps/web/app/lib/documents-filter-sort.ts`                                                                                                                                                      | `compareNames(locale)` вместо `localeCompare(…, 'ru')`                   | 8      |
| `apps/web/app/components/{layout/ImpersonationBanner,user-profile/UserProfileHeader,user-profile/tabs/TeamTab}.tsx`                                                                              | Одна карта ролей `ROLE_LABELS` из `ui/role-select`                       | 8      |
| `apps/web/eslint.config.mjs`, `packages/shared/eslint.config.mjs`                                                                                                                                | `lingui/no-unlocalized-strings: warn`                                    | 9      |
| `.github/workflows/ci.yml`                                                                                                                                                                       | Шаг «каталоги синхронны» (`lingui extract --clean` + `git diff`)         | 9b     |
| `.claude/rules/common/{russian-language,version-pins}.md`, `.claude/agents/copy-reviewer.md`, `.claude/skills/{copywriting,playwright-patterns}/SKILL.md`, `.claude/agents/workflow-registry.md` | Правила под два языка                                                    | 10     |

Порядок: 0 → 0b → 1 → 2 → (3, 4, 5 параллельно) → 6 → 7 → 8 → 9 → 9b → 10. Каждая задача — свой PR (или 1+2 одним, 3+4 одним).

---

### Task 0 (DevOps): Node 22 LTS во всём монорепо

**Files:**

- Modify: `.github/workflows/ci.yml` (все `node-version: '20'` → `'22'`), `.github/workflows/deploy.yml` и остальные воркфлоу с `setup-node` (`grep -rn "node-version" .github/workflows`)
- Modify: `apps/api/Dockerfile` (`FROM node:20-alpine` → `node:22-alpine`, оба stage), другие Dockerfile (`grep -rln "node:20" .`)
- Modify/Create: `.nvmrc` (`22`), корневой `package.json` → `"engines": { "node": ">=22.19 <23", "pnpm": "7.32.4" }`
- Modify: `.claude/rules/common/version-pins.md` — «Node: 22 LTS (строго; поднято 2026-09-19 ради Lingui 6)», `docs/runbooks/deployment.md` — упоминания Node 20
- Test: CI зелёный на этом PR (все jobs), `docker build -f apps/api/Dockerfile .` локально проходит, `pnpm install --frozen-lockfile` под Node 22 без `EBADENGINE`

- [ ] **Step 1: Найти все места**

```bash
grep -rn "node-version\|node:20\|nodejs 20\|Node 20" .github apps/*/Dockerfile Dockerfile* docs/runbooks .claude/rules/common/version-pins.md package.json 2>/dev/null
```

- [ ] **Step 2: Заменить на 22, добавить `engines` и `.nvmrc`; проверить локально**

```bash
nvm install 22 && nvm use 22 && node -v   # ≥ v22.19
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
docker build -f apps/api/Dockerfile -t crm-api:node22 .
```

Если какой-то пакет ломается на Node 22 (сигнал — `pnpm test` красный там, где на 20 зелёный) — это находка задачи, а не повод откатить: записать в PR body и поднять пакет по `version-pins.md`.

- [ ] **Step 3: Коммит и PR (DevOps-зона: workflows + Dockerfile)**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml apps/api/Dockerfile .nvmrc package.json .claude/rules/common/version-pins.md docs/runbooks/deployment.md
git commit -m "infra(node): Node 22 LTS in CI, Docker, engines and pins (prerequisite for Lingui 6)

ac_verified: 0"
```

Деплой после мержа проверить как обычно (`gh run list --workflow deploy.yml`, healthcheck) — образ API пересобирается на новой базе.

---

### Task 0b (спайк, throwaway): CJS-сборка API и shared с ESM-only Lingui 6

**Files:**

- Create (временно, не коммитить): `packages/shared/src/i18n/__spike__/esm-require.spec.ts`

- [ ] **Step 1: Установить `@lingui/core@6.7.0` в `packages/shared` и написать тест, который импортирует его как в продовом коде**

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

- [ ] **Step 2: Три проверки, все три должны быть зелёными**

```bash
pnpm --filter @crm/shared typecheck          # tsc с module=CommonJS резолвит типы @lingui/core (exports с условием "import")
pnpm --filter @crm/shared build && node -e "require('./packages/shared/dist/index.js')"   # require(esm) в рантайме Node 22
pnpm --filter @crm/api typecheck && pnpm --filter @crm/api build && node -e "require('./apps/api/dist/main.js')" 2>&1 | head -3   # то же для API-бандла
```

Ожидаемо: typecheck чист, оба `require` не падают на `ERR_REQUIRE_ESM`/`ERR_PACKAGE_PATH_NOT_EXPORTED`.

- [ ] **Step 3: Вывод**

Все три зелёные → удалить `__spike__`, оставить зависимость, идти в Task 1. Хоть одна красная → `.claude/tasks/task-i18n-stage2.blocked.md` с точным текстом ошибки и двумя вариантами: (a) Lingui 5.9.5 (CJS+ESM, тот же API макросов), (b) `module: node16` + `"type"`-раскладка для `packages/shared`/`apps/api`. Решает оркестратор.

---

### Task 1: Lingui в монорепо — зависимости, конфиг, сборка, тестовый прогон

**Files:**

- Modify: `package.json` (корень: devDeps `@lingui/cli`, скрипты `i18n:extract`, `i18n:compile`), `pnpm-workspace.yaml` не трогать
- Modify: `apps/web/package.json` (deps `@lingui/core`, `@lingui/react`; devDeps `@lingui/vite-plugin`, `@lingui/babel-plugin-lingui-macro`)
- Modify: `packages/shared/package.json`, `apps/api/package.json` (dep `@lingui/core`)
- Create: `lingui.config.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`
- Create: `packages/shared/src/i18n/locales/uk/messages.po`, `packages/shared/src/i18n/locales/en/messages.po` (пустые заголовки — создаст `lingui extract`)
- Modify: `.gitignore` (компилированные `messages.ts`), `turbo.json` (задача `i18n:compile`)
- Modify: `.claude/rules/common/version-pins.md` (строка пинов — см. Task 10, здесь только добавить строку)
- Test: `apps/web/app/lib/__tests__/i18n-smoke.test.tsx`

**Interfaces:**

- Produces: скрипты `pnpm i18n:extract` (`lingui extract --clean`), `pnpm i18n:compile` (`lingui compile --typescript`); путь каталогов `packages/shared/src/i18n/locales/<locale>/messages.po`; compiled `…/messages.ts` (gitignored, генерируется `i18n:compile`, который turbo запускает перед `build`, `test`, `typecheck`, `dev`).

- [ ] **Step 1: Установить зависимости одной версией**

```bash
pnpm add -w -D @lingui/cli@6.7.0 @lingui/babel-plugin-lingui-macro@6.7.0
pnpm --filter @crm/web add @lingui/core@6.7.0 @lingui/react@6.7.0
pnpm --filter @crm/web add -D @lingui/vite-plugin@6.7.0
pnpm --filter @crm/shared add @lingui/core@6.7.0
pnpm --filter @crm/api add @lingui/core@6.7.0
```

В каждом `package.json` версия должна быть `"6.7.0"` без `^` (EXACT-пин, как у пары TanStack). Пакеты ESM-only: `lingui.config.ts` в корне и скрипты CLI работают под Node 22 (Task 0).

- [ ] **Step 2: Конфиг Lingui в корне**

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

- [ ] **Step 3: Скрипты и turbo**

Корневой `package.json` → `scripts`:

```json
"i18n:extract": "lingui extract --clean",
"i18n:compile": "lingui compile --typescript"
```

`turbo.json` → `tasks`: добавить

```json
"i18n:compile": { "cache": false, "inputs": ["packages/shared/src/i18n/locales/**/*.po", "lingui.config.ts"] }
```

и в `build`, `typecheck`, `test`, `dev` добавить `"dependsOn": ["//#i18n:compile", ...существующие]` (синтаксис корневой задачи `//#`). `.gitignore`: `packages/shared/src/i18n/locales/*/messages.ts`.

- [ ] **Step 4: Vite и Vitest — макросы через Babel**

```ts
// apps/web/vite.config.ts — plugins
import { lingui } from '@lingui/vite-plugin'
// ...
plugins: [
  // TanStackRouterVite(...) как было,
  react({ babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] } }),
  lingui(),
  // остальное как было
]
```

То же `react({ babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] } })` в `apps/web/vitest.config.ts` (там свой `react()`), плюс `lingui()`.

- [ ] **Step 5: Пустые каталоги и первый прогон**

```bash
pnpm i18n:extract && pnpm i18n:compile
git status --short packages/shared/src/i18n
```

Ожидаемо: два `messages.po` с заголовками (`Language: uk` / `Language: en`), `messages.ts` в `.gitignore`.

- [ ] **Step 6: Смоук-тест макросов в Vitest (падает до конфигурации, проходит после)**

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

Run: `pnpm --filter @crm/web test -- app/lib/__tests__/i18n-smoke.test.tsx` → PASS (без Babel-плагина падало бы на `Trans is not a function`/`The macro you imported…`).

- [ ] **Step 7: Гейты и коммит**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @crm/web test
git add package.json pnpm-lock.yaml lingui.config.ts turbo.json .gitignore apps/web/package.json apps/web/vite.config.ts apps/web/vitest.config.ts packages/shared/package.json apps/api/package.json packages/shared/src/i18n/locales/uk/messages.po packages/shared/src/i18n/locales/en/messages.po apps/web/app/lib/__tests__/i18n-smoke.test.tsx
git commit -m "infra(i18n): add Lingui 6.7.0 — config, catalogs, vite/vitest macro plugin, turbo compile step

ac_verified: 1"
```

---

### Task 2: `packages/shared/src/i18n` — локали, форматирование, экземпляр `i18n` для Node

**Files:**

- Create: `packages/shared/src/i18n/locales.ts`, `format.ts`, `catalog.ts`, `index.ts`
- Modify: `packages/shared/src/index.ts` (`export * from './i18n'`)
- Test: `packages/shared/src/i18n/locales.spec.ts`, `format.spec.ts`, `catalog.spec.ts`

**Interfaces:**

- Produces:
  - `LOCALES = ['uk','en'] as const`, `type Locale`, `DEFAULT_LOCALE: Locale = 'uk'`, `localeSchema = z.enum(LOCALES)`, `resolveLocale(candidates: ReadonlyArray<string | null | undefined>): Locale` — первый валидный по BCP-47-префиксу (`en-US` → `en`, `uk-UA` → `uk`), иначе `uk`.
  - `formatDate(value: Date | string, locale: Locale, style?: 'short' | 'long'): string`, `formatMoney(amount: number | string, currency: 'USDT'|'USD'|'EUR'|'UAH', locale: Locale): string`, `formatNumber(n: number, locale: Locale): string`, `compareNames(locale: Locale): (a: string, b: string) => number`.
  - `createI18n(locale: Locale): I18n` — новый экземпляр `setupI18n` с загруженным компилированным каталогом (CJS `require`), для API-письма/PDF на локали получателя и для сервера в целом (никакого глобального `activate` в API).

- [ ] **Step 1: Тесты локалей**

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

- [ ] **Step 3: Реализация**

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

- [ ] **Step 4: Тесты форматирования (значения — из `Intl`, не из головы)**

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

- [ ] **Step 5: Run → FAIL, затем реализация**

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

Замечание для исполнителя: если существующий `apps/web/app/lib/format-amount.ts` форматирует иначе (пробел vs запятая), **не** менять его в этой задаче — модули переедут на `formatMoney` на этапе 3.

- [ ] **Step 6: `createI18n` и тест**

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

Run: `pnpm i18n:compile && pnpm --filter @crm/shared test -- src/i18n` → PASS. Примечание: в `packages/shared/vitest.config` (или `tsconfig`) `require` доступен, пакет CommonJS; если Vitest падает на `require` — включить `deps.interopDefault`/оставить `createRequire(import.meta.url)`-вариант — выбрать один и записать в PR body.

- [ ] **Step 7: Экспорт и коммит**

`packages/shared/src/i18n/index.ts`: `export * from './locales'; export * from './format'; export * from './catalog'`; в `packages/shared/src/index.ts` добавить `export * from './i18n'`. Проверить, что `packages/shared/src/public.ts` (публичный бандл лендинга) **не** экспортирует `catalog.ts` (там `require`).

```bash
pnpm --filter @crm/shared typecheck && pnpm --filter @crm/shared lint && pnpm --filter @crm/shared test
git add packages/shared/src/i18n packages/shared/src/index.ts
git commit -m "feat(shared): i18n foundation — locales, Intl formatting, per-request i18n instance

ac_verified: 2"
```

---

### Task 3: `users.locale` — колонка, DDL, `/auth/me`, `PATCH /users/me`, мастер создания

**Files:**

- Modify: `apps/api/src/database/schema.ts` (enum `userLocaleEnum`, колонка `locale`)
- Create: `apps/api/drizzle/manual/2026-09-20_user_locale.sql`
- Modify: `.github/workflows/deploy.yml` — **зона DevOps**: три места (preflight-список, SCP, psql); coder оставляет `.blocked.md` только если DevOps недоступен; в этом плане шаг выполняет тот же PR с пометкой «DevOps-строки — additive wiring по образцу `2026-09-19_notification_email_skip_stale.sql`»
- Modify: `packages/shared/src/schemas/auth.ts` (`sessionUserSchema.locale`), `packages/shared/src/schemas/users.ts` (`updateProfileSchema.locale`, `createUserSchema.locale`)
- Modify: `apps/api/src/auth/auth.controller.ts` (`/me` → `locale`), `apps/api/src/users/users.service.ts` (`updateProfile` пишет `locale`; `create` принимает `locale`), `apps/api/src/users/users.controller.ts` (без изменений, схема расширена)
- Modify: `apps/web/app/components/users/UserDialog.tsx` — шаг «Данные» мастера: `Select` «Мова інтерфейсу / Interface language» (`uk` по умолчанию)
- Test: `packages/shared/src/schemas/auth.spec.ts`, `apps/api/src/users/users-locale.integration.spec.ts`, `apps/api/src/database/user-locale-migration.integration.spec.ts` (идемпотентность DDL, по образцу `notification-email-migrations.integration.spec.ts`), `apps/web/app/components/users/__tests__/UserDialog.create-wizard.test.tsx` (поле локали)

**Interfaces:**

- Produces: `sessionUserSchema` получает `locale: localeSchema` (обязательно); `SessionUser.locale`; `updateProfileSchema.locale?: Locale`; `createUserSchema.locale?: Locale` (дефолт `uk` в сервисе); DDL `user_locale` enum + `users.locale NOT NULL DEFAULT 'uk'`.

- [ ] **Step 1: Тест схемы (падает: поля нет)**

```ts
// packages/shared/src/schemas/auth.spec.ts (добавить)
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

- [ ] **Step 2: Схемы**

```ts
// packages/shared/src/schemas/auth.ts — внутри sessionUserSchema
locale: localeSchema,
// packages/shared/src/schemas/users.ts
export const updateProfileSchema = z.object({ /* …как было… */ locale: localeSchema.optional() })
// createUserSchema: добавить locale: localeSchema.optional()
```

(`import { localeSchema } from '../i18n/locales'`.)

- [ ] **Step 3: Drizzle + DDL**

```ts
// apps/api/src/database/schema.ts (рядом с roleEnum)
export const userLocaleEnum = pgEnum('user_locale', ['uk', 'en'])
// в users: после role
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

`deploy.yml`: добавить файл в три места по образцу предыдущего DDL; `python3 scripts/devops/check-prod-ddl-wiring.py` → `BROKEN WIRING: 0`.

- [ ] **Step 4: `/auth/me` и `updateProfile`**

В обеих ветках `auth.controller.ts` `/me`: `locale: fresh.locale` (в fallback-ветке — `'uk'`). В `users.service.ts` `updateProfile(id, data: { …; locale?: 'uk' | 'en' })` — включить `locale` в `set({...})`. В `create` — `locale: input.locale ?? 'uk'`.

- [ ] **Step 5: Интеграционный тест (реальный Postgres, `skipIf(!hasDatabaseUrl())` как у соседей)**

```ts
// apps/api/src/users/users-locale.integration.spec.ts — суть кейсов
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

Run на scratch-базе: `DATABASE_URL=postgres://…/crm_scratch_i18n pnpm --filter @crm/api test -- users-locale` → PASS.

- [ ] **Step 6: Мастер создания — поле локали**

В шаге «Данные» `UserDialog.tsx` (create-wizard) — `Select` с двумя опциями (`uk` — «Українська», `en` — «English»), `data-testid="user-locale-select"`, значение по умолчанию `uk`, в payload `locale`. Тест в `UserDialog.create-wizard.test.tsx`: выбор `en` → `api.post` вызван с `locale: 'en'`.

- [ ] **Step 7: Гейты и коммит**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @crm/shared test && pnpm --filter @crm/web test && DATABASE_URL=postgres://postgres:postgres@localhost:5432/crm_scratch_i18n pnpm --filter @crm/api test -- integration   # своя scratch-база, инлайн
python3 scripts/devops/check-prod-ddl-wiring.py
git add apps/api/src/database/schema.ts apps/api/drizzle/manual/2026-09-20_user_locale.sql .github/workflows/deploy.yml packages/shared/src/schemas/auth.ts packages/shared/src/schemas/users.ts packages/shared/src/schemas/auth.spec.ts apps/api/src/auth/auth.controller.ts apps/api/src/users/users.service.ts apps/api/src/users/users-locale.integration.spec.ts apps/api/src/database/user-locale-migration.integration.spec.ts apps/web/app/components/users/UserDialog.tsx apps/web/app/components/users/__tests__/UserDialog.create-wizard.test.tsx
git commit -m "feat(users): interface locale per user — users.locale (uk|en), /auth/me, PATCH /users/me, create wizard

ac_verified: 3"
```

---

### Task 4: Локаль запроса на API — `resolveRequestLocale` и `@RequestLocale()`

**Files:**

- Create: `apps/api/src/i18n/request-locale.ts`
- Test: `apps/api/src/i18n/request-locale.spec.ts`

**Interfaces:**

- Consumes: `resolveLocale`, `LOCALE_COOKIE_NAME` из `@crm/shared`; `request.user` (`SessionUser` с `locale`) из `JwtAuthGuard`.
- Produces: `resolveRequestLocale(req: { user?: { locale?: string }; cookies?: Record<string,string>; headers: { 'accept-language'?: string } }): Locale` — порядок: `user.locale` → cookie `pref_locale` → первый язык `Accept-Language` → `uk`; параметр-декоратор `RequestLocale` (`createParamDecorator`).

- [ ] **Step 1: Тест**

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

- [ ] **Step 2: Run → FAIL; реализация**

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

Проверить, что Fastify-cookie парсер уже подключён (`@fastify/cookie` — auth-cookie JWT использует его); если `request.cookies` отсутствует — прочитать заголовок `cookie` вручную в `resolveRequestLocale` (добавить кейс в тест).

- [ ] **Step 3: Run → PASS; коммит**

```bash
pnpm --filter @crm/api typecheck && pnpm --filter @crm/api lint && pnpm --filter @crm/api test -- request-locale
git add apps/api/src/i18n/request-locale.ts apps/api/src/i18n/request-locale.spec.ts
git commit -m "feat(api): request locale resolver — user, pref_locale cookie, Accept-Language, uk

ac_verified: 4"
```

---

### Task 5: Конверт кодов ошибок — реестр в shared, `apiError()` на API, перевод на клиенте, первые шесть кодов

**Files:**

- Create: `packages/shared/src/schemas/api-errors.ts`, `apps/api/src/common/api-error.ts`
- Modify: `apps/web/app/lib/axios-utils.ts` (`getApiErrorMessage`: приоритет 0 — `code`), `apps/web/app/lib/i18n.ts` (см. Task 6 — здесь используется `i18n` из `@lingui/core`; до Task 6 достаточно глобального `i18n` с загруженным `uk`)
- Modify (первые коды): `apps/api/src/contracts/employee-contracts.service.ts` (2 × `No active contract template` → `CONTRACT_TEMPLATE_MISSING`), `apps/api/src/contracts/signed-contracts.service.ts`, `apps/api/src/tos/tos.service.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/notifications/notifications.controller.ts`, `apps/api/src/users/users.service.ts` (approve/reject share), `apps/api/src/projects/projects.service.ts` (approve/reject) — все `*_IMPERSONATION` → `apiError`
- Modify: `apps/web/app/components/user-profile/contract/ContractTab.tsx`, `apps/web/app/components/users/UserDialog.tsx` — ветвление по `code`
- Test: `packages/shared/src/schemas/api-errors.spec.ts`, `apps/api/src/common/api-error.spec.ts`, `apps/web/app/lib/__tests__/axios-utils.spec.ts` (расширить), обновить спеки сервисов на форму `{ code }`

**Interfaces:**

- Produces:
  - `API_ERROR_CODES = ['GENERIC','CONTRACT_TEMPLATE_MISSING','CONTRACT_SIGN_IMPERSONATION','TOS_ACCEPT_IMPERSONATION','INVOICE_SIGN_IMPERSONATION','NOTIFICATION_PREFERENCES_IMPERSONATION','SHARE_DECISION_IMPERSONATION','PROJECT_DECISION_IMPERSONATION'] as const`, `type ApiErrorCode`.
  - `apiErrorEnvelopeSchema = z.object({ statusCode: z.number().int(), code: z.enum(API_ERROR_CODES), params: z.record(z.string(), z.union([z.string(), z.number()])).optional(), message: z.string() })`.
  - `API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor>` — украинские тексты с явными id `api-error.<code>`, помечены `/* i18n */`.
  - `apiError(code: ApiErrorCode, status: HttpStatus, params?: Record<string,string|number>): HttpException` — тело `{ statusCode, code, params, message }`, `message` — английский fallback из `API_ERROR_FALLBACK_EN`.
  - `getApiErrorMessage(err, fallback?)`: если тело ответа проходит `apiErrorEnvelopeSchema` → `i18n._(API_ERROR_MESSAGES[code], params)`; иначе прежняя логика.

- [ ] **Step 1: Тест реестра**

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

- [ ] **Step 2: Реализация реестра**

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

Украинские тексты — черновик кодера; `copy-reviewer` проверяет оба языка (en — в `messages.po`). После правки: `pnpm i18n:extract` → в `uk/messages.po` появятся восемь записей; заполнить `en` там же.

- [ ] **Step 3: `apiError` на API + тест**

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

- [ ] **Step 4: Первые коды на API**

`employee-contracts.service.ts`: оба `throw new NotFoundException(\`No active contract template for role ${user.role}\`)`→`throw apiError('CONTRACT_TEMPLATE_MISSING', HttpStatus.NOT_FOUND, { role: user.role })`. Пять `ForbiddenException(<литерал имперсонации>)`→`apiError('<CODE>\_IMPERSONATION', HttpStatus.FORBIDDEN)`. Литералы `\*\_IMPERSONATION_MESSAGE` в shared **остаются** до этапа 3 (их читает клиентский баннер), но серверный текст теперь английский fallback — обновить спеки сервисов/контроллеров и интеграционные (`expect(res.body.code).toBe('…')` вместо текста).

- [ ] **Step 5: Клиент — `getApiErrorMessage` по коду + ветвления**

```ts
// apps/web/app/lib/axios-utils.ts — в начале getApiErrorMessage после проверок на null/object
const envelope = apiErrorEnvelopeSchema.safeParse(
  (err as { response?: { data?: unknown } }).response?.data,
)
if (envelope.success) {
  return i18n._(API_ERROR_MESSAGES[envelope.data.code], envelope.data.params)
}
```

(`i18n` — из `@/lib/i18n`, Task 6; до него — `import { i18n } from '@lingui/core'` с `uk`-каталогом, загруженным в `client.tsx`.) Добавить `export function getApiErrorCode(err: unknown): ApiErrorCode | null`.

`ContractTab.tsx`: `const isNoTemplate = getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'` (удалить `includes('no active contract template')`). `UserDialog.tsx`: `includes('template')` → `getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'`. Тесты обоих компонентов: мок ошибки с телом-конвертом → пустое состояние показано; ошибка с прозой без кода → **не** показано.

- [ ] **Step 6: Тесты `axios-utils`**

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

- [ ] **Step 7: Гейты, мутационный гейт, коммит**

```bash
pnpm i18n:extract && pnpm i18n:compile && pnpm typecheck && pnpm lint && pnpm test
node scripts/devops/mutation-gate.mjs --changed
git add packages/shared/src/schemas/api-errors.ts packages/shared/src/schemas/api-errors.spec.ts packages/shared/src/schemas/index.ts packages/shared/src/i18n/locales/uk/messages.po packages/shared/src/i18n/locales/en/messages.po apps/api/src/common/api-error.ts apps/api/src/common/api-error.spec.ts apps/api/src/contracts/employee-contracts.service.ts apps/api/src/contracts/signed-contracts.service.ts apps/api/src/tos/tos.service.ts apps/api/src/invoices/invoices.service.ts apps/api/src/notifications/notifications.controller.ts apps/api/src/users/users.service.ts apps/api/src/projects/projects.service.ts apps/api/src/contracts/signed-contracts.service.spec.ts apps/api/src/contracts/employee-contracts.service.spec.ts apps/api/src/tos/tos-accept-impersonation.integration.spec.ts apps/api/src/invoices/invoice-sign-impersonation.integration.spec.ts apps/api/src/notifications/notifications.controller.spec.ts apps/api/src/notifications/notification-preferences.rbac.integration.spec.ts apps/api/src/onboarding/onboarding-contract.integration.spec.ts apps/web/app/lib/axios-utils.ts apps/web/app/lib/__tests__/axios-utils.spec.ts apps/web/app/components/user-profile/contract/ContractTab.tsx apps/web/app/components/users/UserDialog.tsx apps/web/app/components/user-profile/contract/__tests__/ContractTab.test.tsx apps/web/app/components/users/__tests__/UserDialog.test.tsx
git commit -m "feat(api,web,shared): API error envelope with codes translated on the client; first eight codes

ac_verified: 5"
```

security-reviewer обязателен (auth-пути).

---

### Task 6: Веб — `I18nProvider`, активация локали из `/auth/me` и до входа

**Files:**

- Create: `apps/web/app/lib/i18n.ts`
- Modify: `apps/web/app/routes/__root.tsx` (обернуть в `I18nProvider`), `apps/web/app/context/auth.tsx` (эффект: `user.locale` → `activateLocale`), `apps/web/app/client.tsx` (стартовая активация до рендера), `apps/web/index.html` (`lang="uk"`)
- Test: `apps/web/app/lib/__tests__/i18n.test.tsx`

**Interfaces:**

- Consumes: `LOCALES`, `DEFAULT_LOCALE`, `LOCALE_COOKIE_NAME`, `resolveLocale` из `@crm/shared`.
- Produces: `i18n` (глобальный экземпляр `@lingui/core` для браузера), `activateLocale(locale: Locale): Promise<void>` (динамический импорт `@crm/shared/src/i18n/locales/${locale}/messages.po` через Vite-плагин → `i18n.loadAndActivate`, `document.documentElement.lang = locale`, cookie `pref_locale` на год), `readPreLoginLocale(): Locale` (cookie → `navigator.language` → `uk`), `useLocale(): Locale` (из `useLingui`).

- [ ] **Step 1: Тест**

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

- [ ] **Step 2: Реализация**

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

Путь динамического импорта уточнить по алиасу (`vite-tsconfig-paths` + `@crm/shared` `source` export) — Vite-плагин Lingui компилирует `.po` при импорте; в Vitest тот же плагин подключён в Task 1.

`client.tsx`: перед `createRoot(...).render(...)` — `await activateLocale(readPreLoginLocale())`. `__root.tsx`: `<I18nProvider i18n={i18n}>` вокруг `TelemetryProvider`. `auth.tsx`: `useEffect(() => { if (data?.locale && data.locale !== i18n.locale) void activateLocale(data.locale) }, [data?.locale])`.

- [ ] **Step 3: Run → PASS; E2E-смоук**

`apps/e2e`: существующая спека входа проходит; добавить в `auth-nav` шард один кейс: `<html lang>` равен `uk` после входа моком `/auth/me` с `locale: 'uk'` и `en` — с `locale: 'en'` (мок `mockAuthAs` расширить полем `locale`).

- [ ] **Step 4: Коммит**

```bash
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test && pnpm --filter @crm/e2e test -- auth-nav
git add apps/web/app/lib/i18n.ts apps/web/app/lib/__tests__/i18n.test.tsx apps/web/app/routes/__root.tsx apps/web/app/context/auth.tsx apps/web/app/client.tsx apps/web/index.html apps/e2e/tests/auth-nav/login-locale.spec.ts
git commit -m "feat(web): I18nProvider, locale activation from /auth/me and pre-login cookie

ac_verified: 6"
```

---

### Task 7: Переключатель языка в профиле (self-mode)

**Files:**

- Create: `apps/web/app/components/user-profile/LanguageSection.tsx`
- Modify: `apps/web/app/components/user-profile/tabs/OverviewTab.tsx` (рендер секции только при `mode === 'self'`)
- Modify: `apps/web/app/hooks/use-user-profile.ts` (мутация `PATCH /users/me { locale }` + `invalidate` auth-запроса) — или существующий хук обновления профиля
- Test: `apps/web/app/components/user-profile/__tests__/LanguageSection.test.tsx`

**Interfaces:**

- Consumes: `activateLocale`, `useLocale` (Task 6); `updateProfileSchema.locale` (Task 3).
- Produces: `LanguageSection` — две кнопки-радио `uk`/`en` (`data-testid="locale-option-uk|en"`), заголовок `<Trans>Мова інтерфейсу</Trans>`; при выборе: `PATCH /api/users/me { locale }` → `activateLocale(locale)` → `invalidate()`; ошибка → тост через `getApiErrorMessage`.

- [ ] **Step 1: Тест**

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

- [ ] **Step 2: Реализация**

```tsx
// apps/web/app/components/user-profile/LanguageSection.tsx
import { Trans } from '@lingui/react/macro'
import { LOCALES, type Locale } from '@crm/shared'
import { activateLocale } from '@/lib/i18n'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/axios-utils'

const LABELS: Record<Locale, string> = { uk: 'Українська', en: 'English' } // названия языков — на самих языках, не переводятся

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

Стили — как у соседних секций `OverviewTab` (design-gate Tier 3; conformance дизайнером по скриншотам 320/1440 на обоих языках).

- [ ] **Step 3: Run → PASS; коммит**

```bash
git add apps/web/app/components/user-profile/LanguageSection.tsx apps/web/app/components/user-profile/tabs/OverviewTab.tsx apps/web/app/hooks/use-user-profile.ts apps/web/app/components/user-profile/__tests__/LanguageSection.test.tsx
git commit -m "feat(web): interface language switcher in the profile overview (self only)

ac_verified: 7"
```

---

### Task 8: Правки «до извлечения строк» (аудит §2, сквозные)

**Files:**

- Modify: `apps/web/app/components/pending/PendingKindSection.tsx` (проп `kind`, `data-testid` из `kind`), `apps/web/app/routes/_authenticated/pending/index.tsx` (передавать `kind`; селектор фокуса по `kind`), тесты `pending/__tests__/index.test.tsx`, E2E-спека pending (селекторы `pending-kind-heading-<zone>-<KIND>`)
- Modify: `apps/web/app/lib/documents-filter-sort.ts` (`compareNames(locale)` вместо `localeCompare(…, 'ru')`; локаль — параметр функции сортировки, вызывающий передаёт `useLocale()`), тесты
- Modify: `apps/web/app/components/layout/ImpersonationBanner.tsx`, `apps/web/app/components/user-profile/UserProfileHeader.tsx`, `apps/web/app/components/user-profile/tabs/TeamTab.tsx` — удалить локальные карты, импортировать `ROLE_LABELS` из `@/components/ui/role-select`
- Test: обновить тесты трёх компонентов (профиль дропа показывает «Дроп», не `DROP`)

**Interfaces:**

- Produces: `PendingKindSectionProps.kind: PendingItemKind | 'OTHER'`; testid `pending-kind-heading-${zone}-${kind}` и `pending-kind-section-${zone}-${kind}`; `sortDocuments(items, sort, locale: Locale)`.

- [ ] **Step 1: Тесты (падают)**

```tsx
// pending/__tests__/index.test.tsx — заменить селекторы
'[data-testid="pending-kind-heading-mine-PROJECT_APPROVAL"]'
// новый кейс
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

- [ ] **Step 2: Реализация**

`PendingKindSection.tsx`: добавить `kind` в пропсы, `data-testid={\`pending-kind-heading-${zone}-${kind}\`}`и для`<ul>`. В `pending/index.tsx`: `sectionKindOf(item)`вместо`sectionTitleOf` для селектора фокуса (`OTHER`для незнакомых).`documents-filter-sort.ts`: сигнатура с `locale`, `compareNames(locale)`. Три карты ролей → `import { ROLE_LABELS } from '@/components/ui/role-select'`.

- [ ] **Step 3: Run → PASS, E2E pending на живом стенде, коммит**

```bash
pnpm --filter @crm/web test && pnpm --filter @crm/e2e test -- pending
git add apps/web/app/components/pending/PendingKindSection.tsx apps/web/app/routes/_authenticated/pending/index.tsx apps/web/app/routes/_authenticated/pending/__tests__/index.test.tsx apps/web/app/components/pending/__tests__/PendingKindSection.test.tsx apps/e2e/tests/misc/pending.spec.ts apps/web/app/lib/documents-filter-sort.ts apps/web/app/lib/__tests__/documents-filter-sort.spec.ts apps/web/app/components/layout/ImpersonationBanner.tsx apps/web/app/components/user-profile/UserProfileHeader.tsx apps/web/app/components/user-profile/tabs/TeamTab.tsx apps/web/app/components/user-profile/__tests__/UserProfileHeader.test.tsx
git commit -m "refactor(web): pre-i18n fixes — testids from kind, locale-aware name sort, single role label map

ac_verified: 8"
```

---

### Task 9: ESLint — `lingui/no-unlocalized-strings` в режиме предупреждения

**Files:**

- Modify: `apps/web/eslint.config.mjs`, `packages/shared/eslint.config.mjs`, `package.json` (devDep `eslint-plugin-lingui`)
- Test: `pnpm --filter @crm/web lint` завершается с кодом 0 и печатает предупреждения (не ошибки)

- [ ] **Step 1: Установить и включить**

```bash
pnpm add -w -D eslint-plugin-lingui@0.16.0
```

```js
// apps/web/eslint.config.mjs — новый блок после основного
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

Третий `ignore` (без кириллицы — молчать) намеренно сужает правило на этом этапе до строк с кириллицей: цель этапа — видеть, сколько русского/украинского текста ещё не обёрнуто, а не шуметь на английских техничесих строках. На этапе 6 `ignore` сужается и режим → `error`.

- [ ] **Step 2: Прогон и число предупреждений в PR body**

```bash
pnpm --filter @crm/web lint 2>&1 | grep -c 'no-unlocalized-strings'
```

Записать число (ожидаемо тысячи) в PR body как baseline для этапа 3.

- [ ] **Step 3: Коммит**

```bash
git add package.json pnpm-lock.yaml apps/web/eslint.config.mjs packages/shared/eslint.config.mjs
git commit -m "infra(lint): eslint-plugin-lingui no-unlocalized-strings as a warning (baseline for the module waves)

ac_verified: 9"
```

---

### Task 9b (DevOps): CI — каталоги синхронны с кодом

**Files:**

- Modify: `.github/workflows/ci.yml` — в job `Typecheck · Lint · Unit Tests` после установки зависимостей

- [ ] **Step 1: Шаг**

```yaml
- name: i18n catalogs are in sync (lingui extract --clean)
  run: |
    pnpm i18n:extract
    git diff --exit-code -- packages/shared/src/i18n/locales || {
      echo "::error::Run 'pnpm i18n:extract' and commit the updated .po catalogs"; exit 1; }
- name: i18n compile
  run: pnpm i18n:compile
```

Шаг `i18n compile` должен стоять **до** `typecheck`/`test` в этом job и во всех jobs, где собирается web/api (E2E build, mutation gate) — иначе `messages.ts` отсутствует. Проверить `turbo` `dependsOn` из Task 1: если turbo уже запускает `//#i18n:compile`, явный шаг не нужен — оставить только проверку синхронности.

- [ ] **Step 2: Проверка**

Открыть PR с намеренно устаревшим `.po` (локально не запускать `extract`) → job красный с сообщением; исправить → зелёный. `scripts/devops/tests/` — добавить guard-тест не требуется (шаг — не хук).

- [ ] **Step 3: Коммит**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(i18n): fail when .po catalogs are out of sync; compile catalogs before typecheck/test

ac_verified: 9b"
```

---

### Task 10 (Architect/Master, docs-only): правила проекта под два языка

**Files:**

- Modify: `.claude/rules/common/russian-language.md` — русский остаётся языком общения с владельцем, PR-обсуждений и отчётов агентов; **продукт** (UI `apps/web`, письма, PDF счетов) — `uk` (дефолт) и `en`; запрет украинского в продукте снимается; логи — английский. Правило «Reviewer → BLOCK» переформулировать: BLOCK на русский текст в **мигрированном** модуле и на любой новый видимый текст без обёртки Lingui.
- Modify: `.claude/rules/common/version-pins.md` — блок «i18n»: `@lingui/*` **6.7.0** EXACT одной версией (ESM-only, требует Node ≥ 22.19 — см. строку Node 22 из Task 0); `eslint-plugin-lingui 0.16.0`; результат спайка Task 0b одной строкой (как CJS-сборки api/shared подхватывают ESM-пакет).
- Modify: `.claude/agents/copy-reviewer.md`, `.claude/skills/copywriting/SKILL.md` — CRM теперь двуязычна: вердикт по `uk` и `en` отдельно; «два оригинала» действует на CRM; глоссарий `CONTEXT.md` — источник терминов.
- Modify: `.claude/skills/playwright-patterns/SKILL.md` — правило: текст в ассертах из каталога (`i18n._()` дескриптора) или testid/роль, литералы запрещены для мигрированных модулей.
- Modify: `.claude/agents/workflow-registry.md` №8 — после этапа 6 воркфлоу становится аудитом покрытия каталогов.
- Modify: `CONTEXT.md` — в шапке глоссария заметка: термины получают колонки `uk`/`en` в первом PR этапа 3 (`web-core`), пока — русский как язык глоссария.

- [ ] **Step 1: Правки по списку, `prettier --write`, docs-only PR**

```bash
git add .claude/rules/common/russian-language.md .claude/rules/common/version-pins.md .claude/agents/copy-reviewer.md .claude/skills/copywriting/SKILL.md .claude/skills/playwright-patterns/SKILL.md .claude/agents/workflow-registry.md CONTEXT.md
git commit -m "docs(rules): CRM product language is uk/en; Lingui pins; copy and E2E rules for two languages

ac_verified: n/a (docs-only rules update)"
```

---

## Что этот этап НЕ делает (и где это будет)

- Миграция существующих русских строк по модулям — этап 3 (волны `web-core` → `web-people` → `web-projects` → `web-finance` → `web-docs-notify`).
- `EXPENSE_CATEGORIES` как ключи в `transactions.receiver_label` — этап 3, волна `web-finance` (+ миграция данных на API).
- Три legacy-типа уведомлений в `NOTIFICATION_TITLES`, рендер заголовков по `type` + `data`, письма по локали получателя — этап 4.
- 289 русских + 214 английских исключений → коды — этап 4 (реестр и `apiError` готовы здесь).
- PDF счетов по локали — этап 5. Guard на русские буквы и `error`-режим ESLint — этап 6.

## Проверка готовности этапа

- `pnpm i18n:extract` и `pnpm i18n:compile` проходят локально и в CI; шаг синхронности красный при устаревшем `.po`.
- Пользователь с `locale = en` после входа видит `<html lang="en">`, переключатель в профиле меняет язык без перезагрузки, выбор сохраняется в `users.locale`.
- Ошибка `CONTRACT_TEMPLATE_MISSING` приходит конвертом с кодом; `ContractTab` показывает пустое состояние по коду, а не по тексту.
- Пять 403 под «войти как» отдают код; клиент показывает украинский текст из каталога.
- `PendingKindSection` testid не содержит видимого текста; сортировка документов принимает локаль; карта ролей одна.
- `pnpm --filter @crm/web lint` печатает baseline предупреждений `no-unlocalized-strings`, код возврата 0.
