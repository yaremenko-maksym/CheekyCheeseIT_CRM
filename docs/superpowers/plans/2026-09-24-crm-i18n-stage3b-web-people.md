# CRM i18n — stage 3, wave (b) "web-people" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate to `uk`/`en` everything in the CRM that concerns people: onboarding, the profile (shell, tabs, admin actions, self-edit, the employee contract), the user list and the creation wizard, teams, user archival and the senior résumé. Three PRs, the product files do not overlap, no Russian text remains in the migrated files, and both legacy role dictionaries (`ROLE_LABELS` in `role-select.tsx` and in `components/users/constants.ts`) are removed, because after the wave they have no consumers left.

**Architecture:** The same single catalog `packages/shared/src/i18n/locales/{uk,en}/messages.po` and the same templates A–F as in wave (a) (`docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`, the "Migration templates" section). Three things are new in this wave. First — **moving consumers from the old dictionaries to the canons** that are already in `main`: roles via `ROLE_LABEL_MESSAGES`/`useRoleLabel` (3a PR1), server errors and "log in as" texts via `API_ERROR_MESSAGES` (stage 4), Zod messages via `translateZodCode`/`translateZodMessage` (stage 4). Second — **one text for the impact of a user archival** instead of two: the user block from `components/archive/ArchiveConfirmDialog.tsx` is moved out to `components/archive/UserArchiveImpact.tsx`, and both dialogs render it. Third — **the table of canonical term forms of wave (b)** (the section below). PR1 and PR2 go in parallel, so both take the words from it, not invent their own.

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`), already set up in stage 2. React 18, Vite 6, Vitest 4, TanStack Router, Tailwind v4, shadcn/ui, `eslint-plugin-lingui` 0.16.0 (`warn`), Playwright, Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §5 (gates), §7 item 3 (wave b: "team, users, profile, onboarding"), §8 (tests). Audit: `docs/architecture/2026-09-19-crm-i18n-audit.md`, the `web-people` slice (30 findings, `Findings:` at the end of the slice) and the cross-cutting themes §1–§2. A format sample and templates A–F: the wave (a) plan `docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`.

**Measurement:** all the numbers below were taken by commands on `origin/main` `062af6f8` (#707) 2026-09-24. Before starting each PR the implementer repeats the measurement (step 0 of each task), because #706 will merge between the plan and execution.

## Global Constraints

Apply to each task. Items marked "lesson" are taken from the reviews of PR #700–#707, and each of them already cost a separate review round once.

**Lingui versions and mechanics**

- `@lingui/*` — **5.9.5 EXACT**, a single version (`version-pins.md`). This plan upgrades nothing.
- Source text in the code — **Ukrainian** (`sourceLocale: 'uk'`). English is written by the same coder in the same PR as a second original (skill `copywriting` §5, owner decision #7). The default interface is `uk`, the second language is `en`.
- At the module level — only `msg`. `t`, `plural` and `select` at the module level are forbidden: the string freezes on import. In a component `t`/`i18n` are taken from `useLingui()` (`@lingui/react/macro`).
- **Lesson (#700): the `plural()` macro is incompatible with Stryker.** Under instrumentation `#` is not substituted. For numbers in JSX — the `<Plural>` component; outside JSX — `msg` with an ICU string and `i18n._(descriptor, { count })`. Do not use the call `t\`${plural(...)}\``.
- **Lesson (#707): `as const satisfies Record<…, MessageDescriptor>` on a map of `msg` templates disables Stryker for the whole block** (0 mutants). Write `satisfies Record<…>` without `as const`. If the gate shows 0 mutants in a file that definitely has `msg`, the cause is this.
- `i18n._()` accepts only an **expression**: `i18n._(API_ERROR_MESSAGES.X)` or `i18n._(MAP[key])`. An object literal with a spread (`i18n._({ ...d, values })`) breaks `lingui extract` (details in the comment to `translateApiError` in `apps/web/app/lib/axios-utils.ts`).
- **Lesson (#707): for records with an explicit id (`api-error.*`, `zod-error.*`) the `msgstr` is edited by hand in both `.po`.** `i18n:extract` does not overwrite an existing `msgstr`. This wave does not change texts with an explicit id. If such an edit is needed, it is a separate line in the PR's "Assumptions" and a manual edit of both `.po`.

**Texts (`CONTEXT.md` → "`uk`/`en` forms" + the canon table below)**

- The apostrophe — `’` (U+2019), not `'` and not `ʼ`. The ellipsis — `…` (U+2026), not `...` (audit COPY-L-ppl-1: in the slice 23 lines with `...` against 21 with `…`). Quotes: in `uk` guillemets `«…»`, in `en` typographic `“…”`.
- Roles are written in words from the glossary: `uk` — «адміністратор», «сеньйор», «джуніор», «HR», «бухгалтер», «дроп»; `en` — «admin», «senior», «junior», «HR», «accountant», «drop». **`en` for ADMIN — «admin»** (the `CONTEXT.md` glossary and the catalog `Адміністратор → Admin`). If a reviewer references lesson #701 item 4 ("administrator"), answer with the glossary: it is the canon.
- **Lesson (#702, item 13): a raw role enum in visible text is a finding.** After replacing a literal, scan the **whole** file: `grep -nE '\b(ADMIN|SENIOR|JUNIOR|HR|ACCOUNTANT|DROP)\b'` over JSX text, `aria-label`, `title` and `placeholder`. For each screen with a role — a test "no raw enum in the rendered screen". The one exception: `HR` — it is both an enum and a glossary word.
- **Lesson (#702, item 9): substitution of a role into an oblique case breaks `uk`.** A role is substituted only in the nominative («для ролі «Сеньйор»»). If another case is needed — `select` by the role with ready forms, the set of branches of which matches the enum values that actually reach the place (lesson item 8), plus a test that `other` is unreachable.
- A toast and a refusal — **one sentence, no period at the end**, with a verb, and where there is an action, it says "what to do". Telegraphic style («Аватар: документ видалено») is forbidden. One situation — one text: identical states in PR1 and PR2 take the text from the canon table verbatim, then there will be one key in the catalog.
- Field names, API paths, `teamMode=…`, `senior+team`, `cascade` in human-facing text are forbidden (audit COPY-H-ppl-6).
- **Lesson (#701, item 5): check russisms by unicode, not a byte `grep`.** Before each push:

```bash
python3 -c "import re,sys,subprocess;fs=subprocess.run(['git','diff','--name-only','origin/main','--','apps/web/app'],capture_output=True,text=True).stdout.split();[print(f,i,l.strip()) for f in fs if f.endswith(('.ts','.tsx')) for i,l in enumerate(open(f,encoding='utf8'),1) if re.search('[ыЫэЭъЪёЁ]',l) and not re.match(r'\s*(//|\*|\{/\*)',l)]"
```

Strings from this output in files of **your** PR are an incomplete migration. Exceptions — test fixtures with Russian data (people's names from the seed) and comments.

**Tests**

- Anchors — `data-testid` and roles. Text in assertions is taken from the **`uk` catalog**, not a literal:
  - Vitest — `loadCatalog(locale)` and `I18nTestProvider` from `apps/web/app/test/i18n.tsx` (already in `main`);
  - E2E — `loadMessages('uk')` and `assertInCatalog(uk, '<text>')` from `apps/e2e/fixtures/catalog.ts` (already in `main`).
- **Lesson (#700, item 2): the E2E sweep is over the whole `apps/e2e`, not over the specs in the diff.** A regression — any literal of a migrated component in any spec. The procedure and script — "Common step: E2E sweep" below. "Pre-existing" is allowed only if CI on `origin/main` is red on the same spec. If `main` is green, it is a regression.
- **Lesson (#700, item 3): the mutation gate on the full diff is a mandatory AC**, `survived 0`. If a `NoCoverage` has no integration-hint, a unit test closes it (`mutation-gate-integration-specs.md`). A local SKIP on timeout is not a PASS: then `stryker run` directly with `dryRunTimeoutMinutes: 20` and the same config as the gate.
- **Lesson (#699, item 12): each Stryker suppression — with a reason on the same directive line**, no shorter than 12 characters (`// Stryker disable next-line <Mutator>: <reason>`). Before push — `node scripts/devops/check-mutation-suppressions.mjs`: a local `pnpm mutation:changed` does not call it, and CI with it fails all Mutation Gate jobs before even starting.
- Tests are edited by the same coder in the same PR (the AutoTest zone by the file's nature, but editing assertions inside the migrated module is part of the same task, as in wave a). The wave does not introduce new `*.spec.ts` E2E scenarios.

**Process**

- `git add` by an explicit list (each task has one). Push — `DATABASE_URL= git push`, without `--no-verify`. Each commit carries `ac_verified:` with the numbers from the "Acceptance criteria" section of its task.
- **Lesson (#700, item 6): a cadence for 30+ files** — `wip:` commits locally, one push at the end. Pre-push under load flakes, each push takes 5–12 minutes.
- **Lesson (#700, item 5): screenshots and live passes are done with the `npx playwright` script in your own scratchpad**, not via `mcp__playwright__*`: the MCP browser is shared across all parallel agents.
- **Lesson (#704/#707, items 6 and 18): the `.po` conflict on parallel PRs is additive.** Take both sides, then `pnpm i18n:extract` twice, and the second run must give an empty diff. Check by numbers: the number of `msgid` equals `main` plus the PR's new records, and fuzzy, `#-#-#` and empty `msgstr` in `en` — 0. The `.po` merge is not given to haiku.
- **Lesson (#700, item 9): the task file is the only channel of requirements.** In the coder's prompt the orchestrator writes: "all the 'Orchestrator addendum' sections in the task file are part of the assignment".
- After each Edit/Write of `.ts`/`.tsx` — `mcp__eslint__lint-files`. On the lines the wave touches there must be no new `lingui/no-unlocalized-strings` warnings.
- `pnpm i18n:extract` is idempotent: a second consecutive run does not change `.po`. The CI gate "i18n catalogs are in sync" checks this, before push the same is reproduced locally.
- **Lesson (#705, item 15): FM-5 guard-test gate.** The wave **does not touch** `apps/api`. If the implementer still decides to edit a controller from the `guard-test-gate.yml` list, the same PR needs a changed `apps/api/**/*.spec.ts` with a 403 assertion (or the line `guard-test-na: <reason>` in the PR body before push). It is better to carry out such an edit as a separate PR.
- Each PR passes design-gate **Tier 2** (editing existing screens: a ui-ux-designer conformance check, without generation in Claude Design) and fidelity Mode B on all device classes. The `copy-reviewer` verdict — on `uk` and on `en` **separately**. `security-reviewer` is mandatory for all three PRs: they touch the credentials and USDT-wallet forms, shares, user creation with a role, archival and team composition masking (critical-path zones of `pm.md`). The logic there does not change, but the reviewer must verify this, not the author.
- **Responsive AC for each PR:** the screens from the task are checked at 320 and 375 (mobile), 768 (tablet), 1024 and 1280 (laptop), 1440 and 1920 (large) in **both** languages. No horizontal scroll (`document.scrollWidth <= clientWidth`), no label is truncated without `truncate` with `title`, touch targets on mobile are no less than 44×44. Screenshots 320 and 1440 × `uk` and `en` are attached to the PR. Ukrainian is 15–30% longer than English, so 320 in `uk` is the main risk.

---

## Test access to the catalog (helpers already in `main`)

The wave (a) section "Test access to the catalog" is implemented and merged. Here — only how to use it.

```tsx
// Vitest (apps/web) — the real catalog via the same path as in production
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

