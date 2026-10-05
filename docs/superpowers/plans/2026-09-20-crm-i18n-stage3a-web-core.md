# CRM i18n — stage 3, wave (a) "web-core" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate to `uk`/`en` the entire CRM shell — common UI components (`components/ui`, `components/layout`, `components/crm`, `components/archive`), navigation, the post-login dashboards (`routes/_authenticated/routing/**`), login (`login.tsx`, `__root.tsx`, `client.tsx`), error handling (`axios-utils.ts`, `ErrorBoundary.tsx`) and all of `lib`/`hooks` — in three PRs over non-overlapping files, with no Russian text in the migrated files and no regressions in behavior that the translation breaks silently (audit §2).

**Architecture:** The same single catalog `packages/shared/src/i18n/locales/{uk,en}/messages.po` as in stage 2. Module constants (`NAV_ITEMS`, `ROLE_LABELS`, `ERROR_MESSAGES`, `STATUS_MESSAGES`, `SORT_OPTIONS`, etc.) move from "computed at import" to a `msg` descriptor + `i18n._()` in the render — otherwise the language switch does not take effect on an already-loaded tab. Visible JSX text — `<Trans>`; attributes (`aria-label`/`title`/`placeholder`) and imperative strings (`toast.error(...)`) — `t` from `useLingui()` (not the bare `t` macro outside a component — this accounts for reactivity to the locale change). Numeric forms — `plural`/`<Plural>`; branching by role in gender forms — `select`. Date/money/number formatting — only via `packages/shared/src/i18n/format.ts` (`formatDate`, `formatMoney`, `formatNumber`, `compareNames`) plus the new `formatRelativeTime` (Task 1, replaces `date-fns/locale/ru`).

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`) — already installed and set up in stage 2 (`lingui.config.ts`, the Vite/Vitest macro plugin). React 18 + Vite 6 + Vitest 4, TanStack Router, Tailwind v4 + shadcn/ui, `eslint-plugin-lingui` 0.16.0 (already `warn`), Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §7 item 3 (wave a), §8 (tests), §5 (gates). Audit: `docs/architecture/2026-09-19-crm-i18n-audit.md`, the `web-core` slice (lines 129–222) + the cross-cutting themes §1–§4. Foundation (already merged on `origin/main`): `docs/superpowers/plans/2026-09-19-crm-i18n-stage2-foundation.md`.

## Global Constraints

- The `@lingui/*` versions — **5.9.5 EXACT**, a single version (owner decision 2026-09-19 after spikes 0b/0c — Lingui 6 ESM-only breaks `tsc` in api/shared; see `version-pins.md`). Do NOT upgrade in this plan.
- Source text in the code — **Ukrainian** (`sourceLocale: 'uk'`); English is written next to it in the same PR as a second original (skill `copywriting` §5, owner decision #7). Russian literals in files from this wave's perimeter are removed entirely; literals in files OUTSIDE the perimeter (`_Избегать_`) are not touched.
- `msg`/`plural`/`select`/`t`/`Trans` — **never `t`/`plural`/`select` at the module level** (they fix the string once at import): module constants — `msg`, resolved with `i18n._()` at the display place. Source — Lingui 5.9.5 docs (`Do not call t, plural or select at module level`).
- In components — `useLingui()` from `@lingui/react/macro` for `t`/`i18n` (not the bare `@lingui/core/macro` `t`/`plural` outside a component): this way the string reacts to the language switch without repair.
- Tests: anchors `data-testid`/roles. Text in assertions — **fix-round 1, SPEC-H-1**: `import { messages } from '@crm/shared/i18n/locales/uk/messages'` does NOT resolve (`@crm/shared` is aliased to the FILE `packages/shared/src/index.ts`, not to a directory — Vite cannot append a subpath to a file alias). The catalog is loaded by TWO different, each REAL, mechanisms (the code of both — the new "Test access to the catalog" section right after Global Constraints):
  - **Vitest** (`apps/web`) — the canonical helper `apps/web/app/test/i18n.tsx`: `loadCatalog(locale)` → `activateLocale(locale)` from `@/lib/i18n` (THE SAME runtime path as production, via the working alias `@crm/shared-i18n-locales` + `import.meta.glob` — already proven by `LanguageSection.test.tsx`, `apps/web/app/lib/i18n.ts`), plus `I18nTestProvider` — a shared `render`/`renderHook` wrapper.
  - **E2E** (`apps/e2e`) — the Playwright tests go through their own TS loader, not through Vite, `@lingui/vite-plugin` is not available there at all. The compiled catalog (`pnpm i18n:compile`, `compileNamespace: 'ts'`, already in the gates of every Task-Step) — a self-contained module without imports (`export const messages = JSON.parse('{...}')`, Lingui CLI ref), so an ordinary relative file import reads it without a bundler: the helper `apps/e2e/fixtures/catalog.ts` → `loadMessages(locale)`.
  - **Both** read the REAL catalog, not a literal — `playwright-patterns` §10 is observed on both sides. A message id without an explicit `msg({id: ...})` — a HASH of the source text, not the text itself (Lingui: generated ids, `explicit-vs-generated-ids`) — the specific id for a new string is found via `pnpm i18n:extract` → `grep` over the `.po` for the text.
- `git add` by an explicit list; `DATABASE_URL= git push`; without `--no-verify`; commits with `ac_verified: <numbers>`.
- After each Edit/Write of `.ts`/`.tsx` → `mcp__eslint__lint-files`; `lingui/no-unlocalized-strings` is `warn` for now (stage 6 will turn on `error`) — zero new warnings on the lines this wave touches anyway is mandatory.
- `pnpm i18n:extract` (== `lingui extract --clean`) is idempotent: a second consecutive run does not change the `.po` files. The CI gate "i18n catalogs are in sync" (`ci.yml`) already checks this — reproduce it locally before push.
- Each PR: design tier 2 (editing an existing screen — conformance, not full generation), a `copy-reviewer` verdict on `uk` **and** `en` separately, screenshots 320/1440 in both languages, `pnpm mutation:changed` on the diff.
- Zone: the whole range of the wave's files — `apps/web/**` + `packages/shared/src/i18n/format.ts` (an extension, not a rewrite) — the Coder zone. Test files — also Coder (not AutoTest: this is not a new `.spec.ts`, but editing the assertions inside the already-migrated modules, part of the same task).

---

## Test access to the catalog (fix-round 1, SPEC-H-1 — used in ALL Task 1–3 steps)

Global Constraints' original pattern (`import { messages } from '@crm/shared/i18n/locales/uk/messages'`) does not
resolve: `@crm/shared` in `apps/web/vite.config.ts:76`/`vitest.config.ts:99` is aliased to the **file**
`packages/shared/src/index.ts`, not to a directory, and Vite appends the rest of the path to a file alias
(`.../src/index.ts/i18n/locales/...` — invalid; the same comment in both configs, task-i18n-stage2
Task 5/6). Below — the single canonical way for each side (unit vs E2E), further in the plan —
only a reference to this section.

### Vitest (`apps/web`) — `apps/web/app/test/i18n.tsx` (a new file)

The working path is THE SAME one by which production loads the catalog: `activateLocale()` from `@/lib/i18n`, behind which
stands the working (directory, not file) alias `@crm/shared-i18n-locales` + `import.meta.glob` —
already proven by the live test `apps/web/app/components/user-profile/__tests__/LanguageSection.test.tsx`
(`await activateLocale('uk')`, the same `I18nProvider` wrapper).

```tsx
// apps/web/app/test/i18n.tsx
// fix-round 1 (PR #697, SPEC-H-1). `@crm/shared/i18n/locales/<locale>/messages`
// does not resolve (see the section above). `activateLocale` is the only working
// path: it goes through `@crm/shared-i18n-locales` (a directory alias) +
// `import.meta.glob`, THE SAME runtime that the production code uses and already
// proven by `LanguageSection.test.tsx`.
import type { ReactNode } from 'react'
import { I18nProvider } from '@lingui/react'
import { i18n, activateLocale } from '@/lib/i18n'
import type { Locale } from '@crm/shared'

/** Activates the REAL compiled `locale` catalog on the shared `i18n`
 *  singleton that `useLingui()`/`useLocale()` read. Call BEFORE
 *  render/renderHook — this is not a React component, an await inside a wrapper
 *  is impossible. */
export async function loadCatalog(locale: Locale): Promise<void> {
  await activateLocale(locale)
}

