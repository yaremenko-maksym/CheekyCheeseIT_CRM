# CRM i18n — stage 3, wave (d) "web-finance" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate to `uk`/`en` everything in the CRM that concerns money on the web: the transaction ledger and its rows, the transaction detail dialog, drop finance, the transaction create/edit/validate dialogs, the payout-request and settlement dialogs, the cascade preview, the income statistics (`stats.tsx`) and the web part of invoices (`invoices`). This also includes the finance components wave (c) deliberately left untouched (`TransactionRow`, `TransactionDetailDialog`, `fmtUsd`, `ExchangeRates`) — they live in `finance/**` and are native here, not pulled from another slice. Four PRs, merged **sequentially** (shared `.po` + the shared hub `finance/constants.ts`), no Russian text remains in the migrated files, and two label maps of the slice (`TYPE_LABELS` 22 keys, `STATUS_LABELS` 7) and two local `ROLE_LABEL` (`stats.tsx`, `invoice.v.$transactionId.tsx`) are moved to the catalog, because after the wave there is no place left for Russian literals in them.

**Architecture:** The same single catalog `packages/shared/src/i18n/locales/{uk,en}/messages.po` and the same templates A–F as in waves (a)/(b)/(c). Five things are new in this wave. First — **`finance/constants.ts` — a hub consumed by the whole slice plus one file of another slice** (`user-profile/tabs/FinanceTab.tsx`, web-people, already merged). Its maps `TYPE_LABELS`/`STATUS_LABELS` change shape to `Record<enum, MessageDescriptor>`, so the map conversion and the migration of ALL their consumers are coupled: the old string maps live until PR4, where they are removed, exactly as `PAYMENT_TYPE_LABELS` lived PR3→PR4 in wave (c). Second — **data-in-DB: `EXPENSE_CATEGORIES`** are written to `transactions.receiver_label` as is, which is not a pure UI translation but a data migration + codes (see "Contested decision 1"). Third — **money and date formatting** is reduced to a common layer (`@crm/shared` `format.ts`), but its root `apps/web/app/lib/format-amount.ts` (`ru-RU`/`en-US` hardcoded) — is cross-slice, touched in coordination (see "Contested decision 3"). Fourth — **a raw `Error.message` on a money screen** (COPY-H-fin-3) is closed by parsing by status through the already-existing `getApiErrorMessage`/`cascade-preview.ts` pattern, without introducing new codes (the finance/invoices server codes were migrated in #704). Fifth — **money/RBAC on the surface of each PR → `security-reviewer` is mandatory on all four** (amount masking `mapTx(viewer)`, drop/senior share, company account, dividends).

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`), already set up in stage 2. React 18, Vite 6, Vitest 4, TanStack Router, Tailwind v4, shadcn/ui, `eslint-plugin-lingui` 0.16.0 (`warn`), Playwright, Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §5 (gates), §7 (wave order), §8 (tests). Audit: `docs/architecture/2026-09-19-crm-i18n-audit.md`, the `web-finance` slice (21 findings, `Findings:` at the end of the slice) and the cross-cutting themes §1–§2. Samples of format, quality and templates: the wave plans (a) `docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md` (templates A–F), (b) `docs/superpowers/plans/2026-09-24-crm-i18n-stage3b-web-people.md`, (c) `docs/superpowers/plans/2026-09-26-crm-i18n-stage3c-web-projects.md` (wave structure, templates G–L, lessons #700–#728).

**Measurement:** all the numbers below were taken by commands on `origin/main` `5c477321f` (#728, i18n 3c PR4) 2026-09-27, in a clean worktree (`git status` empty). The numbers are tied to **symbols** (`TYPE_LABELS`, `EXPENSE_CATEGORIES`, `fmtUsd`, …) and **per-file counters**, not to line numbers (`doc-durability.md`). Before starting each PR the implementer repeats the measurement (step 0 of each task): between the plan and execution other branches may have merged into `main`.

## Global Constraints

Apply to each task. Items marked "lesson" are taken from the reviews of PR #700–#728 (waves a/b/c) and already cost a separate review round once.

**Lingui versions and mechanics**

- `@lingui/*` — **5.9.5 EXACT**, a single version (`version-pins.md`). This plan upgrades nothing.
- Source text in the code — **Ukrainian** (`sourceLocale: 'uk'`). English is written by the same coder in the same PR as a second original (skill `copywriting` §5, owner decision #7). The default interface is `uk`, the second language is `en`.
- At the module level — only `msg`. `t`, `plural` and `select` at the module level are forbidden: the string freezes on import. In a component `t`/`i18n` are taken from `useLingui()` (`@lingui/react/macro`).
- **Lesson (#700): the `plural()` macro is incompatible with Stryker.** Under instrumentation `#` is not substituted. For numbers in JSX — the `<Plural>` component; outside JSX — `msg` with an ICU string and `i18n._(descriptor, { count })`. In this wave this concerns primarily `finance/utils/company-share.ts` (`pluralizeProjects`/`pluralizeIncomes`) and the four ternaries `=== 1 ? … : …` in `stats.tsx` (COPY-H-fin-4).
- **Lesson (#707): `as const satisfies Record<…, MessageDescriptor>` on a map of `msg` templates disables Stryker for the whole block** (0 mutants). Write `satisfies Record<…>` without `as const` and without `as const satisfies`. If the gate shows 0 mutants in a file that definitely has `msg`, the cause is this. In this wave `TYPE_LABELS`→`TYPE_LABEL_MESSAGES` (22 keys), `STATUS_LABELS`→`STATUS_LABEL_MESSAGES` (7), two `ROLE_LABEL`, `SIG_METHOD_LABEL`/`SIG_ROLE_LABEL`/`STATUS_LABEL` in invoices, `CASCADE_BLOCKED_REASON_MESSAGES` — all `satisfies` without `as const`.
- `i18n._()` accepts only an **expression**: `i18n._(TYPE_LABEL_MESSAGES[tx.type])` or `i18n._(MAP[key])`. An object literal with a spread breaks `lingui extract`. Three-arg — `i18n._(id, values, options)`, not a spread.
- **Lesson (#707): for records with an explicit id (`api-error.*`, `zod-error.*`) the `msgstr` is edited by hand in both `.po`.** `i18n:extract` does not overwrite an existing `msgstr`. This wave does not change texts with an explicit id, only uses them (see "Server codes #704"). If such an edit is needed — a separate line in the PR's "Assumptions" and a manual edit of both `.po`.

**Server error codes (#704) — consume, do not duplicate**

- The API error codes for finance/invoices and the Zod messages are **already migrated** (stage 4, #704): the registry in `packages/shared/src/schemas/api-errors.ts`, the client resolvers `getApiErrorMessage`, `translateZodCode`, `translateZodMessage` in `apps/web/app/lib/axios-utils.ts`. The wave **consumes** them, it does not introduce new ones.
- **COPY-H-fin-3 (raw `Error.message` in a dialog body)** is closed by parsing by status through `getApiErrorMessage` or a local status parse modeled on `finance/cascade-preview.ts` → `cascadeSaveErrorMessage` (403 → "недостатньо прав", ≥500 → "помилка на нашому боці, спробуйте пізніше", no response → "перевірте з’єднання"). Do not hand a raw `.message` outward. The test `apps/web/app/lib/axios-utils.spec.ts` pins the current resolver behavior — do not break its contract; change only those five dialogs and `ReceiptInput` that print `.message` directly.
- **COPY-M-fin-15 (loading errors without a reason/action)** — by the same technique: a status tail + a "Повторити" button. Do not introduce new codes.

**Texts (`CONTEXT.md` → "`uk`/`en` forms" + the canon table below)**

- The apostrophe — `’` (U+2019), not `'` and not `ʼ`. The ellipsis — `…` (U+2026), not `...`. Quotes: in `uk` guillemets `«…»`, in `en` typographic `“…”`.
- **Money terms are taken from the `CONTEXT.md` glossary verbatim** (it is especially strict for this slice):
  - **`PAYOUT` = «Виплата»** (the senior pays the company) — the only meaning. "Give money to a person" — that is a **розрахунок** (settle). `CONTEXT.md` §"Flagged ambiguities" decided this directly. Hence COPY-H-fin-1: `SENIOR_PAID`/`SENIOR_PENDING_PAYOUT`/`DROP_PENDING_PAYOUT`/`PAYOUT_CONFIRMED` — «розрахунок», not «виплата».
  - **The role `DROP` = «дроп»** (`_Избегать_`: посередник, підставна особа, номінал, проксі). Hence COPY-H-fin-2: `stats.tsx` `ROLE_LABEL.DROP: 'Посредник'` — a fourth synonym absent from the glossary.
  - **The unit of accounting — «транзакція»** (`_Избегать_`: платіж). Hence COPY-L-fin-20 («Факт платежу» → «Факт переказу», «Немає історії платежів» → «Переказів ще не було»).
  - **The invoice entity — «Рахунок»** (`_Избегать_`: інвойс, акт, платіжка). Hence COPY-L-fin-16 («Інвойс» ×11 → «Рахунок»).
  - **`dropShare`/`seniorShare` — «частка»** (`_Избегать_`: комісія, ставка, процент). Hence COPY-L-fin-17 (`EXPENSE_CATEGORIES` «Комиссия» → «Банківський збір», not «комісія»).
- **Lesson (#702, item 13): a raw role/status/type enum in visible text is a finding.** After replacing a literal, scan the **whole** file for a raw enum in JSX text, `aria-label`, `title`, `placeholder`. For each screen with a status/type — a test "no raw enum in the rendered screen". Exception: `USDT`, `USD`, `UAH`, `EUR`, `TX Hash`→«Хеш транзакції», `Etherscan`, `HR` — proper nouns/currencies/brands (left as is; Latin inside a Russian label is, on the contrary, a finding, COPY-M-fin-11: «Приход Admin» → «Прихід адміна»).
- **Lesson (#702, item 9): substitution into an oblique case breaks `uk`.** A name/role is substituted only in the nominative. The construction is chosen to not require a case (template K). This concerns the concatenations in `CascadeImpactPanel.tsx` (`` `Синьору ${name}` ``), `cascade-preview.ts` (lead-in + « — » + tail), `CompanySharePayoutModal.tsx` (a summary from fragments via `{' '}`).
- A toast and a refusal — **one sentence, no period at the end**, with a verb; where there is an action, it says "what to do" (COPY-M-fin-5/6/7/12/13/15: dead ends without a next step are a finding). Telegraphic style and truncations («актив. проєкта», «N прих.», «Откл.») are forbidden (COPY-L-fin-18). One situation — one text: identical empty states take the key verbatim (for "a filter found nothing" — the already-existing wave b catalog key «Нічого не знайдено — скиньте фільтри»).
- Development jargon is forbidden outward (COPY-M-fin-10): «click + audit», «dev», «нал» — in human language; an emoji (`🔗`) is moved out of the translatable string into a component.
- **Lesson (#701, item 5): check russisms by unicode, not a byte `grep`.** Before each push:

```bash
python3 -c "import re,sys,subprocess;fs=subprocess.run(['git','diff','--name-only','origin/main','--','apps/web/app'],capture_output=True,text=True).stdout.split();[print(f,i,l.strip()) for f in fs if f.endswith(('.ts','.tsx')) for i,l in enumerate(open(f,encoding='utf8'),1) if re.search('[ыЫэЭъЪёЁ]',l) and not re.match(r'\s*(//|\*|\{/\*)',l)]"
```

Strings from this output in files of **your** PR are an incomplete migration. Exceptions — test fixtures with Russian data (people's names from the seed) and comments. The letters `і ї є ґ` are already Ukrainian, not a russism; the guard targets `ы э ъ ё`. **Separately for this wave:** the old Russian values in `EXPENSE_CATEGORIES` that remained in the DB as data are not code text; their fate is decided by "Contested decision 1", not the guard.

**Tests**

- Anchors — `data-testid` and roles. Text in assertions is taken from the **`uk` catalog**, not a literal:
  - Vitest — `loadCatalog(locale)` and `I18nTestProvider` from `apps/web/app/test/i18n.tsx` (already in `main`);
  - E2E — `loadMessages('uk')` and `assertInCatalog(uk, '<text>')` from `apps/e2e/fixtures/catalog.ts` (already in `main`).
- **Audit lesson (COPY-B "tests duplicate literals"): move anchors to `data-testid` BEFORE translating the text.** In the slice 24 unit files with 112 assertions on visible Russian text and 24+ finance E2E specs. The testids already exist (`compliance-row-*`, `delete-tx-confirm-button`, etc.) — where an assertion by text is not the subject of the check, anchor by testid.
- **Lesson (#700, item 2): the E2E sweep is over the whole `apps/e2e`, not over the specs in the diff.** A regression — any literal of a migrated component in any spec. The procedure and script — "Common step: E2E sweep" below. "Pre-existing" is allowed only if CI on `origin/main` is red on the same spec.
- **Lesson (#700, item 3): the mutation gate on the full diff is a mandatory AC**, `survived 0`. If a `NoCoverage` has no integration-hint, a unit test closes it (`mutation-gate-integration-specs.md`). A local SKIP on timeout is not a PASS: then `stryker run` directly with `dryRunTimeoutMinutes: 20` and the same config as the gate.
- **Lesson (#699, item 12): each Stryker suppression — with a reason on the same directive line**, no shorter than 12 characters (`// Stryker disable next-line <Mutator>: <reason>`). Before push — `node scripts/devops/check-mutation-suppressions.mjs`: a local `pnpm mutation:changed` does not call it, and CI with it fails all Mutation Gate jobs before even starting.
- Tests are edited by the same coder in the same PR (editing assertions inside the migrated module is part of the same task, as in waves a/b/c). The wave does not introduce new `*.spec.ts` E2E scenarios; new unit cases (a test for a type/status without a raw enum, a test for pluralization of projects/incomes at 1/2/5, a test for parsing an error by status) — inside the existing test files.

**Process**

- `git add` by an explicit list (each task has one). Push — `DATABASE_URL= git push`, without `--no-verify`. Each commit carries `ac_verified:` with the numbers from the "Acceptance criteria" section of its task.
- **Lesson (#700, item 6): a cadence for 20+ files** — `wip:` commits locally, one push at the end. Pre-push under load flakes, each push takes 5–12 minutes. `CreateTransactionDialog.tsx` (80 lines, PR3) and `stats.tsx` (62 lines, PR4) — by section, `wip:` after each.
- **Lesson (#700, item 5): screenshots and live passes are done with the `npx playwright` script in your own scratchpad**, not via `mcp__playwright__*`: the MCP browser is shared across all parallel agents.
- **Lesson (#704/#707): the `.po` conflict on sequential PRs is additive.** Take both sides, then `pnpm i18n:extract` twice, the second run gives an empty diff. Check by numbers: the number of `msgid` equals `main` plus the PR's new records, and fuzzy, `#-#-#` and empty `msgstr` in `en` are 0. The `.po` merge is not given to haiku.
- **Lesson (#700, item 9): the task file is the only channel of requirements.** In the coder's prompt the orchestrator writes: "all the 'Orchestrator addendum' sections in the task file are part of the assignment".
- After each Edit/Write of `.ts`/`.tsx` — `mcp__eslint__lint-files`. On the lines the wave touches there must be no new `lingui/no-unlocalized-strings` warnings.
- `pnpm i18n:extract` is idempotent: a second consecutive run does not change `.po`. The CI gate "i18n catalogs are in sync" checks this, before push the same is reproduced locally.
- **Lesson (#705): FM-5 guard-test gate.** The `apps/web` wave **does not touch** `apps/api`. The exception — "Contested decision 1" (`EXPENSE_CATEGORIES` codes+migration), which **is carried out as a separate api+shared PR outside this wave** precisely so as not to drag the guard-test-gate and prod-DDL into a web PR. If the implementer does edit a controller from the `guard-test-gate.yml` list, the same PR needs a changed `apps/api/**/*.spec.ts` with a 403 assertion (or the line `guard-test-na: <reason>` in the PR body).
- Each PR passes design-gate **Tier 2** (editing existing screens: a conformance check by ui-ux-designer, without generation in Claude Design) and fidelity Mode B on all device classes. The `copy-reviewer` verdict — on `uk` and on `en` **separately**. **`security-reviewer` is MANDATORY for ALL four PRs** — the whole slice is in the critical-path zones of `pm.md` (transactions, payouts, drop/senior share, company account, dividends, amount masking). The logic does not change in the PR — the reviewer must verify this, not the author.
- **Responsive AC for each PR:** the screens from the task are checked at 320 and 375 (mobile), 768 (tablet), 1024 and 1280 (laptop), 1440 and 1920 (large) in **both** languages. No horizontal scroll (`document.scrollWidth <= clientWidth`), no label is truncated without `truncate` with `title`, touch targets on mobile are no less than 44×44. Screenshots 320 and 1440 × `uk` and `en` are attached to the PR. **A special risk of the wave is the transaction ledger** (`ActiveTransactionsTable`/`TransactionRow`): the Ukrainian type labels are longer than the Russian ones, and the table is dense; re-measure line wrapping at 320/375/768.

---

## Test access to the catalog (helpers already in `main`)

Implemented by wave (a) and merged. Here — how to use it.

```tsx
// Vitest (apps/web) — the real catalog via the same path as in production
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

await loadCatalog('uk')
render(<TransactionRow tx={tx} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Розрахунок із сеньйором')).toBeInTheDocument()
```

```ts
// E2E (apps/e2e) — `pnpm i18n:compile` is mandatory before a run
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

const uk = await loadMessages('uk')
await expect(page.getByText(assertInCatalog(uk, 'Розрахунок із сеньйором'))).toBeVisible()
```

`assertInCatalog` fails with a clear error if the text is not in the catalog: so an outdated literal does not turn into a Playwright timeout. The relative import path depends on the spec's depth: `'../fixtures/catalog'` for `tests/*.spec.ts`.

---

## Perimeter of wave (d) — how it was obtained

Commands (the boundaries of the `web-finance` audit slice + the finance components left by wave c):

```bash
# the web-finance slice
find apps/web/app/routes/_authenticated/finance \
     apps/web/app/components/finance apps/web/app/components/invoices \
     -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*__tests__*' ! -name '*.spec.*' ! -name '*.test.*'
ls apps/web/app/routes/_authenticated/stats.tsx 'apps/web/app/routes/invoice.v.$transactionId.tsx'
# count of Cyrillic outside comments (per file)
git grep -c -P '[А-Яа-яЁё]' origin/main -- <file>
```

Result on `5c477321f`: in the perimeter **30 product files with Cyrillic outside comments, 744 lines** (the audit counted 34 files / 569 visible fragments + 174 comment lines — it matches: the difference is that `KpiCards.tsx`, `api.ts`, `sort.ts`, `usePaginatedFilter.ts` contain no Cyrillic outside comments, and the "lines" metric is wider than the "fragments" metric). The heaviest: `dialogs/CreateTransactionDialog.tsx` 80 · `stats.tsx` 62 · `finance/index.tsx` 55 · `dialogs/TransactionDetailDialog.tsx` 52 · `dialogs/PayoutPaymentForm.tsx` 52 · `invoices/invoice-detail-dialog.tsx` 42 · `components/DropFinancePage.tsx` 37 · `components/TransactionRow.tsx` 33 · `dialogs/CompanySharePayoutModal.tsx` 32 · `finance/constants.ts` 31.

**Already partially migrated** (import a Lingui macro, but Russian text remained — they must be FINISHED, not started over): `dialogs/AdminEditTransactionDialog.tsx` (`useLingui`/`t`, 19 lines of Russian) and `dialogs/CascadeImpactPanel.tsx` (`<Trans>`, 25 lines of Russian). Checked `git grep -l "@lingui/.*/macro"` over the product files of the perimeter — only these two.

Further the perimeter is adjusted. Each deviation — a line in "Assumptions" below.

| What                                                                                                         | Decision                        | Why                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finance components `TransactionRow`, `TransactionDetailDialog` + formatters `fmtUsd`/`ExchangeRates`         | **include**                     | They live in `finance/**`, native here. Wave (c) left their Russian text consciously (its "Findings outside the perimeter"). Here is their native wave                                                                                   |
| `finance/constants.ts` → `TYPE_LABELS`, `STATUS_LABELS`                                                      | **PR1 owns + PR4 removes**      | A hub consumed by the whole slice + `FinanceTab.tsx` (web-people). PR1 introduces `*_MESSAGES`, the old string maps live until PR4 (removed there) — as `PAYMENT_TYPE_LABELS` lived PR3→PR4 in wave (c). A handoff of one file, a series |
| `components/user-profile/tabs/FinanceTab.tsx` (web-people)                                                   | **PR1 (lookup only)**           | The only foreign consumer of `TYPE_LABELS`/`STATUS_LABELS` (checked `git grep`). Already Lingui-aware; its `Object.entries(TYPE_LABELS)` is moved to `i18n._()`. The rest of its text — wave b, do not touch                             |
| `routes/_authenticated/projects/$projectId.tsx` (web-projects), call `fmtUsd(project.rate, currency, rates)` | **do not touch**                | `fmtUsd` keeps the signature `(amount, currency, rates)` — only its internal locale source changes. `$projectId` is not edited. Checked: the only external consumer of `fmtUsd`                                                          |
| `apps/web/app/lib/format-amount.ts` (`formatAmount` `ru-RU`, `formatAmountUsd` `en-US`)                      | **see "Contested decision 3"**  | A cross-slice root (invoices, notifications, `fmtAmount`). Locale-awareness — in coordination with web-core, not a signature breaking-change inside this wave                                                                            |
| `finance/constants.ts` → `EXPENSE_CATEGORIES`                                                                | **see "Contested decision 1"**  | Data-in-DB (`receiver_label`), not a pure UI translation. Codes + migration — a separate api+shared+DDL-PROD PR, a precondition of PR3                                                                                                   |
| `localeCompare('ru')` in the sorts of finance lists                                                          | **not included (already done)** | Checked `git grep localeCompare -- apps/web/app`: it is NOT in finance. The only `localeCompare('ru')` — a comment in `lib/documents-filter-sort.ts` that it was **replaced with `Intl.Collator`** back in stage 2 (web-docs-notify)     |
| `KpiCards.tsx`, `api.ts`, `sort.ts`, `hooks/usePaginatedFilter.ts`, `receipt-permissions.ts`                 | **do not migrate**              | Cyrillic outside comments 0 (checked). `receipt-permissions.ts` — pure logic, included in PR2 only if an edit to its test is needed                                                                                                      |
| `apps/api/**`, finance/invoices server error codes                                                           | **do not touch (#704)**         | The codes and Zod messages were migrated in stage 4. The wave consumes `getApiErrorMessage`/`translateZodCode`, it does not introduce new codes                                                                                          |
| `CONTEXT.md`                                                                                                 | **add (PR1)**                   | Lesson #700, item 1: the wave's term forms are entered into the glossary before migrating the files. PR1 starts first — it enters the wave (d) canon                                                                                     |

Summary by PR (sequential merge; the sum of migrated lines — 744):

| PR      | What                                                                                                                                                                                                                                                                                                                                            | Product files | Cyrillic lines outside comm. |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------- |
| **PR1** | Hub `constants.ts` (maps→messages, formatters) + transaction ledger: `index`, `TransactionRow`, table, pagination, cascade row, `company-share`, `cascade-preview` + consumer `FinanceTab`                                                                                                                                                      | 10            | ~154                         |
| **PR2** | Transaction detail dialog, drop finance, validation, receipts: `TransactionDetailDialog`, `DropFinancePage`, `ValidateDialog`, `ReceiptInput`, `AttachReceiptSheet`, `receipt-panel`, `PayoutDetailDialog`, `EditSeniorIncomeDialog`                                                                                                            | 8             | ~161                         |
| **PR3** | Transaction create/edit + `EXPENSE_CATEGORIES`: `CreateTransactionDialog` (by section), `AdminEditTransactionDialog` (finish), `FundingSourceFields`, `PaySalaryDialog`                                                                                                                                                                         | 4             | ~125                         |
| **PR4** | Payouts/settlements/cascade panel/confirmation + statistics + invoices + removing old maps: `PayoutPaymentForm`, `SettleSeniorPayoutDialog`, `CompanySharePayoutModal`, `CascadeImpactPanel` (finish), `ConfirmPayoutDialog`, `usePayoutPaymentForm`, `stats` (by section), `invoice-card`, `invoice-detail-dialog`, `invoice.v.$transactionId` | 10            | ~304                         |

PR4 is larger (it reconciles the two giant files `stats.tsx` 62 and `invoice-detail-dialog.tsx` 42 plus the payout cluster); it is done by section with `wip:`, like `$projectId` (287 lines) in wave (c). Splitting it into a 5th PR is a legitimate alternative (see "Assumption 2").

---

## Sequence discipline

The wave is **sequential**, not parallel: a shared `.po` and a shared hub `finance/constants.ts`. Each next PR starts after the previous is merged and is rebased onto it.

| Step | What    | Waits for                                                                       | Why                                                                                                                                                                                                                                                                                                                    |
| ---- | ------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **PR1** | —                                                                               | Introduces `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` and locale-aware formatters in `constants.ts`. **Does NOT remove the old `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth`** — they are still consumed by the PR2/PR3/PR4 files. Marks them `@deprecated`. Migrates its files + `FinanceTab` to the new maps |
| 2    | **PR2** | merge of **PR1**                                                                | Consumes the new maps/formatters. Rebase onto PR1                                                                                                                                                                                                                                                                      |
| 3    | **PR3** | merge of **PR2** + the `EXPENSE_CATEGORIES` precondition (Contested decision 1) | Consumes the new maps. Owns the create/edit dialogs. `EXPENSE_CATEGORIES` — per "Contested decision 1"                                                                                                                                                                                                                 |
| 4    | **PR4** | merge of **PR3**                                                                | Migrates the **last** consumers of `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` and **removes** the old maps/formatters from `constants.ts`. Final check `git grep -nP '\bTYPE_LABELS\b' -- apps/web/app/routes/_authenticated/finance` → empty                                                                  |

**E2E spec distribution** (whichever's text a line asserts, that PR edits it; the guide — take the exact list with the sweep script at the push step of each PR). Finance E2E specs in `apps/e2e/tests` (by name: `finance*`, `drop*`, `payout*`, `invoice*`, `senior-*payout`, `transaction-*`, `company-share*`, `phase8-payout*`) — **53**; with Cyrillic by the sweep — a subset. Main guides:

| PR  | Specs (guide — refine with the sweep)                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | `finance.spec.ts`, `finance-smoke-regressions.spec.ts`, `drop-income-ui.spec.ts`, `drop-balances-panel.spec.ts`, `transaction-receipts.spec.ts` (ledger/rows)                                                             |
| PR2 | `transaction-receipts.spec.ts`, `drop-*` (drop finance), `phase8-payout-company.spec.ts` (detail/validation)                                                                                                              |
| PR3 | `finance-funding-source.spec.ts`, `drop-share-usdt-income.spec.ts`, `drop-create.spec.ts` (transaction creation), `finance.spec.ts` (create)                                                                              |
| PR4 | `finance-payout-simulate.spec.ts`, `finance-senior-*flow.spec.ts`, `senior-confirm-payout.spec.ts`, `drop-confirm-payout*.spec.ts`, `payout-*`, `company-share-cta.spec.ts`, `invoice-*`, `invoices-signing-flow.spec.ts` |

---

## Wave (d) term canon — `uk`/`en`

PR1 moves this table into `CONTEXT.md` (the "`uk`/`en` forms" section, a continuation of waves a/b/c) in the first commit. PR2, PR3, PR4 take the words from here verbatim. The "Source" column refers to the audit finding or the glossary that predetermined the choice. The `uk` forms below are a draft; the final text is approved by `copy-reviewer` ("two originals").

| Term (rus., for reference)              | `uk`                                                                                        | `en`                                                                             | `_Избегать_` in the product (`uk`/`en`)                         | Source                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Transaction (`transactions`)            | транзакція                                                                                  | transaction                                                                      | «платіж» / payment                                              | glossary **Transaction**; COPY-L-fin-20 |
| `TYPE_LABELS.PAYOUT`                    | Виплата                                                                                     | Payout                                                                           | —                                                               | glossary §Flagged ambiguities           |
| `TYPE_LABELS.SENIOR_PAID`               | Розрахунок із сеньйором                                                                     | Senior settlement                                                                | «Виплата синьору»                                               | COPY-H-fin-1                            |
| `TYPE_LABELS.SENIOR_PENDING_PAYOUT`     | Очікуваний розрахунок із сеньйором                                                          | Pending senior settlement                                                        | «Очікувана виплата синьору»                                     | COPY-H-fin-1                            |
| `TYPE_LABELS.DROP_PENDING_PAYOUT`       | Очікуваний розрахунок із дропом                                                             | Pending drop settlement                                                          | «Очікувана виплата дропу»                                       | COPY-H-fin-1                            |
| `TYPE_LABELS.PAYOUT_CONFIRMED`          | Підтверджений розрахунок                                                                    | Confirmed settlement                                                             | «Підтверджена виплата»                                          | COPY-H-fin-1                            |
| `TYPE_DESCRIPTIONS.SALARY`              | Зарплата співробітнику                                                                      | Employee salary                                                                  | —                                                               | COPY-H-fin-1                            |
| `TYPE_LABELS.ADMIN_INCOME`              | Прихід адміна                                                                               | Admin income                                                                     | «Прихід Admin» (Latin)                                          | COPY-M-fin-11                           |
| `TYPE_LABELS.ADMIN_INCOME_CASH`         | Прихід адміна (готівка)                                                                     | Admin income (cash)                                                              | «Прихід Admin (наличные)»                                       | COPY-M-fin-11                           |
| `TYPE_LABELS.ADMIN_INCOME_CRYPTO`       | Прихід адміна (USDT)                                                                        | Admin income (USDT)                                                              | «крипто» as a synonym for USDT                                  | COPY-M-fin-11                           |
| `TYPE_LABELS.DIVIDEND_TO_ADMIN`         | Дивіденди адміну                                                                            | Dividend to admin                                                                | «Дивіденди Admin»                                               | COPY-M-fin-11; glossary **Dividends**   |
| `TYPE_LABELS.TOV_INCOME`                | Прихід (архів)                                                                              | Income (archived)                                                                | «Прихід ТОВ» (legacy value, `_Избегать_` «кошелёк ТОВ»)         | COPY-M-fin-11                           |
| `TYPE_DESCRIPTIONS.DROP_INCOME`         | Дохід дропа з проєкту                                                                       | Drop income from a project                                                       | «дохід дропа з drop-проєкту» (Latin)                            | COPY-M-fin-11                           |
| `STATUS_LABELS.PENDING`                 | Очікує валідації                                                                            | Awaiting validation                                                              | «Очікує» without an object                                      | COPY-M-fin-13                           |
| `STATUS_LABELS.PENDING_CASH_CONFIRM`    | Очікує підтвердження бухгалтером (готівка)                                                  | Awaiting accountant confirmation (cash)                                          | «Очікує підтвердження нала» («нал» — slang)                     | COPY-M-fin-13                           |
| The role `DROP` (in statistics)         | Дроп                                                                                        | Drop                                                                             | «Посередник», «підставна особа», «номінал», «проксі»            | COPY-H-fin-2; glossary **Drop**         |
| The role `SENIOR` / `ADMIN_SENIOR`      | Сеньйор / Адмін-сеньйор                                                                     | Senior / Admin-senior                                                            | «Senior»/«Admin-Senior» in Latin inside `uk`                    | COPY-H-fin-2                            |
| Settle                                  | розрахунок                                                                                  | settlement                                                                       | «виплата» in the sense of "give money to a person"              | glossary **Settle**                     |
| Payout request                          | заявка на виплату                                                                           | payout request                                                                   | —                                                               | glossary                                |
| Invoice (`invoices`)                    | рахунок                                                                                     | invoice                                                                          | «інвойс», «акт», «платіжка»                                     | glossary **Invoice**; COPY-L-fin-16     |
| Open invoice #…                         | Відкрити рахунок №…                                                                         | Open invoice #…                                                                  | «Відкрити інвойс»                                               | COPY-L-fin-16                           |
| `SIG_METHOD_LABEL.MANUAL_CLICK`         | Підписано контрагентом вручну                                                               | Signed manually by counterparty                                                  | «Підписано вручну (click + audit)»                              | COPY-M-fin-10                           |
| Blockchain check (unavailable in dev)   | Перевірка в блокчейні (недоступна в тестовому середовищі)                                   | Blockchain check (unavailable in the test environment)                           | «Реальна перевірка (недоступно в dev)»; an emoji in the string  | COPY-M-fin-10                           |
| Transaction hash                        | Хеш транзакції                                                                              | Transaction hash                                                                 | «TX Hash» as a column header                                    | COPY-L-fin-19                           |
| Etherscan                               | Etherscan                                                                                   | Etherscan                                                                        | «etherscan» lowercase                                           | COPY-L-fin-19                           |
| Transfer record                         | Факт переказу                                                                               | Transfer record                                                                  | «Факт платежу»                                                  | COPY-L-fin-20; glossary **Transaction** |
| No payment history                      | Переказів ще не було                                                                        | No transfers yet                                                                 | «Немає історії платежів»                                        | COPY-L-fin-20                           |
| Expense category "Commission"           | Банківський збір                                                                            | Bank fee                                                                         | «Комісія» (reserved by the glossary for the drop share)         | COPY-L-fin-17; glossary **Drop share**  |
| Drop payment status `failed`            | Не пройшов                                                                                  | Failed                                                                           | «Помилка» without explanation                                   | COPY-M-fin-12                           |
| Empty: no transactions                  | Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»                              | No transactions yet — create the first one with “New transaction”                | «Немає даних»                                                   | COPY-M-fin-6                            |
| A filter found nothing                  | Нічого не знайдено — скиньте фільтри                                                        | No matches — clear the filters                                                   | «Немає даних», «Порожньо»                                       | wave b catalog (key already exists)     |
| Unknown error (fallback)                | Не вдалося виконати операцію — спробуйте ще раз; якщо повториться, повідомте адміністратора | Could not complete the action — try again; if it persists, tell an administrator | «Невідома помилка»                                              | COPY-M-fin-7                            |
| "for {month}" (compliance)              | за {month via `fmtMonth`}                                                                   | for {month via `fmtMonth`}                                                       | «за 2026-09» (raw `YYYY-MM`)                                    | COPY-M-fin-9                            |
| Coverage                                | покриття {n} %                                                                              | {n}% coverage                                                                    | «{n}% покриття» (inconsistent)                                  | COPY-M-fin-9                            |
| Active projects / incomes (plural)      | ICU `one/few/many`                                                                          | ICU `one/other`                                                                  | ternary `=== 1 ? … : …`; truncation «актив. проєкта», «N прих.» | COPY-H-fin-4, COPY-L-fin-18             |
| At least 3 characters (deletion reason) | Не менше 3 символів                                                                         | At least 3 characters                                                            | a silently disabled button                                      | COPY-M-fin-5                            |

The apostrophe, ellipsis, quotes, `en` refusals "Could not …" — per the common `CONTEXT.md` section "`uk`/`en` forms", not rewritten here. The roles DROP/SENIOR in `stats.tsx` and the roles `COMPANY`/`COUNTERPARTY` in `invoice.v.$transactionId.tsx` — these are **the own enums of these screens**, not the app-`Role`; they are translated by their own maps (template G), **not** via `ROLE_LABEL_MESSAGES` (it has a different set of keys).

---

## Migration templates

**A–L — the same as in waves (a)/(b)/(c)** (see `docs/superpowers/plans/2026-09-26-crm-i18n-stage3c-web-projects.md`, the "Migration templates" section): A — module constant → `msg` + `i18n._()`; B — JSX text → `<Trans>`; C — attribute/imperative string → `t` from `useLingui()`; D — number → `<Plural>` (component only, Stryker lesson); E — gender/case form → `select`; F — date/money/number → `@crm/shared` `format.ts`; G — enum map → `Record<…, MessageDescriptor>` (`satisfies` without `as const`); H — local role map → canon (in this wave **not applied** — the `stats`/`invoice` enums are not the app-`Role`, for them template G); I — E2E assert → `assertInCatalog`; J — manual pluralization → `<Plural>`/`i18n._(msg,{count})`; K — concatenation with a case → `<Trans>` slots/`select`; L — date/money with a fixed locale → `format.ts`.

Refinements of this wave:

**G-fin. `TYPE_LABELS`/`STATUS_LABELS` → message maps, do not touch the service maps next to them.**

```ts
// was (finance/constants.ts)
export const TYPE_LABELS: Record<TransactionType, string> = {
  PAYOUT: 'Выплата',
  SENIOR_PAID: 'Выплата синьору' /* … 22 keys */,
}
// became — satisfies without as const; do NOT remove the old map in PR1 (consumers in PR2-4), mark @deprecated
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
export const TYPE_LABEL_MESSAGES = {
  PAYOUT: msg`Виплата`, // en: Payout
  SENIOR_PAID: msg`Розрахунок із сеньйором`, // en: Senior settlement
  // … all 22 keys
} satisfies Record<TransactionType, MessageDescriptor>
```

The consumer — `i18n._(TYPE_LABEL_MESSAGES[tx.type])`. The service maps `TYPE_COLORS`/`STATUS_COLORS` (CSS classes, not text) — **do not touch**. `FinanceTab.tsx` (`Object.entries(TYPE_LABELS).map(([value,label]) => …)`) is moved to `Object.keys(TYPE_LABEL_MESSAGES).map((value) => ({ value, label: i18n._(TYPE_LABEL_MESSAGES[value]) }))` inside the component (not at the module level).

**J-fin. `pluralizeProjects`/`pluralizeIncomes` + the `stats.tsx` ternaries → ICU.** `finance/utils/company-share.ts` holds the correct three forms (mod10/mod100), but hardcoded; `stats.tsx` — four `expected === 1 ? 'проект' : 'проекта'` (wrong at 2–4 and 5+). Both → `<Plural>` (in JSX) or `msg` with ICU + `i18n._(msg,{count})` (outside JSX). Remove the self-written functions.

```tsx
// stats.tsx (in JSX) — three forms, not a ternary
<Plural
  value={receiver.expected}
  one="# активний проєкт"
  few="# активні проєкти"
  many="# активних проєктів"
  other="# активного проєкту"
/>
// en: one="# active project" other="# active projects"
```

**K-fin. Money phrase concatenations → `<Trans>` slots.** `CascadeImpactPanel.tsx` (`` `Синьору ${name}` ``, `` `Дропу ${name}` ``), `cascade-preview.ts` (`CASCADE_PREVIEW_LEAD_IN` + « — » + tail; `cascadeStaleMessage` quotes the label of the "Обновить предпросмотр" button — COPY-L-fin-21, move the label to a common constant or rephrase without the quote), `CompanySharePayoutModal.tsx` (the summary «№… · N {pluralizeProjects} , M {pluralizeIncomes}» from fragments via `{' '}`). A name — only in the nominative.

**L-fin. Money/date formatters — one layer, keep the signatures.** In the slice 25 `toLocale*` (16 `en-US`, 8 `ru-RU`, 1 `uk-UA`) + 14 local `fmt*` (three pairs of same-named shadows: `fmtDate ×2`, `fmtUsd ×2`, `fmtUsdt ×3`, `fmtRelative ×2`) + `date-fns/locale/ru` in two invoices.

```ts
// finance/constants.ts: fmtDate (uk-UA) / fmtMonth (ru-RU) → format.ts with locale from useLocale()
//   fmtDate(iso)            → formatDate(iso, locale, 'short')
//   fmtMonth('2026-09')     → formatDate(`2026-09-01`, locale, 'monthYear')   // COPY-M-fin-9
// DropFinancePage: local fmtDate (ru-RU, a shadow of the exported one) — REMOVE, import from constants
// invoices/*: import { ru } from 'date-fns/locale' + formatDistanceToNow → formatRelativeTime(d, locale)
// fmtUsd(amount, currency, rates): KEEP THE SIGNATURE (external consumer $projectId).
//   Inside `$${usd.toLocaleString('en-US', …)}` → formatMoney(usd, 'USD', locale)
// fmtAmount → formatAmount (lib/format-amount.ts): see "Contested decision 3"
```

Functions that need a `locale` get it as an argument or from `useLocale()` in the component (do not call a hook in `.map()` — one `useLingui()`/`useLocale()` per component, `i18n._()` inside the loop).

---

## Common step: E2E sweep (performed in each PR before push)

The script collects the Russian fragments that **this PR removed** and searches for them across the whole `apps/e2e`. Each hit — a line to check. If the fragment remained in another not-yet-migrated component and a spec asserts exactly it, do not touch the line. If the spec asserts a migrated screen, move the line to template I.

```bash
SCRATCH="${TMPDIR:-/tmp}/wave-d-$(git rev-parse --abbrev-ref HEAD | tr / -)"   # own directory: name from your branch, not a shared path
mkdir -p "$SCRATCH"
git diff origin/main -- apps/web/app > "$SCRATCH/wave-d.diff"
```

```python
# $SCRATCH/e2e_sweep.py — python3 e2e_sweep.py <path-to-wave-d.diff>
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
python3 "$SCRATCH/e2e_sweep.py" "$SCRATCH/wave-d.diff" > "$SCRATCH/sweep.txt"
cut -d: -f1 "$SCRATCH/sweep.txt" | sort -u > "$SCRATCH/sweep-specs.txt"   # list for git add
```

The whole output goes into the PR body (the "E2E sweep" section) with a mark on each line: "moved to the catalog", "testid" or "not our text — <which component outside the wave renders it>". A line without a mark is unclosed. The specs enter the commit via `git add $(cat "$SCRATCH/sweep-specs.txt")`.

---

## Task 1 (PR1): hub `constants.ts` + transaction ledger

**Files** (Cyrillic outside comments on `5c477321f`):

| File                                          | Cyr. lines | Pattern(s)  | Audit findings / note                                                                                                                                                           |
| --------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finance/index.tsx`                           | 55         | A,B,C,F,G,J | COPY-M-fin-5 (threshold «Не менше 3 символів»), M-6 (`EmptyRow` empty states), M-14 (two almost identical deletion texts), L-19 («TX Hash» → «Хеш транзакції»)                  |
| `components/DropFinancePage.tsx`              | 37         | B,C,F,G,L   | _(moved to PR2 — see below)_                                                                                                                                                    |
| `components/TransactionRow.tsx`               | 33         | B,C,F,G,K   | template strings « · до доплати ${fmtAmount}»; `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` — consumer                                                                         |
| `finance/constants.ts`                        | 31         | G,L         | COPY-H-fin-1 (`TYPE_LABELS` terms), M-11 (Latin in labels), M-13 (`STATUS_LABELS`), L-17 (`EXPENSE_CATEGORIES` — see PR3), formatters `fmtDate`/`fmtMonth`/`fmtUsd`/`fmtAmount` |
| `finance/cascade-preview.ts`                  | 10         | K           | COPY-L-fin-21 (button label quote), lead-in concatenation                                                                                                                       |
| `finance/utils/company-share.ts`              | 9          | J           | `pluralizeProjects`/`pluralizeIncomes` → ICU (correct three forms, but hardcoded)                                                                                               |
| `components/ActiveTransactionsTable.tsx`      | 7          | B,C,G       | headers/map consumer                                                                                                                                                            |
| `components/Pagination.tsx`                   | 5          | C           | four navigation `aria-label` (template C)                                                                                                                                       |
| `components/CompanySharePayoutStrip.tsx`      | 4          | B,C         | the company-share CTA strip                                                                                                                                                     |
| `components/user-profile/tabs/FinanceTab.tsx` | consumer   | G           | **cross-slice (web-people)**: `Object.entries(TYPE_LABELS/STATUS_LABELS)` → `i18n._()`; lookup only, the rest of the text — wave b                                              |

> **Correction:** `DropFinancePage.tsx` is moved to **PR2** (detail/drop cluster) for balance; PR1 leaves its russism until PR2 (a line in PR1's "E2E sweep"). Then PR1 ≈ 154 lines without it.

Outside the product: `CONTEXT.md` (the wave d canon), `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests (update the assertions to the catalog): `finance/__tests__/sort.test.ts`, `finance/components/__tests__/ActiveTransactionsTable.test.tsx`, `finance/components/__tests__/CompanySharePayoutStrip.test.tsx`, `finance/components/__tests__/TransactionRow.*.test.tsx`, `finance/components/__tests__/transaction-row-settled.test.tsx`, `finance/utils/company-share.test.ts`, `finance/__tests__/finance-api-cascade-preview.test.ts`, `finance/cascade-preview.spec.ts`, and also unit `user-profile/tabs/__tests__/FinanceTab.*` (if it asserts labels). New cases (type/status without a raw enum; pluralization of projects/incomes at 1/2/5) — inside the existing files.

E2E: see "E2E spec distribution", the PR1 row, plus the sweep output.

**Interfaces:**

- Consumes: `formatDate`, `formatNumber`, `formatMoney`, `formatRelativeTime` (`@crm/shared/i18n/format`), `useLocale()` (`@/lib/i18n`), `getApiErrorMessage` (`@/lib/axios-utils`), the catalog test helpers.
- Produces: `TYPE_LABEL_MESSAGES: Record<TransactionType, MessageDescriptor>`, `STATUS_LABEL_MESSAGES: Record<TransactionStatus, MessageDescriptor>`, `CASCADE_BLOCKED_REASON_MESSAGES` (if still a string) in `finance/constants.ts`. **The old `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` are marked `@deprecated`, but NOT removed** (consumers in PR2–PR4). `fmtUsd`/`fmtRate`/`fmtAmount`/`toUsd` — signatures unchanged (locale-awareness inside). The wave (d) canon section in `CONTEXT.md`.

### Danger: `constants.ts` — a hub, the old maps live until PR4

`finance/constants.ts` — the single source of labels for the whole slice + `FinanceTab`. You cannot remove `TYPE_LABELS`/`STATUS_LABELS` in PR1: they are consumed by the PR2/PR3/PR4 files (checked `git grep -l TYPE_LABELS`/`STATUS_LABELS`). Therefore PR1 **adds** the message maps and migrates its consumers + `FinanceTab`, and the old string maps live `@deprecated` until PR4, where they are removed (as `PAYMENT_TYPE_LABELS` PR3→PR4 of wave c). Because of this `constants.ts` in PR1 **does not claim "0 Russian"** — its old maps are still Russian; the AC "0 `[ыэъё]`" on `constants.ts` is checked in **PR4**, after the removal.

### Danger: amount masking `mapTx(viewer)` — RBAC, do not change

The transaction ledger and `TransactionRow` show amounts masked by the server by the viewer's role (`mapTx(viewer)`, finance SR incidents). The translation changes **only the text of the labels/statuses**, not the masking logic nor which fields are rendered. The test — that after the translation the set of visible fields per-role did not change. A line in the PR body for `security-reviewer`.

### Acceptance criteria (PR1)

1. In `CONTEXT.md` there is a subsection "Wave d — `web-finance`" with the forms from the canon table.
2. `TYPE_LABELS`→`TYPE_LABEL_MESSAGES` (22 keys), `STATUS_LABELS`→`STATUS_LABEL_MESSAGES` (7) — `satisfies` without `as const`; terms per the canon (COPY-H-fin-1 «розрахунок», M-11 without Latin, M-13 statuses with an object); the old maps `@deprecated`, not removed; the test "no raw enum in the rendered row/table" is green.
3. `FinanceTab.tsx` (cross-slice) is moved to `i18n._(TYPE_LABEL_MESSAGES[...])`; its test is green; the rest of the `FinanceTab` text is not touched.
4. `pluralizeProjects`/`pluralizeIncomes` → ICU `<Plural>`/`i18n._(msg,{count})`; the test at 1/2/5/11/21 is green (COPY-H-fin-4 partially, fully — with `stats.tsx` in PR4).
5. `TransactionRow`, `index.tsx`, `ActiveTransactionsTable`, `CompanySharePayoutStrip`, `Pagination` in `uk`/`en`: empty states with a reason+step (M-6), «Хеш транзакції» (L-19), pagination `aria-label` via `t`; `cascade-preview` without a label quote (L-21).
6. Formatters: `fmtDate`/`fmtMonth` via `format.ts` with `useLocale()`; `fmtUsd`/`fmtAmount` — signatures kept, locale inside; `date-fns/locale/ru` does not appear in the PR1 files.
7. In the PR1 files (except `constants.ts`, where the `@deprecated` maps live) 0 lines of `[ыэъё]` outside comments.
8. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR1 E2E specs are green.
9. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
10. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
11. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`; `security-reviewer` APPROVE (amount masking, ledger).

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel                       # == the assigned worktree
git fetch origin main && git log --oneline -1 origin/main
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/routes/_authenticated/finance/constants.ts apps/web/app/routes/_authenticated/finance/index.tsx apps/web/app/routes/_authenticated/finance/components/TransactionRow.tsx
git grep -l "TYPE_LABELS\|STATUS_LABELS" origin/main -- apps/web/app   # the current list of consumers
```

If the numbers differ from the table by more than 10%, update the table in the task file before starting.

- [ ] **Step 1: Term canon → `CONTEXT.md`** — the subsection "Wave d — `web-finance`" after "Wave c". A separate commit `docs(context): wave d uk/en term forms`, `ac_verified: 1`.
- [ ] **Step 2: Test for the maps (fails)** — `it.each` by locale: `TYPE_LABEL_MESSAGES.SENIOR_PAID` = «Розрахунок із сеньйором»/«Senior settlement», no raw enum; `STATUS_LABEL_MESSAGES.PENDING` = «Очікує валідації». Run: `pnpm --filter @crm/web test -- finance` → FAIL.
- [ ] **Step 3: `constants.ts` — message maps + formatters (templates G, L) → PASS** — maps per G (`@deprecated` on the old ones); `fmtDate`/`fmtMonth` via `format.ts`; `fmtUsd`/`fmtAmount` locale inside, signatures intact.
- [ ] **Step 4: `index.tsx` + `TransactionRow` + table + pagination + strip** — consuming the maps; empty states (M-6), «Хеш транзакції» (L-19), `aria-label` (template C); TransactionRow template strings → `<Trans>` slots.
- [ ] **Step 5: `company-share.ts` + `cascade-preview.ts`** — ICU pluralization (J-fin); lead-in concatenation and the label quote (K-fin, L-21).
- [ ] **Step 6: `FinanceTab.tsx` (cross-slice)** — `Object.entries(TYPE_LABELS/STATUS_LABELS)` → `i18n._()`; lookup only.
- [ ] **Step 7: Check, tests, E2E sweep, gates, commit** (the russism-scan script over the PR1 files except `constants.ts`; `i18n:extract ×2`; `typecheck`/`lint`/`test`; `DATABASE_URL= pnpm --filter @crm/e2e test -- finance`; `mutation:changed`; `check-mutation-suppressions.mjs`; `git add` by an explicit list + `sweep-specs.txt`).

Commit: `feat(web,i18n): stage 3d wave (d) part 1 — finance transaction ledger to uk/en` + `ac_verified: 1,2,3,4,5,6,7,8,9,10 (11 — reviews after push)`.

**Design tier 2.** Screenshots 320/1440 × `uk`/`en`: the transaction ledger (types, statuses, empty states, pagination), the company-share CTA, `FinanceTab` (profile). Fidelity Mode B — all widths (risk — the dense table at 320). `copy-reviewer` — `uk`/`en` separately. `security-reviewer` — mandatory.

---

## Task 2 (PR2): detail dialog, drop finance, validation, receipts

**Files:**

| File                                             | Cyr. lines | Pattern(s) | Audit findings / note                                                                                               |
| ------------------------------------------------ | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `components/dialogs/TransactionDetailDialog.tsx` | 52         | B,C,F,G,L  | COPY-L-fin-20 («Факт платежу» → «Факт переказу»); map consumer; dates/amounts via `format.ts`                       |
| `components/DropFinancePage.tsx`                 | 37         | B,C,F,G,L  | COPY-M-fin-12 (`PaymentStatusBadge` `failed`), L-20 («Немає історії платежів»); remove the local `fmtDate` (shadow) |
| `components/dialogs/ValidateDialog.tsx`          | 27         | B,C        | COPY-H-fin-3 (raw `error.message` → parse by status)                                                                |
| `components/ReceiptInput.tsx`                    | 13         | C          | COPY-H-fin-3 (catch `handleFile` → without a raw `.message`)                                                        |
| `components/dialogs/AttachReceiptSheet.tsx`      | 10         | B,C,G      | map consumer                                                                                                        |
| `components/dialogs/receipt-panel.tsx`           | 8          | B,C        | the receipt panel                                                                                                   |
| `components/dialogs/EditSeniorIncomeDialog.tsx`  | 9          | B,C        | COPY-H-fin-3 (raw `error.message`)                                                                                  |
| `components/dialogs/PayoutDetailDialog.tsx`      | 5          | B,C        | payout request details                                                                                              |

Tests: `finance/__tests__/DropFinancePage.test.tsx`, `finance/__tests__/ValidateQueue.test.tsx`, `finance/components/__tests__/ReceiptInput.test.tsx`, `finance/components/__tests__/receipt-permissions.test.ts`, `finance/components/dialogs/__tests__/{transaction-detail-settled,transaction-row-settled,AttachReceiptSheet,EditSeniorIncomeDialog,PayoutDetailDialog,receipt-panel}.test.tsx`. New cases (the detail dialog without a raw enum; parsing the validation error by status) — inside the existing files.

**Interfaces:** Consumes `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` (from PR1), `format.ts`, `useLocale`, `getApiErrorMessage`, the catalog helpers. Produces — consumption only; exports nothing new.

### Danger: `DropFinancePage` — drop data, RBAC + a formatter shadow

`DropFinancePage` shows drop finance (payment-routing). The local `fmtDate` (`ru-RU`) **shadows** the one exported from `constants.ts` — remove it and import (COPY-M-fin-8). Do not change the routing/masking logic; the test — the set of visible fields per-role did not change. A line for `security-reviewer`.

### Acceptance criteria (PR2)

1. `TransactionDetailDialog` in `uk`/`en`: «Факт переказу» (L-20), types/statuses from the PR1 maps without a raw enum; dates/amounts via `format.ts`.
2. `DropFinancePage` in `uk`/`en`: `PaymentStatusBadge.failed` → «Не пройшов» + a hint (M-12); «Переказів ще не було» (L-20); the local `fmtDate` removed, import from `constants`.
3. `ValidateDialog`, `ReceiptInput`, `EditSeniorIncomeDialog` do not print a raw `Error.message`: parse by status via `getApiErrorMessage`/the `cascade-preview` pattern (COPY-H-fin-3); the `axios-utils.spec.ts` contract is not broken.
4. `AttachReceiptSheet`, `receipt-panel`, `PayoutDetailDialog` in `uk`/`en`.
5. In the PR2 files 0 lines of `[ыэъё]` outside comments.
6. Unit asserts the catalog; the E2E sweep; the PR2 E2E specs are green.
7. `i18n:extract ×2` an empty diff; `en` 0 empty `msgstr`.
8. `mutation:changed survived 0`; `check-mutation-suppressions.mjs` green.
9. Design tier 2, fidelity Mode B; screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (drop finance, validation).

Steps: Step 0 measurement → Step 1 tests (fail) → Step 2 `TransactionDetailDialog` → Step 3 `DropFinancePage` (remove the `fmtDate` shadow) → Step 4 `ValidateDialog`/`ReceiptInput`/`EditSeniorIncomeDialog` (error parsing) → Step 5 `AttachReceiptSheet`/`receipt-panel`/`PayoutDetailDialog` → Step 6 check/gates/commit. Commit: `feat(web,i18n): stage 3d wave (d) part 2 — transaction detail, drop finance, validation to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)`.

---

## Task 3 (PR3): transaction create/edit + `EXPENSE_CATEGORIES`

**Files:**

| File                                                | Cyr. lines | Pattern(s) | Audit findings / note                                                                                                                                                                              |
| --------------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/dialogs/CreateTransactionDialog.tsx`    | 80         | A,B,C,F,G  | the largest file of the wave (by section, `wip:`); `TYPE_DESCRIPTIONS` (H-fin-1 SALARY, M-fin-11 DROP_INCOME); `EXPENSE_CATEGORIES` (L-17) consumer; the JSX concatenation «буде нараховано{' '}…» |
| `components/dialogs/AdminEditTransactionDialog.tsx` | 19         | B,C,G      | **finish** (already `useLingui`); `EXPENSE_CATEGORIES` reads back from `receiverLabel` (data-at-rest); the concatenation «перевірте з’єднання» (K)                                                 |
| `components/dialogs/FundingSourceFields.tsx`        | 8          | B,C,G      | the funding source                                                                                                                                                                                 |
| `components/dialogs/PaySalaryDialog.tsx`            | 18         | B,C,F      | the salary payment dialog                                                                                                                                                                          |

Tests: `finance/components/dialogs/__tests__/CreateTransactionDialog.*.test.tsx` (7 files), `AdminEditTransactionDialog.test.tsx`, `PaySalaryDialog*.test.tsx`, `paid-salary-amount-edit.test.tsx`. New cases — inside the existing ones.

**Interfaces:** Consumes the PR1 maps, `EXPENSE_CATEGORY_MESSAGES` (see below), `format.ts`, `useLocale`, `getApiErrorMessage`. Produces — consumption.

### Danger/precondition: `EXPENSE_CATEGORIES` — data-in-DB (see "Contested decision 1")

`EXPENSE_CATEGORIES = ['Оплата сервиса','Комиссия','Прочее']` the user selects in `CreateTransactionDialog`, the value is sent in the `category` field and written by the server into `transactions.receiver_label varchar(255)`; `AdminEditTransactionDialog` reads it back (`setCategory(tx.receiverLabel ?? …)`). You cannot translate the literal: the old records will stop matching the items, the new ones will be written in the operator's language. **PR3 precondition** — a separate api+shared+DDL PR (codes `SERVICE`/`BANK_FEE`/`OTHER` + migration of the values). After it PR3 displays the codes via `EXPENSE_CATEGORY_MESSAGES` (template G) and «Банківський збір» instead of «Комісія» (L-17). If the precondition is not merged — PR3 stops on this part (`.blocked.md`), the other dialogs are migrated.

### Acceptance criteria (PR3)

1. `CreateTransactionDialog` in `uk`/`en`: `TYPE_DESCRIPTIONS.SALARY` = «Зарплата співробітнику», `DROP_INCOME` without Latin (H-fin-1, M-fin-11); the JSX concatenation «буде нараховано …» via a `<Trans>` slot; amounts via `format.ts`.
2. `AdminEditTransactionDialog` finished (fully in `uk`/`en`, `useLingui` extended over all the text); the concatenation «перевірте з’єднання» via `<Trans>`/a constant.
3. `EXPENSE_CATEGORIES` — per "Contested decision 1": codes + `EXPENSE_CATEGORY_MESSAGES`, «Банківський збір» (L-17); the `receiverLabel` read back-compat is kept; if the precondition is not merged — the part is blocked with a record.
4. `FundingSourceFields`, `PaySalaryDialog` in `uk`/`en`.
5. In the PR3 files 0 lines of `[ыэъё]` outside comments.
6. Unit asserts the catalog; the E2E sweep; the PR3 E2E specs are green.
7. `i18n:extract ×2` empty; `en` 0 empty `msgstr`. 8. `mutation:changed survived 0`; suppressions green. 9. Design tier 2, fidelity Mode B; screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (transaction creation, funding source, salary).

Steps: Step 0 measurement + `gh pr view <EXPENSE-codes-PR> --json state` → Step 1 tests (fail) → Step 2 `CreateTransactionDialog` by section (`wip:`: types/descriptions → categories → amounts/concatenations) → Step 3 `AdminEditTransactionDialog` finish + `EXPENSE_CATEGORY_MESSAGES` → Step 4 `FundingSourceFields`/`PaySalaryDialog` → Step 5 check/gates/commit. Commit: `feat(web,i18n): stage 3d wave (d) part 3 — create/edit transaction dialogs to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)`.

---

## Task 4 (PR4): payouts/settlements, statistics, invoices + removing the old maps

**Files:**

| File                                              | Cyr. lines | Pattern(s)  | Audit findings / note                                                                                                                                                                     |
| ------------------------------------------------- | ---------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/_authenticated/stats.tsx`                 | 62         | A,B,C,F,G,J | by section (`wip:`); COPY-H-fin-2 (`ROLE_LABEL` «Посредник», Latin), H-4 (ternaries → ICU), M-9 (`за {YYYY-MM}` → `fmtMonth`, «покриття {n}%»), M-15 (loading errors), L-18 (truncations) |
| `components/dialogs/PayoutPaymentForm.tsx`        | 52         | B,C,G,L     | COPY-M-fin-10 (toggle «Реальна перевірка (недоступно в dev)», emoji), L-19 («Відкрити в Etherscan»); `toLocaleDateString('ru-RU')` inline                                                 |
| `components/dialogs/CompanySharePayoutModal.tsx`  | 32         | B,C,G,K     | COPY-L-fin-18 (truncation), the summary concatenation via `{' '}` + `pluralize*`; `aria-label` with a date (`toLocaleDateString('ru-RU')`)                                                |
| `components/dialogs/SettleSeniorPayoutDialog.tsx` | 27         | B,C         | COPY-M-fin-7 (a local copy of `extractErrorMessage`, fallback «Невідома помилка»)                                                                                                         |
| `components/dialogs/CascadeImpactPanel.tsx`       | 25         | B,C,K       | **finish** (already `<Trans>`); concatenations «Синьору ${name}»/«Дропу ${name}» → `<Trans>` slots                                                                                        |
| `components/finance/ConfirmPayoutDialog.tsx`      | 24         | B,C         | `onError` substitutes `response.data.message` verbatim — a consumer of the server text (#704), leave a comment about the dependency on `api`                                              |
| `invoices/invoice-detail-dialog.tsx`              | 42         | B,C,G,L     | COPY-L-fin-16 («Інвойс» → «Рахунок»), M-10 (`SIG_METHOD_LABEL.MANUAL_CLICK`), M-15 (document/PDF loading errors); `date-fns/locale/ru`                                                    |
| `invoice.v.$transactionId.tsx`                    | 26         | B,C,G       | `ROLE_LABEL` (COMPANY/COUNTERPARTY — own enum, template G), signature table headers                                                                                                       |
| `components/dialogs/PayoutDetailDialog.tsx`       | —          | —           | _(migrated in PR2)_                                                                                                                                                                       |
| `invoices/invoice-card.tsx`                       | 5          | B,C,L       | COPY-L-fin-16 («Відкрити рахунок №…»); `date-fns/locale/ru` → `formatRelativeTime`                                                                                                        |
| `hooks/usePayoutPaymentForm.ts`                   | 9          | C           | COPY-M-fin-7 (`extractErrorMessage` fallback) — reconcile with the copy in `SettleSeniorPayoutDialog`                                                                                     |
| `finance/constants.ts`                            | (delete)   | —           | **remove** the `@deprecated` `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` (the last consumers migrated); final check `git grep TYPE_LABELS`                                         |

Tests: `admin` — none; `finance/components/dialogs/__tests__/{CompanySharePayoutModal,SettleSeniorPayoutDialog,cascade-impact-panel*,settle-senior-remaining,paid-salary-amount-edit}.test.tsx`, `finance/__tests__/finance-api-cascade-preview.test.ts`, `components/finance/__tests__/ConfirmPayoutDialog.test.tsx`, `invoices/__tests__/{invoice-card,invoice-detail-dialog}.test.tsx`. `stats.tsx` — tests by `compliance-row-*` testid. New cases (ROLE_LABEL without «Посредник»/Latin; ICU pluralization of compliance at 1/2/5) — inside the existing ones.

**Interfaces:** Consumes the PR1 maps, `format.ts`, `useLocale`, `getApiErrorMessage`, `translateZodCode`, the catalog helpers. Produces: **removes** the old `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` from `constants.ts`. After PR4 `git grep -nP '\bTYPE_LABELS\b|\bSTATUS_LABELS\b' -- apps/web/app/routes/_authenticated/finance` — empty.

### Danger: removing the old maps — only when no consumers remain

Before removing the `@deprecated` maps — `git grep -nP '\bTYPE_LABELS\b' -- apps/web/app` must return only `constants.ts` (the definition) and, possibly, comments in `projects/constants.ts`. Any live consumer = stop, finish it in PR4.

### Danger: payouts/settlements/company account — critical-path

`PayoutPaymentForm`, `CompanySharePayoutModal`, `SettleSeniorPayoutDialog`, `ConfirmPayoutDialog` — payout requests, settlements, company account (drop-share, dividends). `ConfirmPayoutDialog` prints `response.data.message` verbatim — until `api` is fully localized, the screen is mixed (a known limitation, note in the PR body; do not change the logic). A line for `security-reviewer`.

### Acceptance criteria (PR4)

1. `stats.tsx` in `uk`/`en`: `ROLE_LABEL` = «Дроп»/«Сеньйор»/«Адмін-сеньйор» without «Посредник»/Latin (H-fin-2); four ternaries → ICU `<Plural>` (H-fin-4); «за {месяц}» via `fmtMonth`, «покриття {n} %» (M-9); loading errors with a reason+button (M-15); truncations expanded (L-18).
2. `PayoutPaymentForm`, `CompanySharePayoutModal`, `SettleSeniorPayoutDialog`, `CascadeImpactPanel` (finished), `ConfirmPayoutDialog`, `usePayoutPaymentForm` in `uk`/`en`: jargon removed (M-10), «Відкрити в Etherscan» (L-19), concatenations via `<Trans>` slots/ICU (K-fin), an error fallback with an action (M-7), dates via `format.ts`.
3. Invoices in `uk`/`en`: «Рахунок» instead of «Інвойс» (L-16, 11 places), `SIG_METHOD_LABEL` in human language (M-10), document/PDF loading errors with a status tail (M-15), the invoice `ROLE_LABEL` (template G), `date-fns/locale/ru` replaced with `formatRelativeTime`.
4. The old `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` removed from `constants.ts`; `git grep` in finance empty; `constants.ts` — 0 lines of `[ыэъё]` outside comments.
5. In the PR4 files 0 lines of `[ыэъё]` outside comments; lines with a raw enum are parsed.
6. Unit asserts the catalog; the E2E sweep; the PR4 E2E specs are green.
7. `i18n:extract ×2` empty; `en` 0 empty `msgstr`. 8. `mutation:changed survived 0`; suppressions green. 9. The final wave (d) check (script below) — `violations: 0`, `git grep TYPE_LABELS/STATUS_LABELS` in finance empty. 10. Design tier 2, fidelity Mode B; screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (payouts, settlements, company account, invoices).

The final wave (d) check — in PR4, into the PR body:

```bash
python3 - <<'EOF'
import re, pathlib, subprocess
out = subprocess.run(['git','ls-files',
  'apps/web/app/routes/_authenticated/finance','apps/web/app/components/finance',
  'apps/web/app/components/invoices','apps/web/app/routes/_authenticated/stats.tsx',
  'apps/web/app/routes/invoice.v.$transactionId.tsx'], capture_output=True, text=True).stdout.split()
bad=0
for f in out:
    if re.search(r'__tests__|\.(spec|test)\.', f): continue
    for n,l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(),1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f,n,l.strip()); bad+=1
print('violations:', bad)
EOF
git grep -nP '\bTYPE_LABELS\b|\bSTATUS_LABELS\b' -- apps/web/app/routes/_authenticated/finance   # expected: empty
```

Steps: Step 0 measurement → Step 1 tests (fail) → Step 2 `stats.tsx` by section (`wip:`: ROLE_LABEL → compliance pluralization → month/coverage → errors/truncations) → Step 3 the payout/settlement cluster → Step 4 invoices (invoice-card, invoice-detail-dialog, invoice.v) → Step 5 **removal** of the old maps from `constants.ts` + the final check → Step 6 gates/commit. Commit: `feat(web,i18n): stage 3d wave (d) part 4 — payouts, stats, invoices to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)`.

---

## Trace of the `web-finance` audit findings

The slice's `Findings:` — 21. Each identifier below.

| Finding       | Status on `5c477321f`                 | Where it is closed                                                                           |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| COPY-H-fin-1  | open (terms `TYPE_LABELS`)            | PR1 Step 3 (map), PR3 Step 2 (`TYPE_DESCRIPTIONS.SALARY`)                                    |
| COPY-H-fin-2  | open («Посредник», Latin)             | PR4 Step 2 (`stats.ROLE_LABEL`)                                                              |
| COPY-H-fin-3  | open (raw `Error.message`)            | PR2 Step 4 (`ValidateDialog`/`ReceiptInput`/`EditSeniorIncome`), PR4 Step 3 (`SettleSenior`) |
| COPY-H-fin-4  | open (plural ternaries)               | PR1 Step 5 (`company-share`), PR4 Step 2 (`stats`)                                           |
| COPY-M-fin-5  | open (the 3-char threshold not named) | PR1 Step 4 (`index.tsx`)                                                                     |
| COPY-M-fin-6  | open (`EmptyRow` «Нет данных»)        | PR1 Step 4                                                                                   |
| COPY-M-fin-7  | open («Неизвестная ошибка»)           | PR4 Step 3 (`usePayoutPaymentForm` + `SettleSenior`)                                         |
| COPY-M-fin-8  | open (four date formats, a shadow)    | PR1 Step 3 (formatters), PR2 Step 3 (the shadow in `DropFinancePage`)                        |
| COPY-M-fin-9  | open (`за {YYYY-MM}`, «% coverage»)   | PR4 Step 2 (`stats`)                                                                         |
| COPY-M-fin-10 | open (jargon, emoji)                  | PR4 Step 2 (`PayoutPaymentForm`), Step 4 (`invoice-detail`)                                  |
| COPY-M-fin-11 | open (Latin in labels)                | PR1 Step 3 (`TYPE_LABELS`), PR3 Step 2 (`TYPE_DESCRIPTIONS.DROP_INCOME`)                     |
| COPY-M-fin-12 | open (`PaymentStatusBadge.failed`)    | PR2 Step 3                                                                                   |
| COPY-M-fin-13 | open (`STATUS_LABELS` ambiguous)      | PR1 Step 3                                                                                   |
| COPY-M-fin-14 | open (two similar deletion texts)     | PR1 Step 4 (`index.tsx`)                                                                     |
| COPY-M-fin-15 | open (loading errors without action)  | PR4 Step 2 (`stats`), Step 4 (`invoice-detail`)                                              |
| COPY-L-fin-16 | open («Инвойс» ×11)                   | PR4 Step 4 (invoices)                                                                        |
| COPY-L-fin-17 | open («Комиссия» in expenses)         | PR3 Step 3 (`EXPENSE_CATEGORIES`)                                                            |
| COPY-L-fin-18 | open (truncations)                    | PR4 Step 2 (`stats`), Step 3 (`CompanySharePayoutModal`)                                     |
| COPY-L-fin-19 | open («TX Hash», etherscan)           | PR1 Step 4 (`index.tsx`), PR4 Step 2 (`PayoutPaymentForm`)                                   |
| COPY-L-fin-20 | open («Факт платежа», «платёж»)       | PR2 Step 2 (`TransactionDetailDialog`), Step 3 (`DropFinancePage`)                           |
| COPY-L-fin-21 | open (button label quote)             | PR1 Step 5 (`cascade-preview`)                                                               |

Findings: COPY-H-fin-1 … COPY-H-fin-4, COPY-M-fin-5 … COPY-M-fin-15, COPY-L-fin-16 … COPY-L-fin-21 (21) — 21 rows in the table.

---

## Findings outside the perimeter (we do not expand, we record)

| What                                                                                                                | Whose wave / where to                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/lib/format-amount.ts` (`formatAmount` `ru-RU`, `formatAmountUsd` `en-US`) — the money-formatting root | Cross-slice (invoices, notifications, web-core). See "Contested decision 3" — a separate coordinated edit     |
| `EXPENSE_CATEGORIES` codes + migration of `receiver_label` (api + shared + prod-DDL)                                | A separate api+shared+DDL PR, a precondition of PR3. See "Contested decision 1"                               |
| `ConfirmPayoutDialog.onError` / `cascade-preview.extractBackendMessage` — verbatim server text                      | Until `api` is fully localized, the screen is mixed. A dependency on the `api` slice; do not change the logic |
| Finance/invoices server error codes                                                                                 | Migrated in #704 — consume, do not duplicate                                                                  |

---

## What is NOT included

- **`apps/api`** — the `apps/web` wave does not touch it (except the `EXPENSE_CATEGORIES` precondition, carried out as a separate PR).
- **Stage 6**: ESLint `lingui/no-unlocalized-strings` in error mode, the guard for Russian letters, `extract --clean` as a hard gate.
- Texts with an explicit id (`api-error.*`, `zod-error.*`) the wave does not change, only uses (#704).
- Currencies/brands (`USDT`, `USD`, `UAH`, `EUR`, `Etherscan`, `HR`) — not translated.
- `localeCompare('ru')` — it is not in finance (checked); in `documents-filter-sort.ts` it was already replaced with `Intl.Collator` in stage 2 (web-docs-notify).

---

## Assumptions (A1 — reversible, recorded)

1. **Perimeter = the `web-finance` audit slice + the finance components left by wave c** (`TransactionRow`, `TransactionDetailDialog`, `fmtUsd`, `ExchangeRates` — they are in `finance/**`, native here). Excluded: files without Cyrillic (`KpiCards`, `api.ts`, `sort.ts`, `usePaginatedFilter`), `apps/api`, the format-amount root (cross-slice), the EXPENSE migration (a separate PR). Each deviation — a line in the "Perimeter" table.
2. **4 PRs, sequential merge.** The slice 744 lines / 30 files ≈ wave c (786/33 → 4 PR). PR4 is larger (~304) because of `stats.tsx` + invoices + removing the maps — it is done by section (`stats` and `CreateTransactionDialog` — `wip:` by section), like `$projectId` in wave c. **Alternative:** split out statistics+invoices into a 5th PR — without changing the rest of the plan; the choice is up to the orchestrator/owner if the PR4 review turns out heavy.
3. **`security-reviewer` is mandatory on ALL four PRs** (the whole slice — money/RBAC/critical-path), not only on the "financial" ones: even the ledger shows amounts with `mapTx(viewer)` masking.
4. **`fmtUsd`/`fmtAmount`/`toUsd` keep their signatures** — locale-awareness is done inside, so that `$projectId` (web-projects) and other external consumers are not edited by this wave.
5. **The old `TYPE_LABELS`/`STATUS_LABELS` live `@deprecated` PR1→PR4**, removed in PR4 (as `PAYMENT_TYPE_LABELS` PR3→PR4 of wave c). Because of this `constants.ts` "0 Russian" is checked in PR4, not PR1.
6. **The `uk`/`en` drafts in the canon** — a guide; the final text is approved by `copy-reviewer` ("two originals"); a divergence from the draft is not a plan violation.
7. **The `stats`/`invoice` roles — their own enums**, translated by template G, not via `ROLE_LABEL_MESSAGES` (it has a different set of keys).

## Questions for the owner (A2 — irreversible/expensive, accumulate in the decision brief)

1. **`EXPENSE_CATEGORIES` — migration of the `receiver_label` data on prod.** Introducing stable codes (`SERVICE`/`BANK_FEE`/`OTHER`) requires migrating the existing Russian values on prod (finance data, prod-DDL via `deploy.yml`, no SSH). This is **irreversible** and a **critical path** → A3-by-cost-of-error, but it does not block the rest of the wave. **Recommendation:** a separate api+shared PR BEFORE PR3, with idempotent SQL in `deploy.yml`, security+DDL review. If the owner prefers a minimum — an interim: display by code + a back-compat resolver of the old Russian values, the real data migration deferred (then the data-at-rest stays Russian until a separate task; the stage 6 guard will flag it later). An owner decision on the migration timing is needed.
2. **`lib/format-amount.ts` locale-awareness.** The money-formatting root (`ru-RU`/`en-US`) is used by invoices, notifications, `fmtAmount`. Making it locale-aware is possible (a) without changing the signature — read the current locale from the i18n context, or (b) add a `locale` parameter — breaking for all calls (web-core, api). **Recommendation:** option (a) within this wave for the finance calls, the full consolidation — a coordinated task with web-core; clarify with the owner whether to do (b) now or defer. It does not block PR1–PR4 (finance amounts are formatted via `formatMoney`/`fmtUsd` with the locale).

---

## Wave (d) readiness check

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — green after each PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` on the specs from the "Distribution" and the sweep output — green; CI on all shards green.
- `pnpm i18n:extract` twice in a row — the second run does not change `.po`; in `en` 0 empty `msgstr`.
- `pnpm mutation:changed` — `survived 0`; a `NoCoverage` without an integration-hint closed by a unit test; `node scripts/devops/check-mutation-suppressions.mjs` — green.
- PR4 final check: 0 lines with `[ыэъё]` outside comments in the perimeter; `git grep TYPE_LABELS/STATUS_LABELS` in finance empty; the old formatter shadows removed.
- In `CONTEXT.md` there is a subsection "Wave d — `web-finance`".
- `copy-reviewer`: `PASS` on `uk` and on `en` for each of the 4 PRs.
- `security-reviewer`: `APPROVE` for ALL four PRs (amount masking, drop/senior share, company account, dividends, payouts/settlements, invoices).
- Screenshots 320/1440 × `uk`/`en` for each migrated screen — in each PR's body; fidelity Mode B — all widths.
- Trace: 21 `web-finance` audit identifiers — each with a line in the body of the PR that closes it (`review-findings-transfer.md`).