await loadCatalog('uk')
render(<UserRow user={senior} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Сеньйор')).toBeInTheDocument()

await loadCatalog('en')
render(<UserRow user={senior} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Senior')).toBeInTheDocument()
```

```ts
// E2E (apps/e2e) — `pnpm i18n:compile` is mandatory before a run
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

const uk = await loadMessages('uk')
await page.getByTestId('user-dialog-role-trigger').click()
await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
```

`assertInCatalog` fails with a clear error if the text is not in the catalog: so an outdated literal does not turn into a Playwright timeout. The relative import path depends on the spec's depth: `'../fixtures/catalog'` for `tests/*.spec.ts`, `'../../../fixtures/catalog'` for `tests/crm/<section>/*.spec.ts` (a sample — `crm/team/team-archive.spec.ts`).

---

## Perimeter of wave (b) — how it was obtained

Command (the zone of the `web-people` audit slice):

```bash
git ls-files apps/web/app/components/{users,user-profile,onboarding,job-sourcing} \
  apps/web/app/routes/_authenticated/{team,users,profile,onboarding} \
  | grep -vE '__tests__|\.(spec|test)\.'
```

Result on `062af6f8` — **60 product files** (the audit on `3990a584` counted 59: since then stage 2 added `LanguageSection.tsx`). Cyrillic — 1045 lines, of which 880 outside comments.

Further the perimeter is adjusted. Each deviation — a line in "Assumptions" below.

| What                                                                                                                                                      | Decision           | Why                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/job-sourcing/**` (3 files, 47 lines outside comments)                                                                                        | **exclude**        | Résumé auto-submit is paused by the owner's decision: "do not touch the job-sourcing code, do not introduce new tasks". What to do with the module by stage 6 — the A2 question below |
| `components/user-profile/LanguageSection.tsx`                                                                                                            | **do not migrate** | Stage 2 already wrote it in `uk` (6 lines with Cyrillic — Ukrainian `msg`/`Trans` sources)                                                               |
| `components/user-profile/contract/ContractEditor.tsx`, `users/{ProfileNameLink,UnarchiveButton,UserAvatar,section}.tsx`, `job-sourcing/open-original.ts` | **do not touch**   | 0 Cyrillic                                                                                                                                              |
| `routes/_authenticated/profile/{index,$userId}.tsx`                                                                                                      | **do not migrate** | 1 Cyrillic line each, both — comments                                                                                                                   |
| `components/archive/ArchiveConfirmDialog.tsx`                                                                                                            | **add** (PR2)      | The deferred COPY-L-31/L-32 from #700 live in it; the user block is moved out to a shared component                                                     |
| `components/archive/UserArchiveImpact.tsx`                                                                                                               | **create** (PR2)   | The deferred item 3: one archival-impact text instead of two                                                                                           |
| `components/ui/role-select.tsx`                                                                                                                          | **add** (PR3)      | Removal of the legacy `ROLE_LABELS` after the last consumer is migrated (lesson #700, item 8)                                                           |
| `packages/shared/src/schemas/{contracts,tos,notification-preferences}.ts`                                                                                | **add** (PR1)      | Removal of three Russian `*_IMPERSONATION_MESSAGE`: after PR1 they have no consumers left                                                               |
| `packages/shared/src/i18n/format.ts`                                                                                                                     | **add** (PR3)      | The `'dateTime'` style for `formatResetTime` (the quota reset time — hours and minutes in the local zone are needed; all existing styles — dates in UTC) |
| `CONTEXT.md`                                                                                                                                             | **add** (PR1)      | Lesson #700, item 1: the wave's term forms are entered into the glossary before migrating the files                                                      |

Summary by PR:

| PR      | What                                                                                                                                         | Product files (migrates / analyzed) | Cyrillic lines outside comments |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| **PR1** | Onboarding and profile (shell, tabs, admin actions, self-edit, the employee contract)                                                       | 30 / 30 + 3 shared schemas + `CONTEXT.md`  | 362                              |
| **PR2** | User list, teams, user archival (both dialogs and the shared impact text)                                                                   | 11 / 11 + 1 new                            | 221                              |
| **PR3** | The user wizard (`UserDialog.tsx`), the senior résumé, removing both legacy `ROLE_LABELS`, the `'dateTime'` style, 17 E2E clicks on «Синьор» | 10 / 10 + `format.ts`                      | 244                              |

The sum of migrated lines — 827 of 880. The remaining 53 — `job-sourcing` (47) and `LanguageSection.tsx` (6, already Ukrainian sources). The "lines" column counts lines with Cyrillic outside comments (the `uk` lines of the already-migrated `components/archive/ArchiveConfirmDialog.tsx` are not in the sum).

---

## Parallelism discipline

| Step | What                         | Waits for          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | #706 (3a PR2, `lib`/`hooks`) | —                  | Open. Touches this wave's files: `user-profile/admin-actions/__tests__/{AdminActionsMenu.resend-invite,ArchiveUserDialog}.test.tsx`, `user-profile/tabs/__tests__/{FinanceTab.total-earned,OverviewTab.pending-share}.test.tsx`, E2E `profile-self-edit`, `requisites-warning`, `crm/team/team-archive`, and also `CONTEXT.md`. It also changes `formatAmount`/`formatBytes` (the `locale` parameter)                                                                             |
| 1   | **PR1 ∥ PR2**                | merge of #706      | The product, test and E2E files of PR1 and PR2 do not overlap (checked by a script over text fragments unique to each group: no spec asserts the texts of both groups). The only shared thing — `.po` — an additive conflict (Global Constraints). Identical states («нічого не знайдено», «не вказано») both write verbatim per the canon table — one key                                                                                                                      |
| 2   | **PR3**                      | merge of **PR1 and PR2** | (1) Removal of `role-select.ROLE_LABELS` is possible only after PR1 (`UserProfileHeader`, `ContractTab`, `TeamTab`), removal of `constants.ROLE_LABELS` — only after PR2 (`UserRow`, `users/index.tsx`). (2) The specs `users`, `crm/users/users-refactor`, `drop-add-senior`, `drop-create`, `drop-create-ui-regressions`, `senior-create-default` are edited by both PR2 (badges, filter) and PR3 (wizard). The same with `admin-actions` and `requisites-warning` (PR1 and PR3). Sequentially there are no conflicts |

**E2E spec distribution** (whichever's text a line asserts, that PR edits it; taken with a script, repeat at the sweep step):

| PR  | Specs (lines — on `062af6f8`, for a guide)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | `admin-actions.spec.ts` (the menu item «Заметка админа»), `crm/contract-editor.spec.ts` («Нет шаблона контракта для роли Синьор», «Вернуть подписанный контракт в черновик?», «Остаться»), `crm/mobile-keyboard-attributes.spec.ts` («Реквизиты для выплат»), `crm/senior-resume.spec.ts` (only «Остаться» — the unsaved-changes dialog of `UserProfileShell`), `onboarding-logout.spec.ts` («Выйти»), `profile-self-edit.spec.ts`, `requisites-warning.spec.ts` (except the wizard lines)                                                                                                             |
| PR2 | `crm/team/team-archive.spec.ts`, `crm/users/users-refactor.spec.ts` (the «Синьор» badge in the row, filters), `drop-archive-real.spec.ts`, `drop-archive-user-real.spec.ts`, `drop-archive-cascade.spec.ts`, `drop-rotate-senior.spec.ts`, `polish-regressions.spec.ts`, `team.spec.ts` (31 lines), `users.spec.ts` (the badges «Администратор»/«Синьор», the filter «Все роли»/«Джун»), team and HR-chip lines in `drop-add-senior`, `drop-create`, `drop-create-ui-regressions`, `senior-create-default`                                                                                            |
| PR3 | **17 clicks `getByRole('option', { name: 'Синьор' })` on `user-dialog-role-trigger`** in 5 specs: `users.spec.ts` ×5, `drop-add-senior.spec.ts` ×6, `senior-create-default.spec.ts` ×3, `crm/users/users-refactor.spec.ts` ×2, `drop-create-ui-regressions.spec.ts` ×1. Plus `admin-actions.spec.ts` (the title «Редактировать пользователя», the role trigger «Джун», the toast «Пользователь обновлён»), `drop-duplicate-email.spec.ts` («Дроп создан»), `requisites-warning.spec.ts` (the caption «USDT ERC-20 кошелёк» in the wizard), `crm/senior-resume.spec.ts` («Распознаём резюме»), `crm/create-wizard.spec.ts` |

`cache/anti-stale.spec.ts` (`/^Синьор/`) asserts the caption in the **project** dialog (wave c) — not touched in this wave.

---

## Wave (b) term canon — `uk`/`en`

PR1 moves this table into `CONTEXT.md` (the "`uk`/`en` forms" section, a continuation of wave a) in the first commit. PR2 and PR3 take the words from here verbatim. The "Source" column refers to the audit finding that predetermined the choice.

| Term (rus., for reference)           | `uk`                                                                             | `en`                                                                   | `_Избегать_` in the product                                                                                   | Source                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| User (an account in the CRM)         | користувач                                                                       | user                                                                   | «юзер»                                                                                                        | —                                                                                             |
| Employee (a person in the company)   | співробітник                                                                     | employee                                                               | «працівник» (the catalog already has 21 records with «співробітник»)                                         | catalog `main`                                                                                |
| Profile                              | профіль                                                                          | profile                                                                | —                                                                                                             | —                                                                                             |
| Onboarding                           | онбординг                                                                         | onboarding                                                             | «адаптація», «введення в посаду»                                                                              | —                                                                                             |
| Terms of Service (ToS)               | Умови використання                                                               | Terms of Service                                                       | Latin «Terms of Service» in `uk`; «Умови користування», «Користувацька угода»                                | COPY-H-ppl-2; the catalog already says «умови використання» (`api-error.TOS_ACCEPT_IMPERSONATION`) |
| Legal name                           | юридичне ПІБ                                                                     | legal name                                                             | «ФІО», «display name»                                                                                         | glossary **Legal name**; COPY-H-ppl-7                                                         |
| Name in the CRM (displayed)          | ім’я та прізвище                                                                 | full name                                                              | «display name» in the text                                                                                   | —                                                                                             |
| Payout details                       | реквізити для виплат                                                             | payout details                                                         | «платіжні реквізити», «payment requisites»                                                                    | COPY-M-ppl-10                                                                                 |
| Payout method (`paymentMethodEnum`)  | спосіб виплати                                                                   | payout method                                                          | «спосіб оплати», «метод оплати», «payment method»                                                            | glossary **Payout method**; COPY-M-ppl-10                                                     |
| USDT wallet                          | гаманець USDT (ERC-20)                                                           | USDT wallet (ERC-20)                                                   | «USDT кошельок»                                                                                               | catalog `main` («Гаманець USDT ERC-20»)                                                        |
| RNOKPP                               | РНОКПП                                                                           | tax ID (RNOKPP)                                                        | «ІПН», «ИНН ФОП»                                                                                              | —                                                                                             |
| Archive / restore                    | архівувати / відновити                                                           | archive / restore                                                      | «видалити», «deleted» about archival                                                                          | COPY-H-ppl-8                                                                                  |
| Archive (filter)                     | в архіві                                                                         | archived                                                               | —                                                                                                             | —                                                                                             |
| Admin note                           | нотатка адміністратора                                                           | admin note                                                             | «заметка админа», «коментар»                                                                                  | COPY-H-ppl-3                                                                                  |
| Personal email                       | особистий email                                                                  | personal email                                                         | «особиста адреса» (reads as a postal address; the catalog currently has both variants — PR1 aligns its strings) | catalog `main`                                                                                |
| Contract status `DRAFT`              | чернетка                                                                         | draft                                                                  | —                                                                                                             | glossary **Employee contract**                                                                |
| Contract status `READY_TO_SIGN`      | готовий до підписання                                                            | ready to sign                                                          | «передано на підпис» as a status name                                                                        | audit §1 item 3 (two wordings)                                                               |
| Contract status `SIGNED`             | підписаний                                                                       | signed                                                                 | —                                                                                                             | —                                                                                             |
| Contract status `CANCELLED`          | скасований                                                                       | cancelled                                                              | —                                                                                                             | —                                                                                             |
| Senior résumé                        | резюме                                                                           | CV                                                                     | «resume» (in the `en` interface coincides with the verb "continue")                                          | locale `en-GB` (`INTL_TAG` in `format.ts`)                                                    |
| Empty field value                    | не вказано                                                                       | not set                                                                | «—» without text, «Не указано»/«не указано» intermixed, «Заметок нет»                                        | COPY-L-ppl-4                                                                                  |
| A filter found nothing               | Нічого не знайдено — скиньте фільтри                                             | No matches — clear the filters                                         | «Нет данных», «Пользователи не найдены», «Нет доступных пользователей»                                       | COPY-M-ppl-14                                                                                 |
| No access to a profile               | Немає доступу до профілю — якщо він потрібен для роботи, напишіть адміністратору | No access to this profile — if you need it for work, write to an admin | two texts for one case                                                                                       | COPY-M-ppl-7                                                                                  |
| Full-name example (placeholder)      | Іваненко Іван Іванович                                                           | Ivan Ivanenko                                                          | «Иванов Иван Иванович»                                                                                        | COPY-M-ppl-13                                                                                 |
| FOP registration address example     | м. Київ, вул. Хрещатик, 1                                                        | 1 Khreshchatyk St, Kyiv                                                | «г. Киев, ул. Крещатик, 1»                                                                                    | COPY-M-ppl-13                                                                                 |
| Bank example                         | ПриватБанк                                                                       | PrivatBank                                                             | —                                                                                                             | COPY-M-ppl-13                                                                                 |
| Technologies field hint              | Почніть вводити: React, Node.js…                                                 | Start typing: React, Node.js…                                          | «Начните вводить, например: Re...»                                                                           | COPY-M-ppl-13                                                                                 |

---

## Migration templates

**A–F — the same as in wave (a)** (`docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`, the "Migration templates" section): A — module constant → `msg` + `i18n._()` in the render; B — JSX text → `<Trans>`; C — attribute or imperative string → `t` from `useLingui()`; D — number → `<Plural>` (in this wave **component only**, see the Stryker lesson); E — gender form by role → `select`; F — date, money, number → `@crm/shared` `format.ts`.

New in this wave:

**G. Text that already exists in the catalog by code — via the catalog, not via a Russian constant from `@crm/shared`.**

```tsx
// was (SignContractStep.tsx; same in AcceptTosStep.tsx and NotificationSettingsTab.tsx)
import { CONTRACT_SIGN_IMPERSONATION_MESSAGE } from '@crm/shared'
const IMPERSONATION_EXPLANATION = `${CONTRACT_SIGN_IMPERSONATION_MESSAGE}.`
// …
{
  IMPERSONATION_EXPLANATION
}

// became — the same text the server returns by the code CONTRACT_SIGN_IMPERSONATION;
// one sentence without a period, the period is not glued on outside (audit, B "Cross-slice imports")
import { API_ERROR_MESSAGES } from '@crm/shared'
import { useLingui } from '@lingui/react/macro'
const { i18n } = useLingui()
// …
{
  i18n._(API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION)
}
```

Zod messages of client schemas — the code `'zod.<CODE>'` from the `ZOD_ERROR_CODES` registry and `translateZodMessage`/`translateZodCode` from `@/lib/axios-utils` (the reference — `ChangePersonalEmailDialog.tsx` and `RejoinTeamDialog.tsx`, which stage 4 already translated). The wave does not introduce a new code into the registry: everything needed exists (`EMAIL_INVALID`, `EMAIL_TOO_LONG`, `DISPLAY_NAME_MIN`, `LEGAL_FULL_NAME_MIN`, `RECIPIENT_NAME_MIN`, `VALIDATION_FAILED_FORM`, `RESUME_TEXT_TOO_SHORT`). If a code is nevertheless needed, it is an edit of `packages/shared/src/schemas/zod-errors.ts` with a manual edit of both `.po` (Global Constraints).

**H. A legacy role-dictionary consumer → `ROLE_LABEL_MESSAGES`.** A single value — the hook, a list — one `useLingui()` per component and `i18n._()` inside `.map()` (a hook cannot be called in `.map()`). The reference — `routes/_authenticated/admin/login-as.tsx`.

```tsx
// was (UserRow.tsx)
import { ROLE_LABELS } from './constants'
<Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>{ROLE_LABELS[user.role]}</Badge>

// became — a single value
import { useRoleLabel } from '@/components/ui/role-select'
const roleLabel = useRoleLabel(user.role)
<Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>{roleLabel}</Badge>

// became — a list (TeamTab, $teamId, users/index, UserDialog)
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
const { i18n } = useLingui()
{members.map((m) => (
  <Badge key={m.id} variant="outline">{i18n._(ROLE_LABEL_MESSAGES[m.role])}</Badge>
))}
```

The `?? user.role` fallback is removed: `Role` is a closed union, and `ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor>` covers all six values. The fallback would print the enum (COPY-H-ppl-4).

**I. E2E assert on migrated text → `assertInCatalog`.**

```ts
// was
await expect(seniorRow.getByText('Синьор')).toBeVisible()
// became
const uk = await loadMessages('uk')
await expect(seniorRow.getByText(assertInCatalog(uk, 'Сеньйор'))).toBeVisible()
```

If the element has a `data-testid` and the text is not the subject of the check, better anchor by testid without text.

---

## Common step: E2E sweep (performed in each PR before push)

The script collects the Russian fragments that **this PR removed** and searches for them across the whole `apps/e2e`. Each hit — a line to check. If the fragment remained in another not-yet-migrated component and a spec asserts exactly it, do not touch the line. If the spec asserts a migrated screen, move the line to template I.

```bash
SCRATCH="${TMPDIR:-/tmp}/wave-b-$(git rev-parse --abbrev-ref HEAD | tr / -)"   # own directory: name from your branch, not a shared path
mkdir -p "$SCRATCH"
git diff origin/main -- apps/web/app > "$SCRATCH/wave-b.diff"
```

```python
# $SCRATCH/e2e_sweep.py — python3 e2e_sweep.py <path-to-wave-b.diff>
import re, sys, pathlib
ru = re.compile(r'[А-Яа-яЁё]')
frag = re.compile(r"""['"`]([^'"`\n]*[А-Яа-яЁё][^'"`\n]*)['"`]|>\s*([^<>{}\n]*[А-Яа-яЁё][^<>{}\n]*?)\s*(?:<|\{|$)|^-\s+([А-Яа-яЁё][^<>{}\n]*?)\s*(?:<|\{|$)""")
removed = set()
for line in open(sys.argv[1], encoding='utf8'):
    if line.startswith('-') and not line.startswith('---') and ru.search(line) \
            and not re.match(r'^-\s*(//|\*|\{/\*)', line):
        for m in frag.finditer(line):
            text = next(g for g in m.groups() if g).strip()
            if len(text) >= 4 and ru.search(text):
                removed.add(text)
for spec in sorted(pathlib.Path('apps/e2e').rglob('*.ts')):
    for n, line in enumerate(spec.read_text(encoding='utf8').splitlines(), 1):
        if re.match(r'^\s*(//|\*)', line):
            continue
        hits = [t for t in removed if t in line]
        if hits:
            print(f'{spec}:{n}: {hits[0]!r}')
```

```bash
python3 "$SCRATCH/e2e_sweep.py" "$SCRATCH/wave-b.diff" > "$SCRATCH/sweep.txt"
cut -d: -f1 "$SCRATCH/sweep.txt" | sort -u > "$SCRATCH/sweep-specs.txt"   # list for git add
```

The whole output goes into the PR body (the "E2E sweep" section) with a mark on each line: "moved to the catalog", "testid" or "not our text — <which component outside the wave renders it>". A line without a mark is unclosed. The specs enter the commit via `git add $(cat "$SCRATCH/sweep-specs.txt")`: for files without changes this is a no-op.

---

## Task 1 (PR1): onboarding and profile

**Files:**

Product (`apps/web/app/`, Cyrillic on `062af6f8`: total / outside comments):

| File                                                                  | Cyr. lines | Pattern(s) | Audit findings / note                                                                                                                                     |
| --------------------------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/user-profile/tabs/OverviewTab.tsx`                        | 55 / 51    | B, C, D, F | COPY-H-ppl-2 (the ToS card), H-3 («Заметка администратора», «Админ увидит причину»), M-10, M-12, L-4; the ToS acceptance date — `formatDate(…, 'short')`   |
| `components/onboarding/SignContractStep.tsx`                          | 30 / 23    | B, C, G    | COPY-H-ppl-7 (the hint), L-2 (`PREVIEW`), L-5 (the file name), gendered «ознакомился»; **the deferred item 4** — the COPY-M-15/16 banners from #702 (Step 4) |
| `components/user-profile/AvatarUploadDialog.tsx`                      | 29 / 29    | B, C, F    | COPY-M-ppl-8 (KB vs MB) — `formatBytes(bytes, locale)` after #706                                                                                          |
| `components/user-profile/UserProfileShell.tsx`                        | 28 / 24    | B, C       | COPY-H-ppl-8 («был удалён»), M-7 (two 403 texts), the «Остаться» dialog                                                                                    |
| `components/user-profile/self-edit/RequisitesEditForm.tsx`            | 26 / 26    | B, C, G    | COPY-M-ppl-10, M-11 («SENIOR и ADMIN» ×2), M-13 (the full-name example)                                                                                    |
| `components/user-profile/tabs/NotificationSettingsTab.tsx`            | 78 / 26    | A, B, C, G | The "log in as" banner — `API_ERROR_MESSAGES.NOTIFICATION_PREFERENCES_IMPERSONATION`; `'Новый тип'`; type titles — see "Danger: `NOTIFICATION_TITLES`"     |
| `components/user-profile/tabs/FinanceTab.tsx`                         | 25 / 22    | B, C, F    | COPY-H-ppl-9 (the «Всего заработано» card), M-5 (an unreachable branch), M-14; `TYPE_OPTIONS`/`STATUS_OPTIONS` — see "Danger: finance maps"               |
| `components/user-profile/contract/ContractPdfPreview.tsx`             | 16 / 15    | B, C       | COPY-L-ppl-5 (the file name)                                                                                                                               |
| `components/user-profile/contract/ContractFillForm.tsx`               | 15 / 15    | B, C       | —                                                                                                                                                         |
| `components/user-profile/contract/ContractActionBar.tsx`              | 14 / 14    | B, C       | Statuses — the canon table                                                                                                                                |
| `components/user-profile/contract/ContractTab.tsx`                    | 14 / 14    | A, B, H    | COPY-H-ppl-5 — `ROLE_LABELS[targetRole]` → `useRoleLabel`; `STATUS_LABELS`, `FROZEN_BANNERS` → `msg`                                                       |
| `components/onboarding/AcceptTosStep.tsx`                             | 14 / 9     | B, C, G    | COPY-H-ppl-2 («Terms of Service» ×7 → «Умови використання»), L-1 («Принятие...»)                                                                           |
| `components/user-profile/tabs/RequisitesTab.tsx`                      | 13 / 13    | B          | COPY-M-ppl-10, L-4                                                                                                                                         |
| `components/user-profile/UserProfileHeader.tsx`                       | 10 / 6     | B, F, H    | `ROLE_LABELS` → `useRoleLabel`; «Зарегистрирован» (gender) → «Дата реєстрації»; `toLocaleDateString('ru-RU')` → `formatDate(…, 'long')`                    |
| `routes/_authenticated/onboarding/index.tsx`                          | 9 / 9      | B, C       | —                                                                                                                                                         |
| `components/user-profile/admin-actions/AdminActionsMenu.tsx`          | 11 / 7     | A, B       | COPY-H-ppl-3 («Заметка админа»)                                                                                                                            |
| `components/user-profile/contract/useEmployeeContract.ts`             | 9 / 5      | C          | Five concatenations `` `Не удалось сохранить контракт: ${msg}` `` — the concatenation with the server text goes away, the server text comes from `getApiErrorMessage` |
| `components/user-profile/ProfileCredentialsSection.tsx`               | 8 / 8      | B, C       | «Нет доступа» — the canon table                                                                                                                           |
| `components/user-profile/admin-actions/ChangePersonalEmailDialog.tsx` | 22 / 8     | C, G       | Zod already on codes (stage 4); the remainder — captions and toasts                                                                                       |
| `components/user-profile/tabs/ProjectsTab.tsx`                        | 7 / 7      | B, F       | Two `toLocaleDateString('ru-RU')` → `formatDate`                                                                                                           |
| `components/user-profile/admin-actions/AdminNoteDialog.tsx`           | 6 / 6      | B, C       | COPY-H-ppl-3                                                                                                                                               |
| `components/onboarding/ContractWaitScreen.tsx`                        | 5 / 4      | B          | COPY-M-ppl-15 («15 секунд»), H-3 («Администратор заполнит»)                                                                                                |
| `components/user-profile/self-edit/ProfileEditFields.tsx`             | 5 / 5      | B, C       | COPY-M-ppl-13 (the technologies hint)                                                                                                                      |
| `components/user-profile/contract/MissingFieldsBanner.tsx`            | 5 / 4      | B          | —                                                                                                                                                         |
| `components/user-profile/tabs/DocumentsTab.tsx`                       | 3 / 3      | B          | The stub «(Phase 6)» — an internal stage name in human-facing text, remove                                                                               |
| `components/onboarding/TosUpdateBanner.tsx`                           | 2 / 2      | B          | COPY-H-ppl-2                                                                                                                                               |
| `components/user-profile/tabs/InterviewsTab.tsx`                      | 2 / 2      | B          | «синьора» → the role per the glossary                                                                                                                      |
| `components/user-profile/cropImage.ts`                                | 2 / 2      | —          | Not UI text: `Error('…')` for the developer. Messages → English; `AvatarUploadDialog` shows **its own** text, not `err.message` (Step 9)                  |
| `routes/_authenticated/onboarding/route.tsx`                          | 2 / 2      | B          | «Выйти», «Все права защищены»                                                                                                                              |
| `components/user-profile/tabs/TeamTab.tsx`                            | 1 / 1      | B, F, H    | `ROLE_LABELS` → template H; `localeCompare` → `compareNames(locale)`; the empty state — see "Danger: masking"                                             |

Do not migrate (checked): `components/user-profile/LanguageSection.tsx` (already `uk`, stage 2), `components/user-profile/contract/ContractEditor.tsx` (0), `routes/_authenticated/profile/{index,$userId}.tsx` (comments only).

Outside `apps/web/app`:

- `CONTEXT.md` — the canon section (Step 1).
- `packages/shared/src/schemas/contracts.ts`, `tos.ts`, `notification-preferences.ts` — remove `CONTRACT_SIGN_IMPERSONATION_MESSAGE`, `TOS_ACCEPT_IMPERSONATION_MESSAGE`, `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` and their cases in `contracts.spec.ts`, `tos.spec.ts`, `notification-preferences.spec.ts` (Step 3). `INVOICE_SIGN_IMPERSONATION_MESSAGE` **do not touch**: its consumer `invoice-detail-dialog.tsx` — wave (d).
- `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests (update the assertions to the catalog; the number of lines with Cyrillic in parentheses):

`components/onboarding/{AcceptTosStep.spec.tsx (0), SignContractStep.spec.tsx (7)}`, `components/user-profile/__tests__/{UserProfileHeader.test.tsx (5), UserProfileShell.drop-redirect.test.tsx (10), UserProfileShell.notifications-tab.test.tsx (12)}`, `components/user-profile/admin-actions/__tests__/{AdminActionsMenu.change-personal-email.test.tsx (8), AdminActionsMenu.resend-invite.test.tsx (3), ChangePersonalEmailDialog.test.tsx (32)}`, `components/user-profile/contract/__tests__/{ContractActionBar.test.tsx (5), ContractEditor.test.tsx (3), ContractFillForm.test.tsx (12), ContractPdfPreview.test.tsx (5), ContractTab.test.tsx (3)}`, `components/user-profile/tabs/__tests__/{FinanceTab.total-earned.test.tsx (2), NotificationSettingsTab.grouping.test.ts (10), NotificationSettingsTab.test.tsx (30), OverviewTab.pending-share.test.tsx (48), OverviewTab.share-card.test.tsx (6), OverviewTab.tos.test.tsx (1), TeamTab.empty-state.test.tsx (4)}`. New cases (Step 2) — inside the existing files, PR1 does not introduce new test files.

E2E: see "E2E spec distribution", the PR1 row, plus the sweep output.

**Interfaces:**

- Consumes: `useRoleLabel(role: Role): string`, `ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor>` (`@/components/ui/role-select`, 3a PR1); `API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor>` (`@crm/shared`, stage 4); `getApiErrorMessage(err, fallback?)`, `getApiErrorCode(err)`, `translateZodCode(code)`, `translateZodMessage(message)` (`@/lib/axios-utils`); `formatDate(value, locale, style)`, `compareNames(locale)` (`@crm/shared`); `useLocale(): Locale` (`@/lib/i18n`); `formatBytes(bytes, locale)` and `formatAmount` — **in the signature #706 will leave** (before Step 7 and Step 9 check `git show origin/main:apps/web/app/lib/format-amount.ts` and `format-bytes.ts`); `loadCatalog`, `I18nTestProvider`, `loadMessages`, `assertInCatalog`.
- Produces: the wave (b) canon section in `CONTEXT.md` — read by PR2 and PR3. Three `*_IMPERSONATION_MESSAGE` exports are removed from `@crm/shared` (listed above). No new exports. `components/user-profile/tabs/TeamTab.tsx`, `UserProfileHeader.tsx` and `contract/ContractTab.tsx` stop importing `ROLE_LABELS` — this is a precondition for removing the legacy in PR3.

### Danger: team composition masking (`TeamTab`)

The audit (COPY-M-ppl-6) proposes for `TeamTab` the text «Состав команды пока пуст — добавьте участников кнопкой выше». **This cannot be applied here.** The comment above the `TeamTab` empty state records the decision from 2026-08-17: the masking hides the composition identically for all viewers, and the text must remain true in both cases, i.e. say neither «команда пуста» nor «что-то скрыто». The junior legend is built as an allow-list (glossary **Legend**). Text that hints at the reason for the emptiness reveals the masking.

The translation keeps the neutrality verbatim: `uk` «Немає даних про склад команди», `en` "No team composition data". In the PR body — a line "COPY-M-ppl-6 not applied to `TeamTab`: the masking invariant", separately for `security-reviewer`.

### Acceptance criteria (PR1)

1. In `CONTEXT.md` there is a subsection "Wave b — `web-people`" with the forms from the canon table.
2. `UserProfileHeader`, `ContractTab`, `TeamTab` do not import `ROLE_LABELS`; roles in them — from `ROLE_LABEL_MESSAGES` in `uk` and `en`; the "no raw enum" tests are green.
3. The "log in as" banners in `SignContractStep`, `AcceptTosStep`, `NotificationSettingsTab` take the text from `API_ERROR_MESSAGES`; `CONTRACT_SIGN_IMPERSONATION_MESSAGE`, `TOS_ACCEPT_IMPERSONATION_MESSAGE`, `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` removed from `@crm/shared`.
4. Onboarding in `uk`/`en`, the meaning of the COPY-M-15/16 fixes from #702 preserved; COPY-H-ppl-2, H-7, M-15, L-2, L-5 (onboarding and contract) closed.
5. The profile in `uk`/`en`; COPY-H-ppl-3 (in the PR1 files), H-5, H-8, H-9, M-5, M-7, M-8, M-10, M-11, M-12, M-13 (in the PR1 files), M-14 (`FinanceTab`), L-4 closed; the `TeamTab` empty state stayed neutral (masking).
6. In the PR1 files there is no `toLocale*String('ru-RU')` and no `date-fns/locale`; dates, sizes and sorting go via `format.ts`/`formatBytes`.
7. Step 10 check: not a single `RU` line, the `ENUM` lines parsed.
8. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR1 E2E specs are green.
9. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
10. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
11. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`; `security-reviewer` APPROVE.

### Danger: finance maps in `FinanceTab` (a cross-slice import)

`FinanceTab.tsx` imports `TYPE_LABELS`/`STATUS_LABELS` from `@/routes/_authenticated/finance/constants` — this is wave (d), and there they are still Russian. This wave **does not touch** `finance/constants.ts`. The derived arrays `TYPE_OPTIONS`/`STATUS_OPTIONS` move from the module level into the component (`useMemo`) and keep reading the legacy maps. Then wave (d) only needs to change one source, and there is no freeze-on-import left here. The Russian type and status captions in the `FinanceTab` filter live until wave (d) — this is a line in the PR's "Assumptions", not an incomplete migration.

### Danger: `NOTIFICATION_TITLES` (stage 4, Task 6)

`NotificationSettingsTab.rowTitle` shows `NOTIFICATION_TITLES[type]` — this is `Record<NewNotificationType, string>` in Russian in `packages/shared/src/schemas/notification-registry.ts`. Its translation is handled by stage 4, Task 6: it introduces `NOTIFICATION_TITLE_MESSAGES` and leaves the legacy unchanged. At Step 10 check `git grep -n NOTIFICATION_TITLE_MESSAGES origin/main -- packages/shared`:

- **present** — `rowTitle` moves to `i18n._(NOTIFICATION_TITLE_MESSAGES[type])`, and the function gets a parameter `i18n: I18n`;
- **absent** — `rowTitle` stays on the legacy, a line "notification type titles — after stage 4 Task 6" is written in the PR body, a comment with the same text is placed in `NotificationSettingsTab.tsx`. The rest of the file's text migrates in any case.

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel                       # == the assigned worktree
git fetch origin main && git log --oneline -1 origin/main
gh pr view 706 --json state -q .state               # MERGED, otherwise stop: start after the merge of #706
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/components/onboarding apps/web/app/components/user-profile apps/web/app/routes/_authenticated/onboarding
```

If the numbers differ from the table by more than 10%, update the table in the task file before starting.

- [ ] **Step 1: Term canon → `CONTEXT.md`**

Add to `CONTEXT.md` right after the table "`uk`/`en` forms (stage 3, wave a …)" a subsection:

```markdown
### Wave b — `web-people` (added by PR <N>)

| Term (Russian, for reference) | `uk` | `en` | `_Избегать_` in the product (`uk`/`en`) |
| ----------------------------- | ---- | ---- | ----------------------------------- |
```

The rows — from the "Wave (b) term canon" table of this plan, the columns "Term", `uk`, `en`, "_Избегать_" verbatim (the "Source" column is not carried into the glossary). A separate commit `docs(context): wave b uk/en term forms`, `ac_verified: 1`.

- [ ] **Step 2: Test for roles in the profile (fails)**

In the existing `components/user-profile/__tests__/UserProfileHeader.test.tsx` (it already has the factory `makeUser(overrides)`) add:

```tsx
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const RAW_ROLE = /\b(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)\b/

describe('role badge comes from ROLE_LABEL_MESSAGES', () => {
  it.each([
    ['uk', 'SENIOR', 'Сеньйор'],
    ['uk', 'DROP', 'Дроп'],
    ['en', 'SENIOR', 'Senior'],
    ['en', 'ADMIN', 'Admin'],
  ] as const)('%s: %s badge reads %s and no raw enum leaks', async (locale, role, label) => {
    await loadCatalog(locale)
    const { container } = render(<UserProfileHeader user={makeUser({ role })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(RAW_ROLE)
  })
})
```

The existing `render(<UserProfileHeader …/>)` of this file get `{ wrapper: I18nTestProvider }` and `beforeEach(() => loadCatalog('uk'))`: after Step 3 the component calls `useLingui()`.

For `TeamTab` and `ContractTab` — the same `it.each` in their test files: `TeamTab.empty-state.test.tsx` gets a case with a member list (roles `SENIOR`, `JUNIOR`, `HR` → «Сеньйор», «Джуніор», «HR» in `uk`; «Senior», «Junior», «HR» in `en`), `ContractTab.test.tsx` — an empty state without a template for `SENIOR` (in `uk` the text «Сеньйор», no `SENIOR`).

Run: `pnpm --filter @crm/web test -- UserProfileHeader ContractTab TeamTab` → FAIL (currently «Синьор» from the legacy).

- [ ] **Step 3: Legacy roles and "log in as" banners (templates H and G) → PASS**

`UserProfileHeader.tsx`: `ROLE_LABELS[user.role]` → `useRoleLabel(user.role)`; «Зарегистрирован {дата}» → `<Trans>Дата реєстрації: {createdAt}</Trans>`, where `createdAt = formatDate(user.createdAt, locale, 'long')`, `locale = useLocale()` (a form without gender — COPY "gender endings").

`TeamTab.tsx`: template H for the list; sorting — `ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || compareNames(locale)(a.displayName, b.displayName)` (create the collator once: `const cmp = useMemo(() => compareNames(locale), [locale])`).

`ContractTab.tsx`: an empty state without a template.

```tsx
const roleLabel = useRoleLabel(targetRole as Role)
// …
<Trans>Немає шаблону контракту для ролі «{roleLabel}»</Trans>
```

`STATUS_LABELS`, `FROZEN_BANNERS` — template A (`Record<ContractStatus, MessageDescriptor>`, `satisfies` without `as const`), statuses — per the canon («Чернетка», «Готовий до підписання», «Підписаний», «Скасований»).

The "log in as" banners (template G):

- `SignContractStep.tsx` → `i18n._(API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION)`;
- `AcceptTosStep.tsx` → `i18n._(API_ERROR_MESSAGES.TOS_ACCEPT_IMPERSONATION)`;
- `NotificationSettingsTab.tsx` → `i18n._(API_ERROR_MESSAGES.NOTIFICATION_PREFERENCES_IMPERSONATION)`.

The module constant `IMPERSONATION_EXPLANATION` in the three files is removed. The period is no longer glued on outside: the catalog text is one sentence without a period.

Then remove three constants from `@crm/shared`: `CONTRACT_SIGN_IMPERSONATION_MESSAGE` (`schemas/contracts.ts`), `TOS_ACCEPT_IMPERSONATION_MESSAGE` (`schemas/tos.ts`), `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` (`schemas/notification-preferences.ts`) and their cases in the neighboring `*.spec.ts`. Before removing: `git grep -n '<NAME>' -- apps packages` — there must be no occurrences outside these files and the migrated tests. The tests `AcceptTosStep.spec.tsx`, `SignContractStep.spec.tsx`, `NotificationSettingsTab.test.tsx` that asserted `` `${…_MESSAGE}.` `` move to `i18n._(API_ERROR_MESSAGES.<CODE>)` after `loadCatalog('uk')`.

Run: `pnpm --filter @crm/web test -- UserProfileHeader ContractTab TeamTab AcceptTosStep SignContractStep NotificationSettingsTab && pnpm --filter @crm/shared test` → PASS.

- [ ] **Step 4: Onboarding — `SignContractStep`, `AcceptTosStep`, `TosUpdateBanner`, `ContractWaitScreen`, `routes/onboarding/*` (the deferred item 4)**

`SignContractStep.tsx` — the banners that #702 left in Russian (COPY-M-15/16 are **already fixed by meaning**, exactly the fixed meaning is carried over, not the original):

| Place                                                  | `uk`                                                                                                                                  | `en`                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The unconditional paragraph «Данные в контракте…» (COPY-M-16) | Дані в контракті — ім’я, email і реквізити — задає адміністратор; якщо щось не так, напишіть йому                                     | The contract data — name, email and payout details — is set by an admin; if something is wrong, write to them |
| The `legalNameMissing` banner (COPY-M-15)              | Юридичне ПІБ не заповнено — підписання відкриється, щойно його заповнить адміністратор                                                | Your legal name is not filled in yet — signing opens as soon as an admin adds it                              |
| The button hint on `legalNameMissing` (COPY-H-ppl-7)   | Юридичне ПІБ заповнює адміністратор — напишіть йому, і підписання відкриється одразу після цього                                      | An admin fills in your legal name — write to them and signing opens right after                               |
| The «Я ознакомился…» checkbox (gender ending, audit B) | Умови персонального контракту прочитано — підтверджую                                                                                 | I have read and accept the terms of my personal contract                                                      |
| `<Badge>PREVIEW</Badge>` (COPY-L-ppl-2)                | Попередній перегляд                                                                                                                   | Preview                                                                                                       |
| The success toast                                      | Контракт підписано, номер {contractNumber}                                                                                            | Contract signed, number {contractNumber}                                                                      |
| The generic error toast                                | `getApiErrorMessage(err)` — without a client literal; the branches by codes `LEGAL_NAME_REQUIRED`/`ADMIN_DOES_NOT_SIGN_CONTRACTS` do not touch | —                                                                                                             |
| `download="contract-preview.pdf"` (COPY-L-ppl-5)       | `download={t\`Контракт — попередній перегляд.pdf\`}`                                                                                  | Contract — preview.pdf                                                                                        |

The texts above — a draft for `copy-reviewer`, edited per his verdict. The existing test from #702 "no `\bADMIN\b` in the screen" is **kept** and run in `uk` and `en` (`it.each(['uk','en'])`). It also additionally checks `SENIOR|JUNIOR|ACCOUNTANT|DROP` — lesson item 13.

`AcceptTosStep.tsx` and `TosUpdateBanner.tsx` — «Terms of Service» → «Умови використання» (COPY-H-ppl-2): «Завантажуємо Умови використання…», «Приймаю Умови використання», «Умови використання не знайдено — зверніться до адміністратора» (the plural in `uk` has no gender, the «не найден» problem goes away), «Умови використання — версія {version}», the button «Прийняти Умови використання» / «Приймаємо…». `en` — "Terms of Service" with an article by context: "Loading the Terms of Service…", "I accept the Terms of Service", "The Terms of Service could not be found — contact an admin". The error toast — `getApiErrorMessage(err, t\`Не вдалося прийняти Умови використання\`)` instead of `err.message`.

`ContractWaitScreen.tsx` (COPY-M-ppl-15, H-3): «Контракт готується», «Ваш персональний контракт ще не готовий до підписання — адміністратор заповнить його найближчим часом», «Сторінка оновиться сама, щойно контракт буде готовий». There is no number in the text — the parent's `refetchInterval` may change.

`routes/_authenticated/onboarding/route.tsx`: «Выйти» → `<Trans>Вийти</Trans>` (E2E `onboarding-logout.spec.ts` asserts `toContainText('Выйти')` — moved to template I). «© {year} Cheeky Cheese IT. Все права защищены.» → `<Trans>© {year} Cheeky Cheese IT. Усі права захищено.</Trans>`.

- [ ] **Step 5: `UserProfileShell.tsx` (COPY-H-ppl-8, M-7)**

```tsx
// the load-error branch
<h2 className="text-xl font-semibold">
  {is403 ? <Trans>Немає доступу до профілю</Trans> : <Trans>Профіль не знайдено</Trans>}
</h2>
<p className="max-w-sm text-sm text-muted-foreground">
  {is403 ? (
    <Trans>Якщо він потрібен для роботи, напишіть адміністратору</Trans>
  ) : (
    <Trans>Можливо, користувача архівовано — перевірте фільтр «В архіві» у списку</Trans>
  )}
</p>

// data-testid="profile-no-access" — the same text as for 403 (one situation — one text, M-7)
<p className="text-sm text-muted-foreground">
  <Trans>Немає доступу до профілю — якщо він потрібен для роботи, напишіть адміністратору</Trans>
</p>
```

The unsaved-changes dialog: «Остаться» → `<Trans>Залишитися</Trans>` and the rest of the dialog's strings — template B/C. E2E `crm/contract-editor.spec.ts` and `crm/senior-resume.spec.ts` click `name: 'Остаться'` → template I (the «Остаться» line in `senior-resume.spec.ts` — PR1's only edit in that spec).

- [ ] **Step 6: Credentials — `OverviewTab`, `RequisitesTab`, `RequisitesEditForm`, `ProfileEditFields` (COPY-M-ppl-10…13, L-4, H-2, H-3)**

- «Способ выплат», «Способ выплаты», `aria-label="Способ выплаты"` → everywhere «Спосіб виплати» / "Payout method" (M-10). «Реквизиты для выплат» → «Реквізити для виплат» / "Payout details".
- `RequisitesEditForm` — `disabledTooltip` and `TooltipContent`, two copies of «SENIOR и ADMIN получают только в USDT ERC-20» (M-11): the text is addressed to the person themselves, one `msg` constant for both copies:

```tsx
const USDT_ONLY_HINT = msg`Ви отримуєте виплати лише в USDT (мережа Ethereum) — змінити спосіб не можна`
// en: "You receive payouts in USDT (Ethereum network) only — the method cannot be changed"
const { i18n } = useLingui()
// …
disabledTooltip: i18n._(USDT_ONLY_HINT)
// …
<TooltipContent side="top">{i18n._(USDT_ONLY_HINT)}</TooltipContent>
```

- `OverviewTab` the `drop-requisites-missing-banner` (M-12): «Реквізити не заповнено» / «Без реквізитів ми не зможемо вам заплатити — вкажіть гаманець USDT або банківський рахунок».
- Empty values (L-4): «не указано» ×4, «Не указано», «Заметок нет» → one `msg` constant `NOT_SET = msg\`не вказано\`` in each of the two files (`OverviewTab`, `RequisitesTab`) — the text is identical, one key in the catalog.
- Admin note (H-3): «Заметка администратора» → «Нотатка адміністратора»; «Админ увидит причину и сможет предложить другой процент» → «Адміністратор побачить причину і зможе запропонувати іншу частку» (glossary: «частка», not «відсоток»).
- The «Пользовательское соглашение» card (H-2) → «Умови використання», the acceptance date — `formatDate(tosAcceptedAt, locale, 'short')` instead of `toLocaleDateString('ru-RU')`.
- The `pendingSeniorShare` concatenation («Вашу долю по умолчанию предлагают изменить: сейчас {x}%, предлагают {y}%…», audit B "assembling a phrase from JSX parts") → one `<Trans>` with the slots `{current}` and `{proposed}`, without `{' '}` joints.
- The placeholders (M-13) — strictly from the canon table: full name «Іваненко Іван Іванович», technologies «Почніть вводити: React, Node.js…».

- [ ] **Step 7: `FinanceTab.tsx` (COPY-H-ppl-9, M-5, M-14)**

```tsx
// the total-earned card: only ADMIN/ACCOUNTANT see it on SOMEONE ELSE's profile
<p className="text-xs uppercase tracking-wide text-muted-foreground">
  <Trans>Усього виплачено цій людині</Trans>
</p>
<p className="text-xs text-muted-foreground/70">
  <Trans>Сума всіх розрахунків з нею за весь час</Trans>
</p>
// en: "Total paid to this person" / "Sum of all settlements with them, all time"
```

`formatAmount(totalEarned.totalEarned, totalEarned.currency)` — bring to the signature after #706 (if the function accepts `locale`, pass `useLocale()`).

Empty states: «Транзакций пока нет» → «Транзакцій поки немає». The unreachable branch `hasActive ? 'Ничего не найдено' : 'Нет данных'` (M-5) is removed: only the canon text «Нічого не знайдено — скиньте фільтри» (M-14) remains. So the mutation gate does not treat the removal as a coverage loss, add a test for the branch "filters active and nothing found".

`TYPE_OPTIONS`/`STATUS_OPTIONS` — inside the component, `useMemo(() => Object.entries(TYPE_LABELS).map(…), [])` (see "Danger: finance maps").

- [ ] **Step 8: Employee contract — `ContractActionBar`, `ContractFillForm`, `ContractPdfPreview`, `MissingFieldsBanner`, `useEmployeeContract` (COPY-L-ppl-5)**

`useEmployeeContract.ts` — five concatenations of the form ``toast.error(`Не удалось сохранить контракт: ${msg}`)``. The server text is no longer glued to the client (audit B "template concatenation"):

```ts
// was
onError: (err) => toast.error(`Не удалось сохранить контракт: ${extractMsg(err)}`)
// became — the hook is called from a component, `t` is taken from useLingui() inside the hook
const { t } = useLingui()
onError: (err) => toast.error(getApiErrorMessage(err, t`Не вдалося зберегти контракт`))
```

Each of the five places gets its own fallback by action («зберегти», «позначити готовим до підписання», «скасувати», etc.). The server code, if present, wins — so the refusal text matches what the server knows.

`ContractPdfPreview.tsx` — the `download` the same as in `SignContractStep` (Step 4, the same string → one key).

- [ ] **Step 9: `AvatarUploadDialog.tsx` + `cropImage.ts` (COPY-M-ppl-8)**

```tsx
// was
setError(`Файл ${(file.size / 1024).toFixed(0)} KB — максимум 5 MB`)
// became — both values with one function (formatBytes from @/lib/format-bytes after #706)
const locale = useLocale()
const size = formatBytes(file.size, locale)
const limit = formatBytes(AVATAR_MAX_BYTES, locale)
setError(t`Файл ${size} — максимум ${limit}, виберіть менший`)
```

`AVATAR_MAX_BYTES` — the constant against which the file size is compared (do not hardcode `5 MB` a second time). If there is none, introduce `const AVATAR_MAX_BYTES = 5 * 1024 * 1024` next to the check and compare against it.

`cropImage.ts`: `new Error('Не удалось создать canvas context')` → `new Error('canvas 2d context unavailable')`, `'Не удалось загрузить изображение'` → `'image failed to load'` (for the developer, in English). In `AvatarUploadDialog` the display `err instanceof Error ? err.message : …` is replaced with its own text `t\`Не вдалося обрізати зображення\``: the `Error` message is not shown to the user.

The rest of the file's strings — templates B/C, ellipses `…`.

- [ ] **Step 10: The rest of the profile files**

`AdminActionsMenu.tsx` («Заметка админа» → «Нотатка адміністратора», E2E `admin-actions.spec.ts` — template I), `AdminNoteDialog.tsx`, `ChangePersonalEmailDialog.tsx` (captions and toasts; «личный email» → «особистий email» per the canon), `ProfileCredentialsSection.tsx`, `DocumentsTab.tsx` («Документы появятся здесь (Phase 6)» → «Тут з’являться документи профілю» — without the internal stage name), `InterviewsTab.tsx» («Доска собеседований этого синьора» → «Дошка співбесід цього сеньйора», «Открыть Канбан» → «Відкрити дошку»), `ProjectsTab.tsx` (two dates → `formatDate(…, 'short')`, the range `{start}–{end}` via `<Trans>`), `NotificationSettingsTab.tsx` (`'Новый тип'` → `msg\`Новий тип сповіщень\``; `LOCKED_EXPLANATION`, `UNKNOWN_TYPE_EXPLANATION` — template A; titles — "Danger: `NOTIFICATION_TITLES`"), `routes/_authenticated/onboarding/index.tsx`, `MissingFieldsBanner.tsx`.

The final check of the PR1 files (the onboarding and profile product files, except `resume/` — PR3 — and `ArchiveUserDialog.tsx` — PR2):

```bash
python3 - <<'EOF'
import re, pathlib
roots = ['apps/web/app/components/onboarding', 'apps/web/app/routes/_authenticated/onboarding',
         'apps/web/app/components/user-profile']
skip = re.compile(r'__tests__|\.(spec|test)\.|/resume/|ArchiveUserDialog\.tsx$')
enum = re.compile(r'\b(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)\b')
code = re.compile(r"===|!==|case |: Role|Role\[|z\.enum|role ===|\.role\b|'(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)'")
for root in roots:
    for f in sorted(pathlib.Path(root).rglob('*.ts*')):
        if skip.search(str(f)):
            continue
        for n, l in enumerate(f.read_text(encoding='utf8').splitlines(), 1):
            if re.match(r'\s*(//|\*|\{/\*)', l):
                continue
            if re.search('[ыЫэЭъЪёЁ]', l):
                print('RU  ', f, n, l.strip())
            if enum.search(l) and not code.search(l):
                print('ENUM', f, n, l.strip())
EOF
```

There must be no `RU` lines. Parse the `ENUM` lines one by one: visible text with an enum — an incomplete migration, an identifier in the code (a map key, a type) — normal.

- [ ] **Step 11: Tests, E2E sweep, gates, commit**

Each test file from the Files list: a literal → the catalog (`loadCatalog('uk')`, for key screens — also a `en` case). The E2E sweep (the common step) → the spec lines from the "Distribution" and the script output.

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/shared test
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- admin-actions contract-editor mobile-keyboard-attributes senior-resume onboarding-logout profile-self-edit requisites-warning onboarding-regression-pr110 notification-settings
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add CONTEXT.md \
  apps/web/app/components/onboarding/AcceptTosStep.tsx \
  apps/web/app/components/onboarding/AcceptTosStep.spec.tsx \
  apps/web/app/components/onboarding/ContractWaitScreen.tsx \
  apps/web/app/components/onboarding/SignContractStep.tsx \
  apps/web/app/components/onboarding/SignContractStep.spec.tsx \
  apps/web/app/components/onboarding/TosUpdateBanner.tsx \
  apps/web/app/routes/_authenticated/onboarding/index.tsx \
  apps/web/app/routes/_authenticated/onboarding/route.tsx \
  apps/web/app/components/user-profile/AvatarUploadDialog.tsx \
  apps/web/app/components/user-profile/ProfileCredentialsSection.tsx \
  apps/web/app/components/user-profile/UserProfileHeader.tsx \
  apps/web/app/components/user-profile/UserProfileShell.tsx \
  apps/web/app/components/user-profile/cropImage.ts \
  apps/web/app/components/user-profile/admin-actions/AdminActionsMenu.tsx \
  apps/web/app/components/user-profile/admin-actions/AdminNoteDialog.tsx \
  apps/web/app/components/user-profile/admin-actions/ChangePersonalEmailDialog.tsx \
  apps/web/app/components/user-profile/contract/ContractActionBar.tsx \
  apps/web/app/components/user-profile/contract/ContractFillForm.tsx \
  apps/web/app/components/user-profile/contract/ContractPdfPreview.tsx \
  apps/web/app/components/user-profile/contract/ContractTab.tsx \
  apps/web/app/components/user-profile/contract/MissingFieldsBanner.tsx \
  apps/web/app/components/user-profile/contract/useEmployeeContract.ts \
  apps/web/app/components/user-profile/self-edit/ProfileEditFields.tsx \
  apps/web/app/components/user-profile/self-edit/RequisitesEditForm.tsx \
  apps/web/app/components/user-profile/tabs/DocumentsTab.tsx \
  apps/web/app/components/user-profile/tabs/FinanceTab.tsx \
  apps/web/app/components/user-profile/tabs/InterviewsTab.tsx \
  apps/web/app/components/user-profile/tabs/NotificationSettingsTab.tsx \
  apps/web/app/components/user-profile/tabs/OverviewTab.tsx \
  apps/web/app/components/user-profile/tabs/ProjectsTab.tsx \
  apps/web/app/components/user-profile/tabs/RequisitesTab.tsx \
  apps/web/app/components/user-profile/tabs/TeamTab.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileHeader.test.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileShell.drop-redirect.test.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileShell.notifications-tab.test.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/AdminActionsMenu.change-personal-email.test.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/AdminActionsMenu.resend-invite.test.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/ChangePersonalEmailDialog.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractActionBar.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractEditor.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractFillForm.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractPdfPreview.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractTab.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/FinanceTab.total-earned.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/NotificationSettingsTab.grouping.test.ts \
  apps/web/app/components/user-profile/tabs/__tests__/NotificationSettingsTab.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/OverviewTab.pending-share.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/OverviewTab.share-card.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/OverviewTab.tos.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/TeamTab.empty-state.test.tsx \
  packages/shared/src/schemas/contracts.ts \
  packages/shared/src/schemas/contracts.spec.ts \
  packages/shared/src/schemas/tos.ts \
  packages/shared/src/schemas/tos.spec.ts \
  packages/shared/src/schemas/notification-preferences.ts \
  packages/shared/src/schemas/notification-preferences.spec.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/admin-actions.spec.ts \
  apps/e2e/tests/crm/contract-editor.spec.ts \
  apps/e2e/tests/crm/mobile-keyboard-attributes.spec.ts \
  apps/e2e/tests/crm/senior-resume.spec.ts \
  apps/e2e/tests/onboarding-logout.spec.ts \
  apps/e2e/tests/profile-self-edit.spec.ts \
  apps/e2e/tests/requisites-warning.spec.ts
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,shared,i18n): stage 3b wave (b) part 1 — onboarding and profile to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9,10 (11 — reviews after push)
EOF
)"
```

The `git add` list — an upper bound. A file that did not need changing (a test without Russian assertions) will simply not be touched by `git add`.

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: onboarding (ToS, contract wait, signing — the ordinary one, without the legal name, "log in as"), the profile (header, «Огляд», «Фінанси» as seen by ADMIN, «Реквізити» with the disabled tab, «Команда», «Контракт» without a template, «Сповіщення»), dialogs (avatar with a size error, note, personal email change, unsaved changes). Fidelity Mode B — on all widths from Global Constraints. `copy-reviewer` — a verdict on `uk` and `en` separately. `security-reviewer` — mandatory (credentials, wallet, the payout card, `TeamTab` masking).

---

## Task 2 (PR2): user list, teams, user archival

**Files:**

| File                                                                             | Cyr. lines | Pattern(s)    | Audit findings / note                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/_authenticated/team/$teamId.tsx`                                         | 78 / 73    | A, B, C, F, H | The local copy of `ROLE_LABELS` is removed (template H); COPY-M-ppl-2 («Ошибка добавления», «Не удалось обновить команду»), M-14; the creation date — `formatDate(…, 'long')`; two `localeCompare` → `compareNames` |
| `routes/_authenticated/team/index.tsx`                                           | 45 / 41    | B, C, D       | COPY-H-ppl-1 («Сортування» in `uk` is correct, but `en` — "Sort by"), M-2 («Ошибка при создании»), M-13 (the technologies hint), M-14; `localeCompare` → `compareNames`                                     |
| `components/users/ArchiveConfirmDialog.tsx` → **`ArchiveUserConfirmDialog.tsx`** | 34 / 33    | B, C          | **The deferred item 3** (rename); COPY-H-ppl-6 (the jargon `senior+team`, `cascade`, `JUNIOR`), M-2 («Ошибка при архивации»), L-1, «{n} шт.» (audit B) — goes away with `ImpactWarning`                     |
| `routes/_authenticated/users/index.tsx`                                          | 24 / 22    | B, C, H       | The role filter — template H; «Пользователи не найдены» (M-14), «Все роли»                                                                                                                                 |
| `components/users/RejoinTeamDialog.tsx`                                          | 19 / 18    | B, C          | COPY-L-ppl-3 («Готово» / «Сохранение...» → «Зберегти» / «Збереження…»), M-6 («Нет доступных…»)                                                                                                             |
| `components/users/UserRow.tsx`                                                   | 10 / 9     | B, F, H       | `ROLE_LABELS` → `useRoleLabel`; `date-fns` + `ru` → `formatRelativeTime(createdAt, locale)`                                                                                                                |
| `components/users/HrChipsField.tsx`                                              | 9 / 8      | B, C          | COPY-M-ppl-6 («Нет доступных HR» → «Немає вільних HR — створіть HR у розділі «Команда»»)                                                                                                                   |
| `components/users/AccountantChipField.tsx`                                       | 8 / 8      | B, C          | COPY-M-ppl-6 (the same for accountants)                                                                                                                                                                    |
| `components/user-profile/admin-actions/ArchiveUserDialog.tsx`                    | 5 / 5      | B, C          | Import `ImpactWarning` → `UserArchiveImpact`                                                                                                                                                               |
| `components/users/CreateWizardStepper.tsx`                                       | 4 / 4      | B             | —                                                                                                                                                                                                          |
| `components/archive/ArchiveConfirmDialog.tsx`                                    | already `uk` | —           | **The deferred item 2**: COPY-L-31, COPY-L-32; the user branch moves to `UserArchiveImpact`; «інвойси» → «рахунки» (glossary **Invoice**) in the project branch                                           |
| `components/archive/UserArchiveImpact.tsx`                                       | new        | B, D, E       | The single source of the user-archival impact text                                                                                                                                                        |

`components/users/constants.ts` is **not touched** in PR2: its `ROLE_LABELS` is still read by `UserDialog.tsx` (PR3). After PR2 the legacy has one consumer left.

Tests: `components/users/__tests__/ArchiveConfirmDialog.test.tsx` (36) → `git mv` to `ArchiveUserConfirmDialog.test.tsx`; `components/user-profile/admin-actions/__tests__/ArchiveUserDialog.test.tsx` (11); `components/users/__tests__/{CreateWizardStepper.test.tsx (3), ProfileNameLink.test.tsx (4), RejoinTeamDialog.schema-translation.test.tsx (2), UserRow.test.tsx (1)}`; `components/archive/__tests__/ArchiveConfirmDialog.test.tsx`. New: `components/archive/__tests__/UserArchiveImpact.test.tsx`. `apps/web/app/__tests__/support/mobile-keyboard-registry.ts` references the testid `archive-confirm-name-input` — the testid is kept, the file is not changed.

E2E: see "E2E spec distribution", the PR2 row, plus the sweep output.

**Interfaces:**

- Consumes: `useRoleLabel`, `ROLE_LABEL_MESSAGES` (`@/components/ui/role-select`); `formatRelativeTime(value, locale)`, `formatDate`, `compareNames` (`@crm/shared`); `useLocale()`; `getApiErrorMessage`, `translateZodCode`, `translateZodMessage` (`@/lib/axios-utils`); `ArchiveImpact` (`@crm/shared`); the catalog test helpers.
- Produces:
  - `export function UserArchiveImpact(props: { entityName: string; impact: Extract<ArchiveImpact, { type: 'user' }> }): JSX.Element` — `components/archive/UserArchiveImpact.tsx`. Renders a wrapper with a `data-testid` by role (`archive-warning-senior` for `SENIOR` and `DROP`, `archive-warning-hr`, `archive-warning-accountant`, `archive-warning-junior`, `archive-warning-admin`) and the name in `<strong data-testid="archive-confirm-user-name">`. These testids are already asserted by 5 E2E specs and 2 unit files — they do not change.
  - `export function ArchiveUserConfirmDialog(props: { user: UserProfileDto | null; onClose: () => void }): JSX.Element` — `components/users/ArchiveUserConfirmDialog.tsx` (the former `components/users/ArchiveConfirmDialog.tsx`, the behavior and the testids `archive-confirm-dialog`, `archive-confirm-name-input`, `archive-confirm-submit` unchanged).
  - Removed: `components/users/ArchiveConfirmDialog.tsx` (as a file name) and the export `ImpactWarning`.

### Danger: two `ArchiveConfirmDialog` — rename and split the text, but do not merge the dialogs

Merging the two dialogs into one `components/archive/ArchiveConfirmDialog` (`entityType='user'`) would be prettier, but it changes the behavior of a destructive action. They differ not only in text:

| Property                   | `components/users/…` (the `/users` list)                            | `components/archive/…` (`entityType='user'`) |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Mutation and cache invalidation | its own: `['users-admin']`, for SENIOR/DROP also `teams` and `projects` | `useArchiveEntity('user', id)`               |
| Success toasts             | by role («Сеньйора й команду архівовано»…)                           | the common hook                              |
| testid                     | `archive-confirm-dialog`, `archive-confirm-name-input`               | `archive-confirm-input`                      |
| Closing during a request   | forbidden (Escape, overlay, «Отмена») — security-review #584 round 3 | not forbidden                                |
| Enter confirms             | yes                                                                  | no                                           |

Merging would pull in editing 5 E2E specs and removing a protection that security-review #584 placed consciously. Therefore in this wave: **shared text** (`UserArchiveImpact`) plus **different names** (`ArchiveUserConfirmDialog`). Merging the dialogs, if needed, — a separate task with `security-reviewer` (a line in "Findings outside the perimeter").

### Acceptance criteria (PR2)

1. `components/archive/UserArchiveImpact.tsx` — the single source of the user-archival impact text; it is rendered by `components/archive/ArchiveConfirmDialog`, `ArchiveUserConfirmDialog` and `ArchiveUserDialog`; the testids `archive-warning-*` and `archive-confirm-user-name` kept.
2. COPY-L-31 and COPY-L-32 closed, «з N команд/проєктів» — in the genitive case, «інвойси» → «рахунки»; the `UserArchiveImpact` tests are green on `uk` and `en`.
3. `components/users/ArchiveConfirmDialog.tsx` renamed to `ArchiveUserConfirmDialog.tsx`, `ImpactWarning` removed; the behavior (invalidation, the ban on closing during a request, Enter, testids) did not change — the existing dialog tests are green without editing the logic.
4. `UserRow`, `users/index.tsx`, `team/$teamId.tsx` show roles from `ROLE_LABEL_MESSAGES`; the local `ROLE_LABELS` map in `$teamId.tsx` removed; `date-fns/locale`, `toLocale*('ru-RU')` and `localeCompare` in the PR2 files replaced with `format.ts`.
5. COPY-H-ppl-1, H-6, M-2 (in the PR2 files), M-6 (chips), M-13 (`team/index`), M-14 (`users/index`, `team/*`), L-3 closed.
6. In the PR2 files 0 lines with `[ыэъё]` outside comments (checked in Step 7).
7. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR2 E2E specs are green.
8. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
9. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
10. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en` (with a separate line on L-31/L-32); `security-reviewer` APPROVE.

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel
git fetch origin main && gh pr view 706 --json state -q .state     # MERGED
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/components/users apps/web/app/routes/_authenticated/team apps/web/app/routes/_authenticated/users
git grep -n "ArchiveConfirmDialog'" origin/main -- apps/web/app    # the consumers of both dialogs — compare with the table
```

The term canon — from this plan (PR1 enters it into `CONTEXT.md` in parallel; if PR1 is already merged, read `CONTEXT.md`).

- [ ] **Step 1: Test `UserArchiveImpact` (fails)**

```tsx
// apps/web/app/components/archive/__tests__/UserArchiveImpact.test.tsx (new)
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ArchiveImpact } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UserArchiveImpact } from '../UserArchiveImpact'

type UserImpact = Extract<ArchiveImpact, { type: 'user' }>
const base = { type: 'user' as const, pendingTransactions: [] }

const cases: Array<[string, UserImpact]> = [
  [
    'archive-warning-senior',
    {
      ...base,
      role: 'SENIOR',
      teamName: 'Alpha',
      projectsCount: 2,
      projectNames: ['P1', 'P2'],
      hrAccountantsOnTeam: 1,
      juniorsAffected: 3,
    },
  ],
  ['archive-warning-senior', { ...base, role: 'DROP', teamName: null, projectsCount: 1 }],
  ['archive-warning-hr', { ...base, role: 'HR', teamsCount: 5 }],
  ['archive-warning-accountant', { ...base, role: 'ACCOUNTANT', teamsCount: 1 }],
  ['archive-warning-junior', { ...base, role: 'JUNIOR', projectsCount: 2 }],
  ['archive-warning-admin', { ...base, role: 'ADMIN' }],
]

describe('UserArchiveImpact', () => {
  it.each(cases)(
    '%s renders for role, keeps the name testid, no raw enum or jargon',
    async (testId, impact) => {
      for (const locale of ['uk', 'en'] as const) {
        await loadCatalog(locale)
        const { unmount } = render(
          <UserArchiveImpact entityName="Олена Коваль" impact={impact} />,
          {
            wrapper: I18nTestProvider,
          },
        )
        const block = screen.getByTestId(testId)
        expect(screen.getByTestId('archive-confirm-user-name')).toHaveTextContent('Олена Коваль')
        expect(block.textContent).not.toMatch(
          /\b(SENIOR|JUNIOR|ACCOUNTANT|DROP|ADMIN)\b|senior\+team|cascade/,
        )
        unmount()
      }
    },
  )

  it('COPY-L-32: uk text never agrees with the person’s gender (no «архівований»/«архівована»)', async () => {
    await loadCatalog('uk')
    for (const [, impact] of cases) {
      const { container, unmount } = render(
        <UserArchiveImpact entityName="Олена" impact={impact} />,
        {
          wrapper: I18nTestProvider,
        },
      )
      expect(container.textContent).not.toMatch(/архівован(ий|а)/)
      unmount()
    }
  })

  it('COPY-L-31: the SENIOR/DROP branch without a team still says it can be restored', async () => {
    await loadCatalog('uk')
    render(<UserArchiveImpact entityName="Олена" impact={cases[1][1]} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('archive-warning-senior')).toHaveTextContent('Відновлення можливе')
  })

  it('HR/JUNIOR counts after «з» are genitive in uk (1 команди, 5 команд, 2 активних проєктів)', async () => {
    await loadCatalog('uk')
    const { rerender } = render(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 1 }} />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('archive-warning-hr')).toHaveTextContent('з 1 команди')
    rerender(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 5 }} />,
    )
    expect(screen.getByTestId('archive-warning-hr')).toHaveTextContent('з 5 команд')
    rerender(
      <UserArchiveImpact
        entityName="Олена"
        impact={{ ...base, role: 'JUNIOR', projectsCount: 2 }}
      />,
    )
    expect(screen.getByTestId('archive-warning-junior')).toHaveTextContent('з 2 активних проєктів')
  })
})
```

Run: `pnpm --filter @crm/web test -- UserArchiveImpact` → FAIL (no module).

- [ ] **Step 2: `UserArchiveImpact.tsx` + COPY-L-31, COPY-L-32 (the deferred item 2) → PASS**

The branch `entityType === 'user'` is moved out of `renderImpactText` (`components/archive/ArchiveConfirmDialog.tsx`), with three text fixes:

1. **COPY-L-32** — five lines «<ім’я> буде архівований …» are rewritten gender-neutrally, by the idiom already present in the neighboring branch («В архів підуть: …»): «В архів піде профіль <ім’я> …». The subject — «профіль» (masculine), so the text no longer depends on the person's gender.
2. **COPY-L-31** — the SENIOR/DROP branch without a team gets a line about reversibility.
3. **The genitive case after «з»** (found while preparing the plan): now `<Plural one="# команда">` stands after «прибраний з», and it comes out «з 1 команда». After the preposition the genitive is needed: `one="# команди" few="# команд" many="# команд" other="# команди"`; for projects — `one="# активного проєкту" few="# активних проєктів" many="# активних проєктів" other="# активного проєкту"`.

```tsx
// apps/web/app/components/archive/UserArchiveImpact.tsx
import type { ArchiveImpact } from '@crm/shared'
import { select } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'

type UserImpact = Extract<ArchiveImpact, { type: 'user' }>

const TESTID_BY_ROLE: Record<UserImpact['role'], string> = {
  SENIOR: 'archive-warning-senior',
  DROP: 'archive-warning-senior',
  HR: 'archive-warning-hr',
  ACCOUNTANT: 'archive-warning-accountant',
  JUNIOR: 'archive-warning-junior',
  ADMIN: 'archive-warning-admin',
}

/** Single source of the "what archiving this person changes" copy — rendered by
 *  `components/archive/ArchiveConfirmDialog` (entityType='user'),
 *  `components/users/ArchiveUserConfirmDialog` and
 *  `user-profile/admin-actions/ArchiveUserDialog`. Gender-neutral by construction
 *  (the subject is «профіль», COPY-L-32). */
export function UserArchiveImpact({
  entityName,
  impact,
}: {
  entityName: string
  impact: UserImpact
}) {
  return <div data-testid={TESTID_BY_ROLE[impact.role]}>{renderBody(entityName, impact)}</div>
}

/** Inside <Trans> this becomes a numbered component slot (<0>…</0>), so the name keeps
 *  its markup and testid in every locale without being glued outside the sentence. */
function Name({ children }: { children: React.ReactNode }) {
  return (
    <strong className="text-foreground" data-testid="archive-confirm-user-name">
      {children}
    </strong>
  )
}

function renderBody(entityName: string, impact: UserImpact): React.ReactNode {
  const projectNames = impact.projectNames ?? []
  const namesSuffix = projectNames.length > 0 ? `: ${projectNames.join(', ')}` : ''

  if (impact.role === 'SENIOR' || impact.role === 'DROP') {
    if (!impact.teamName) {
      return (
        <>
          <Trans>
            В архів піде профіль <Name>{entityName}</Name> разом з усіма проєктами (
            <Plural
              value={impact.projectsCount ?? 0}
              one="# проєкт"
              few="# проєкти"
              many="# проєктів"
              other="# проєкту"
            />
            {namesSuffix}).
          </Trans>{' '}
          <Trans>Відновлення можливе — профіль повернеться, але проєкти відновлювати окремо.</Trans>
        </>
      )
    }
    // Stryker disable next-line ObjectLiteral,StringLiteral: Lingui's select() macro must read this options object as a literal at compile time (the `{}` mutant makes the transform throw before any test runs); `other` is unreachable inside the SENIOR|DROP guard
    const roleGenitive = select(impact.role, {
      SENIOR: 'сеньйора',
      DROP: 'дропа',
      other: 'співробітника',
    })
    // Stryker disable next-line ObjectLiteral,StringLiteral: same literal-options requirement and the same unreachable `other` as roleGenitive above
    const pairWord = select(impact.role, { SENIOR: 'сеньйор', DROP: 'дроп', other: 'співробітник' })
    return (
      <>
        <Trans>
          <Name>{entityName}</Name> та команда «<strong>{impact.teamName}</strong>» — пов’язана
          пара, прибрати по одному не можна. В архів підуть: профіль {roleGenitive}, команда і всі
          її проєкти (
          <Plural
            value={impact.projectsCount ?? 0}
            one="# проєкт"
            few="# проєкти"
            many="# проєктів"
            other="# проєкту"
          />
          {namesSuffix}).
        </Trans>{' '}
        <Trans>
          HR/бухгалтери в команді (
          <Plural
            value={impact.hrAccountantsOnTeam ?? 0}
            one="# HR/бухгалтер"
            few="# HR/бухгалтери"
            many="# HR/бухгалтерів"
            other="# HR/бухгалтера"
          />
          ) і джуніори на цих проєктах (
          <Plural
            value={impact.juniorsAffected ?? 0}
            one="# джуніор"
            few="# джуніори"
            many="# джуніорів"
            other="# джуніора"
          />
          ) залишаються активними учасниками і продовжують отримувати оплату — архівація команди й
          проєктів їх не стосується.
        </Trans>{' '}
        <Trans>
          Відновлення можливе — пара «{pairWord}+команда» повернеться, але проєкти відновлювати
          окремо.
        </Trans>
      </>
    )
  }

  if (impact.role === 'HR') {
    return (
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
        <strong>
          <Plural
            value={impact.teamsCount ?? 0}
            one="# команди"
            few="# команд"
            many="# команд"
            other="# команди"
          />
        </strong>{' '}
        (роль HR). Самі команди залишаться активними.
      </Trans>
    )
  }

  if (impact.role === 'ACCOUNTANT') {
    return (
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
        <strong>
          <Plural
            value={impact.teamsCount ?? 0}
            one="# команди"
            few="# команд"
            many="# команд"
            other="# команди"
          />
        </strong>{' '}
        (роль бухгалтера). Самі команди залишаться активними.
      </Trans>
    )
  }

  if (impact.role === 'JUNIOR') {
    return (
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
        <strong>
          <Plural
            value={impact.projectsCount ?? 0}
            one="# активного проєкту"
            few="# активних проєктів"
            many="# активних проєктів"
            other="# активного проєкту"
          />
        </strong>
        . Самі проєкти залишаться активними.
      </Trans>
    )
  }

  // ADMIN — the only remaining member of the role union.
  return (
    <Trans>
      В архів піде профіль <Name>{entityName}</Name>. Нічого пов’язаного архівувати не треба.
    </Trans>
  )
}
```

The text of the "pair + team" branch is moved from `renderImpactText` verbatim, with two fixes: `other` of `<Plural>` — the form for fractional numbers (genitive singular: «проєкту», «джуніора»), as `uk` CLDR requires; «команди/проєктів» → «команди й проєктів» instead of `/` in the text. If the #700 text review fixed `other` differently, leave it as in the catalog — this is a question for `copy-reviewer`, not for this plan.

`en` (the second original, a draft for `copy-reviewer`): "{name}’s profile will be archived together with all their projects (…)", "Restoring is possible — the profile comes back, but projects must be restored separately.", "{name}’s profile will be archived and removed from {n, plural, one {# team} other {# teams}} (HR role). The teams themselves stay active."

The `// Stryker disable` comments in the new file — only with a reason on the same line (the guard). The existing suppressions from `renderImpactText` are moved together with the code, the reason text is not lost.

The `ACCOUNTANT`, `JUNIOR`, `ADMIN` branches and the continuation of the SENIOR/DROP branch with a team the implementer writes out fully per the sample above. The comment `// …далее` does not remain in the final code — it stands only in the plan.

In `components/archive/ArchiveConfirmDialog.tsx`:

```tsx
if (entityType === 'user' && impact.type === 'user') {
  return <UserArchiveImpact entityName={entityName} impact={impact} />
}
```

There too, in the `project` branch: «Фінансова історія (транзакції, інвойси)» → «(транзакції, рахунки)» — glossary **Invoice**, «інвойс» is in `_Избегать_`. The existing `components/archive/__tests__/ArchiveConfirmDialog.test.tsx` for the user branches moves to the testids from `UserArchiveImpact`.

Run: `pnpm --filter @crm/web test -- UserArchiveImpact archive/__tests__/ArchiveConfirmDialog` → PASS.

- [ ] **Step 3: Renaming `components/users/ArchiveConfirmDialog` → `ArchiveUserConfirmDialog` (the deferred item 3)**

```bash
git mv apps/web/app/components/users/ArchiveConfirmDialog.tsx apps/web/app/components/users/ArchiveUserConfirmDialog.tsx
git mv apps/web/app/components/users/__tests__/ArchiveConfirmDialog.test.tsx apps/web/app/components/users/__tests__/ArchiveUserConfirmDialog.test.tsx
```

In the file: `export function ArchiveConfirmDialog` → `export function ArchiveUserConfirmDialog`; the body of `ImpactWarning` is removed entirely (together with «{projectsCount} шт.», `senior+team`, `cascade`, `JUNIOR` — COPY-H-ppl-6) and replaced with `impact?.type === 'user' ? <UserArchiveImpact entityName={user.displayName} impact={impact} /> : null`. The rest of the text — templates B/C:

| Was                                                           | `uk`                                                                                                                             | `en`                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| «Архивировать пользователя»                                    | Архівувати користувача                                                                                                           | Archive user                                                            |
| «Для подтверждения введите имя:»                               | Для підтвердження введіть ім’я:                                                                                                  | To confirm, type the name:                                              |
| «Отмена» / «Архивировать» / «Архивация...»                     | Скасувати / Архівувати / Архівуємо…                                                                                              | Cancel / Archive / Archiving…                                           |
| Success toasts by role                                         | `select(role, { SENIOR: 'Сеньйора й команду архівовано', DROP: 'Дропа й команду архівовано', other: 'Користувача архівовано' })` | `Senior and team archived` / `Drop and team archived` / `User archived` |
| `err?.response?.data?.message ?? 'Ошибка при архивации'` (M-2) | `getApiErrorMessage(err, t\`Не вдалося архівувати користувача — спробуйте ще раз\`)`                                             | Could not archive the user — try again                                  |

The success toast is assembled so the role stands in the accusative case inside `select` (lesson item 9): «Сеньйора й команду архівовано» — an impersonal form, independent of gender. `select` takes `user.role`, which all six values reach, so the `other` branch is reachable here (HR, ACCOUNTANT, JUNIOR, ADMIN) — the test runs all six values.

Imports: `routes/_authenticated/users/index.tsx` → `import { ArchiveUserConfirmDialog } from '@/components/users/ArchiveUserConfirmDialog'`; `user-profile/admin-actions/ArchiveUserDialog.tsx` → `import { UserArchiveImpact } from '@/components/archive/UserArchiveImpact'` instead of `ImpactWarning`, plus the migration of its five lines. Check: `git grep -n "components/users/ArchiveConfirmDialog\|ImpactWarning" -- apps/web` → empty.

- [ ] **Step 4: `UserRow.tsx`, `routes/_authenticated/users/index.tsx`**

`UserRow`: template H (a single value) and `formatRelativeTime(user.createdAt, locale)` instead of `formatDistanceToNow(…, { locale: ru })` (the `date-fns` and `date-fns/locale` imports are removed). «В архиве» → «В архіві».

`users/index.tsx`: the role filter — template H (a list); «Все роли» → «Усі ролі»; «Пользователи не найдены» → the canon text «Нічого не знайдено — скиньте фільтри». If «Пользователи не найдены» is shown also for an empty database without filters, split the branches: without filters — «Користувачів поки немає».

- [ ] **Step 5: Teams — `team/index.tsx`, `team/$teamId.tsx`**

`team/index.tsx`: `placeholder="Сортування"` (COPY-H-ppl-1) → `t\`Сортування\`` (the word in `uk` is correct, `en` — "Sort by"). «Ошибка при создании» (M-2) → `getApiErrorMessage(err, t\`Не вдалося створити команду — спробуйте ще раз\`)`. «Ничего не найдено» (M-14) → the canon. The technologies hint (M-13) → the canon. `a.name.localeCompare(b.name)` → `compareNames(locale)(a.name, b.name)`.

`team/$teamId.tsx`: the local `const ROLE_LABELS` is removed; two places `{ROLE_LABELS[x.role] ?? x.role}` → template H. `ROLE_VARIANT` stays (it is not text). «Создана {дата}» → `<Trans>Створено {createdAt}</Trans>` with `formatDate(team.createdAt, locale, 'long')`. «Ошибка добавления» → `getApiErrorMessage(err, t\`Не вдалося додати учасника — спробуйте ще раз\`)`; «Не удалось обновить команду» → `getApiErrorMessage(err, t\`Не вдалося оновити команду — спробуйте ще раз\`)` (M-2). «Нет доступных пользователей» (M-14) — if it is a search result, then the canon «Нічого не знайдено — скиньте фільтри»; if the candidate list is empty without a search — «Немає користувачів, яких можна додати». Two `localeCompare` → `compareNames`.

- [ ] **Step 6: Chips and dialogs — `HrChipsField`, `AccountantChipField`, `RejoinTeamDialog`, `CreateWizardStepper`**

COPY-M-ppl-6: «Нет доступных HR» → «Немає вільних HR — створіть HR у розділі «Команда»» / "No HR available — create one in the Team section"; the same for accountants. COPY-L-ppl-3 (`RejoinTeamDialog`): `{mutation.isPending ? 'Сохранение...' : 'Готово'}` → `{mutation.isPending ? <Trans>Збереження…</Trans> : <Trans>Зберегти</Trans>}`.

- [ ] **Step 7: Tests, E2E sweep, gates, commit**

E2E: the badges in the row (`users.spec.ts` «Администратор», «Синьор»; `crm/users/users-refactor.spec.ts` the badge) → template I with «Адміністратор», «Сеньйор»; the filter `users.spec.ts` «Все роли»/«Джун» → «Усі ролі»/«Джуніор» via the catalog; `team.spec.ts` (31 lines) and the archive specs — per the sweep. The `user-dialog-role-trigger` clicks → «Синьор» **do not touch**: this is `UserDialog`, PR3.

The PR2 file check (there must be no lines):

```bash
python3 - <<'EOF'
import re, pathlib
files = ['apps/web/app/components/archive/UserArchiveImpact.tsx',
         'apps/web/app/components/archive/ArchiveConfirmDialog.tsx',
         'apps/web/app/components/users/ArchiveUserConfirmDialog.tsx',
         'apps/web/app/components/users/AccountantChipField.tsx',
         'apps/web/app/components/users/HrChipsField.tsx',
         'apps/web/app/components/users/CreateWizardStepper.tsx',
         'apps/web/app/components/users/RejoinTeamDialog.tsx',
         'apps/web/app/components/users/UserRow.tsx',
         'apps/web/app/components/user-profile/admin-actions/ArchiveUserDialog.tsx',
         'apps/web/app/routes/_authenticated/users/index.tsx',
         'apps/web/app/routes/_authenticated/team/index.tsx',
         'apps/web/app/routes/_authenticated/team/$teamId.tsx']
for f in files:
    for n, l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(), 1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f, n, l.strip())
EOF
```

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- users users-refactor team team-archive drop-archive-real drop-archive-user-real drop-archive-cascade senior-archive-regression drop-rotate-senior polish-regressions drop-add-senior drop-create drop-create-ui-regressions senior-create-default
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add \
  apps/web/app/components/archive/UserArchiveImpact.tsx \
  apps/web/app/components/archive/ArchiveConfirmDialog.tsx \
  apps/web/app/components/archive/__tests__/UserArchiveImpact.test.tsx \
  apps/web/app/components/archive/__tests__/ArchiveConfirmDialog.test.tsx \
  apps/web/app/components/users/ArchiveUserConfirmDialog.tsx \
  apps/web/app/components/users/__tests__/ArchiveUserConfirmDialog.test.tsx \
  apps/web/app/components/users/AccountantChipField.tsx \
  apps/web/app/components/users/HrChipsField.tsx \
  apps/web/app/components/users/CreateWizardStepper.tsx \
  apps/web/app/components/users/RejoinTeamDialog.tsx \
  apps/web/app/components/users/UserRow.tsx \
  apps/web/app/components/users/__tests__/CreateWizardStepper.test.tsx \
  apps/web/app/components/users/__tests__/ProfileNameLink.test.tsx \
  apps/web/app/components/users/__tests__/RejoinTeamDialog.schema-translation.test.tsx \
  apps/web/app/components/users/__tests__/UserRow.test.tsx \
  apps/web/app/components/user-profile/admin-actions/ArchiveUserDialog.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/ArchiveUserDialog.test.tsx \
  apps/web/app/routes/_authenticated/users/index.tsx \
  apps/web/app/routes/_authenticated/team/index.tsx \
  "apps/web/app/routes/_authenticated/team/\$teamId.tsx" \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/crm/team/team-archive.spec.ts \
  apps/e2e/tests/crm/users/users-refactor.spec.ts \
  apps/e2e/tests/drop-archive-real.spec.ts \
  apps/e2e/tests/drop-archive-user-real.spec.ts \
  apps/e2e/tests/drop-archive-cascade.spec.ts \
  apps/e2e/tests/drop-rotate-senior.spec.ts \
  apps/e2e/tests/polish-regressions.spec.ts \
  apps/e2e/tests/team.spec.ts \
  apps/e2e/tests/users.spec.ts
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3b wave (b) part 2 — users list, teams, user archive to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)
EOF
)"
```

`git mv` has already staged the removal of the old paths. `git status` before the commit will show `renamed:` for both files.

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: `/users` (the list, the role filter, an empty result), `/team` (the list, sorting, an empty result, creation), `/team/$teamId` (members, adding), the archival dialogs for SENIOR with a team, SENIOR without a team, HR (5 teams), JUNIOR — from the `/users` list **and** from the profile menu (both render `UserArchiveImpact`). `copy-reviewer` — on `uk` and `en` separately, with a separate line — the verdict on COPY-L-31 and L-32. `security-reviewer` — mandatory (archival, team composition).

---

## Task 3 (PR3): the user wizard, résumé, removing the legacy

**Files:**

| File                                                        | Cyr. lines | Pattern(s)       | Audit findings / note                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/users/UserDialog.tsx`                           | 142 / 119  | A, B, C, D, G, H | COPY-M-ppl-2 (5 fallbacks), M-3 («переводе контракта»), M-6 («Нет активного шаблона»), M-13 (three examples), H-3 («Нельзя сменить свою роль ADMIN»); the manual form «команд(ы) доступно» → `<Plural>`; the «Платёжные реквизиты» section per the canon |
| `components/user-profile/resume/ResumeTab.tsx`              | 39 / 36    | B, C             | —                                                                                                                                                                                                                                     |
| `components/user-profile/resume/ResumeLayoutPanel.tsx`      | 29 / 29    | A, C             | `` `Показать «${SECTION_LABELS[key]}»` ``/`` `Скрыть «…»` `` — a nested substitution of a translatable string (audit B) → `SECTION_LABEL_MESSAGES` + `t\`Показати «${label}»\``, the `aria-label`/`title` pair — one variable for both |
| `components/user-profile/resume/ResumeStatusPanel.tsx`      | 17 / 15    | A, F             | `formatResetTime` → `formatDate(at, locale, 'dateTime')` (a new style); `failureHint` — template A                                                                                                                                      |
| `components/user-profile/resume/ResumeIntake.tsx`           | 14 / 13    | B, C, G          | COPY-M-ppl-9 → `translateZodCode('RESUME_TEXT_TOO_SHORT')` (the text with the number is already in the registry, stage 4)                                                                                                              |
| `components/user-profile/resume/ResumeExperienceEditor.tsx` | 13 / 13    | C                | Six `aria-label` of the form `` `Переместить место работы ${index + 1} вверх` `` → `t\`Перемістити місце роботи ${position} вгору\`` (`position = index + 1` before the macro)                                                        |
| `components/user-profile/resume/ResumePdfPreview.tsx`       | 8 / 7      | C                | COPY-L-ppl-5: ``filename={`Резюме — ${…}.pdf`}`` → `t\`Резюме — ${name}.pdf\`` (`en`: "CV — {name}.pdf")                                                                                                                                |
| `components/user-profile/resume/ResumeSectionCard.tsx`      | 7 / 7      | B                | —                                                                                                                                                                                                                                     |
| `components/users/constants.ts`                             | 7 / 5      | —                | Remove `ROLE_LABELS` (5 value lines and 1 comment line inside the block); the remaining line — a data example in the JSDoc of `getInitials` («Иван Иванов» → «ИИ»), do not migrate                                                      |
| `components/ui/role-select.tsx`                             | —          | —                | Remove the legacy `ROLE_LABELS` and the comment above it; update the comment at `ROLE_BADGE_VARIANT` («See ROLE_LABELS»)                                                                                                                 |
| `packages/shared/src/i18n/format.ts` + `format.spec.ts`     | —          | F                | The `'dateTime'` style                                                                                                                                                                                                                 |