/** A `render`/`renderHook` wrapper with THE SAME `i18n` singleton that `loadCatalog` activates. */
export function I18nTestProvider({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}
```

Usage (example — the full test `role-select.locale.test.tsx` see Task 1 Step 1):

```ts
await loadCatalog('uk')
const { result: uk } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
expect(uk.current).toBe('Адміністратор')
await loadCatalog('en')
const { result: en } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
expect(en.current).toBe('Admin')
```

For a smoke check of the mere fact that the macro compiled (without needing a real translation,
`uk` — the `sourceLocale`) — the existing pattern `i18n-smoke.test.tsx` (`i18n.load('uk', {}); i18n.activate('uk')`

- an assertion on the source uk text of `<Trans>`) remains valid and is NOT replaced by this helper; `loadCatalog`
  is needed where the test wants the REAL `en` translation or the hash resolution of a specific `msg`/`plural`.

### E2E (`apps/e2e`) — `apps/e2e/fixtures/catalog.ts` (a new file)

`apps/e2e` does not go through Vite: Playwright runs the `.spec.ts` with its own TS loader
(`playwright.config.ts` does not plug in `@lingui/vite-plugin`, `package.json` does not carry `@lingui/*`
dependencies at all — checked). But the compiled catalog (`pnpm i18n:compile`,
`compileNamespace: 'ts'`, already in the gates of every Task-Step BEFORE the E2E command) — a self-contained module
without a single import (`export const messages = JSON.parse('{...}')`, Lingui CLI reference, "Compiled
message file structure"), so an ordinary relative file import reads it without a bundler —
a bundler is not needed here.

```ts
// apps/e2e/fixtures/catalog.ts
// fix-round 1 (PR #697, SPEC-H-1). `apps/e2e` does not see either `@crm/shared` or
// `@crm/shared-i18n-locales` (both — apps/web Vite aliases, e2e does not go through
// Vite). The compiled catalog is a flat object without imports, we read it
// directly by the relative path (requires `pnpm i18n:compile` BEFORE
// the run — already in the command order of every Task-Step).
import { join } from 'node:path'

const LOCALES_DIR = join(__dirname, '../../../packages/shared/src/i18n/locales')

/** The compiled `locale` catalog: a message id (a hash of the source text —
 *  generated by `lingui extract`, NOT the text itself, see
 *  https://lingui.dev/guides/explicit-vs-generated-ids) -> the localized
 *  string. The id for a NEW assertion — `pnpm i18n:extract`, then
 *  `grep -B2 'msgstr "<source uk text>"' packages/shared/src/i18n/locales/uk/messages.po`. */
export async function loadMessages(locale: 'uk' | 'en'): Promise<Record<string, string>> {
  const mod = (await import(join(LOCALES_DIR, locale, 'messages'))) as {
    messages: Record<string, string>
  }
  return mod.messages
}
```

Usage — an example in Task 1 Step 8.

---

## Perimeter of wave (a) — how it was obtained and why it is narrower than the literal command

The assignment required taking the perimeter with the command:

```bash
git ls-files apps/web/app | grep -E '^apps/web/app/(components/(ui|layout)|lib|hooks|routes/(__root|index|login|_auth)[^/]*|router)'
```

**This command gives the wrong perimeter**, and this is checked by a run, not by assumption: `grep -E` without a `$` at the end does a **prefix**, not an exact, match — `routes/(_auth)[^/]*` matches `routes/_authenticated` and ANY tail after it, including `/`. In fact the command returns **all** files under `routes/_authenticated/**` — `finance/`, `interviews/`, `projects/`, `vacancies/`, `team/`, `users/`, `profile/`, `documents.tsx`, `stats.tsx` — i.e. waves (b)–(e) entirely, contrary to §7 of the spec, which explicitly distributes them to other waves. The run:

```bash
git ls-files apps/web/app | grep -E '^apps/web/app/(components/(ui|layout)|lib|hooks|routes/(__root|index|login|_auth)[^/]*|router)' | wc -l
# 269 files — this is ALL of apps/web/app/routes/_authenticated, not just the shell
```

Further: the literal list **skips** files that the audit and the spec itself assign to the "shell" — `apps/web/app/components/crm/nav-sidebar.tsx` (the whole `NAV_ITEMS`, the navigation `aria-label`s — COPY-M-core-\*, the most-cited file of the slice) and `StickyPageHeader.tsx` do not fall under `components/(ui|layout)`, but lie in `components/crm/`; `apps/web/app/client.tsx` (the SPA entry, PWA wiring) does not fall under any of the listed prefixes at all.

**The adjusted perimeter** — the intersection of (a) the literal intent of the assignment ("shell, navigation, login, common `ui`/`layout` components, `lib`/`hooks`"), (b) the actual content of the audit's `web-core` slice (209 files, 56 product ones with Cyrillic outside comments — audit lines 138–152) and (c) §7 of the spec, where wave (a) explicitly does NOT include `finance`/`interviews`/`projects`/`vacancies`/`team`/`users`/`profile`/`documents`/`stats`/`pending` (these are waves b–e). This is an A1 decision — reversible, docs-only, recorded in "Assumptions" below.

The resulting perimeter — **69 files analyzed** across three PRs (the full tables — in each task below; the count — line by line by the Task 1–3 tables, not an estimate), of which **61 actually migrate text**, 8 — checked (`grep -noP` over quotes with Cyrillic) and left as is (only comments, or already translated in stage 2):

| PR      | Directories                                                                                                                                                                                                                                                               | Analyzed / migrates                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **PR1** | `components/{ui,layout,crm,archive}/**`, `components/admin/TosPdfPreview.tsx`, `routes/_authenticated/{index,route,routing}.tsx` + `routing/components/**`, `routes/_authenticated/admin/{route,login-as,tos.index,tos.new}.tsx`, `router.tsx`, `public/site.webmanifest` | 37 / 37 (list — Task 1)                         |
| **PR2** | `lib/**` (except `axios.ts`, `axios-utils.ts`, `axios-unsafe-settle.d.ts`, `use-logout.ts`, `telemetry/**`, `pwa-runtime-caching.ts`, `preload-reload.ts`, `sw-reload.ts`, `i18n.ts` — already ready), `hooks/**`                                                         | 25 / 21 (list — Task 2, 4 without visible text) |
| **PR3** | `routes/login.tsx`, `routes/__root.tsx`, `client.tsx`, `lib/axios.ts`, `lib/axios-utils.ts`, `lib/telemetry/ErrorBoundary.tsx`, `index.html` (already ready from stage 2 — only a check)                                                                                  | 7 / 3 (list — Task 3, 4 without visible text)   |

`components/user-profile/**` (`UserProfileHeader.tsx`, `TeamTab.tsx`) are already partially touched in stage 2 (Task 8 — `ROLE_LABELS` consolidation), but remain **outside the wave (a) perimeter**: this is `web-people`, wave (b). Task 1 below introduces the transitional `useRoleLabel()` precisely so as not to drag their edit here (see "Danger: ROLE_LABELS" in Task 1).

---

## Migration templates (legend — one code per pattern, further in the tasks — only a reference to the letter)

**A. Module constant → `msg` + `i18n._()` in the render.**

```tsx
// was (apps/web/app/components/ui/role-select.tsx)
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  // ...
}

// became
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'

export const ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor> = {
  ADMIN: msg`Адміністратор`,
  SENIOR: msg`Синьйор`,
  JUNIOR: msg`Джун`,
  HR: msg`HR`,
  ACCOUNTANT: msg`Бухгалтер`,
  DROP: msg`Дроп`,
}

export function useRoleLabel(role: Role): string {
  const { i18n } = useLingui()
  return i18n._(ROLE_LABEL_MESSAGES[role])
}
```

**B. JSX text → `<Trans>`.**

```tsx
// was
;<h3>Валидация выплат</h3>

// became
import { Trans } from '@lingui/react/macro'
;<h3>
  <Trans>Приходи на перевірку</Trans>
</h3>
```

**C. Attribute / imperative string (`aria-label`, `toast.error`, `placeholder`) → `t` from `useLingui()`.**

```tsx
// was
<nav aria-label="Основная навигация">

// became
import { useLingui } from '@lingui/react/macro'
function NavSidebar() {
  const { t } = useLingui()
  return <nav aria-label={t`Основна навігація`}>
}
```

**D. Numeric form → `plural` (non-JSX) / `<Plural>` (JSX).**

```tsx
// was
count === 1 ? 'начисление' : 'начисления'

// became (JSX — a component, reacts to the locale change via the context)
import { Plural } from '@lingui/react/macro'
;<Plural
  value={count}
  one="# нарахування"
  few="# нарахування"
  many="# нарахувань"
  other="# нарахувань"
/>
```

```ts
// became (non-JSX, inside a component — via useLingui().t, a template with plural)
import { useLingui } from '@lingui/react/macro'
const { t } = useLingui()
const label = t`${plural(count, { one: '# команда', few: '# команди', many: '# команд', other: '# команди' })}`
```

**E. Gender form depending on the role (not a number) → `select`.**

```tsx
// was
const roleGenitive = role === 'SENIOR' ? 'синьора' : 'дропа'

// became
import { Trans } from '@lingui/react/macro'
;<Trans>
  Ви підтверджуєте архівацію {role === 'SENIOR' ? <Trans>синьйора</Trans> : <Trans>дропа</Trans>}
</Trans>
// or, if variants > 2, the select macro:
import { select } from '@lingui/core/macro'
const roleGenitive = select(role, { SENIOR: 'синьйора', DROP: 'дропа', other: 'співробітника' })
```

**F. Date/money/number formatting → `packages/shared/src/i18n/format.ts` instead of `toLocale*('ru-RU'|'en-US'|'uk-UA')`.**

```ts
// was (apps/web/app/lib/format-bytes.ts)
return `${rounded.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[unitIndex]}`

// became
import { formatNumber, type Locale } from '@crm/shared'
export function formatBytes(bytes: number, locale: Locale): string {
  // ...
  return `${formatNumber(rounded, locale)} ${unitLabel(unitIndex, locale)}`
}
```

---

## Task 1 (PR1): the shell — `ui`/`layout`/`crm`/`archive`, navigation, dashboards, admin-guard

**Files:**

- Modify (the full list with the number of candidate lines, `grep -cP '[А-Яа-яЁё]'`, product files without tests):

| File                                                    | Cyr. lines | Pattern(s)                                         | Note                                                               |
| ------------------------------------------------------- | ---------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `components/layout/notifications-bell.tsx`              | 66         | B, C, F (date-fns→Intl)                            | `date-fns/locale/ru` → `formatRelativeTime` (new, see Step 3)      |
| `components/archive/ArchiveConfirmDialog.tsx`           | 59         | B, D, E                                            | The most expensive file — Step 6, separately                       |
| `routes/_authenticated/index.tsx`                       | 52         | B, C                                               | Role-dependent dashboard render                                    |
| `components/crm/nav-sidebar.tsx`                        | 44         | A, B, C                                            | `NAV_ITEMS` — Step 2                                               |
| `routing/components/SeniorDashboard.tsx`                | 32         | B, C, F                                            | `fmtUsd` on `en-US` → `formatMoney`                                |
| `routing/components/EarningsStatsBlock.tsx`             | 32         | B, F                                               | `RU_MONTHS`/`ruMonthYear` → `Intl.DateTimeFormat` via `formatDate` |
| `routing/components/DropDashboard.tsx`                  | 32         | B, C, D, F                                         | «Начислений: N» — plural                                           |
| `routing/components/DropBalanceCard.tsx`                | 24         | B, D, F                                            | COPY-H-core-1 (the debt direction) — Step 4                        |
| `routing/components/AccountantDashboard.tsx`            | 24         | B, F                                               | COPY-H-core-3 («Валидация выплат» → «приходи»)                     |
| `routing/components/PendingProjectApprovalsPanel.tsx`   | 20         | B                                                  | —                                                                  |
| `routing/components/InProgressPanel.tsx`                | 17         | B                                                  | —                                                                  |
| `routes/_authenticated/admin/tos.new.tsx`               | 16         | B, C                                               | —                                                                  |
| `routing/components/HRDashboard.tsx`                    | 15         | B                                                  | —                                                                  |
| `routing/components/EarningsSparkline.tsx`              | 15         | B, D, F                                            | `MONTH_ABBR` → `formatDate`; «Нет данных за период» COPY-L-core-25 |
| `routes/_authenticated/admin/login-as.tsx`              | 12         | A (ROLE_LABEL_MESSAGES), B                         | COPY-M-core-12 (the text references the banner caption verbatim)   |
| `components/ui/image-upload-field.tsx`                  | 12         | B, C                                               | COPY-M-core-11 — MIME/limit from `DOCUMENT_MAX_BYTES`              |
| `components/admin/TosPdfPreview.tsx`                    | 11         | B, C                                               | The 429 text — Step 5 (dedup with PR3)                             |
| `routes/_authenticated/admin/tos.index.tsx`             | 9          | B                                                  | —                                                                  |
| `routes/_authenticated/admin/route.tsx`                 | 9          | C                                                  | COPY-M-core-18 — Step 4                                            |
| `components/archive/CascadeUnarchiveModal.tsx`          | 9          | B                                                  | —                                                                  |
| `routes/_authenticated/route.tsx`                       | 8          | B                                                  | —                                                                  |
| `components/ui/upload-progress.tsx`                     | 8          | B, C                                               | —                                                                  |
| `routes/_authenticated/routing.tsx`                     | 7          | B                                                  | —                                                                  |
| `components/ui/role-select.tsx`                         | 7          | A                                                  | Canon — Step 2                                                     |
| `components/ui/share-slider.tsx`                        | 6          | A, E                                               | COPY-M-core-10 — its own local map, case                           |
| `components/archive/ArchivePendingTransactionsList.tsx` | 5          | B, F                                               | `formatPeriod` — COPY-M-core-13                                    |
| `components/ui/amount-currency-input.tsx`               | 4          | C, F                                               | `uk-UA` → `formatMoney`                                            |
| `components/layout/ImpersonationBanner.tsx`             | 4          | A (replace `ROLE_LABELS[...]` with `useRoleLabel`) | —                                                                  |
| `components/ui/tech-autocomplete-input.tsx`             | 3          | C                                                  | COPY-M-core-5, `aria-label` concatenation                          |
| `components/ui/phone-input.tsx`                         | 3          | C                                                  | —                                                                  |
| `components/ui/crm-dialog.tsx`                          | 3          | B                                                  | —                                                                  |
| `components/ui/command.tsx`                             | 2          | B                                                  | —                                                                  |
| `components/ui/calendar.tsx`                            | 2          | A, F                                               | `MONTHS_SHORT`/`MONTHS_FULL` → `Intl.DateTimeFormat` months        |
| `components/ui/segmented-toggle.tsx`                    | 1          | B                                                  | —                                                                  |
| `components/ui/dialog.tsx`                              | 1          | B                                                  | —                                                                  |
| `components/ui/date-picker.tsx`                         | 1          | B                                                  | —                                                                  |
| `public/site.webmanifest`                               | —          | static                                             | COPY-M-core-14 — Step 7                                            |

- Test (update the existing ones, text from the `uk` catalog instead of a literal): `components/crm/__tests__/nav-sidebar.test.tsx`, `components/crm/__tests__/nav-sidebar.route-access.test.tsx`, `components/layout/__tests__/{ImpersonationBanner.spec.tsx,notifications-bell.footer-link.test.tsx,notifications-bell.render.test.tsx}`, `components/ui/__tests__/{date-picker,tech-autocomplete-input,amount-currency-input,upload-progress}.test.tsx`, `components/archive/__tests__/ArchivePendingTransactionsList.test.tsx`, `routing/components/__tests__/{AccountantDashboard,DropBalanceCard,DropDashboard,EarningsSparkline,HRDashboard,PendingProjectApprovalsPanel,SeniorDashboard}.test.tsx`, `routes/_authenticated/admin/__tests__/login-as.spec.tsx`.
- E2E (`grep -l` over Cyrillic in files covering the affected routes — some assertions hit text outside wave (a) and are NOT touched, see Step 8): `apps/e2e/tests/navigation.spec.ts`, `apps/e2e/tests/dashboard-russian-strings.spec.ts`, `apps/e2e/tests/accountant-dashboard.spec.ts`, `apps/e2e/tests/hr-dashboard.spec.ts`, `apps/e2e/tests/drop-routing-hub.spec.ts`, `apps/e2e/tests/auth.spec.ts` (partly — nav text on the page after login).

**Interfaces:**

- Consumes: `formatDate`, `formatNumber`, `formatMoney`, `compareNames`, `type Locale` from `@crm/shared` (stage 2, Task 2); `useLocale()` from `@/lib/i18n` (stage 2, Task 6); `activateLocale` is not used here directly.
- Produces: `formatRelativeTime(value: Date | string, locale: Locale): string` — added to `packages/shared/src/i18n/format.ts` by this PR (the only extension of the shared package in wave a; used by PR1 and, in the future, by wave (e) for `notifications`/`/pending`). `ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor>` + `useRoleLabel(role: Role): string` from `@/components/ui/role-select` — the new canon for JSX; the **old** `ROLE_LABELS: Record<Role, string>` remains exported UNCHANGED (see "Danger" below) for consumers outside wave (a). `loadCatalog(locale): Promise<void>` + `I18nTestProvider` from `apps/web/app/test/i18n.tsx`, `loadMessages(locale): Promise<Record<string,string>>` from `apps/e2e/fixtures/catalog.ts` — the catalog test helpers (SPEC-H-1, see "Test access to the catalog"); PR2/PR3 import them, do not redefine.

### Danger: `ROLE_LABELS` — a shared export, part of the consumers outside wave (a)

`role-select.tsx`'s `ROLE_LABELS: Record<Role, string>` is imported by **10 files**, of which only 2 (`ImpersonationBanner.tsx`, `role-select.tsx` itself) are in this wave's perimeter. The other eight — `components/user-profile/{UserProfileHeader,tabs/TeamTab,contract/ContractTab}.tsx`, `components/users/{constants.ts,UserRow.tsx,UserDialog.tsx}`, `routes/_authenticated/{projects/$projectId.tsx,admin/{contracts.index,contracts.$role}.tsx,team/$teamId.tsx,users/index.tsx}`, `routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx` — belong to waves (b)/(c), which are not written yet. If the **type** of `ROLE_LABELS` is changed to `Record<Role, MessageDescriptor>`, all eight break on typecheck (`{ROLE_LABELS[role]}` in JSX expects a `ReactNode`-compatible string, gets an object) and at runtime show `[object Object]`.

**Solution — Template A with a transitional duplicate, not a replacement:** `ROLE_LABEL_MESSAGES` + `useRoleLabel()` — a NEW export. `ROLE_LABELS` stays as is (Russian, eager) until waves (b)/(c) translate their eight consumers to `useRoleLabel()` — then `ROLE_LABELS` is removed as a separate task of that wave. This wave touches **only** its two files (`role-select.tsx` — the `<SelectItem>` render itself, `ImpersonationBanner.tsx` — `const roleName = ...`).

- [ ] **Step 1: Test for `useRoleLabel` (fails)**

```tsx
// apps/web/app/components/ui/__tests__/role-select.locale.test.tsx (a new file)
// The catalog — via `loadCatalog`/`I18nTestProvider` (see "Test access to the
// catalog", SPEC-H-1) — the only working path, not `@crm/shared/i18n/...`.
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { useRoleLabel } from '../role-select'

describe('useRoleLabel', () => {
  it('translates ADMIN per active locale', async () => {
    await loadCatalog('uk')
    const { result: uk } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
    expect(uk.current).toBe('Адміністратор')
    await loadCatalog('en')
    const { result: en } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
    expect(en.current).toBe('Admin')
  })
  it('leaves the legacy ROLE_LABELS export untouched (type: string) for not-yet-migrated consumers', async () => {
    const { ROLE_LABELS } = await import('../role-select')
    expect(typeof ROLE_LABELS.ADMIN).toBe('string')
  })
})
```

- [ ] **Step 2: Run → FAIL, then implement `role-select.tsx` + `nav-sidebar.tsx`**

Run: `pnpm --filter @crm/web test -- role-select.locale.test.tsx` → FAIL (`useRoleLabel` is not exported).

`role-select.tsx`: add `ROLE_LABEL_MESSAGES`/`useRoleLabel` per Template A (the code above in "Migration templates"); switch `RoleSelect`'s `<SelectItem>` to `useRoleLabel(role)`; the `ariaLabel` default (`'Роль'`) → `t`\`Роль\` via `useLingui()`.

`nav-sidebar.tsx`: `NAV_ITEMS` → `label: MessageDescriptor` (Template A, a `msg` per caption — «Мій проект», «Легенда», «Дашборд», «Чекають рішення», «Користувачі», «Адмін», «Команда», «Проєкти», «Фінанси», «Статистика», «Співбесіди», «Документи», «Вакансії», «Профіль»); in the `.map()` where the items are rendered — `i18n._(item.label)` via `useLingui()`. Two `aria-label="Основная навигация"` → Template C (`t`\`Основна навігація\`); `aria-label={collapsed ? 'Развернуть' : 'Свернуть'}` → `t`\`Розгорнути\`/`t`\`Згорнути\`.

- [ ] **Step 3: `formatRelativeTime` + `notifications-bell.tsx`**

```ts
// packages/shared/src/i18n/format.ts — add
export function formatRelativeTime(value: Date | string, locale: Locale): string {
  const d = typeof value === 'string' ? new Date(value) : value
  const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: 'auto' })
  const abs = Math.abs(diffSeconds)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  for (const [unit, secondsPerUnit] of units) {
    if (abs >= secondsPerUnit || unit === 'second') {
      return rtf.format(Math.round(diffSeconds / secondsPerUnit), unit)
    }
  }
  return rtf.format(0, 'second')
}
```

```ts
// packages/shared/src/i18n/format.spec.ts — add a case
it('formatRelativeTime renders "X minutes ago" per locale', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
  expect(formatRelativeTime(fiveMinAgo, 'en')).toBe('5 minutes ago')
})
```

`notifications-bell.tsx`: remove `import { formatDistanceToNow } from 'date-fns'` and `import { ru } from 'date-fns/locale'`; replace the call with `formatRelativeTime(iso, locale)` (the locale — `useLocale()` from `@/lib/i18n`). The rest of the JSX strings — Template B/C.

- [ ] **Step 4: `DropBalanceCard.tsx` (COPY-H-core-1) and `admin/route.tsx` (COPY-M-core-18)**

`DropBalanceCard.tsx`: the caption «Долг компании» → `<Trans>Ви маєте сплатити компанії</Trans>`, the hint → `<Trans>Підтверджені прибутки, які ви ще не перерахували</Trans>` — the debt direction fixed per the finding, not just translated verbatim. «начисление»/«начисления» (COPY-M-core-6, a word from `_Избегать_`) → `<Trans>Зобов'язання</Trans>` + Template D for the number.

`admin/route.tsx`:

```tsx
// was: toast.error('Доступ только для ADMIN')
import { useLingui } from '@lingui/react/macro'
// inside the guard component:
const { t } = useLingui()
const roleLabel = useRoleLabel('ADMIN') // from '@/components/ui/role-select'
toast.error(t`Розділ доступний лише для ролі «${roleLabel}»`)
```

- [ ] **Step 5: `TosPdfPreview.tsx` — the 429 text, canon with PR3**

COPY-M-core-16: `TosPdfPreview.tsx` and `lib/axios-utils.ts` (`STATUS_MESSAGES[429]`) talk about 429 with two different phrases. The canon lives in PR3 (Task 3, `axios-utils.ts` — this is the file responsible for status codes). Here, in PR1: `TosPdfPreview.tsx` gets ITS OWN `msg` descriptor with the final text now (PR1 lands first), and PR3 (Task 3, Step 2) on migrating `STATUS_MESSAGES[429]` **must** take the same text verbatim (not reinvent it) — checked by `grep` in Step 2 of Task 3.

```tsx
// TosPdfPreview.tsx
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
const RATE_LIMIT_MESSAGE = msg`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз.`
// in the component:
const { i18n } = useLingui()
if (getAxiosStatus(err) === 429) toast.error(i18n._(RATE_LIMIT_MESSAGE))
```

- [ ] **Step 6: `ArchiveConfirmDialog.tsx` — the most expensive file (Templates B, D, E; fix-round 1, SPEC-H-2)**

`ROLE_RU: Record<string, string>` (genitive case, no `DROP` key — a bug, `.SENIOR` is read for DROP too) → remove, replace with pointwise `<Trans>`/`select` at the use place (Template E) — DROP gets ITS OWN form, not someone else's. The `roleGenitive` ternary → `select` (Template E).

`renderImpactText`'s numbers → `<Plural>` (Template D) instead of bare `{n}`/`{n ?? 0}`, since the surrounding text
in uk must decline («0 проєктів» / «1 проєкт» / «2 проєкти» / «5 проєктів» — 4 forms, not 2
English ones). The full list — all branches of `renderImpactText`, the fields verified against `origin/main`
(`packages/shared/src/schemas/projects.ts`, `archiveImpactSchema`, `git grep -n
'teamsCount\|projectsCount\|juniorsAffected\|hrAccountantsOnTeam\|membersAffected\|activeMembersCount'
origin/main -- packages/shared`) — each field exists exactly in the `renderImpactText` branch where
it is already used on `origin/main` (the types of `archiveImpactSchema`'s discriminated union by `type:
'user'|'team'|'project'` — the fields are NOT interchangeable between branches):

| `renderImpactText` branch            | `impact` field(s)                                         | What is pluralized                                                                                            |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `type==='user'`, role SENIOR/DROP    | `projectsCount`, `hrAccountantsOnTeam`, `juniorsAffected` | «N проєктів», «N HR/бухгалтерів», «N джунів»                                                                  |
| `type==='user'`, role HR             | `teamsCount`                                              | «N команд» — **closes COPY-M-core-5** («убран из 1 команд»)                                                   |
| `type==='user'`, role ACCOUNTANT     | `teamsCount`                                              | the same field, a second render branch                                                                        |
| `type==='user'`, role JUNIOR         | `projectsCount`                                           | «N активних проєктів»                                                                                         |
| `type==='team'`, `teamType==='DROP'` | `projectsCount`, `membersAffected`                        | «N проєктів», «N HR/бухгалтерів»                                                                              |
| `type==='team'`, default (SENIOR)    | `projectsCount`, `membersAffected`                        | the same, a second branch                                                                                     |
| `type==='project'`                   | `activeMembersCount`                                      | «N активних джунів» — **closes COPY-M-core-5** (the second occurrence of the same finding, a separate branch) |

The original Step 6 edition listed only the first table row (the SENIOR/DROP branch) and declared it
the one closing COPY-M-core-5 — but both audit quotes for this file («убран из 1 команд», «1 активных
джунов будут отвязаны») lie in OTHER branches (`teamsCount` of HR/ACCOUNTANT, `activeMembersCount` of
`project`), which the original list did not mention at all.

The rest of the file's JSX concatenations — the same technique (`<Trans>` with slots `{impact.teamName}`, etc., modeled on
`renderImpactText` — do not rewrite the branching logic, only the text nodes).

- [ ] **Step 7: `site.webmanifest`**

```json
{
  "name": "CRM CheekyCheeseIT",
  "short_name": "CRM CheekyCheeseIT",
  "description": "Робочий простір команди: проєкти, фінанси, документи",
  "lang": "uk",
  ...
}
```

The manifest — static JSON, not React; there is nowhere to embed an `en` localization yet (the PWA manifest does not reload on a language change at runtime) — leave the Ukrainian text with an explicit `lang: "uk"` (was: no product text, no `lang` at all) and record this as a technical limitation in the PR body, not an incomplete migration.

- [ ] **Step 8: E2E — a pointwise check, not the whole file**

For each file from the E2E list above: `grep -n '[А-Яа-яЁё]'` → for lines referencing text **migrated** in this PR (navigation, dashboards, admin-guard), replace the literal with an import from the compiled `uk` catalog:

```ts
// apps/e2e/tests/navigation.spec.ts — was
await expect(page.getByRole('link', { name: 'Дашборд' })).toBeVisible()
// became — the catalog via the fixture (see "Test access to the catalog", SPEC-H-1),
// not the bare specifier '@crm/shared/i18n/...' (does not resolve in apps/e2e at all)
import { loadMessages } from '../fixtures/catalog'
// the id found in advance: pnpm i18n:extract, then
// grep -B2 'msgstr "Дашборд"' packages/shared/src/i18n/locales/uk/messages.po
const uk = await loadMessages('uk')
await expect(
  page.getByRole('link', { name: uk['<the id from lingui extract for "Дашборд">'] }),
).toBeVisible()
```

Lines referencing NOT-yet-migrated pages (`/finance`, `/projects` content, not just the header in nav) — **do not touch**, they will remain red until the corresponding wave only if they actually check migrated text; otherwise they are green on Russian now and stay that way.

- [ ] **Step 9: Run, gates, commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales  # idempotency
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
pnpm --filter @crm/shared test -- src/i18n/format.spec.ts
DATABASE_URL= pnpm --filter @crm/e2e test -- navigation dashboard-russian-strings accountant-dashboard hr-dashboard drop-routing-hub auth
pnpm mutation:changed
# An explicit list (git-policy.md — do NOT add whole directories, so as not to
# sweep up someone else's debug artifacts from the worktree). Product files — 36 from
# the table above (the 37th, site.webmanifest, separately) + the new role-select.locale.test.tsx
# + the two new catalog test helpers (SPEC-H-1, used by PR2/PR3 too):
git add \
  apps/web/app/test/i18n.tsx \
  apps/e2e/fixtures/catalog.ts \
  apps/web/app/components/layout/notifications-bell.tsx \
  apps/web/app/components/archive/ArchiveConfirmDialog.tsx \
  apps/web/app/components/archive/CascadeUnarchiveModal.tsx \
  apps/web/app/components/archive/ArchivePendingTransactionsList.tsx \
  apps/web/app/routes/_authenticated/index.tsx \
  apps/web/app/routes/_authenticated/route.tsx \
  apps/web/app/routes/_authenticated/routing.tsx \
  apps/web/app/routes/_authenticated/routing/components/SeniorDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/EarningsStatsBlock.tsx \
  apps/web/app/routes/_authenticated/routing/components/DropDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/DropBalanceCard.tsx \
  apps/web/app/routes/_authenticated/routing/components/AccountantDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/PendingProjectApprovalsPanel.tsx \
  apps/web/app/routes/_authenticated/routing/components/InProgressPanel.tsx \
  apps/web/app/routes/_authenticated/routing/components/HRDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/EarningsSparkline.tsx \
  apps/web/app/routes/_authenticated/admin/tos.new.tsx \
  apps/web/app/routes/_authenticated/admin/tos.index.tsx \
  apps/web/app/routes/_authenticated/admin/route.tsx \
  apps/web/app/routes/_authenticated/admin/login-as.tsx \
  apps/web/app/components/crm/nav-sidebar.tsx \
  apps/web/app/components/ui/image-upload-field.tsx \
  apps/web/app/components/admin/TosPdfPreview.tsx \
  apps/web/app/components/ui/upload-progress.tsx \
  apps/web/app/components/ui/role-select.tsx \
  apps/web/app/components/ui/share-slider.tsx \
  apps/web/app/components/ui/amount-currency-input.tsx \
  apps/web/app/components/layout/ImpersonationBanner.tsx \
  apps/web/app/components/ui/tech-autocomplete-input.tsx \
  apps/web/app/components/ui/phone-input.tsx \
  apps/web/app/components/ui/crm-dialog.tsx \
  apps/web/app/components/ui/command.tsx \
  apps/web/app/components/ui/calendar.tsx \
  apps/web/app/components/ui/segmented-toggle.tsx \
  apps/web/app/components/ui/dialog.tsx \
  apps/web/app/components/ui/date-picker.tsx \
  apps/web/app/router.tsx \
  apps/web/public/site.webmanifest \
  apps/web/app/components/ui/__tests__/role-select.locale.test.tsx \
  apps/web/app/components/crm/__tests__/nav-sidebar.test.tsx \
  apps/web/app/components/crm/__tests__/nav-sidebar.route-access.test.tsx \
  apps/web/app/components/layout/__tests__/ImpersonationBanner.spec.tsx \
  apps/web/app/components/layout/__tests__/notifications-bell.footer-link.test.tsx \
  apps/web/app/components/layout/__tests__/notifications-bell.render.test.tsx \
  apps/web/app/components/ui/__tests__/date-picker.test.tsx \
  apps/web/app/components/ui/__tests__/tech-autocomplete-input.test.tsx \
  apps/web/app/components/ui/__tests__/amount-currency-input.test.tsx \
  apps/web/app/components/ui/__tests__/upload-progress.test.tsx \
  apps/web/app/components/archive/__tests__/ArchivePendingTransactionsList.test.tsx \
  apps/web/app/routes/_authenticated/admin/__tests__/login-as.spec.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/AccountantDashboard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/DropBalanceCard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/DropDashboard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/EarningsSparkline.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/HRDashboard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/PendingProjectApprovalsPanel.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/SeniorDashboard.test.tsx \
  packages/shared/src/i18n/format.ts \
  packages/shared/src/i18n/format.spec.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/navigation.spec.ts \
  apps/e2e/tests/dashboard-russian-strings.spec.ts \
  apps/e2e/tests/accountant-dashboard.spec.ts \
  apps/e2e/tests/hr-dashboard.spec.ts \
  apps/e2e/tests/drop-routing-hub.spec.ts \
  apps/e2e/tests/auth.spec.ts
git commit -m "$(cat <<'EOF'
feat(web,shared,i18n): stage 3a wave (a) part 1 — shell, nav, dashboards, admin guard to uk/en

ac_verified: n/a (see task file AC list)
EOF
)"
```

Design tier 2 (editing an existing screen): screenshots 320/1440 for nav-sidebar (collapsed/expanded), each of the five dashboards, the admin-guard toast, ArchiveConfirmDialog — in `uk` and `en`. The `copy-reviewer` verdict on both languages separately (`Copy Review: PASS|ISSUES|BLOCK`).

---

## Task 2 (PR2): `lib`/`hooks` — formatting, sorting, plural forms

**Files:**

| File                              | Cyr. lines | Pattern(s) | Note                                                                                                                                                                        |
| --------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/use-user-profile.ts`       | 50         | B, C       | COPY-M-core-8 — a "tail" in a variable, Step 4                                                                                                                              |
| `lib/pwa-runtime-caching.ts`      | 36         | —          | **Comments only, no visible text** — checked `grep` over quotes, 0 matches. Do NOT migrate, skip                                                                            |
| `hooks/use-document-blob.ts`      | 31         | —          | Also comments only — skip                                                                                                                                                   |
| `lib/format-bytes.ts`             | 8          | F          | `formatBytes(bytes, locale)` — Step 2                                                                                                                                       |
| `hooks/use-vacancies.ts`          | 10         | B, C       | Common toasts (not vacancy content — that's in wave c)                                                                                                                      |
| `hooks/use-documents.ts`          | 10         | B, C       | Common toasts (not document content — that's in wave e)                                                                                                                     |
| `hooks/use-archive.ts`            | 9          | B, C       | —                                                                                                                                                                           |
| `hooks/use-credentials.ts`        | 8          | B, C       | COPY-M-core-8 — Step 4                                                                                                                                                      |
| `lib/notification-type-icon.tsx`  | 7          | B          | A common helper, not the notifications themselves                                                                                                                           |
| `hooks/use-legend.ts`             | 4          | B, C       | COPY-M-core-8 — Step 4                                                                                                                                                      |
| `lib/documents-filter-sort.ts`    | 6          | A          | `SORT_OPTION_MESSAGES` the new canon, `SORT_OPTIONS` legacy unchanged — Step 3, a transitional shim (`compareNames` already migrated in stage 2, Task 8)                    |
| `hooks/use-senior-resume.ts`      | 6          | B, C       | —                                                                                                                                                                           |
| `hooks/use-project-approvals.ts`  | 6          | B, C       | —                                                                                                                                                                           |
| `hooks/use-pending-items.ts`      | 6          | B, C       | —                                                                                                                                                                           |
| `lib/invoice-labels.ts`           | 5          | A          | COPY-H-core-4 — Step 5, dedup with `ArchivePendingTransactionsList.TYPE_LABEL` (PR1, already merged)                                                                        |
| `hooks/use-job-sourcing.ts`       | 5          | B, C       | —                                                                                                                                                                           |
| `lib/format-amount.ts`            | 2          | F          | `formatAmount`/`formatAmountUsd` → `formatMoney` — Step 2                                                                                                                   |
| `hooks/use-invoices.ts`           | 2          | B          | COPY-M-core-7 — «Инвойс» → «Рахунок»                                                                                                                                        |
| `hooks/use-admin-summary.ts`      | 2          | B, C       | —                                                                                                                                                                           |
| `hooks/use-active-team.ts`        | 2          | B, C       | —                                                                                                                                                                           |
| `hooks/use-accountant-summary.ts` | 2          | B, C       | —                                                                                                                                                                           |
| `hooks/use-senior-summary.ts`     | 1          | B, C       | —                                                                                                                                                                           |
| `hooks/use-hr-summary.ts`         | 1          | B, C       | —                                                                                                                                                                           |
| `lib/route-access.ts`             | 59         | —          | **All 59 lines — JSDoc comments, 0 user-visible text** (confirmed by the audit, lines 150–152: «route-access.ts — 59 Cyrillic lines and zero user-visible»). Do NOT migrate |
| `lib/use-logout.ts`               | 10         | —          | Comments only — skip                                                                                                                                                        |

- Test: update `documents-filter-sort.spec.ts` (labels), `hooks/__tests__/use-invoices.test.ts`, `hooks/__tests__/use-notification-preferences.test.tsx` (if it references the toast text of the use-hooks), `lib/format-bytes.test.ts`, add `lib/format-amount.spec.ts` (the file is currently without a test — new).
- E2E: `apps/e2e/tests/crm/documents-search-sort.spec.ts` (16 Cyrillic lines — sort labels).

**Interfaces:**

- Consumes: `formatMoney`, `formatNumber`, `compareNames`, `type Locale`, `useLocale()` (already exist).
- Produces: `formatBytes(bytes: number, locale: Locale): string` (the signature changes — a mandatory `locale` is added; all 6 calls over `apps/web` are updated in the same PR, `grep -rn 'formatBytes('`), `SORT_OPTION_MESSAGES: Array<{ value: SortKey; label: MessageDescriptor }>` — a NEW canon (Template A with a transitional shim, fix-round 1 SPEC-H-3, the same grounds as `ROLE_LABEL_MESSAGES` in Task 1); the legacy `SORT_OPTIONS: Array<{ value: SortKey; label: string }>` remains exported UNCHANGED (see Step 3) until the migration of its only consumer (`documents.tsx`, wave e). `useInvoiceTypeLabel(type: InvoiceTypeForLabel): string` — a NEW hook in `invoice-labels.ts` (Template A); the legacy `getInvoiceTypeLabel(type): string` remains UNCHANGED (see "Danger" in Step 5 — the same grounds as `ROLE_LABELS` in Task 1).

- [ ] **Step 1: Test `formatBytes` with the locale (fails)**

```ts
// apps/web/app/lib/format-bytes.test.ts
import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
  it('formats with locale-appropriate decimal separator and unit', () => {
    expect(formatBytes(2_345_678, 'uk')).toBe('2,2 МБ')
    expect(formatBytes(2_345_678, 'en')).toBe('2.2 MB')
  })
  it('uses English unit abbreviations for en', () => {
    expect(formatBytes(1024, 'en')).toBe('1.0 KB')
  })
})
```

- [ ] **Step 2: Run → FAIL, implement `formatBytes` + `format-amount.ts`**

```ts
// apps/web/app/lib/format-bytes.ts
import { formatNumber, type Locale } from '@crm/shared'

const UNITS: Record<Locale, readonly string[]> = {
  uk: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'],
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
}

export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `0 ${UNITS[locale][0]}`
  if (bytes < 1024) return `${bytes} ${UNITS[locale][0]}`

  const units = UNITS[locale]
  let value = bytes / 1024
  let unitIndex = 1

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = Math.round(value * 10) / 10
  return `${formatNumber(rounded, locale)} ${units[unitIndex]}`
}
```

`format-amount.ts`: `formatAmount(amount)` (was `ru-RU`) and `formatAmountUsd(amount)` (was `en-US`) rewritten via `formatMoney(amount, currency, locale)` from `@crm/shared`, adding a `locale: Locale` parameter to each function; update all calls (`grep -rln "formatAmount\|formatAmountUsd" apps/web/app` — the PR1 dashboards already migrate their calls there too in Task 1 Step, here — only the function definitions and the calls outside the PR1 files).

- [ ] **Step 3: `documents-filter-sort.ts` — `SORT_OPTIONS` (fix-round 1, SPEC-H-3 — Template A, a transitional shim)**

**Danger — the same as `ROLE_LABELS` in Task 1 and `getInvoiceTypeLabel` in Step 5:** the only current consumer of `SORT_OPTIONS` — `routes/_authenticated/documents.tsx:514`
(`{opt.label}`, rendered directly as JSX text inside `<SelectItem>`) — belongs to wave (e), this
wave does not touch it. Changing the type of `label` to `MessageDescriptor` (an ordinary object `{id, message}`) without
migrating the consumer does not "show `[object Object]`", but **throws** `Error: Objects are not valid as a
React child` — a crash of the whole "Documents" page for the entire interval between the merge of PR2 and the merge of wave (e).
The solution — the same technique, not a new one: the legacy `SORT_OPTIONS` is not touched, the new canon — a separate
export.

```ts
// apps/web/app/lib/documents-filter-sort.ts
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

// Legacy — UNCHANGED (the type, the values, the alphabet letters in the labels) until
// `documents.tsx` (wave e) switches to SORT_OPTION_MESSAGES below
// and removes this export as a separate task of that wave.
export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'date_desc', label: 'Сначала новые' },
  { value: 'date_asc', label: 'Сначала старые' },
  { value: 'name_asc', label: 'Имя: А-Я' },
  { value: 'name_desc', label: 'Имя: Я-А' },
  { value: 'size_desc', label: 'Размер: больше' },
  { value: 'size_asc', label: 'Размер: меньше' },
]

/** The new canon (Template A) — closes COPY-M-core-15 (the alphabet letters in the
 *  labels named the Russian collation and would become a lie in en) NOW, without
 *  risk to production: `documents.tsx` (wave e) will switch to
 *  `i18n._(opt.label)` in its PR; until then it renders the legacy `SORT_OPTIONS`
 *  above, as today. */
export const SORT_OPTION_MESSAGES: Array<{ value: SortKey; label: MessageDescriptor }> = [
  { value: 'date_desc', label: msg`Спочатку нові` },
  { value: 'date_asc', label: msg`Спочатку старі` },
  { value: 'name_asc', label: msg`За ім'ям: за зростанням` },
  { value: 'name_desc', label: msg`За ім'ям: за спаданням` },
  { value: 'size_desc', label: msg`Розмір: більше` },
  { value: 'size_asc', label: msg`Розмір: менше` },
]
```

`documents-filter-sort.ts` remains in the wave (a) perimeter — the file lies in `lib/`, adding a NEW
export to it does not require touching `documents.tsx` (wave e); moving the file whole into wave (e) is
not needed — the `sortDocuments`/`compareNames` use in it is already migrated in stage 2 and remains a
working part of PR2 independently of `SORT_OPTION_MESSAGES`.

- [ ] **Step 4: `use-credentials.ts`, `use-documents.ts`, `use-legend.ts`, `use-user-profile.ts` — a unified error toast pattern**

COPY-M-core-8: 14 occurrences of ``toast.error(`Ошибка: ${e.message}`)`` in these 4 files. `e.message` after the interceptor (`axios.ts`) is already a human-readable phrase — the «Ошибка: » prefix is redundant, and which action failed — is not said.

```ts
// was (use-credentials.ts, 4 similar places)
onError: (e) => toast.error(`Ошибка: ${e.message}`)

// became — pattern C, the action is named by the calling code
import { useLingui } from '@lingui/react/macro'
// inside the hook factory or the component that uses the mutation:
const { t } = useLingui()
onError: (e: Error) => toast.error(t`Не вдалося зберегти пароль: ${e.message}`)
```

Each of the 14 places gets its own action name («Не вдалося зберегти пароль» / «Не вдалося видалити документ» / etc.) by the context of the specific mutation — not one common text for all.

- [ ] **Step 5: `invoice-labels.ts` — dedup with archive (COPY-H-core-4), the legacy export kept**

`ArchivePendingTransactionsList.tsx` (PR1, already merged) holds its own `TYPE_LABEL` with `SENIOR_INCOME: 'Доход синьора (неоплаченная доля)'`; `invoice-labels.ts` — `SENIOR_INCOME: 'Выплата синьора'`. One enum — two texts, «выплата» in a forbidden place.

**Danger — the same as `ROLE_LABELS` in Task 1:** `getInvoiceTypeLabel(type): string` (the current export of `invoice-labels.ts`) is imported by `components/invoices/invoice-card.tsx` and `components/invoices/invoice-detail-dialog.tsx` (`git grep -rn getInvoiceTypeLabel apps/web/app`) — this is `web-finance` (wave d, audit line 415), NOT wave (a). Changing the signature of `getInvoiceTypeLabel` would break typecheck and the render in these two files several waves before their own migration. The solution — Template A with a transitional duplicate: a new `useInvoiceTypeLabel()` for the wave (a) consumers, the legacy `getInvoiceTypeLabel` is not touched.

```ts
// apps/web/app/lib/invoice-labels.ts
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'

const INVOICE_TYPE_MESSAGES: Record<InvoiceTypeForLabel, MessageDescriptor> = {
  SENIOR_INCOME: msg`Дохід синьйора`,
  SALARY: msg`Зарплата`,
}

/** The new canon for the wave (a)+ consumers; the legacy `getInvoiceTypeLabel` (below,
 *  unchanged) serves `components/invoices/**` (wave d) until their migration. */
export function useInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  const { i18n } = useLingui()
  return i18n._(INVOICE_TYPE_MESSAGES[type])
}