Tests: `components/users/__tests__/{UserDialog.create-wizard.test.tsx (40), UserDialog.edit-drop-share.test.tsx (4), UserDialog.edit-prefill.test.tsx (8), UserDialog.pending-share-hygiene.test.tsx (21), UserDialog.share-role-scoping.test.tsx (23), UserDialog.test.tsx (4)}`, `components/user-profile/resume/__tests__/{ResumeExperienceEditor.test.tsx (0), ResumeLayoutPanel.test.tsx (7), ResumeTab.test.tsx (39)}`, `components/ui/__tests__/role-select.locale.test.tsx` (the case "legacy not touched" → "legacy removed"), `components/layout/__tests__/ImpersonationBanner.spec.tsx` (the comment references `ROLE_LABELS`, fix the comment text).

E2E: **17 clicks** and the rest from the "Distribution", the PR3 row, plus the sweep output.

**Interfaces:**

- Consumes: everything in PR1/PR2 (`useRoleLabel`, `ROLE_LABEL_MESSAGES`, `translateZodCode`, `translateZodMessage`, `getApiErrorMessage`, `formatDate`, `useLocale`); `ShareSlider`, `RoleSelect` (already migrated in 3a); `ContractEditor`, `ContractActionBar`, `useEmployeeContract` (migrated in PR1 — `UserDialog` only renders them).
- Produces: `formatDate(value, locale, style: 'short' | 'long' | 'month' | 'monthYear' | 'dateTime')` — `'dateTime'` = day, month in words, hours and minutes, **in the browser's local zone** (without `timeZone: 'UTC'`, unlike the other styles: the quota reset time the person reads by their own clock). `ROLE_LABELS` is removed from `@/components/ui/role-select` and from `@/components/users/constants`. After PR3 `git grep -nP '\bROLE_LABELS\b' apps/web/app` finds only local maps **outside** the perimeter (`projects/$projectId.tsx`, `admin/contracts.{index,$role}.tsx` — wave c; "Findings outside the perimeter").

### Danger: removing the legacy — only after the merge of PR1 and PR2

`role-select.ROLE_LABELS` is read by `UserProfileHeader`, `ContractTab`, `TeamTab` (PR1). `constants.ROLE_LABELS` is read by `UserRow`, `users/index.tsx` (PR2) and `UserDialog` (this PR). If the export is removed earlier, typecheck falls for everyone who has not migrated yet. Step 0 checks that both PRs are merged, and Step 3 — that there are zero consumers.

### Acceptance criteria (PR3)

1. `UserDialog.tsx` in `uk`/`en`: the roles in the picker and the trigger — from `ROLE_LABEL_MESSAGES`; COPY-M-ppl-2 (in the wizard), M-3, M-6 (the contract step), M-10 and M-13 (in the wizard), H-3 (the hint about your own role) closed; «команд(ы) доступно» — `<Plural>`; Zod messages — registry codes.
2. `ROLE_LABELS` removed from `role-select.tsx` and from `components/users/constants.ts`; the "legacy removed" tests are green; `ROLE_LABELS` does not occur in the wave's perimeter.
3. Résumé in `uk`/`en`; COPY-M-ppl-9 and L-5 (résumé) closed; `formatDate` got the `'dateTime'` style with a test; `formatResetTime` accepts the locale.
4. 17 clicks `name: 'Синьор'` in 5 specs go through `assertInCatalog(uk, 'Сеньйор')`; `git grep "name: 'Синьор'" -- apps/e2e/tests` empty.
5. The final wave check (three Step 6 commands) gave the expected result, the output — in the PR body.
6. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR3 E2E specs are green.
7. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
8. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
9. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`; `security-reviewer` APPROVE.

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel
git fetch origin main
git grep -nP "\bROLE_LABELS\b" origin/main -- apps/web/app ':!**/__tests__/**'
```