export function getInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  if (type === 'SENIOR_INCOME') return 'Выплата синьора'
  if (type === 'SALARY') return 'Зарплата'
  return type
}
```

`ArchivePendingTransactionsList.tsx` (PR1, landing first) on the first pass gets ITS OWN `TYPE_LABEL` text «Дохід синьйора» already agreed verbatim with the `INVOICE_TYPE_MESSAGES` of this Step (the same technique as the 429 text in Task 1 Step 5 — PR1 fixes the text canon in advance, PR2 on introducing `useInvoiceTypeLabel` takes it verbatim, checked by `grep` at the PR2 review); replacing the local `TYPE_LABEL` in `ArchivePendingTransactionsList.tsx` with an import of `useInvoiceTypeLabel` — a task of the wave where `components/invoices/**` is migrated as a whole (wave d), so as not to leave the hook with a single consumer half-migrated.

- [ ] **Step 6: Run, gates, commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- documents-search-sort
pnpm mutation:changed
# An explicit list — 20 migrating files from the Task 2 table (the comment-only
# files route-access.ts/use-document-blob.ts/use-logout.ts/pwa-runtime-caching.ts
# are not included — their code did not change):
git add \
  apps/web/app/hooks/use-user-profile.ts \
  apps/web/app/lib/format-bytes.ts \
  apps/web/app/lib/format-bytes.test.ts \
  apps/web/app/hooks/use-vacancies.ts \
  apps/web/app/hooks/use-documents.ts \
  apps/web/app/hooks/use-archive.ts \
  apps/web/app/hooks/use-credentials.ts \
  apps/web/app/hooks/use-legend.ts \
  apps/web/app/lib/notification-type-icon.tsx \
  apps/web/app/lib/documents-filter-sort.ts \
  apps/web/app/lib/documents-filter-sort.spec.ts \
  apps/web/app/hooks/use-senior-resume.ts \
  apps/web/app/hooks/use-project-approvals.ts \
  apps/web/app/hooks/use-pending-items.ts \
  apps/web/app/lib/invoice-labels.ts \
  apps/web/app/hooks/use-job-sourcing.ts \
  apps/web/app/lib/format-amount.ts \
  apps/web/app/lib/format-amount.spec.ts \
  apps/web/app/hooks/use-invoices.ts \
  apps/web/app/hooks/__tests__/use-invoices.test.ts \
  apps/web/app/hooks/use-admin-summary.ts \
  apps/web/app/hooks/use-active-team.ts \
  apps/web/app/hooks/use-accountant-summary.ts \
  apps/web/app/hooks/use-senior-summary.ts \
  apps/web/app/hooks/use-hr-summary.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/crm/documents-search-sort.spec.ts
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3a wave (a) part 2 — lib/hooks formatting, sort labels, error toasts to uk/en

ac_verified: n/a (see task file AC list)
EOF
)"
```

Design tier 2: screenshots of the toasts (credentials/documents/legend/profile errors) and the sort dropdown at 320/1440, `uk`+`en`. `copy-reviewer` on both languages.

---

## Task 3 (PR3): login, `__root`, errors, `ErrorBoundary`

**Files:**

| File                              | Cyr. lines        | Pattern(s) | Note                                                                           |
| --------------------------------- | ----------------- | ---------- | ------------------------------------------------------------------------------ |
| `routes/login.tsx`                | 27                | A          | `ERROR_MESSAGES` — Step 1                                                      |
| `lib/axios-utils.ts`              | 17                | A, B       | `STATUS_MESSAGES` + fallbacks — Step 2                                         |
| `lib/telemetry/ErrorBoundary.tsx` | 6                 | B          | A real fallback UI, the only visible text in `telemetry/**`                    |
| `client.tsx`                      | 37                | —          | Comments only (SW/PWA reload logic) — skip, checked `grep` over quotes         |
| `lib/axios.ts`                    | 0                 | —          | No Cyrillic at all — do not touch                                              |
| `routes/__root.tsx`               | 0                 | —          | No Cyrillic — only verify the `I18nProvider` wrapper (already done in stage 2) |
| `index.html`                      | 0 (after stage 2) | —          | `lang="uk"` already set by Task 6 of stage 2 — only a regression check         |

`lib/telemetry/{transport,form-abandon,error-dedupe,batcher,use-visibility-flush,state,validate-events,use-click-delegation,route-duration,config}.ts`, `lib/{preload-reload,sw-reload,use-logout}.ts`, `hooks/use-document-blob.ts`, `lib/pwa-runtime-caching.ts` — **all checked `grep -noP` over quoted strings with Cyrillic: zero real string literals**, only JSDoc comments (spec quotes, algorithm explanations). These files — **outside the extraction perimeter**; ESLint `lingui/no-unlocalized-strings` does not touch them (the rule looks at JSX text and string literals in UI code, not comments).

- Test: `lib/telemetry/ErrorBoundary.test.tsx` (already exists — update the assertions), `routes/__tests__/login.search-schema.spec.ts` (see Step 1 — it holds per-code mutation pins on the former Russian literals of `ERROR_MESSAGES`).
- E2E: `apps/e2e/tests/auth.spec.ts` (3 Cyrillic lines — the `?error=` codes from `ERROR_MESSAGES`, finishing what PR1 Step 8 left).

**Interfaces:**

- Consumes: `useLingui`, `i18n` (the global one, from `@/lib/i18n`).
- Produces: `ERROR_MESSAGES: Record<string, MessageDescriptor>` (the type changes from `Record<string,string>`; `ERROR_CODES = Object.keys(ERROR_MESSAGES)` — works unchanged, the keys do not change); the canonical 429 text (see Task 1 Step 5) in `STATUS_MESSAGES`.

- [ ] **Step 1: `login.tsx` — `ERROR_MESSAGES`**

```tsx
// apps/web/app/routes/login.tsx
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

export const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
  unauthorized: msg`Ваш email не авторизовано. Зверніться до адміністратора.`,
  google_error: msg`Помилка Google OAuth. Спробуйте ще раз.`,
  invalid_state: msg`Сесія закінчилася. Спробуйте ще раз, будь ласка.`,
  invite_email_mismatch: msg`Ви увійшли в інший акаунт Google. Відкрийте посилання з листа ще раз і виберіть акаунт тієї адреси, на яку воно прийшло. Якщо акаунта Google на цій адресі немає — увійти по ньому не можна, напишіть адміністратору.`,
  invite_expired: msg`Термін дії запрошення закінчився. Попросіть адміністратора надіслати його ще раз.`,
  invite_used: msg`Запрошення вже використано — особисту адресу підтверджено. Увійдіть через Google кнопкою нижче.`,
  invite_invalid: msg`Посилання не працює. Відкрийте посилання з останнього листа, а якщо його немає — попросіть адміністратора надіслати запрошення ще раз.`,
  invite_account_taken: msg`Цей акаунт Google вже використовується для входу з іншої адреси. Зверніться до адміністратора.`,
  account_mismatch: msg`Ця адреса вже прив'язана до іншого акаунта Google. Увійдіть тим акаунтом, яким входили раніше, або напишіть адміністратору.`,
  account_disabled: msg`Доступ до CRM закрито. Якщо це помилка, напишіть адміністратору.`,
} as const satisfies Record<string, MessageDescriptor>

const ERROR_CODES = Object.keys(ERROR_MESSAGES) as [string, ...string[]]
```

The render place (the component showing `ERROR_MESSAGES[code]` next to `AlertCircle`) switches to `i18n._(ERROR_MESSAGES[code])` via `useLingui()`.

`routes/__tests__/login.search-schema.spec.ts` pins each `ERROR_MESSAGES` code with a separate mutation test (the `StringLiteral` mutation — see the comment in `login.tsx`, PR #623). These tests checked the RUSSIAN text directly as a literal — after Step 1 there are no more text literals in `ERROR_MESSAGES` (they are `msg` descriptors), so the pin tests switch to checking the **keys** (`Object.keys(ERROR_MESSAGES)` contains exactly these 10 codes — the code list itself, not their text, is what the mutation can spoil) plus ONE new test "each code resolves to a non-empty string via `i18n._()` on both locales" (closes the same observable behavior that the 10 separate string pins gave before, without copying the text into the test — the text lives only in the `.po` catalog).

- [ ] **Step 2: `axios-utils.ts` — `STATUS_MESSAGES` + unification of the fallbacks (COPY-L-core-22, COPY-M-core-16)**

```ts
// apps/web/app/lib/axios-utils.ts
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

const STATUS_MESSAGES: Readonly<Record<number, MessageDescriptor>> = {
  400: msg`Некоректний запит. Перевірте введені дані і спробуйте знову.`,
  401: msg`Потрібно увійти в систему знову.`,
  403: msg`Недостатньо прав для цієї дії.`,
  404: msg`Запитувані дані не знайдено.`,
  409: msg`Конфлікт даних. Оновіть сторінку і спробуйте знову.`,
  413: msg`Файл занадто великий.`,
  415: msg`Формат файлу не підтримується.`,
  // The 429 canon — the same text as TosPdfPreview.tsx got in PR1 Step 5:
  // "Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз." — verify verbatim.
  429: msg`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз.`,
}

const SERVER_ERROR_MESSAGE = msg`Помилка на нашій стороні. Ми вже знаємо про проблему — спробуйте трохи пізніше.`
const GENERIC_HTTP_FALLBACK = msg`Не вдалося виконати запит. Спробуйте ще раз.`
const NETWORK_ERROR_MESSAGE = msg`Немає зв'язку із сервером. Перевірте підключення до інтернету і спробуйте знову.`
// COPY-L-core-22: there were TWO different last-resort texts
// (getApiErrorMessage's default param 'Произошла ошибка' vs
// UNKNOWN_ERROR_FALLBACK 'Произошла ошибка. Попробуйте ещё раз.') —
// now the same text in both places.
const UNKNOWN_ERROR_FALLBACK = msg`Сталася помилка. Спробуйте ще раз.`

function messageForStatus(status: number, i18n: I18n): string {
  const known = STATUS_MESSAGES[status]
  if (known !== undefined) return i18n._(known)
  if (status >= 500) return i18n._(SERVER_ERROR_MESSAGE)
  return i18n._(GENERIC_HTTP_FALLBACK)
}
```

`getApiErrorMessage(err, fallback = i18n._(UNKNOWN_ERROR_FALLBACK))` — the default is no longer the hardcode `'Произошла ошибка'`, it uses `UNKNOWN_ERROR_FALLBACK` (the same text as the last resort of `getUserFacingErrorMessage`); `getUserFacingErrorMessage`, `messageForStatus` accept `i18n` from the global `@/lib/i18n` import (not via `useLingui()` — this pair of functions is already called outside React components, from the `axios.ts` interceptor, so the only correct source is the global singleton instance `i18n`, the same one `activateLocale` activates).

- [ ] **Step 3: `ErrorBoundary.tsx`**

```tsx
// apps/web/app/lib/telemetry/ErrorBoundary.tsx — the fallback UI (was Russian)
import { Trans } from '@lingui/react/macro'
// in the render() fallback branch of the ErrorBoundary class component:
;<Trans>Щось пішло не так. Оновіть сторінку.</Trans>
```

The class component (a React `ErrorBoundary` cannot be functional, `useLingui()` is unavailable) — `<Trans>` works in class components too (it is a JSX macro, not a hook), so pattern B applies directly without a wrapper.

- [ ] **Step 4: Run, gates, commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- auth
pnpm mutation:changed
git add \
  apps/web/app/routes/login.tsx \
  apps/web/app/routes/__tests__/login.search-schema.spec.ts \
  apps/web/app/lib/axios-utils.ts \
  apps/web/app/lib/axios-utils.spec.ts \
  apps/web/app/lib/telemetry/ErrorBoundary.tsx \
  apps/web/app/lib/telemetry/ErrorBoundary.test.tsx \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/auth.spec.ts
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3a wave (a) part 3 — login errors, HTTP status messages, error boundary to uk/en

ac_verified: n/a (see task file AC list)
EOF
)"
```

Design tier 2: screenshots of the login page with each `?error=` code, the error boundary fallback, at 320/1440, `uk`+`en`. `copy-reviewer` on both languages. **The final wave (a) check:** `git grep -n "includes('" apps/web/app` finds no branchings by error text inside the wave's perimeter (audit §4, the second check item); `git grep -c '[А-Яа-яЁё]'` over all 69 analyzed files of the wave, minus the files marked "comments only" in the Task 1–3 tables, gives 0.

---

## Replacing `ru-RU`/`en-US`/`uk-UA`/`date-fns/locale/ru` — the full list from the audit and where it moves

The audit (table B, web-core) names "9 places" of a fixed money/number locale + "4 arrays" of months + "1 date-fns/ru" in this slice. In total 14 points in 12 files — all below, with the PR indicated:

| #   | File                                                    | What was                                                                                          | Replaced with                                                                             | PR  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --- |
| 1   | `components/ui/calendar.tsx`                            | `MONTHS_SHORT` (by hand)                                                                          | `Intl.DateTimeFormat(locale, {month:'short'})` a loop over 12 months                      | PR1 |
| 2   | `components/ui/calendar.tsx`                            | `MONTHS_FULL` (by hand)                                                                           | `Intl.DateTimeFormat(locale, {month:'long'})`                                             | PR1 |
| 3   | `routing/components/EarningsSparkline.tsx`              | `MONTH_ABBR` (by hand)                                                                            | `formatDate(d, locale, 'short')` on the 1st of the month                                  | PR1 |
| 4   | `routing/components/EarningsStatsBlock.tsx`             | `RU_MONTHS` + `ruMonthYear` (by hand, nominative)                                                 | `formatDate(d, locale, 'long')`                                                           | PR1 |
| 5   | `lib/format-amount.ts`                                  | `formatAmount` → `toLocaleString('ru-RU')`                                                        | `formatMoney(amount, 'UAH', locale)`                                                      | PR2 |
| 6   | `lib/format-amount.ts`                                  | `formatAmountUsd` → `toLocaleString('en-US')`                                                     | `formatMoney(amount, 'USD', locale)`                                                      | PR2 |
| 7   | `routing/components/AccountantDashboard.tsx`            | an own `fmtUsd` on `en-US`                                                                        | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 8   | `routing/components/DropBalanceCard.tsx`                | an own `fmtUsd` on `en-US`                                                                        | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 9   | `routing/components/DropDashboard.tsx`                  | an own `fmtUsd` on `en-US`                                                                        | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 10  | `routing/components/SeniorDashboard.tsx`                | an own `fmtUsd` on `en-US`                                                                        | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 11  | `components/ui/amount-currency-input.tsx`               | `toLocaleString('uk-UA')`                                                                         | `formatMoney`/`formatNumber(…, locale)`                                                   | PR1 |
| 12  | `components/archive/ArchivePendingTransactionsList.tsx` | `formatPeriod` → `toLocaleDateString('ru-RU')` (COPY-M-core-13, mixed with the raw `salaryMonth`) | `formatDate(d, locale, 'long')` for both branches (salary and date) — one format, not two | PR1 |
| 13  | `lib/format-bytes.ts`                                   | `toLocaleString('ru-RU')` + Cyrillic units                                                        | `formatNumber(rounded, locale)` + `UNITS[locale]` (Task 2 Step 2)                         | PR2 |
| 14  | `components/layout/notifications-bell.tsx`              | `date-fns/locale/ru` + `formatDistanceToNow`                                                      | `formatRelativeTime(iso, locale)` (Task 1 Step 3, a new function in `format.ts`)          | PR1 |

`documents-filter-sort.ts`'s `localeCompare(…, 'ru')` — **already replaced** in stage 2 (Task 8, `compareNames(locale)`), not in this list again.

---

## What is NOT included

- **Waves (b)–(e)** entirely: `web-people` (team, profile, `UserDialog.tsx` ~2,500 lines, contracts), `web-projects` (projects, interviews, vacancy content), `web-finance` (finance, `EXPENSE_CATEGORIES`, statistics, invoices), `web-docs-notify` (document content, notifications, the `/pending` page, notification routing). Their files are **not edited**, even when they contain duplicate maps (the `ROLE_LABELS` consumers outside the wave — see "Danger" in Task 1).
- **`apps/api`**, **`packages/shared`** (except the one `format.ts` extension — `formatRelativeTime`) — stage 4 of the spec.
- **Invoice PDFs** — stage 5.
- **`ESLint` error mode, the guard for Russian letters, the final `extract --clean` as a hard gate** — stage 6 (`lingui/no-unlocalized-strings` stays `warn` throughout stage 3).
- **`share-slider.tsx`'s own ROLE_LABELS `.side` map** — touched (COPY-M-core-10, pattern E, the case aligned), but NOT merged with the `role-select.tsx` canon (a different data shape — a `side`/`aria` pair, not a simple label); merging — not this wave's task.
- **`components/user-profile/**`, `components/users/**`, `routes/_authenticated/{team,users,profile,projects,finance,interviews,vacancies,documents,stats,pending,onboarding,admin/{contracts.*,wallet.index,ChangeWalletAddressDialog}}.tsx`** — waves (b)/(c)/(d)/(e), the ROLE_LABELS consumers among them remain on the legacy export until their wave. `documents.tsx` (wave e) — the same case for `SORT_OPTIONS`/`SORT_OPTION_MESSAGES` (fix-round 1 SPEC-H-3, Assumption 7): the toolbar switches to the new canon in its wave, not this one.
- **`LanguageSection.tsx`** (the language switcher in the profile, stage 2 Task 7) — not confirmed merged at the time of this plan (not found on `origin/main`); if not yet merged by the time of execution — it does not block this wave, both are independent.

---

## Assumptions (A1 — reversible, recorded)

1. **The wave (a) perimeter is adjusted** relative to the assignment's literal grep command (an over-match on `_authenticated/**` due to the missing `$` anchor) in favor of the intersection of the `web-core` audit + §7 of the spec: `components/crm/**`, `components/archive/**`, `routing/components/**` (dashboards), `admin/{route,login-as,tos.*}.tsx`, `client.tsx` added; all files `_authenticated/{finance,interviews,projects,vacancies,team,users,profile,documents,stats,pending,onboarding}/**` excluded.
2. **`ROLE_LABELS` (legacy, `Record<Role,string>`) is not removed or renamed** in this wave — eight consumers outside the perimeter would break on typecheck. The new canon `ROLE_LABEL_MESSAGES`/`useRoleLabel()` — an addition, not a replacement; removing the legacy — a task of wave (b)/(c), when the last external consumer migrates. **The same technique and for the same reason** — for `getInvoiceTypeLabel`/`useInvoiceTypeLabel` in `invoice-labels.ts` (Task 2, Step 5): `components/invoices/**` (wave d) stays on the legacy export.
3. **`formatBytes`, `formatAmount`, `formatAmountUsd`, `getInvoiceTypeLabel` change their signature** (a mandatory `locale`/`i18n` parameter) — all calls inside the wave's perimeter are updated in the same PR; no calls outside the perimeter were found at audit time (`grep -rln`, checked above), but the implementer should re-check this right before Step 2 of each task (the code may have changed between planning and execution).
4. **Comment-only files** (`route-access.ts`, `use-document-blob.ts`, `use-logout.ts`, `client.tsx`, `preload-reload.ts`, `pwa-runtime-caching.ts`, `sw-reload.ts`, most of `telemetry/**`) are excluded from migration by the fact of the check (`grep -noP` over quotes with Cyrillic — zero matches), not skipped by oversight. ESLint `no-unlocalized-strings` does not flag them, since the rule looks at UI JSX/string literals, not comments.
5. **`site.webmanifest` stays single-language (uk)** — the PWA manifest does not reload on a language change at browser runtime, a second `en` manifest is not introduced within this wave; recorded as a technical limitation, not an incomplete migration.
6. **The 429 text and the `SENIOR_INCOME` text** — one canon each, established by the FIRST PR that touches it (PR1 lands first); the second PR takes the ready text verbatim (checked by `grep` at the second PR's review), instead of centralizing into a common module — no new common file is created for two texts.
7. **`SORT_OPTIONS`** in `documents-filter-sort.ts` (PR2, fix-round 1 SPEC-H-3) does NOT change the export type — the only current consumer (`documents.tsx:514`, `{opt.label}` as JSX text) belongs to wave (e) and would render a `MessageDescriptor` directly as a React child, which is not a cosmetic issue («`[object Object]`»), but a thrown exception (`Error: Objects are not valid as a React child`) and a crash of the whole "Documents" page for the entire interval until wave (e) — weeks. The same Template A with a transitional shim as `ROLE_LABEL_MESSAGES`/`useRoleLabel` in Task 1 is applied: the legacy `SORT_OPTIONS: Array<{value, label: string}>` stays UNCHANGED (the alphabet letters in the labels too), the new canon `SORT_OPTION_MESSAGES: Array<{value, label: MessageDescriptor}>` closes COPY-M-core-15 at once, `documents.tsx` switches to it in its wave (e) PR and the legacy is removed then. The file stays in the wave (a) perimeter whole (it lies in `lib/`, `sortDocuments`/`compareNames` are already migrated in stage 2) — moving it into wave (e) is not needed, there is no regression for production at all (not "temporary", but none).

## Questions for the owner (A2)

None. All of this wave's forks — file boundaries, transitional shims and the PR order — are reversible (a docs-only plan, nothing is deployed) and do not touch money/RBAC/prod-data/external publication; classified A1 above.

---

## Wave (a) readiness check

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — green after each PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` on the affected shards — green.
- `pnpm i18n:extract` twice in a row — the second run does not change `.po`.
- `pnpm mutation:changed` — without new `Survived`/`NoCoverage` without explanation (see `mutation-gate-integration-specs.md` — a `NoCoverage` with an integration-hint is allowed, without — not).
- `git grep -c '[А-Яа-яЁё]'` over all product files of the wave (69 analyzed, 61 actually migrate — "comments only" do not count) — 0.
- `copy-reviewer`: `PASS` on `uk` and on `en` for each of the 3 PRs.
- Screenshots 320/1440, `uk`+`en`, for each migrated screen — in each PR's body.