Expected: occurrences only in `role-select.tsx` (the declaration), `components/users/constants.ts` (the declaration), `components/users/UserDialog.tsx` and the local maps outside the perimeter (`projects/$projectId.tsx`, `admin/contracts.index.tsx`, `admin/contracts.$role.tsx`). Any other occurrence — means PR1 or PR2 is not merged or missed something: stop, `.blocked.md`.

- [ ] **Step 1: Test — the roles in the wizard from the canon, the legacy removed (fails)**

In the existing `components/users/__tests__/UserDialog.create-wizard.test.tsx` (it already has `render` with `I18nTestProvider`, `beforeEach(loadCatalog('uk'))` and mocks of `@/context/auth`, the router and `api`) add:

```tsx
import { within } from '@testing-library/react'

describe('role picker reads ROLE_LABEL_MESSAGES', () => {
  it.each([
    ['uk', ['Сеньйор', 'Джуніор', 'HR', 'Бухгалтер', 'Дроп']],
    ['en', ['Senior', 'Junior', 'HR', 'Accountant', 'Drop']],
  ] as const)(
    '%s: every CREATE_ALLOWED_ROLES option is the canon label, no legacy or enum',
    async (locale, labels) => {
      await loadCatalog(locale)
      const user = userEvent.setup()
      render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
      await user.click(screen.getByTestId('user-dialog-role-trigger'))
      const listbox = await screen.findByRole('listbox')
      for (const label of labels) {
        expect(within(listbox).getByRole('option', { name: label })).toBeInTheDocument()
      }
      expect(listbox.textContent).not.toMatch(/Синьор|Джун\b|SENIOR|JUNIOR|ACCOUNTANT|DROP/)
    },
  )
})
```

In `components/ui/__tests__/role-select.locale.test.tsx` replace the case `'leaves the legacy ROLE_LABELS export untouched (type: string) …'` with:

```tsx
describe('legacy ROLE_LABELS exports are gone (wave b, PR3)', () => {
  it('role-select no longer exports ROLE_LABELS', async () => {
    expect('ROLE_LABELS' in (await import('../role-select'))).toBe(false)
  })
  it('components/users/constants no longer exports ROLE_LABELS', async () => {
    expect('ROLE_LABELS' in (await import('@/components/users/constants'))).toBe(false)
  })
})
```

Run: `pnpm --filter @crm/web test -- UserDialog.create-wizard role-select.locale` → FAIL.

- [ ] **Step 2: `UserDialog.tsx` — migration**

The file is the largest in the wave (2596 lines), so go by wizard section, with a `wip:` commit after each: «Ідентичність» → «Роль і мова» → «Дані для контракту» → «Контакти» → «Професія» → «Фінанси» → «Реквізити для виплат» → «Команда» → the contract step → the email change dialog → the mutation toasts.

Key places:

- **Role picker**: `{ROLE_LABELS[r]}` in `SelectItem` → template H (a list); `{ROLE_LABELS[role]}` in the trigger — template H (a single value). The hardcode «Синьор» and «(HR может создавать только синьоров)» → `i18n._(ROLE_LABEL_MESSAGES.SENIOR)` and `<Trans>(HR може створювати лише сеньйорів)</Trans>`. The `hint` «Нельзя сменить свою роль ADMIN» (H-3, a raw enum) → `t\`Свою роль змінити не можна\``.
- **Credentials**: «Для роли «{ROLE_LABELS[role]}» доступна только оплата через USDT ERC-20» → `<Trans>Для ролі «{roleLabel}» доступні лише виплати в USDT ERC-20</Trans>` (the role in the nominative case inside quotes, lesson item 9). «Способ оплаты» (the label and `ariaLabel`) → «Спосіб виплати» (the canon). «USDT ERC-20 кошелёк» → «Гаманець USDT (ERC-20)» — exactly the string that is in `RequisitesEditForm` after PR1: one key, and `requisites-warning.spec.ts` asserts one caption for both forms. «ФИО получателя (ФОП)», «РНОКПП (ИНН ФОП)» → «ПІБ отримувача (ФОП)», «РНОКПП». The placeholders — the canon (M-13): «Іваненко Іван Іванович» (both full-name fields — one example, now they are two different), «м. Київ, вул. Хрещатик, 1», «ПриватБанк».
- **Drop team**: `'команда доступна' / 'команд(ы) доступно'` → `<Plural value={n} one="# команда доступна" few="# команди доступні" many="# команд доступно" other="# команди доступно" />`.
- **Mutation toasts** (M-2, M-3) — `explainUserMutationError(err, <fallback>)`, the fallback names the action and says the data is in place:

| Was                                   | `uk`                                                                       | `en`                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| «Ошибка при создании»                 | Не вдалося створити користувача — дані у формі збережено, спробуйте ще раз | Could not create the user — the form keeps your data, try again  |
| «Ошибка при создании дропа»           | Не вдалося створити дропа — дані у формі збережено, спробуйте ще раз       | Could not create the drop — the form keeps your data, try again  |
| «Ошибка при обновлении» (×2)          | Не вдалося зберегти зміни — дані у формі збережено, спробуйте ще раз       | Could not save the changes — the form keeps your data, try again |
| «Ошибка при переводе контракта» (M-3) | Не вдалося позначити контракт готовим до підписання                        | Could not mark the contract as ready to sign                     |

«Ошибка при переводе» — this is the status change `DRAFT → READY_TO_SIGN`, not a text translation: the wording is taken from the button's words («Позначити готовим до підписання»), otherwise `en` would get "translation".

- **Successes**: «Пользователь создан, контракт готов к подписанию» → «Користувача створено, контракт готовий до підписання»; «Пользователь обновлён» → «Зміни збережено» (`admin-actions.spec.ts` asserts the toast → template I); the multiline `` `Сохранено. Предложение отправлено синьору: ${pending.percent}%…` `` → `<Trans>` / `t` as one sentence with `{percent}`.
- **Contract step**: «Нет активного шаблона» (M-6) → «Немає активного шаблону контракту для цієї ролі — контракт можна додати пізніше з профілю користувача; натисніть «Далі», щоб продовжити». «Черновик» / «Отметить готовым к подписи» / «Отправка...» → «Чернетка» / «Позначити готовим до підписання» / «Надсилаємо…». The `frozenBanner` → the status canon.
- **Email change dialog**: «Убедись, что пользователь…» (addressing with «ты» in an interface where it is «вы» everywhere) → «Переконайтеся, що користувач знає про зміну і за потреби змінить свій обліковий запис Google» («обліковий запис Google» — the glossary).
- **Zod** inside the render (`z.string().email('Некорректный email')`, «Имя минимум 2 символа», «ФИО минимум 5 символов», «ФИО получателя минимум 3 символа» — three manual forms of the word «символ», audit B) → `'zod.EMAIL_INVALID'`, `'zod.DISPLAY_NAME_MIN'`, `'zod.LEGAL_FULL_NAME_MIN'`, `'zod.RECIPIENT_NAME_MIN'` + `translateZodMessage` at the field-error display place. The numbers live in the registry (stage 4), they are not duplicated in JSX.
- «Язык интерфейса» (the field added in stage 2) and its `hint` → «Мова інтерфейсу» / «Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі». The items `Українська`/`English` — endonyms, not translated.

- [ ] **Step 3: Removing the legacy `ROLE_LABELS` (the deferred item 1)**

`components/users/constants.ts` — remove `export const ROLE_LABELS` entirely. `components/ui/role-select.tsx` — remove `export const ROLE_LABELS` and the comment «task-i18n-stage3a (Task 1), Step 1/2 — legacy export, LEFT UNCHANGED …» above it; at `ROLE_BADGE_VARIANT` rewrite the comment «See ROLE_LABELS — placeholder …» without the reference to the removed export.

```bash
git grep -nP "\bROLE_LABELS\b" -- apps/web/app ':!**/__tests__/**'
# expected: only projects/$projectId.tsx, admin/contracts.index.tsx, admin/contracts.$role.tsx (local maps outside the perimeter)
git grep -nP "\bROLE_LABELS\b" -- apps/web/app/**/__tests__
# expected: only comments — fix the text in ImpersonationBanner.spec.tsx and UserProfileHeader.test.tsx
```

Run: `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web test -- UserDialog role-select` → PASS.

- [ ] **Step 4: Résumé + the `'dateTime'` style**

```ts
// packages/shared/src/i18n/format.spec.ts — add
it("formatDate 'dateTime' keeps the reader's local clock (no UTC shift)", () => {
  const d = new Date(2026, 8, 24, 14, 5) // local 24 Sep 2026 14:05
  expect(formatDate(d, 'en', 'dateTime')).toMatch(/24 September.*14:05/)
  expect(formatDate(d, 'uk', 'dateTime')).toMatch(/24 вересня.*14:05/)
})
```

```ts
// packages/shared/src/i18n/format.ts — extend the style union and STYLE_OPTS
dateTime: { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' },
// without timeZone: 'UTC' — see Interfaces
```

`ResumeStatusPanel.formatResetTime(iso)` → `formatResetTime(iso, locale)`: `Number.isNaN` → `msg\`найближчим часом\``, otherwise `formatDate(at, locale, 'dateTime')`. The string goes into «Ліміт оновиться {when}» as one `<Trans>` — without concatenation. `failureHint` (a `switch` by code) — template A, a `msg` per branch.

`ResumeIntake.tsx`: `toast.error('Текст резюме слишком короткий')` (M-9) → `toast.error(translateZodCode('RESUME_TEXT_TOO_SHORT'))` — the same text as the server check, one string for two packages.

`ResumeLayoutPanel.tsx`: `SECTION_LABELS` → `SECTION_LABEL_MESSAGES: Record<ResumeSectionKey, MessageDescriptor>` (template A); `` `Показать «${…}»` `` / `` `Скрыть «${…}»` `` → `const label = i18n._(SECTION_LABEL_MESSAGES[key])`, then `t\`Показати «${label}»\`` / `t\`Приховати «${label}»\``. One variable goes into both `aria-label` and `title` (audit B: the pair easily diverges).

The rest of the `resume/*` files — templates B/C, ellipses `…`. E2E `crm/senior-resume.spec.ts` («Распознаём резюме» and the rest from the sweep) — template I.

- [ ] **Step 5: The 17 E2E clicks «Синьор» and the rest of the wizard strings (the deferred item 1, COPY-H-8 #707)**

In each of the 5 specs — one `const uk = await loadMessages('uk')` at the start of the test (or in `beforeEach`, if the spec is arranged that way), then:

```ts
// was
await page.getByRole('option', { name: 'Синьор' }).click()
// became
await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
```

Places: `users.spec.ts` ×5, `drop-add-senior.spec.ts` ×6, `senior-create-default.spec.ts` ×3, `crm/users/users-refactor.spec.ts` ×2, `drop-create-ui-regressions.spec.ts` ×1 — 17 in total. In `drop-create-ui-regressions.spec.ts` the comment «UserDialog renders the legacy `ROLE_LABELS` map … Flip to assertInCatalog(uk, 'Сеньйор') together with those 17 other call sites» is removed — this is exactly that edit. There too the clicks `name: 'Дроп'` (×3) → `assertInCatalog(uk, 'Дроп')` (the word is the same, but the assert goes through the catalog — the spec rule §8).

The count check:

```bash
git grep -c "name: 'Синьор'" origin/main -- apps/e2e/tests   # before: 17 in 5 files
git grep -c "name: 'Синьор'" -- apps/e2e/tests                # after: empty
```

The rest of the wizard strings: `admin-actions.spec.ts` (the title «Редактировать пользователя» → «Редагувати користувача», the role trigger `toContainText('Джун')` → `assertInCatalog(uk, 'Джуніор')`, the toast), `drop-duplicate-email.spec.ts` («Дроп создан»), `requisites-warning.spec.ts` (the wallet caption in the wizard), `crm/create-wizard.spec.ts` — per the sweep.

- [ ] **Step 6: Tests, sweep, the final wave check, gates, commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/shared test -- src/i18n/format.spec.ts
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- users users-refactor drop-add-senior senior-create-default drop-create-ui-regressions drop-create drop-duplicate-email admin-actions requisites-warning create-wizard senior-resume
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
```

The final wave (b) check — performed in PR3 and inserted into the PR body:

```bash
# 1. there are no Russian letters in the wave's migrated files (exception — job-sourcing, outside the wave)
python3 - <<'EOF'
import re, pathlib, subprocess
out = subprocess.run(['git', 'ls-files', 'apps/web/app/components/users', 'apps/web/app/components/user-profile',
                      'apps/web/app/components/onboarding', 'apps/web/app/routes/_authenticated/team',
                      'apps/web/app/routes/_authenticated/users', 'apps/web/app/routes/_authenticated/onboarding',
                      'apps/web/app/components/archive'], capture_output=True, text=True).stdout.split()
bad = 0
for f in out:
    if re.search(r'__tests__|\.(spec|test)\.', f):
        continue
    for n, l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(), 1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f, n, l.strip()); bad += 1
print('violations:', bad)
EOF
# 2. there is no branching by the server error text (audit §4)
git grep -nE "message\)?\.(toLowerCase\(\)\.)?includes\('" -- apps/web/app/components/users apps/web/app/components/user-profile apps/web/app/components/onboarding
# 3. there is no role legacy in the perimeter
git grep -nP "\bROLE_LABELS\b" -- apps/web/app/components apps/web/app/routes/_authenticated/{team,users,onboarding,profile}
```

Expected: 1 — `violations: 0`; 2 — empty; 3 — empty.

```bash
git add \
  apps/web/app/components/users/UserDialog.tsx \
  apps/web/app/components/users/constants.ts \
  apps/web/app/components/ui/role-select.tsx \
  apps/web/app/components/ui/__tests__/role-select.locale.test.tsx \
  apps/web/app/components/layout/__tests__/ImpersonationBanner.spec.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileHeader.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.create-wizard.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.edit-drop-share.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.edit-prefill.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.pending-share-hygiene.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.share-role-scoping.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.test.tsx \
  apps/web/app/components/user-profile/resume/ResumeTab.tsx \
  apps/web/app/components/user-profile/resume/ResumeLayoutPanel.tsx \
  apps/web/app/components/user-profile/resume/ResumeStatusPanel.tsx \
  apps/web/app/components/user-profile/resume/ResumeIntake.tsx \
  apps/web/app/components/user-profile/resume/ResumeExperienceEditor.tsx \
  apps/web/app/components/user-profile/resume/ResumePdfPreview.tsx \
  apps/web/app/components/user-profile/resume/ResumeSectionCard.tsx \
  apps/web/app/components/user-profile/resume/__tests__/ResumeLayoutPanel.test.tsx \
  apps/web/app/components/user-profile/resume/__tests__/ResumeTab.test.tsx \
  packages/shared/src/i18n/format.ts \
  packages/shared/src/i18n/format.spec.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/users.spec.ts \
  apps/e2e/tests/drop-add-senior.spec.ts \
  apps/e2e/tests/senior-create-default.spec.ts \
  apps/e2e/tests/crm/users/users-refactor.spec.ts \
  apps/e2e/tests/drop-create-ui-regressions.spec.ts \
  apps/e2e/tests/admin-actions.spec.ts \
  apps/e2e/tests/drop-duplicate-email.spec.ts \
  apps/e2e/tests/requisites-warning.spec.ts \
  apps/e2e/tests/crm/senior-resume.spec.ts \
  apps/e2e/tests/crm/create-wizard.spec.ts
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,shared,i18n): stage 3b wave (b) part 3 — user wizard, senior CV, drop legacy ROLE_LABELS

ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)
EOF
)"
```

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: the creation wizard — each step for SENIOR, DROP (with the drop team selection), JUNIOR and HR; editing (including the email change dialog and the hint «Свою роль змінити не можна»); the contract step without a template; the résumé tab (intake, recognition, the quota error with the reset time, the section layout). The main risk at 320 — long Ukrainian field captions in the two-column wizard sections. `copy-reviewer` — on `uk` and `en` separately. `security-reviewer` — mandatory (user creation with a role, shares, credentials).

---

## Items deferred into wave (b) — where they are closed

| #   | Item                                                                                                                  | Where                                                                                                                                  | How to check                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Legacy `ROLE_LABELS` → the canon `ROLE_LABEL_MESSAGES`, removing the legacy; 17 E2E clicks «Синьор» in 5 specs (COPY-H-8 #707) | PR1 Step 3 (profile), PR2 Step 4–5 (list, teams), PR3 Step 2–3 (wizard + removing both exports), PR3 Step 5 (the 17 clicks)           | The "legacy removed" test (PR3 Step 1); `git grep -c "name: 'Синьор'" -- apps/e2e/tests` → empty; the PR3 final check item 3                |
| 2   | COPY-L-31 (the branch without a team is silent about reversibility), COPY-L-32 («буде архівований» in 5 lines)        | PR2 Step 2                                                                                                                           | The `UserArchiveImpact` tests: «Відновлення можливе» in the branch without a team; no `архівован(ий\|а)` in any user branch                 |
| 3   | Two `ArchiveConfirmDialog` components                                                                                 | PR2 Step 2–3: rename to `ArchiveUserConfirmDialog` + the shared `UserArchiveImpact`; a full merge rejected ("Danger" Task 2)         | `git grep -n "components/users/ArchiveConfirmDialog\|ImpactWarning" -- apps/web` → empty; the name `ArchiveConfirmDialog` is exported by one file |
| 4   | `SignContractStep.tsx` — the Russian banners from #702 (COPY-M-15/16)                                                 | PR1 Step 4                                                                                                                           | The "no raw role enum" test on `uk` and `en`; 0 lines with `[ыэъё]` in the file                                                           |
| 5   | Logic duplicates outside the perimeter (like `$projectId.tsx`) — do not expand the perimeter, record                 | "Findings outside the perimeter" below                                                                                              | The section exists and is filled                                                                                                           |

---

## Trace of the `web-people` audit findings

The slice's `Findings:` — 30. Each identifier below.

| Finding       | Status on `062af6f8`                                              | Where it is closed                                                                                    |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| COPY-H-ppl-1  | open («Сортування» in the Russian interface)                     | PR2 Step 5                                                                                         |
| COPY-H-ppl-2  | open                                                              | PR1 Step 4, Step 6                                                                                 |
| COPY-H-ppl-3  | partially (#702 removed `ADMIN` in `SignContractStep`)           | PR1 Step 4, 6, 10; PR2 Step 5; PR3 Step 2                                                          |
| COPY-H-ppl-4  | closed in stage 2 (Task 8: the canon with `DROP`)                | PR1 Step 3 moves to `useRoleLabel`                                                                 |
| COPY-H-ppl-5  | partially (the role caption exists, but from the Russian legacy) | PR1 Step 3                                                                                         |
| COPY-H-ppl-6  | open                                                              | PR2 Step 2–3 (`ImpactWarning` removed)                                                             |
| COPY-H-ppl-7  | open                                                              | PR1 Step 4                                                                                         |
| COPY-H-ppl-8  | open                                                              | PR1 Step 5                                                                                         |
| COPY-H-ppl-9  | open                                                              | PR1 Step 7                                                                                         |
| COPY-H-ppl-10 | closed in stage 4 (`CONTRACT_TEMPLATE_MISSING`, `getApiErrorCode`) | check: the PR3 final check item 2                                                                 |
| COPY-M-ppl-1  | closed in stage 4 (`VALIDATION_FAILED_FORM`, 0 occurrences in the slice) | —                                                                                          |
| COPY-M-ppl-2  | open (7 fallbacks)                                               | PR2 Step 3, 5; PR3 Step 2                                                                          |
| COPY-M-ppl-3  | open                                                              | PR3 Step 2                                                                                         |
| COPY-M-ppl-4  | closed in #702 (`ADMIN_DOES_NOT_SIGN_CONTRACTS`, text from the catalog) | —                                                                                          |
| COPY-M-ppl-5  | open                                                              | PR1 Step 7                                                                                         |
| COPY-M-ppl-6  | open                                                              | PR2 Step 6 (chips); PR3 Step 2 (template); **not applied to `TeamTab`** — "Danger: masking"       |
| COPY-M-ppl-7  | open                                                              | PR1 Step 5                                                                                         |
| COPY-M-ppl-8  | open                                                              | PR1 Step 9                                                                                         |
| COPY-M-ppl-9  | the server part closed in stage 4 (`RESUME_TEXT_TOO_SHORT`)      | PR3 Step 4 (the client toast)                                                                      |
| COPY-M-ppl-10 | open                                                              | PR1 Step 6; PR3 Step 2                                                                             |
| COPY-M-ppl-11 | open                                                              | PR1 Step 6                                                                                         |
| COPY-M-ppl-12 | open                                                              | PR1 Step 6                                                                                         |
| COPY-M-ppl-13 | open                                                              | PR1 Step 6; PR2 Step 5; PR3 Step 2                                                                 |
| COPY-M-ppl-14 | open                                                              | PR1 Step 7; PR2 Step 4, 5                                                                          |
| COPY-M-ppl-15 | open                                                              | PR1 Step 4                                                                                         |
| COPY-L-ppl-1  | open                                                              | Global Constraints (`…`), all three PRs                                                            |
| COPY-L-ppl-2  | open                                                              | PR1 Step 4                                                                                         |
| COPY-L-ppl-3  | open                                                              | PR2 Step 6                                                                                         |
| COPY-L-ppl-4  | open                                                              | PR1 Step 6                                                                                         |
| COPY-L-ppl-5  | open                                                              | PR1 Step 4, 8; PR3 Step 4                                                                          |

Findings: COPY-H-ppl-1 … COPY-H-ppl-10, COPY-M-ppl-1 … COPY-M-ppl-15, COPY-L-ppl-1 … COPY-L-ppl-5 (30) — 30 rows in the table.

---

## Findings outside the perimeter (we do not expand, we record)

| What                                                                                                                                                                                                                                                                                                                                                                                                   | Whose wave / where to                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Local role maps: `routes/_authenticated/projects/$projectId.tsx` (`ROLE_LABELS`, the `?? role` fallback prints the enum), `admin/contracts.index.tsx` and `admin/contracts.$role.tsx` (`ROLE_LABELS: Record<ContractTargetRole, string>`, plus the concatenation `` `Шаблон для роли ${…} опубликован` ``), `routes/_authenticated/stats.tsx` (`ROLE_LABEL`), `routes/invoice.v.$transactionId.tsx` (`ROLE_LABEL`) | (c) — projects and the contracts admin; (d) — statistics and invoices. Template H from this plan                           |
| `components/admin-actions/AdminActionsMenu.tsx` + its test: the file **is not imported anywhere** (`git grep "components/admin-actions" -- apps/web` → empty) since #34, it has Russian «Действия», «Восстановить из архива», «Архивировать»                                                                                                                                                             | A candidate for removal, a separate light-track PR. If it is not removed, the stage 6 Russian-letters guard will fail on dead code |
| `INVOICE_SIGN_IMPERSONATION_MESSAGE` (`@crm/shared`, Russian) — the last consumer `components/invoices/invoice-detail-dialog.tsx`                                                                                                                                                                                                                                                                       | (d) — move to `API_ERROR_MESSAGES.INVOICE_SIGN_IMPERSONATION` and remove the constant (like PR1 Step 3)                    |
| `TYPE_LABELS`/`STATUS_LABELS` (`routes/_authenticated/finance/constants.ts`) read by `FinanceTab`                                                                                                                                                                                                                                                                                                       | (d)                                                                                                                        |
| `NOTIFICATION_TITLES` (`@crm/shared`) read by `NotificationSettingsTab`                                                                                                                                                                                                                                                                                                                                 | stage 4 Task 6                                                                                                             |
| The catalog holds two variants «особиста адреса» / «особистий email» (`api-error.*`, `zod-error.*`)                                                                                                                                                                                                                                                                                                     | Stage 4: align by this wave's canon («особистий email»), the `msgstr` is edited by hand in both `.po`                      |
| A full merge of the two user-archival dialogs                                                                                                                                                                                                                                                                                                                                                          | A separate task with `security-reviewer`, if needed ("Danger" Task 2)                                                      |

---

## What is NOT included

- **`components/job-sourcing/**`** — the module is paused (the owner's decision). The A2 question below.
- **`apps/api`** — the wave does not touch it (FM-5 does not apply; if needed — Global Constraints).
- **Waves (c)–(e)**: projects, interviews, vacancies, finance, statistics, invoices, documents, notifications, `/pending`. Their files are not edited, even when duplicates are found in them (see "Findings outside the perimeter").
- **Stage 6**: ESLint `lingui/no-unlocalized-strings` in error mode, the guard for Russian letters, `extract --clean` as a hard gate.
- Texts with an explicit id (`api-error.*`, `zod-error.*`) the wave does not change, only uses.

---

## Assumptions (A1 — reversible, recorded)

1. **The perimeter is adjusted** relative to the literal audit slice: `job-sourcing` (owner's pause), `LanguageSection.tsx` (already `uk`) and files without Cyrillic or with comments only are excluded; `components/archive/ArchiveConfirmDialog.tsx`, the new `UserArchiveImpact.tsx`, `role-select.tsx`, `format.ts`, three shared schemas and `CONTEXT.md` are added — each for a specific reason (the "Perimeter" table).
2. **Résumé — in PR3, not in PR1**, although it is a profile tab. This way PR1 (362 lines, 30 files) and PR3 (244) are balanced. PR3 is sequential anyway, this does not break the parallelism discipline. The shared E2E spec `crm/senior-resume.spec.ts` is edited by two PRs sequentially (PR1 — «Остаться», PR3 — the résumé texts).
3. **The two archival dialogs are not merged**: shared text plus a rename (rationale — "Danger" Task 2). Merging — a separate task.
4. **ToS in `uk` — «Умови використання»**, although the audit proposed «Умови користування». The catalog already says «умови використання» (`api-error.TOS_ACCEPT_IMPERSONATION`), the same form from the Ukrainian Google interface — the same argument as «обліковий запис Google» in the glossary.
5. **`en` for "résumé" — «CV»**: the `en-GB` locale, and «resume» in the `en` interface coincides with the verb "continue". `copy-reviewer` may reconsider — then an edit of one canon line and the catalog.
6. **COPY-M-ppl-6 not applied to `TeamTab`**: the masking invariant (the junior legend) is more important than the hint. The text stays neutral.
7. **Three Russian `*_IMPERSONATION_MESSAGE` are removed from `@crm/shared` in PR1**: they have no consumers left (lesson #700, item 8). `INVOICE_SIGN_…` stays until wave (d).
8. **The `'dateTime'` style in `formatDate` — without `timeZone: 'UTC'`**, unlike the other styles: the quota reset time is a moment the person checks against their own clock. Dates without a time are still in UTC.
9. **The genitive case after «з» in the archival text** is fixed on the fly (the catalog currently has «з 1 команда»). The finding is not from the audit — recorded here so `copy-reviewer` sees where the edit in the already-migrated file comes from.
10. **The `uk`/`en` drafts in the steps** — a guide, not the final text. The final text is approved by `copy-reviewer` per the "two originals" rubric; a divergence from the plan's draft in the PR is not a plan violation.

## Questions for the owner (A2)

```
🟠 Decisions from you — 1 item · the i18n wave (b) plan
Everything else in the plan is decided and recorded in "Assumptions".
Continue going: PR1 and PR2 of wave (b) after the merge of #706, stage 4.

❓ 1 — The résumé auto-submit module (job-sourcing) — translate or remove by stage 6?
   The module is paused since 2026-08-23, the code is not touched. It has 2 screens and 47 lines of Russian text.
   Stage 6 includes the check "not a single Russian letter in the product" — on these files it will fail.
➡️ Recommend: decide during stage 6 planning. If the pause is still in effect by then —
   add the module to the check's exceptions with a review date, do not translate a dead screen.
🔓 Reversible · ⏱ silence until the stage 6 planning → I take the recommendation and record it
   in the "Assumptions" of the stage 6 plan; the rollback = one translation of two files
```

---

## Wave (b) readiness check

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — green after each PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` on the specs from the "Distribution" and the sweep output — green; CI on all shards green.
- `pnpm i18n:extract` twice in a row — the second run does not change `.po`; in `en` 0 empty `msgstr`.
- `pnpm mutation:changed` — `survived 0`; a `NoCoverage` without an integration-hint closed by a unit test; `node scripts/devops/check-mutation-suppressions.mjs` — green.
- The PR3 final check: 0 lines with `[ыэъё]` outside comments in the perimeter; 0 branchings by the error text; 0 `ROLE_LABELS` in the perimeter; 0 clicks `name: 'Синьор'` in `apps/e2e/tests`.
- In `CONTEXT.md` there is a subsection "Wave b — `web-people`".
- `copy-reviewer`: `PASS` on `uk` and on `en` for each of the 3 PRs.
- `security-reviewer`: `APPROVE` for each of the 3 PRs.
- Screenshots 320/1440 × `uk`/`en` for each migrated screen — in each PR's body; fidelity Mode B — all widths.
- Trace: 30 `web-people` audit identifiers — each with a line in the body of the PR that closes it (`review-findings-transfer.md`).
