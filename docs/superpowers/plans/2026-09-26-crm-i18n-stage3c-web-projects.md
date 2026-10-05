# CRM i18n — stage 3, wave (c) "web-projects" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate to `uk`/`en` everything in the CRM that concerns projects and hiring: interviews (kanban), vacancies and applications, the project list with a status filter, the junior legend, project approval and credentials, the project detail page, the junior hub and the admin contract templates. Four PRs, the product files do not overlap, no Russian text remains in the migrated files, and nine `*_LABELS` maps of this slice (kanban stages, payment type, status filter, vacancy/application statuses, employment type, salary period, local `ROLE_LABELS`) are moved to the catalog or to the `ROLE_LABEL_MESSAGES` canon, because after the wave there is no place left for Russian literals in them.

**Architecture:** The same single catalog `packages/shared/src/i18n/locales/{uk,en}/messages.po` and the same templates A–F as in waves (a)/(b). Three things are new in this wave. First — **nine label maps in three `constants.ts`** (`interviews`, `projects`, `vacancies`): they are edited before string extraction, not after, otherwise English stage names, three spellings of "gig contract" and a mismatched gender would go into both catalogs. Second — **two places of manual pluralization** (`VacancyCard` self-written `pluralizeOtklik`, `vacancies/constants.zodIssueRu`) and three concatenations with a case (`project-approval-caption`), which are translated not by a mechanical replacement but by restructuring the phrase. Third — **the wave (c) term canon table** (the section below): roles are taken from the already-merged `ROLE_LABEL_MESSAGES`, and the project/hiring terms (composition, interview, application, payment type, legend) — from the `CONTEXT.md` glossary. PR1, PR2 and PR3 go in parallel; PR4 waits for PR3, because `$projectId.tsx` consumes the payment-type map that PR3 translates.

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`), already set up in stage 2. React 18, Vite 6, Vitest 4, TanStack Router, Tailwind v4, shadcn/ui, `eslint-plugin-lingui` 0.16.0 (`warn`), Playwright, Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §5 (gates), §7 (wave order), §8 (tests). Audit: `docs/architecture/2026-09-19-crm-i18n-audit.md`, the `web-projects` slice (23 findings, `Findings:` at the end of the slice) and the cross-cutting themes §1–§2. Samples of format, quality and templates: the wave plans (a) `docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md` (templates A–F) and (b) `docs/superpowers/plans/2026-09-24-crm-i18n-stage3b-web-people.md` (wave structure, lessons #700–#721).

**Measurement:** all the numbers below were taken by commands on `origin/main` `0420499b` (#721) 2026-09-26. Before starting each PR the implementer repeats the measurement (step 0 of each task): between the plan and execution other branches may have merged into `main`.

## Global Constraints

Apply to each task. Items marked "lesson" are taken from the reviews of PR #700–#721 (waves a/b) and already cost a separate review round once.

**Lingui versions and mechanics**

- `@lingui/*` — **5.9.5 EXACT**, a single version (`version-pins.md`). This plan upgrades nothing.
- Source text in the code — **Ukrainian** (`sourceLocale: 'uk'`). English is written by the same coder in the same PR as a second original (skill `copywriting` §5, owner decision #7). The default interface is `uk`, the second language is `en`.
- At the module level — only `msg`. `t`, `plural` and `select` at the module level are forbidden: the string freezes on import. In a component `t`/`i18n` are taken from `useLingui()` (`@lingui/react/macro`).
- **Lesson (#700): the `plural()` macro is incompatible with Stryker.** Under instrumentation `#` is not substituted. For numbers in JSX — the `<Plural>` component; outside JSX — `msg` with an ICU string and `i18n._(descriptor, { count })`. Do not use the call `t\`${plural(...)}\``. In this wave this concerns primarily `VacancyCard.pluralizeOtklik` and `vacancies/constants.zodIssueRu` (see template J).
- **Lesson (#707): `as const satisfies Record<…, MessageDescriptor>` on a map of `msg` templates disables Stryker for the whole block** (0 mutants). Write `satisfies Record<…>` without `as const`. If the gate shows 0 mutants in a file that definitely has `msg`, the cause is this. In this wave nine label maps are moved to `Record<…, MessageDescriptor>` — all `satisfies` without `as const`.
- `i18n._()` accepts only an **expression**: `i18n._(STAGE_LABEL_MESSAGES[stage])` or `i18n._(MAP[key])`. An object literal with a spread breaks `lingui extract`.
- **Lesson (#707): for records with an explicit id (`api-error.*`, `zod-error.*`) the `msgstr` is edited by hand in both `.po`.** `i18n:extract` does not overwrite an existing `msgstr`. This wave does not change texts with an explicit id, only uses them. If such an edit is needed — a separate line in the PR's "Assumptions" and a manual edit of both `.po`.

**Texts (`CONTEXT.md` → "`uk`/`en` forms" + the canon table below)**

- The apostrophe — `’` (U+2019), not `'` and not `ʼ`. The ellipsis — `…` (U+2026), not `...` (audit COPY-L-proj-19: in the slice 13 lines with `...` in 8 files against 11 with `…` in 5 — after extraction this would be 48 divergences in two catalogs instead of 24). Quotes: in `uk` guillemets `«…»`, in `en` typographic `“…”`.
- Roles are written from the `ROLE_LABEL_MESSAGES` canon (`@/components/ui/role-select`, 3a): `uk` — «адміністратор», «сеньйор», «джуніор», «HR», «бухгалтер», «дроп»; `en` — «admin», «senior», «junior», «HR», «accountant», «drop». The legacy `ROLE_LABELS` **is already removed** from `role-select.tsx` and `users/constants.ts` (3b PR3), but three **local** role maps still live in this wave's perimeter (`$projectId.tsx`, `admin/contracts.index.tsx`, `admin/contracts.$role.tsx`) — they are removed (template H).
- **Lesson (#702, item 13): a raw role/status enum in visible text is a finding.** After replacing a literal, scan the **whole** file: `grep -nE '\b(ADMIN|SENIOR|JUNIOR|HR|ACCOUNTANT|DROP|DRAFT|PUBLISHED|CLOSED|NEW|VIEWED|REJECTED|ACTIVE|PENDING|ARCHIVED|HR_SCREEN|TECH_INTERVIEW|OFFER_RECEIVED|HIRED|FOP|GIG_CONTRACT|USDT)\b'` over JSX text, `aria-label`, `title` and `placeholder`. For each screen with a role/status/stage — a test "no raw enum in the rendered screen". Exception: `HR`, `USDT`, `AI`/`EdTech`/… (vacancy domains) and `Senior`/`Lead` (levels) — these are at once an enum and canonical visible text (proper nouns / anglicisms, left as is — see the canon table).
- **Lesson (#702, item 9): substitution into an oblique case breaks `uk`.** A role/name is substituted only in the nominative. If another case is needed — `select` by the enum value with ready forms (the set of branches matches the values that actually reach the place), plus a test that `other` is unreachable. It is exactly this defect — the essence of COPY-H-proj-2 (`project-approval-caption`: `от ${имя}` in the nominative) and COPY-H-proj-4 (declension of the word "состав").
- A toast and a refusal — **one sentence, no period at the end**, with a verb; where there is an action, it says "what to do" (COPY-M-proj-13: dead ends without a next step are a finding). Telegraphic style is forbidden. One situation — one text: identical empty states take the text from the canon table verbatim (for "a filter found nothing" — the already-existing catalog key «Нічого не знайдено — скиньте фільтри», wave b), then there is one key in the catalog.
- Field names, `teamMode`, enum values, `senior+team`, «крипта», internal names («карточка» about an interview, «Drop-проект» in Latin) in human-facing text are forbidden (audit COPY-H-proj-4/5, M-14, L-21).
- **Lesson (#701, item 5): check russisms by unicode, not a byte `grep`.** Before each push:

```bash
python3 -c "import re,sys,subprocess;fs=subprocess.run(['git','diff','--name-only','origin/main','--','apps/web/app'],capture_output=True,text=True).stdout.split();[print(f,i,l.strip()) for f in fs if f.endswith(('.ts','.tsx')) for i,l in enumerate(open(f,encoding='utf8'),1) if re.search('[ыЫэЭъЪёЁ]',l) and not re.match(r'\s*(//|\*|\{/\*)',l)]"
```

Strings from this output in files of **your** PR are an incomplete migration. Exceptions — test fixtures with Russian data (people's names from the seed) and comments. Separately: the letters `і ї є ґ` are already Ukrainian, not a russism; the guard targets exactly `ы э ъ ё`.

**Tests**

- Anchors — `data-testid` and roles. Text in assertions is taken from the **`uk` catalog**, not a literal:
  - Vitest — `loadCatalog(locale)` and `I18nTestProvider` from `apps/web/app/test/i18n.tsx` (already in `main`);
  - E2E — `loadMessages('uk')` and `assertInCatalog(uk, '<text>')` from `apps/e2e/fixtures/catalog.ts` (already in `main`).
- **Lesson (#700, item 2): the E2E sweep is over the whole `apps/e2e`, not over the specs in the diff.** A regression — any literal of a migrated component in any spec. The procedure and script — "Common step: E2E sweep" below. "Pre-existing" is allowed only if CI on `origin/main` is red on the same spec.
- **Lesson (#700, item 3): the mutation gate on the full diff is a mandatory AC**, `survived 0`. If a `NoCoverage` has no integration-hint, a unit test closes it (`mutation-gate-integration-specs.md`). A local SKIP on timeout is not a PASS: then `stryker run` directly with `dryRunTimeoutMinutes: 20` and the same config as the gate.
- **Lesson (#699, item 12): each Stryker suppression — with a reason on the same directive line**, no shorter than 12 characters (`// Stryker disable next-line <Mutator>: <reason>`). Before push — `node scripts/devops/check-mutation-suppressions.mjs`: a local `pnpm mutation:changed` does not call it, and CI with it fails all Mutation Gate jobs before even starting.
- Tests are edited by the same coder in the same PR (the AutoTest zone by the file's nature, but editing assertions inside the migrated module is part of the same task, as in waves a/b). The wave does not introduce new `*.spec.ts` E2E scenarios; new unit cases (a test for a role/stage without a raw enum, a test for pluralization) — inside the existing test files.

**Process**

- `git add` by an explicit list (each task has one). Push — `DATABASE_URL= git push`, without `--no-verify`. Each commit carries `ac_verified:` with the numbers from the "Acceptance criteria" section of its task.
- **Lesson (#700, item 6): a cadence for 20+ files** — `wip:` commits locally, one push at the end. Pre-push under load flakes, each push takes 5–12 minutes. `$projectId.tsx` (165 lines, PR4) — by section, `wip:` after each.
- **Lesson (#700, item 5): screenshots and live passes are done with the `npx playwright` script in your own scratchpad**, not via `mcp__playwright__*`: the MCP browser is shared across all parallel agents.
- **Lesson (#704/#707): the `.po` conflict on parallel PRs is additive.** Take both sides, then `pnpm i18n:extract` twice, the second run gives an empty diff. Check by numbers: the number of `msgid` equals `main` plus the PR's new records, and fuzzy, `#-#-#` and empty `msgstr` in `en` — 0. The `.po` merge is not given to haiku.
- **Lesson (#700, item 9): the task file is the only channel of requirements.** In the coder's prompt the orchestrator writes: "all the 'Orchestrator addendum' sections in the task file are part of the assignment".
- After each Edit/Write of `.ts`/`.tsx` — `mcp__eslint__lint-files`. On the lines the wave touches there must be no new `lingui/no-unlocalized-strings` warnings.
- `pnpm i18n:extract` is idempotent: a second consecutive run does not change `.po`. The CI gate "i18n catalogs are in sync" checks this, before push the same is reproduced locally.
- **Lesson (#705): FM-5 guard-test gate.** The wave **does not touch** `apps/api`. If the implementer still decides to edit a controller from the `guard-test-gate.yml` list, the same PR needs a changed `apps/api/**/*.spec.ts` with a 403 assertion (or the line `guard-test-na: <reason>` in the PR body before push). It is better to carry out such an edit as a separate PR.
- Each PR passes design-gate **Tier 2** (editing existing screens: a ui-ux-designer conformance check, without generation in Claude Design) and fidelity Mode B on all device classes. The `copy-reviewer` verdict — on `uk` and on `en` **separately**. `security-reviewer` is **mandatory for PR3 and PR4**: they touch project-share approval, project credentials, the junior legend (masking), project passwords and the admin contract templates (critical-path zones of `pm.md`). PR1 (interviews) and PR2 (vacancies) do not require `security-reviewer` by the rule, but pass copy+code+spec+design like all. The logic in PR3/PR4 does not change — the reviewer must verify this, not the author.
- **Responsive AC for each PR:** the screens from the task are checked at 320 and 375 (mobile), 768 (tablet), 1024 and 1280 (laptop), 1440 and 1920 (large) in **both** languages. No horizontal scroll (`document.scrollWidth <= clientWidth`), no label is truncated without `truncate` with `title`, touch targets on mobile are no less than 44×44. Screenshots 320 and 1440 × `uk` and `en` are attached to the PR. **A special risk of the wave is the project status filter tabs** (`STATUS_FILTER_LABELS`/`STATUS_FILTER_LABELS_MOBILE`, PR3): their width was tuned to the Russian text over six rounds with two CI failures (see the comment in `projects/constants.ts` and the COPY danger "The width is tuned to the Russian text"). Ukrainian is 15–30% longer than Russian, so this tuning must be re-measured anew at 320/375/768/1024, not trusting the old pixel values.

---

## Test access to the catalog (helpers already in `main`)

Implemented by wave (a) and merged. Here — how to use it.

```tsx
// Vitest (apps/web) — the real catalog via the same path as in production
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

await loadCatalog('uk')
render(<KanbanColumn stage="HR_SCREEN" cards={[]} />, { wrapper: I18nTestProvider })
expect(screen.getByText('HR-скринінг')).toBeInTheDocument()
```

```ts
// E2E (apps/e2e) — `pnpm i18n:compile` is mandatory before a run
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

const uk = await loadMessages('uk')
await expect(
  page.getByRole('columnheader', { name: assertInCatalog(uk, 'HR-скринінг') }),
).toBeVisible()
```

`assertInCatalog` fails with a clear error if the text is not in the catalog: so an outdated literal does not turn into a Playwright timeout. The relative import path depends on the spec's depth: `'../fixtures/catalog'` for `tests/*.spec.ts`, `'../../../fixtures/catalog'` for `tests/crm/<section>/*.spec.ts`.

---

## Perimeter of wave (c) — how it was obtained

Command (the boundaries of the `web-projects` audit slice + the additions from the assignment):

```bash
# the web-projects slice
find apps/web/app/components/{projects,interviews,pending-share} \
     apps/web/app/routes/_authenticated/{projects,interviews,vacancies} \
     apps/web/app/routes/_authenticated/{project,projects,legend}.tsx \
     -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*__tests__*' ! -name '*.spec.*' ! -name '*.test.*'
# there is no components/interviews directory — the kanban components live under routes/_authenticated/interviews/components/
# additions from the assignment (admin contract templates + vacancy hook)
find apps/web/app/components/contracts -type f
ls apps/web/app/routes/_authenticated/admin/contracts.index.tsx apps/web/app/routes/_authenticated/admin/contracts.\$role.tsx
ls apps/web/app/hooks/use-vacancies.ts apps/web/app/hooks/use-contract-tokens.ts apps/web/app/lib/contract-variables.ts
```

Result on `0420499b`: in the `web-projects` slice — **30 product files with Cyrillic** (678 lines outside comments out of 889 with Cyrillic in total; the audit counted 33 product files and ≈676 lines — it matches, the difference is that `ProjectLogo.tsx` and two more files contain no Cyrillic). The additions from the assignment give another **6 files** (~108 lines outside comments).

Further the perimeter is adjusted. Each deviation — a line in "Assumptions" below.

| What                                                                                                                            | Decision           | Why                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/routes/_authenticated/vacancies/**`, `hooks/use-vacancies.ts`                                                    | **include** (PR2)  | The audit explicitly assigns `vacancies` to the boundaries of the `web-projects` slice (not to `web-finance`/`web-docs-notify`). We give them to this wave                               |
| `routes/_authenticated/admin/contracts.{index,$role}.tsx`, `components/contracts/{VariablesPanel,AddCustomVariableDialog}.tsx` | **include** (PR4)  | The wave (b) plan in "Findings outside the perimeter" explicitly gave the contracts admin to wave (c). The local `ROLE_LABELS` (`HR-менеджер`) and the concatenation «Шаблон для роли … опубликован» wait here |
| `components/user-profile/contract/**`, the onboarding contract                                                                 | **exclude**        | Already migrated in wave (b) (#717). Not in the perimeter                                                                                                                                 |
| `components/contracts/contractTokenHighlight.ts`, `hooks/use-contract-tokens.ts`, `lib/contract-variables.ts`                  | **do not migrate** | 0 Cyrillic (checked). The assignment listed them as the contracts admin area, but there is no text in them — nothing to touch                                                            |
| `components/projects/ProjectLogo.tsx`                                                                                           | **do not touch**   | 0 Cyrillic                                                                                                                                                                                 |
| `routes/_authenticated/projects/constants.ts` → `PAYMENT_TYPE_LABELS`, `STATUS_FILTER_LABELS(_MOBILE)`                         | **PR3 owns**       | The payment-type map is consumed by `projects/index.tsx` (PR3) and `$projectId.tsx` (PR4) — it moves to `PAYMENT_TYPE_MESSAGES` in PR3, PR4 consumes the new form. Hence the PR4→PR3 dependency |
| `CONTEXT.md`                                                                                                                   | **add** (PR1)      | Lesson #700, item 1: the wave's term forms are entered into the glossary before migrating the files. PR1 starts first of the parallel wave — it enters the canon                          |
| Finance components embedded in `$projectId.tsx` (`TransactionRow`, `TransactionDetailDialog`) and `fmtUsd`/`ExchangeRates`     | **do not touch**   | This is the `web-finance` slice (wave d), not yet migrated. `$projectId` only renders/calls them; their Russian text lives until wave (d) — a line in "Findings outside the perimeter" and in the PR4 body |

Summary by PR:

| PR      | What                                                                                                             | Product files | Cyrillic lines outside comments |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------- |
| **PR1** | Interviews (kanban): stages, boards, card dialogs, the interview detail sheet, archive                           | 8                  | 86                               |
| **PR2** | Vacancies and applications: status/type maps, forms, cards, candidates, empty states, application pluralization  | 12                 | 171                              |
| **PR3** | Projects: list + status filter, junior legend, approval, status badge, credentials/passwords, pending-share      | 10                 | 242                              |
| **PR4** | The project detail page (`$projectId`), the junior hub (`project.tsx`), the admin contract templates             | 6                  | 287                              |

The sum of migrated lines — 786. Three PRs are parallel (PR1 ∥ PR2 ∥ PR3, the files do not overlap, the only shared thing is `.po` — an additive conflict). PR4 waits for PR3.

---

## Parallelism discipline

| Step | What                | Waits for    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PR1 ∥ PR2 ∥ PR3** | —            | The product files of the three PRs do not overlap: `interviews/**` (PR1), `vacancies/**`+`use-vacancies.ts` (PR2), `projects` (list/legend/components/pending-share) (PR3). The only shared thing — `.po` (additive) and common terms from the canon table (identical empty states take one key verbatim). Dispatch in a wave of ≤ 3–4 simultaneously (`light-track.md` "Concurrency ceiling")                                                                                                                                                                 |
| 2   | **PR4**             | merge of **PR3** | (1) `$projectId.tsx` consumes `PAYMENT_TYPE_MESSAGES` from `projects/constants.ts`, which PR3 introduces (removing/changing the old `PAYMENT_TYPE_LABELS` is possible only after both consumers have migrated — the consumer `projects/index.tsx` in PR3, `$projectId.tsx` in PR4). (2) The shared E2E spec `projects.spec.ts`/`project-status-filter-ui.spec.ts` is affected by both PR3 (list, tabs) and PR4 (detail) — sequentially there are no conflicts. The admin contract templates inside PR4 do **not** depend on PR3 and may, if desired, start earlier |

**E2E spec distribution** (whichever's text a line asserts, that PR edits it; the guide — take the exact list with the sweep script at the push step of each PR). E2E specs outside the perimeter that hit these routes and search by Cyrillic — 14. The main ones:

| PR  | Specs (guide, Cyrillic lines on `0420499b`)                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR1 | `interviews.spec.ts` (48), plus any specs asserting the kanban stages and interview dialogs — per the sweep output                                                                                                                                                                                                             |
| PR2 | `vacancies.spec.ts` (47), plus specs on applications/candidates — per the sweep                                                                                                                                                                                                                                                |
| PR3 | `projects.spec.ts` (49), `project-status-filter-ui.spec.ts` (62), `projects-senior-share-override.spec.ts` (133), `project-credentials.spec.ts` (113), `legend.spec.ts` (16), `crm/projects/projects-archive.spec.ts` (16), `project-draft-status.spec.ts` (13) — per the sweep                                                 |
| PR4 | `junior-hub.spec.ts` (80), `drop-attach-project.spec.ts` (30), `project-payment-type-and-drop-share.spec.ts` (15), `drop-project-create.spec.ts` (10), `senior-project-distribution-regression.spec.ts` (4), `dashboard-russian-strings.spec.ts` (14 — check whether it specifically asserts the hub's Russian strings) — per the sweep |

`cache/anti-stale.spec.ts` (`/^Синьор/`) asserts the role caption in the project dialog — it lands in the sweep of the PR that migrates that caption (PR4, `$projectId`).

---

## Wave (c) term canon — `uk`/`en`

PR1 moves this table into `CONTEXT.md` (the "`uk`/`en` forms" section, a continuation of waves a/b) in the first commit. PR2, PR3 and PR4 take the words from here verbatim. The "Source" column refers to the audit finding or the glossary that predetermined the choice.

| Term (rus., for reference)              | `uk`                                                     | `en`                                                         | `_Избегать_` in the product (`uk`/`en`)                                                                                                                                          | Source                                             |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Interview (`interviews`)                | співбесіда                                               | interview                                                    | «інтерв’ю», «карточка», «candidate card»                                                                                                                                          | glossary **Interview**; COPY-M-proj-14             |
| Interview stage (`interviewStage`)      | стадія                                                   | stage                                                        | «колонка» as a term; English stage names in visible text                                                                                                                         | COPY-H-proj-1                                      |
| Stage `HR_SCREEN`                       | HR-скринінг                                              | HR screen                                                    | «HR Screen» in Latin inside `uk`                                                                                                                                                 | COPY-H-proj-1                                      |
| Stage `ENGLISH_CHECK`                   | Англійська                                               | English                                                      | «English» in `uk`                                                                                                                                                                 | COPY-H-proj-1                                      |
| Stage `TECH_INTERVIEW`                  | Технічна                                                 | Technical                                                    | «Tech» as a label                                                                                                                                                                | COPY-H-proj-1                                      |
| Stage `FINAL_INTERVIEW`                 | Фінальна                                                 | Final                                                        | —                                                                                                                                                                                 | COPY-H-proj-1                                      |
| Stage `CLIENT_INTERVIEW`                | З клієнтом                                               | Client                                                       | —                                                                                                                                                                                 | COPY-H-proj-1                                      |
| Stage `OFFER_RECEIVED`                  | Оффер отримано                                           | Offer received                                               | «Offer» in Latin inside `uk`; **a flag for copy-reviewer**: the glossary «Vacancy» puts «оффер» into `_Избегать_` — if the reviewer insists, `uk` «Пропозицію надіслано» / `en` «Offer sent» | COPY-H-proj-1 + glossary **Vacancy**               |
| Stage `HIRED`                           | Найнято                                                  | Hired                                                        | «Нанят» (rus.)                                                                                                                                                                   | COPY-H-proj-1                                      |
| Stage `REJECTED` (interview)            | Відмова                                                  | Rejected                                                     | «Отказ» (rus.)                                                                                                                                                                   | COPY-H-proj-1                                      |
| Stage `ARCHIVED` (interview)            | Архів                                                    | Archived                                                     | —                                                                                                                                                                                 | COPY-H-proj-1                                      |
| Project (`projects`)                    | проєкт                                                   | project                                                      | «проект» without «є»                                                                                                                                                             | glossary (wave a)                                  |
| Project composition (`projectMembers`)  | склад                                                    | project members                                              | «команда проекту» (`teams` is its own entity), «участники»                                                                                                                       | glossary **Composition**; COPY-H-proj-4            |
| Add to/remove from the composition      | додати до складу / прибрати зі складу                    | add to the project / remove from the project                 | «додати учасника», «додати в команду»                                                                                                                                            | COPY-H-proj-4                                      |
| Payment type (`projectPaymentType`)     | тип оплати                                               | payment type                                                 | —                                                                                                                                                                                 | glossary **Project payment type**                 |
| `PAYMENT_TYPE_LABELS.FOP`               | ФОП                                                      | FOP                                                          | —                                                                                                                                                                                 | —                                                  |
| `PAYMENT_TYPE_LABELS.GIG_CONTRACT`      | гіг-контракт                                             | gig contract                                                 | «гиг», «гиг-контракт» (rus.), two cases                                                                                                                                          | COPY-H-proj-5                                      |
| `PAYMENT_TYPE_LABELS.USDT`              | USDT                                                     | USDT                                                         | «крипта» as a synonym for USDT                                                                                                                                                   | COPY-H-proj-5                                      |
| Corporate hardware (`corpTech`)         | корпоративна техніка                                     | corporate hardware                                           | «Корп. техника», «Корп. технологии» — three spellings of one field                                                                                                              | COPY-H-proj-3                                      |
| Salary review (`salaryReview`)          | перегляд зарплати                                        | salary review                                                | «Пересмотр ЗП» / «Пересмотр зарплаты» intermixed                                                                                                                                 | COPY-H-proj-3                                      |
| Project approval status                 | Очікує рішення                                           | Awaiting decision                                            | «Отклонено» (neuter), «На подтверждении», «Черновик» as project status names                                                                                                    | glossary **Project approval status**               |
| The "awaiting" projects section (`/pending`) | Очікують рішення                                         | Awaiting decision                                            | —                                                                                                                                                                                 | glossary (plural)                                  |
| Status filter `ACTIVE`                  | Активні / (short) Активні                                | Active                                                       | —                                                                                                                                                                                 | COPY danger "width"                                |
| Status filter `PENDING`                 | Очікують рішення / (short) Чекають                       | Awaiting / (short) Waiting                                   | «Ждут решения» (rus.); «Откл.»                                                                                                                                                   | glossary; COPY danger "width"                      |
| Status filter `REJECTED` (project)      | Відхилені / (short) Відмова                              | Rejected                                                     | «Отклонённые» (rus.)                                                                                                                                                             | COPY-M-proj-8                                      |
| Status filter `ARCHIVED` (project)      | Архів                                                    | Archived                                                     | «Завершён» about archival                                                                                                                                                        | COPY-M-proj-8                                      |
| Archived (project)                      | в архіві / в архіві з {дата}                             | archived / archived since {date}                             | «Завершён», «Завершено»                                                                                                                                                          | COPY-M-proj-8; wave b catalog                      |
| Project with a drop                     | проєкт з дропом                                          | project with a drop                                          | «Drop-проект» in Latin                                                                                                                                                           | COPY-L-proj-21                                     |
| Vacancy (`vacancies`)                   | вакансія                                                 | vacancy                                                      | «позиція», «джоба», «оффер»                                                                                                                                                      | glossary **Vacancy**                               |
| Application to a vacancy                | відгук                                                   | application                                                  | «заявка», «позиція»                                                                                                                                                             | glossary **Vacancy**; COPY-M-proj-10               |
| Vacancy status `DRAFT`                  | Чернетка                                                 | Draft                                                        | —                                                                                                                                                                                 | COPY-M-proj-7; wave b catalog («чернетка»)         |
| Vacancy status `PUBLISHED`              | Опублікована                                             | Published                                                    | «Опубликовано» (neuter with «вакансия»)                                                                                                                                          | COPY-M-proj-7                                      |
| Vacancy status `CLOSED`                 | Закрита                                                  | Closed                                                       | «Закрыто» (neuter)                                                                                                                                                              | COPY-M-proj-7                                      |
| Application status `NEW`                | Новий                                                    | New                                                          | —                                                                                                                                                                                 | COPY-M-proj-7                                      |
| Application status `VIEWED`             | Переглянутий                                             | Viewed                                                       | «Просмотрено» (neuter); «Просм.»                                                                                                                                                 | COPY-M-proj-7, M-11                                |
| Application status `REJECTED` (application) | Відхилений                                               | Rejected                                                     | «Отклонено» (neuter); «Откл.» (reads as "turned off")                                                                                                                           | COPY-M-proj-7, M-11                                |
| Employment type `FULL_TIME`             | Повна зайнятість                                         | Full-time                                                    | —                                                                                                                                                                                 | COPY-M-proj-7 (map `EMPLOYMENT_TYPE_LABELS`)       |
| Employment type `PART_TIME`             | Часткова зайнятість                                      | Part-time                                                    | —                                                                                                                                                                                 | —                                                  |
| Employment type `CONTRACT`              | Проєктна робота                                          | Contract                                                     | «Контракт» (confused with the contract status)                                                                                                                                  | —                                                  |
| Salary period (`SALARY_PERIOD`)         | година / день / тиждень / місяць / рік                   | hour / day / week / month / year                             | —                                                                                                                                                                                 | COPY-M-proj-7 (the neighboring map)                |
| Vacancy domains (`DOMAIN_LABELS`)       | AI, EdTech, E-Commerce, …                                | AI, EdTech, E-Commerce, …                                    | translating proper domain names                                                                                                                                                  | the comment in `vacancies/constants.ts`            |
| Levels (`SENIORITY_LABELS`)             | Senior, Lead, …                                          | Senior, Lead, …                                              | translating grades                                                                                                                                                              | the comment in `vacancies/constants.ts`            |
| Junior legend (`legends`)               | легенда                                                  | legend                                                       | —                                                                                                                                                                                 | glossary **Legend**                                |
| Cover story (`cover story`)             | кавер-сторі                                              | cover story                                                  | «cover story» in Latin inside `uk`, «Бэкстори» — three spellings                                                                                                                | COPY-M-proj-18                                     |
| Role shown to the client                | посада для клієнта                                       | role shown to the client                                     | «Позиция для клиента» (glossary «Vacancy»: _avoid_ «позиция»)                                                                                                                   | COPY-L-proj-23                                     |
| Legend example (address)                | Київ, вул. Хрещатик, 1                                   | 1 Khreshchatyk St, Kyiv                                      | «Киев, ул. Крещатик 1» (rus. translit), examples with Russian realia (МГУ)                                                                                                     | COPY-M-proj-17                                     |
| A filter found nothing                  | Нічого не знайдено — скиньте фільтри                     | No matches — clear the filters                               | «Нет данных», «Пусто» without explanation                                                                                                                                       | wave b catalog (key exists — reuse)                |
| The public vacancies page               | розділ «Вакансії» на сайті                               | the “Vacancies” section on the site                          | «страница карьеры»/«careers page» (not called that publicly)                                                                                                                    | COPY-M-proj-10                                     |
| Project money (credentials)             | Гроші за проєктом більше не йтимуть через його реквізити | Project money will no longer go through their payout details | «Приходы больше не будут проходить через него»                                                                                                                                  | COPY-L-proj-22                                     |
| Contract template (admin)               | шаблон договору                                          | contract template                                            | —                                                                                                                                                                                 | glossary **Template/signed contract**              |
| Role in a template (`ContractTargetRole`) | from `ROLE_LABEL_MESSAGES`                               | from `ROLE_LABEL_MESSAGES`                                   | «HR-менеджер» (in `admin/contracts` the HR role is named differently from the canon map)                                                                                        | COPY-M-core-9                                      |

The apostrophe, ellipsis, quotes, `en` refusals "Could not …" — per the common `CONTEXT.md` section "`uk`/`en` forms", not rewritten here.

---

## Migration templates

**A–F — the same as in waves (a)/(b)** (`docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`, the "Migration templates" section): A — module constant → `msg` + `i18n._()` in the render; B — JSX text → `<Trans>`; C — attribute or imperative string → `t` from `useLingui()`; D — number → `<Plural>` (in this wave **component only**, the Stryker lesson); E — gender/case form by the enum value → `select`; F — date, money, number → `@crm/shared` `format.ts`.

New/refined in this wave:

**G. Enum label map → `Record<…, MessageDescriptor>` (template A on a map).** Nine maps (`STAGE_LABELS`, `PAYMENT_TYPE_LABELS`, `STATUS_FILTER_LABELS`, `STATUS_FILTER_LABELS_MOBILE`, `VACANCY_STATUS_LABELS`, `APPLICATION_STATUS_LABELS`, `EMPLOYMENT_TYPE_LABELS`, `SALARY_PERIOD_LABELS` and the local `ROLE_LABELS`). The service maps next to them (`STAGE_COLORS`, `VACANCY_STATUS_BADGE`, `DOMAIN_DOT_COLOR`) — **not text, do not touch.**

```ts
// was (interviews/constants.ts)
export const STAGE_LABELS: Record<InterviewStage, string> = {
  HR_SCREEN: 'HR Screen',
  ENGLISH_CHECK: 'English',
  /* … */ HIRED: 'Нанят',
}
// became — satisfies without `as const` (otherwise Stryker sees 0 mutants, lesson #707)
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
export const STAGE_LABEL_MESSAGES = {
  HR_SCREEN: msg`HR-скринінг`, // en: HR screen
  ENGLISH_CHECK: msg`Англійська`, // en: English
  // …
  HIRED: msg`Найнято`, // en: Hired
} satisfies Record<InterviewStage, MessageDescriptor>
```

The consumer — `i18n._(STAGE_LABEL_MESSAGES[stage])` (one value) or one `useLingui()` per component and `i18n._()` inside `.map()` (a hook cannot be called in `.map()`). Remove the old string map when it has no consumers left inside the PR; the check — `git grep -n STAGE_LABELS -- apps/web` inside your PR.

**H. Local role map → the `ROLE_LABEL_MESSAGES`/`useRoleLabel` canon.** Three places: `$projectId.tsx` (`Record<string, string>` with a `?? role` fallback, prints the enum — COPY-H-proj-4/lesson #702), `admin/contracts.index.tsx` and `admin/contracts.$role.tsx` (`Record<ContractTargetRole, string>` with `HR: 'HR-менеджер'` — COPY-M-core-9). `ContractTargetRole` ⊂ `Role`, so `ROLE_LABEL_MESSAGES[role]` is typed.

```tsx
// was ($projectId.tsx)
const ROLE_LABELS: Record<string, string> = {
  /* … */
}
{
  ROLE_LABELS[member.role] ?? member.role
}
// became — the `?? member.role` fallback is removed: the map covers all roles
import { useRoleLabel } from '@/components/ui/role-select'
const memberRoleLabel = useRoleLabel(member.role as Role) // in .map — via ROLE_LABEL_MESSAGES + one useLingui()
```

The replacement in `admin/contracts` changes «HR-менеджер» → «HR» (canon): this is a conscious consolidation COPY-M-core-9 (one role map per application), noted with a line in the PR4 body for `copy-reviewer`.

**I. E2E assert on migrated text → `assertInCatalog`.**

```ts
// was
await expect(page.getByText('гіг-контракт')).toBeVisible()
// became
const uk = await loadMessages('uk')
await expect(page.getByText(assertInCatalog(uk, 'гіг-контракт'))).toBeVisible()
```

If the element has a `data-testid` and the text is not the subject of the check — anchor by testid without text.

**J. Manual pluralization → `<Plural>` (in JSX) or `i18n._(msg, { count })` (outside JSX).** Two places: `VacancyCard.pluralizeOtklik` (a self-written ru pluralizer) and `vacancies/constants.zodIssueRu` (`«Минимум ${n} символов»` without branching). Remove the self-written function entirely.

```tsx
// was (VacancyCard.tsx)
{
  vacancy.applicationsCount
}
{
  pluralizeOtklik(vacancy.applicationsCount)
}
// became — a component, not the plural() macro (Stryker, lesson #700)
import { Plural } from '@lingui/react/macro'
;<Plural
  value={vacancy.applicationsCount}
  one="# відгук"
  few="# відгуки"
  many="# відгуків"
  other="# відгуку"
/>
// en (the second original): one="# application" other="# applications"
```

```ts
// was (vacancies/constants.ts zodIssueRu, outside a component)
;`Минимум ${issue.minimum} символов`
// became — outside JSX: msg with ICU + i18n._ at the display place (the function is passed i18n)
import { msg } from '@lingui/core/macro'
const MIN_CHARS = msg`{n, plural, one {Мінімум # символ} few {Мінімум # символи} many {Мінімум # символів} other {Мінімум # символа}}`
// in the component where i18n is known:  i18n._(MIN_CHARS, { n: issue.minimum })
```

`zodIssueRu` turns from a pure function either into a set of `msg` descriptors resolved by the calling component, or (preferably) moves to the `translateZodCode`/`translateZodMessage` code registry (`@/lib/axios-utils`, stage 4), if there are already codes for these schemas. The check: `git grep -n "min(1)\|min(2)\|min(3)" -- apps/web/app/routes/_authenticated/vacancies` and comparison with `packages/shared/src/schemas/zod-errors.ts`. The wave does not introduce a new code into the registry without an explicit line in "Assumptions" and a manual edit of both `.po`.

**K. Phrase concatenation with a case/gender → `<Trans>` with slots or `select`.** `project-approval-caption.ts` (`от ${имя}` in the nominative where the genitive is required — COPY-H-proj-2) and concatenations in JSX via `{' '}` (the COPY danger "a phrase from parts"). The function `resolveProjectApprovalCaption` returns a string — it moves either into a component as `<Trans>` with name slots, or into a set of `msg` descriptors the component resolves. The construction is chosen **to not require a case** (the neighboring file `cancel-pending-share.tsx` is already rewritten this way on COPY-M-17): «Підтверджують: {дроп}, {сеньйор}» instead of «від {імені}». `en` has no case, so one structure fits both languages. The test — that the output has neither a raw status enum nor the literal «null» (COPY-M-4: `seniorName` is sometimes `null`).

**L. Date/money with a fixed locale → `format.ts`.** In the slice 15 `toLocale*` calls with three locales (`ru-RU`, `uk-UA`, no locale) plus two `date-fns/locale/ru`.

```ts
// dates: was  new Date(iso).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
//        became  formatDate(iso, locale, 'monthYear')            // locale = useLocale()
// interviews/constants.ts formatDate('uk-UA', {day,month}) → formatDate(iso, locale, 'short')
// date-fns: was  formatDistanceToNow(d, { locale: ru })  →  formatRelativeTime(d, locale)   // CandidateCard
//           was  format(d, 'dd.MM.yyyy', { locale: ru })  →  formatDate(d, locale, 'short')  // $vacancyId
// money (bare number): was  project.rate.toLocaleString()  →  formatNumber(project.rate, locale)
// money (amount+code):    formatMoney(amount, currency, locale)
```

`salaryMonth` («2026-04», COPY-H-proj-6) in `project.tsx` is formatted by the same function as the fallback: the string `"2026-04"` is parsed into a date (`new Date(\`${salaryMonth}-01\`)`) and goes into `formatDate(…, locale, 'monthYear')`, then both variants in one list go into the locale together. `fmtUsd`/`ExchangeRates` from `finance/constants` **do not touch** — this is wave (d) (see "Danger: cross-slice finance").

---

## Common step: E2E sweep (performed in each PR before push)

The script collects the Russian fragments that **this PR removed** and searches for them across the whole `apps/e2e`. Each hit — a line to check. If the fragment remained in another not-yet-migrated component and a spec asserts exactly it, do not touch the line. If the spec asserts a migrated screen, move the line to template I.

```bash
SCRATCH="${TMPDIR:-/tmp}/wave-c-$(git rev-parse --abbrev-ref HEAD | tr / -)"   # own directory: name from your branch, not a shared path
mkdir -p "$SCRATCH"
git diff origin/main -- apps/web/app > "$SCRATCH/wave-c.diff"
```

```python
# $SCRATCH/e2e_sweep.py — python3 e2e_sweep.py <path-to-wave-c.diff>
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
python3 "$SCRATCH/e2e_sweep.py" "$SCRATCH/wave-c.diff" > "$SCRATCH/sweep.txt"
cut -d: -f1 "$SCRATCH/sweep.txt" | sort -u > "$SCRATCH/sweep-specs.txt"   # list for git add
```

The whole output goes into the PR body (the "E2E sweep" section) with a mark on each line: "moved to the catalog", "testid" or "not our text — <which component outside the wave renders it>". A line without a mark is unclosed. The specs enter the commit via `git add $(cat "$SCRATCH/sweep-specs.txt")`: for files without changes this is a no-op.

---

## Task 1 (PR1): interviews (kanban)

**Files:**

Product (`apps/web/app/routes/_authenticated/interviews/`, Cyrillic outside comments on `0420499b`):

| File                                          | Cyr. lines (outside comm.) | Pattern(s) | Audit findings / note                                                                                                                    |
| --------------------------------------------- | ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `components/InterviewDetailSheet.tsx`         | 41                     | B, C, G, H | COPY-H-proj-3 (`Корпоративная техника`, `Пересмотр зарплаты` — canon), H-5 (the placeholder `ФОП / гиг-контракт / крипта`, `через 3 місяці`) |
| `components/CreateProjectFromHiredDialog.tsx` | 17                     | B, C       | Texts for creating a project from a hired candidate; statuses/roles — canon                                                              |
| `components/CreateInterviewDialog.tsx`        | 10                     | B, C       | COPY-M-proj-14 («Новая карточка» → «Нове собеседование»)                                                                                 |
| `index.tsx`                                   | 8                      | B, C       | COPY-M-proj-13 («Нет доступа к разделу» → state+reason+step; the neighboring correct state is a model)                                   |
| `components/KanbanColumn.tsx`                 | 5                      | B, C, G    | The column header = `STAGE_LABEL_MESSAGES[stage]`                                                                                        |
| `constants.ts`                                | 3                      | G, L       | COPY-H-proj-1 (`STAGE_LABELS`: 6 Eng + 3 rus → canon); the local `formatDate('uk-UA')` → `format.ts`                                     |
| `components/ArchiveSection.tsx`               | 2                      | B          | COPY-M-proj-13 («Пусто» → «Сюди потрапляють завершені співбесіди»)                                                                       |
| `use-board-seniors.ts`                        | 0                      | —          | No Cyrillic — do not migrate (in the list for completeness)                                                                              |

Outside `apps/web/app/routes/_authenticated/interviews`:

- `CONTEXT.md` — the wave (c) canon section (Step 1).
- `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests (update the assertions to the catalog): `interviews/__tests__/index.test.tsx` (5), `interviews/use-board-seniors.spec.ts` (1). New cases — inside the existing files.

E2E: see "E2E spec distribution", the PR1 row, plus the sweep output.

**Interfaces:**

- Consumes: `formatDate(value, locale, style)` (`@crm/shared`), `useLocale()` (`@/lib/i18n`), `ROLE_LABEL_MESSAGES`/`useRoleLabel` (`@/components/ui/role-select`), `getApiErrorMessage` (`@/lib/axios-utils`), the catalog test helpers.
- Produces: `STAGE_LABEL_MESSAGES: Record<InterviewStage, MessageDescriptor>` in `interviews/constants.ts` (the consumers — only inside `interviews/**`, so entirely within PR1). The wave (c) canon section in `CONTEXT.md` — read by PR2, PR3, PR4. The service `formatDate` from `interviews/constants.ts` is removed in favor of `@crm/shared`.

### Danger: `STAGE_LABELS` — the single source, do not touch the service maps next to it

`interviews/constants.ts` carries **seven** maps over `InterviewStage`: `STAGE_LABELS` (text) and six color ones (`STAGE_COLORS`, `STAGE_BADGE_COLORS`, `COLUMN_BORDER`, `COLUMN_HEADER_BG`, `COLUMN_BG`) plus `STAGE_ORDER`/`ACTIVE_STAGES`/`TERMINAL_STAGES`. Migrate **only** `STAGE_LABELS` → `STAGE_LABEL_MESSAGES`. The color maps — CSS classes, not text; touching them = introducing risk into the kanban layout for no reason.

### Acceptance criteria (PR1)

1. In `CONTEXT.md` there is a subsection "Wave c — `web-projects`" with the forms from the canon table.
2. `STAGE_LABELS` → `STAGE_LABEL_MESSAGES` (`satisfies` without `as const`); all nine stages in the interface language in `uk` and `en`; the test "no raw enum and no stage Latin in the rendered column" is green; COPY-H-proj-1 closed.
3. `InterviewDetailSheet` in `uk`/`en`: `corpTech`/`salaryReview` named with one word from the canon; the payment-type placeholder — a set from the Select (`ФОП / гіг-контракт / USDT`), without «крипта»; the term example in the interface language; COPY-H-proj-3, H-5 closed (in the PR1 files).
4. Dialogs and the section in `uk`/`en`: «карточка» → «співбесіда» (COPY-M-proj-14); the dead ends «Пусто»/«Нет доступа к разделу» got a reason and a step (COPY-M-proj-13, in the PR1 files).
5. In the PR1 files there is no `toLocale*String` and no `date-fns`; dates via `format.ts`; the service `formatDate` from `constants.ts` removed.
6. Step check: not a single line of `[ыэъё]` outside comments; lines with a raw enum parsed.
7. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR1 E2E specs are green.
8. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
9. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
10. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`.

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel                       # == the assigned worktree
git fetch origin main && git log --oneline -1 origin/main
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/routes/_authenticated/interviews
```

If the numbers differ from the table by more than 10%, update the table in the task file before starting.

- [ ] **Step 1: Term canon → `CONTEXT.md`**

Add to `CONTEXT.md` after the subsection "Wave b — `web-people`" a subsection "Wave c — `web-projects` (added by PR <branch>)" with the rows from the "Wave (c) term canon" table (the columns "Term", `uk`, `en`, "_Избегать_" verbatim; "Source" is not carried into the glossary). A separate commit `docs(context): wave c uk/en term forms`, `ac_verified: 1`.

- [ ] **Step 2: Test for the kanban stages (fails)**

In `interviews/__tests__/index.test.tsx` (or a new case in the `KanbanColumn` test, if there is one) add `it.each` by locale that the column header is read from the canon and does not contain a raw enum/stage Latin:

```tsx
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
const RAW_STAGE = /HR_SCREEN|TECH_INTERVIEW|OFFER_RECEIVED|HR Screen|\bTech\b|\bOffer\b/
it.each([
  ['uk', 'HR_SCREEN', 'HR-скринінг'],
  ['uk', 'HIRED', 'Найнято'],
  ['en', 'TECH_INTERVIEW', 'Technical'],
] as const)('%s: stage %s reads %s, no raw enum', async (locale, stage, label) => {
  await loadCatalog(locale)
  const { container } = render(<KanbanColumn stage={stage} cards={[]} />, {
    wrapper: I18nTestProvider,
  })
  expect(screen.getByText(label)).toBeInTheDocument()
  expect(container.textContent ?? '').not.toMatch(RAW_STAGE)
})
```

Run: `pnpm --filter @crm/web test -- interviews` → FAIL (currently `English`/`Нанят` from the legacy).

- [ ] **Step 3: `STAGE_LABELS` → `STAGE_LABEL_MESSAGES` + consumers → PASS** (templates G, L)

`constants.ts`: a map per template G; the service `formatDate` is replaced with `@crm/shared` `formatDate(iso, locale, 'short')` at the call sites (the consumers get a `locale`). The header consumers (`KanbanColumn`, the columns in `index.tsx`) — `i18n._(STAGE_LABEL_MESSAGES[stage])`. Run: `pnpm --filter @crm/web test -- interviews` → PASS.

- [ ] **Step 4: `InterviewDetailSheet.tsx`** (COPY-H-proj-3, H-5) — templates B, C, H. The fields `corpTech`/`salaryReview` — canon; the payment-type placeholder `ФОП / гіг-контракт / USDT`; roles — `useRoleLabel`.

- [ ] **Step 5: Dialogs and the section** — `CreateInterviewDialog`, `CreateProjectFromHiredDialog`, `ArchiveSection`, `index.tsx` (COPY-M-proj-13, M-14): «карточка» → «співбесіда»; the dead ends — state+reason+step.

- [ ] **Step 6: Check, tests, E2E sweep, gates, commit**

```bash
python3 - <<'EOF'
import re, pathlib
for f in pathlib.Path('apps/web/app/routes/_authenticated/interviews').rglob('*.ts*'):
    if re.search(r'__tests__|\.(spec|test)\.', str(f)): continue
    for n,l in enumerate(f.read_text(encoding='utf8').splitlines(),1):
        if re.match(r'\s*(//|\*|\{/\*)', l): continue
        if re.search('[ыЫэЭъЪёЁ]', l): print('RU  ', f, n, l.strip())
EOF
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- interviews
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add CONTEXT.md \
  apps/web/app/routes/_authenticated/interviews/constants.ts \
  apps/web/app/routes/_authenticated/interviews/index.tsx \
  apps/web/app/routes/_authenticated/interviews/components/InterviewDetailSheet.tsx \
  apps/web/app/routes/_authenticated/interviews/components/CreateInterviewDialog.tsx \
  apps/web/app/routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx \
  apps/web/app/routes/_authenticated/interviews/components/KanbanColumn.tsx \
  apps/web/app/routes/_authenticated/interviews/components/ArchiveSection.tsx \
  apps/web/app/routes/_authenticated/interviews/__tests__/index.test.tsx \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3c wave (c) part 1 — interviews kanban to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)
EOF
)"
```

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: the kanban board (all nine columns), the interview detail sheet, the create dialog, archive, the "no access" state. Fidelity Mode B — all widths. `copy-reviewer` — on `uk` and `en` separately (special attention — the form of stage `OFFER_RECEIVED`, the flag in the canon table).

---

## Task 2 (PR2): vacancies and applications

**Files:**

| File                                      | Cyr. lines (outside comm.) | Pattern(s) | Audit findings / note                                                                                                                                                                      |
| ----------------------------------------- | ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/VacancyCard.tsx`              | 34                     | B, C, G, J | A self-written `pluralizeOtklik` → `<Plural>` (danger "manual plural forms"); `VACANCY_STATUS_LABELS`/`EMPLOYMENT_TYPE_LABELS` — canon                                                     |
| `$vacancyId.tsx`                          | 31                     | B, C, G, L | COPY-M-proj-10 (the applications empty state), M-11 (`Откл.`/`Просм.` → «Відмова»/«Перегляд»), L-20 (counters); `date-fns/ru` → `formatDate`                                               |
| `constants.ts`                            | 25                     | G, J       | COPY-M-proj-7 (`VACANCY_STATUS_LABELS`, `APPLICATION_STATUS_LABELS`, `EMPLOYMENT_TYPE_LABELS`, `SALARY_PERIOD_LABELS` — gender), M-9 (`zodIssueRu`); domains and levels — do not translate (proper nouns) |
| `index.tsx`                               | 17                     | B, C, G    | COPY-M-proj-10 (the empty state «страница карьеры»/«заявка»), L-20 (the format of the counters `Все 12`)                                                                                   |
| `components/CandidateCard.tsx`            | 11                     | B, C, G, L | `APPLICATION_STATUS_LABELS` — canon; `formatDistanceToNow(..., {locale: ru})` → `formatRelativeTime`                                                                                       |
| `components/VacancySeoFields.tsx`         | 9                      | B, C       | SEO field captions                                                                                                                                                                         |
| `components/VacancyFormFields.tsx`        | 8                      | B, C, G    | `EMPLOYMENT_TYPE_LABELS` — canon                                                                                                                                                           |
| `components/VacancySalaryFields.tsx`      | 8                      | B, C, G    | `SALARY_PERIOD_LABELS` — canon                                                                                                                                                             |
| `components/VacancyTranslationFields.tsx` | 8                      | B, C       | COPY-M-proj-16 («оригинал английский» — the claim is false; text without a claim about the language)                                                                                      |
| `components/VacancySheet.tsx`             | 6                      | B, C       | The vacancy form shell                                                                                                                                                                     |
| `components/ResumePreviewDialog.tsx`      | 5                      | B, C       | The candidate résumé preview dialog                                                                                                                                                        |
| `hooks/use-vacancies.ts`                  | 9                      | C          | Vacancy mutation toast texts → `getApiErrorMessage(err, t\`…\`)`                                                                                                                           |

Outside the product: `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests: `vacancies/__tests__/{CandidateCard.test.tsx (23), VacancySheet.test.tsx (17), VacancyCard.test.tsx (7), ResumePreviewDialog.test.tsx (7), constants.test.ts (6)}`. New cases (application pluralization at 1/2/5, statuses without a raw enum) — inside the existing files.

E2E: see "E2E spec distribution", the PR2 row, plus the sweep output.

**Interfaces:**

- Consumes: `formatDate`, `formatRelativeTime`, `formatNumber`, `formatMoney` (`@crm/shared`); `useLocale()`; `getApiErrorMessage`, `translateZodCode`, `translateZodMessage` (`@/lib/axios-utils`); the catalog test helpers.
- Produces: `VACANCY_STATUS_LABEL_MESSAGES`, `APPLICATION_STATUS_LABEL_MESSAGES`, `EMPLOYMENT_TYPE_LABEL_MESSAGES`, `SALARY_PERIOD_LABEL_MESSAGES` in `vacancies/constants.ts` (the consumers only inside `vacancies/**`, entirely within PR2). `DOMAIN_LABELS`/`SENIORITY_LABELS` **remain string maps** (proper nouns/grades) — not migrated, their comment is supplemented with a note "do not translate". `zodIssueRu` is replaced with `<Plural>`/the code registry.

### Danger: `DOMAIN_LABELS` and `SENIORITY_LABELS` — not interface text, but names

The comment in `vacancies/constants.ts` already notes that `DOMAIN_LABELS` (AI, EdTech, E-Commerce, …) and `SENIORITY_LABELS` (Senior, Lead, …) — proper domain names and grades written the same in any language (like the endonyms `Українська`/`English` in wave b). Do **not** translate them and do **not** move them to `Record<…, MessageDescriptor>` — leave them as strings. They are not Russian, the `[ыэъё]` guard will not touch them. Only `EMPLOYMENT_TYPE_LABELS`, `SALARY_PERIOD_LABELS`, `VACANCY_STATUS_LABELS`, `APPLICATION_STATUS_LABELS` — ordinary Russian words — are translated.

### Danger: the width of the applications filter (`$vacancyId.tsx`, `CandidateCard.tsx`)

As with the project status tabs, the applications filter has a full and a short label set, tuned to the Russian width (`Все 12`/`Новые 3` vs `Отклики · 3`, COPY-L-proj-20; `Откл.`/`Просм.`, COPY-M-proj-11). Ukrainian is longer — re-measure the short forms («Відмова», «Перегляд») at 320/375/768. Reduce the counter format to one: canon «Все (12)» (parentheses carry over to any language).

### Acceptance criteria (PR2)

1. Four label maps (`VACANCY_STATUS`, `APPLICATION_STATUS`, `EMPLOYMENT_TYPE`, `SALARY_PERIOD`) → `Record<…, MessageDescriptor>` (`satisfies` without `as const`); the gender is agreed with the subject in `uk` (COPY-M-proj-7); `DOMAIN_LABELS`/`SENIORITY_LABELS` left as is with a note.
2. The applications counter — `<Plural>` in `uk` (1 відгук / 2 відгуки / 5 відгуків) and `en`; the self-written `pluralizeOtklik` removed; the test at 1/2/5/11/21 green (COPY-M-proj-9, danger "manual plural forms").
3. `zodIssueRu` does not assemble the form by concatenation: either `<Plural>`/`i18n._(msg,{n})`, or the code registry; «Минимум N символов» is pluralized by the number.
4. Vacancy/application empty states in `uk`/`en` per the canon: «розділ «Вакансії» на сайті», «відгук» (not «заявка»/«страница карьеры»); COPY-M-proj-10, M-16 closed.
5. The short filter labels — «Відмова»/«Перегляд» (not «Откл.»/«Просм.»); the counter format unified «Все (N)»; COPY-M-proj-11, L-20 closed; the widths re-measured at 320/375/768.
6. In the PR2 files there is no `date-fns` and no `toLocale*`; dates/relative time/money via `format.ts`.
7. In the PR2 files 0 lines of `[ыэъё]` outside comments (checked in the Step).
8. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR2 E2E specs are green.
9. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
10. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
11. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`.

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel
git fetch origin main && git log --oneline -1 origin/main
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/routes/_authenticated/vacancies apps/web/app/hooks/use-vacancies.ts
git grep -n "min(1)\|min(2)\|min(3)" origin/main -- apps/web/app/routes/_authenticated/vacancies   # compare zodIssueRu with the registry codes
```

The term canon — from this plan (PR1 enters it into `CONTEXT.md` in parallel; if PR1 is merged — read `CONTEXT.md`).

- [ ] **Step 1: Test — vacancy/application statuses from the canon, application pluralization (fails)**

`it.each` by locale: `VACANCY_STATUS_LABEL_MESSAGES.PUBLISHED` = «Опублікована»/«Published», no raw enum; the applications counter at 1/2/5/11/21 gives the correct form. Run: `pnpm --filter @crm/web test -- vacancies` → FAIL.

- [ ] **Step 2: Label maps → `Record<…, MessageDescriptor>` + `zodIssueRu` (templates G, J) → PASS**

Four maps — per template G; `zodIssueRu` — per template J. Do not touch `DOMAIN_LABELS`/`SENIORITY_LABELS` (supplement the comment with the note "proper nouns — do not translate"). Run: `pnpm --filter @crm/web test -- vacancies` → PASS for the maps.

- [ ] **Step 3: `VacancyCard.tsx` — application pluralization (template J)** — remove `pluralizeOtklik`, the counter → `<Plural>`; statuses/types — consuming the maps.

- [ ] **Step 4: `$vacancyId.tsx`, `index.tsx`, `CandidateCard.tsx`** — empty states (COPY-M-proj-10), short labels and counters (M-11, L-20), dates (`date-fns/ru` → `format.ts`, template L).

- [ ] **Step 5: Forms and shells** — `VacancyFormFields`, `VacancySalaryFields`, `VacancySeoFields`, `VacancyTranslationFields` (COPY-M-proj-16), `VacancySheet`, `ResumePreviewDialog`, `use-vacancies.ts` (toasts → `getApiErrorMessage`).

- [ ] **Step 6: Check, tests, E2E sweep, gates, commit**

```bash
python3 - <<'EOF'
import re, pathlib
roots=['apps/web/app/routes/_authenticated/vacancies']
files=[f for r in roots for f in pathlib.Path(r).rglob('*.ts*')]+[pathlib.Path('apps/web/app/hooks/use-vacancies.ts')]
for f in files:
    if re.search(r'__tests__|\.(spec|test)\.', str(f)): continue
    for n,l in enumerate(f.read_text(encoding='utf8').splitlines(),1):
        if re.match(r'\s*(//|\*|\{/\*)', l): continue
        if re.search('[ыЫэЭъЪёЁ]', l): print('RU  ', f, n, l.strip())
EOF
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- vacancies
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add \
  apps/web/app/routes/_authenticated/vacancies/index.tsx \
  "apps/web/app/routes/_authenticated/vacancies/\$vacancyId.tsx" \
  apps/web/app/routes/_authenticated/vacancies/constants.ts \
  apps/web/app/routes/_authenticated/vacancies/components/VacancyCard.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/CandidateCard.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/VacancyFormFields.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/VacancySalaryFields.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/VacancySeoFields.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/VacancyTranslationFields.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/VacancySheet.tsx \
  apps/web/app/routes/_authenticated/vacancies/components/ResumePreviewDialog.tsx \
  apps/web/app/hooks/use-vacancies.ts \
  apps/web/app/routes/_authenticated/vacancies/__tests__/CandidateCard.test.tsx \
  apps/web/app/routes/_authenticated/vacancies/__tests__/VacancySheet.test.tsx \
  apps/web/app/routes/_authenticated/vacancies/__tests__/VacancyCard.test.tsx \
  apps/web/app/routes/_authenticated/vacancies/__tests__/ResumePreviewDialog.test.tsx \
  apps/web/app/routes/_authenticated/vacancies/__tests__/constants.test.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3c wave (c) part 2 — vacancies and applications to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9,10 (11 — reviews after push)
EOF
)"
```

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: the vacancy list (the full and short filter set), the vacancy page with applications, the candidate card, the forms (main/salary/SEO/translation), the empty states. Fidelity Mode B — all widths (risk — the applications filter width at 320). `copy-reviewer` — on `uk` and `en` separately.

---

## Task 3 (PR3): projects — list, legend, approval, credentials

**Files:**

| File                                                | Cyr. lines (outside comm.) | Pattern(s)    | Audit findings / note                                                                                                                                 |
| --------------------------------------------------- | ---------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/_authenticated/legend.tsx`                  | 45                     | B, C, K       | COPY-M-proj-17 (placeholders Kyiv/MSU → Київ/neutral), M-18 (`aria-label` cover story ≠ the visible caption), L-23 («Позиция для клиента» → «посада»)  |
| `routes/_authenticated/projects/index.tsx`          | 55                     | A, B, C, G, F | COPY-H-proj-5 (`PAYMENT_TYPE_LABELS` consumer), M-8 (the status filter), M-13 (empty states); the tabs `STATUS_FILTER_LABELS(_MOBILE)` — width         |
| `components/projects/ProjectLegendSection.tsx`      | 34                     | B, C          | COPY-M-proj-17, L-23; ~80% of the text matches `legend.tsx` — shared catalog keys, do not translate twice                                             |
| `components/projects/ProjectCredentialsSection.tsx` | 28                     | B, C          | COPY-M-proj-13 («Нет доступа к этому паролю» → reason+step)                                                                                            |
| `components/projects/ProjectApprovalActions.tsx`    | 21                     | B, C          | Already passed copy-review (COPY-H-1, #646) — mostly extraction is needed; do not change the approval logic                                            |
| `components/projects/ProjectRow.tsx`                | 20                     | B, C, F, K    | COPY-M-proj-15 (`rate.toLocaleString()` → `formatNumber`); `aria-label` «Открыть проект …»; the approval caption → template K                          |
| `components/pending-share/cancel-pending-share.tsx` | 17                     | B, C          | Already passed copy-review (COPY-M-17, #648) — extraction; the concatenation «Підтверджує {імя}» already rewritten                                     |
| `routes/_authenticated/projects/constants.ts`       | 10                     | G             | COPY-H-proj-5 (`PAYMENT_TYPE_LABELS` → `PAYMENT_TYPE_MESSAGES`), M-8 (`STATUS_FILTER_LABELS(_MOBILE)` → canon, `PENDING`/`REJECTED`/`ARCHIVED`)        |
| `components/projects/ProjectStatusBadge.tsx`        | 6                      | B, G          | COPY-M-proj-8 («В архиве», remove «Завершён»); the approval status — canon «Очікує рішення»                                                            |
| `components/projects/project-approval-caption.ts`   | 6                      | K             | COPY-H-proj-2 (the case `от ${имя}`) — restructure the phrase, a construction without a case                                                          |

`routes/_authenticated/projects.tsx` — **do not migrate** (0 Cyrillic, checked; a route wrapper without text). Not in the PR3 perimeter.

Outside the product: `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests: `components/projects/__tests__/{ProjectApprovalActions.test.tsx (60), ProjectRow.test.tsx (46), ProjectStatusBadge.test.tsx (24), project-approval-caption.test.ts (25)}`, `components/pending-share/__tests__/cancel-pending-share.test.tsx (40)`, `routes/_authenticated/projects/__tests__/{ProjectEditFields.test.tsx (29) — only if ProjectEditFields is in PR3, otherwise PR4; PendingShareApprovalBanner.copy.test.tsx (27), ProjectHeaderApprovalNote.test.tsx (11), constants.test.ts (10), InfoRow.structure.test.tsx (3)}`. **Note:** `ProjectEditFields` lives inside `$projectId.tsx` (PR4), but its test `ProjectEditFields.test.tsx` searches for `getByText('гіг-контракт')` from `PAYMENT_TYPE_LABELS` — after PR3 translates the map, this test goes red. Solution: the test `ProjectEditFields.test.tsx` is edited by **PR4** (the owner of `$projectId`), not PR3; in its E2E/unit sweep PR3 marks it as "edited by PR4 (the map consumer)". Similarly `constants.test.ts` (the maps) is edited by PR3.

E2E: see "E2E spec distribution", the PR3 row, plus the sweep output. **Special attention** — `project-status-filter-ui.spec.ts`: it asserts the tab row height at 320/375/768/1024; after the language change the widths may break (six rounds of tuning in the history). Re-measure.

**Interfaces:**

- Consumes: `ROLE_LABEL_MESSAGES`/`useRoleLabel` (`@/components/ui/role-select`); `formatDate`, `formatNumber`, `formatMoney`, `compareNames` (`@crm/shared`); `useLocale()`; `getApiErrorMessage`, `translateZodCode`, `translateZodMessage` (`@/lib/axios-utils`); the catalog test helpers.
- Produces: `PAYMENT_TYPE_MESSAGES: Record<ProjectPaymentType, MessageDescriptor>`, `STATUS_FILTER_LABEL_MESSAGES` and `STATUS_FILTER_LABEL_MESSAGES_MOBILE: Record<ProjectStatusFilter, MessageDescriptor>` in `projects/constants.ts` — **consumed by PR4** (`$projectId.tsx` reads `PAYMENT_TYPE_MESSAGES`). This is a PR4 precondition. `project-approval-caption` stops returning a Russian string (template K).

### Danger: the status filter tabs — the width is tuned to Russian, the language under it changes

`projects/constants.ts` carries `STATUS_FILTER_LABELS` (full) and `STATUS_FILTER_LABELS_MOBILE` (short), and the comment above them describes **six** rounds of tuning to measured pixels (`154px → 113.5px`, "requirement 701.9px → 538px", two CI failures at 768px and 810px). The short-set show threshold is at `lg:` (1024px). On translation:

- move both maps to `Record<…, MessageDescriptor>`, the canon from the table (`PENDING` → «Очікують рішення», short «Чекають»; `REJECTED` → «Відхилені»/«Відмова»; `ARCHIVED` → «Архів»);
- **re-measure the width anew** at 320/375/768/1024 with a live run (Ukrainian is longer than Russian), because the old pixel values refer to the Russian text. Do not trust the comment as truth about the new strings;
- `project-status-filter-ui.spec.ts` asserts the tab row height (wrap = 2 lines) — run it at all widths, not only at 320/768.

A line in the PR body for `copy-reviewer` and `ui-ux-designer`: "the filter tab width re-measured for `uk`, the values are such-and-such".

### Danger: junior legend masking (`legend.tsx`, `ProjectLegendSection.tsx`)

The legend is what the junior shows the client (glossary **Legend**: the masking is built as an allow-list). The placeholder examples in it (COPY-M-proj-17) are part of the masking: they prompt the employee what to say. Translate them on par with the text (Київ instead of Kyiv-in-Russian, a neutral example instead of MSU), and do **not** leave them "as is" and do not make text that reveals that this is masking. `legend.tsx` and `ProjectLegendSection.tsx` duplicate ~80% of the text — reduce to shared catalog keys (one `msg`/`<Trans>` per shared string), do not translate twice. A line in the PR body for `security-reviewer`.

### Danger: `project-approval-caption` — case, `null`-name, RBAC masking

`resolveProjectApprovalCaption` (COPY-H-proj-2) assembles «от {имя}» in the nominative where the genitive is required. Rewrite it per template K into a construction without a case. Keep: (1) the fallback `seniorName || 'синьора'` → the safe `uk` «сеньйора» (COPY-M-4: `seniorName` is sometimes `null`, otherwise «null» on the screen); (2) the absence of a role branch — `rejectionReason` is already masked by the server for everyone except ADMIN (SR-M-5), the function does not check the role. The test — there is no literal «null», no raw status enum, the order "drop, then senior" is preserved.

### Acceptance criteria (PR3)

1. `PAYMENT_TYPE_LABELS` → `PAYMENT_TYPE_MESSAGES`, `STATUS_FILTER_LABELS(_MOBILE)` → message maps (`satisfies` without `as const`); the consumer `projects/index.tsx` migrated; COPY-H-proj-5 (map + list), M-8 (statuses/archive, «Завершён» removed) closed.
2. `project-approval-caption` does not assemble the phrase with a case and does not print «null»/a raw enum (COPY-H-proj-2); the test for `DRAFT`/`REJECTED`/both-pending/viewer-acted is green in `uk` and `en`.
3. The legend and `ProjectLegendSection` in `uk`/`en` per the canon: the placeholders translated (Київ, a neutral example), the cover story `aria-label` matches the visible caption «кавер-сторі», «Позиция для клиента» → «посада для клієнта»; the shared text reduced to shared keys; the masking invariant preserved; COPY-M-proj-17, M-18, L-23 closed.
4. Empty states and passwords (COPY-M-proj-13): state+reason+step; «Нет доступа к паролю» — per the canon.
5. `ProjectRow`/`ProjectStatusBadge` in `uk`/`en`: the approval status — «Очікує рішення», money via `format.ts` (COPY-M-proj-15 in the PR3 files), «В архіві» instead of «Завершён».
6. The status filter tabs re-measured for `uk` at 320/375/768/1024; `project-status-filter-ui.spec.ts` green at all widths; a line about the re-measurement — in the PR body.
7. In the PR3 files 0 lines of `[ыэъё]` outside comments (checked in the Step).
8. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR3 E2E specs are green.
9. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
10. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
11. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`; `security-reviewer` APPROVE (share approval, legend, passwords).

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel
git fetch origin main && git log --oneline -1 origin/main
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/components/projects apps/web/app/components/pending-share apps/web/app/routes/_authenticated/projects apps/web/app/routes/_authenticated/legend.tsx apps/web/app/routes/_authenticated/projects.tsx
git grep -nP '\bROLE_LABELS\b' origin/main -- apps/web/app/routes/_authenticated/projects   # local maps (for PR4)
```

- [ ] **Step 1: Tests (fail)** — the approval status from the canon without a raw enum; `project-approval-caption` without a case/«null»; the filter tabs from the canon. Run: `pnpm --filter @crm/web test -- ProjectStatusBadge project-approval-caption ProjectRow projects/__tests__/constants` → FAIL.

- [ ] **Step 2: `projects/constants.ts` — maps (template G) → PASS partially** — `PAYMENT_TYPE_MESSAGES`, `STATUS_FILTER_LABEL_MESSAGES(_MOBILE)` per the canon; `constants.test.ts` to the catalog.

- [ ] **Step 3: `project-approval-caption.ts` + `ProjectStatusBadge` + `ProjectRow` (templates K, F)** — the phrase without a case; the status «Очікує рішення»; money `formatNumber`; caption consumer. Run: `pnpm --filter @crm/web test -- ProjectStatusBadge project-approval-caption ProjectRow` → PASS.

- [ ] **Step 4: `projects/index.tsx`** — the consumer of `PAYMENT_TYPE_MESSAGES` and the tabs; empty states (canon «Нічого не знайдено — скиньте фільтри»); **re-measure the tab width** (a live run 320/375/768/1024, a script in the scratchpad).

- [ ] **Step 5: Legend — `legend.tsx`, `ProjectLegendSection.tsx`** (COPY-M-proj-17, M-18, L-23) — shared keys, placeholders per the canon, `aria-label` = the visible caption, the masking invariant.

- [ ] **Step 6: `ProjectCredentialsSection`, `ProjectApprovalActions`, `cancel-pending-share`, `projects.tsx`** — extraction (two are already copy-reviewed); empty states/passwords — reason+step.

- [ ] **Step 7: Check, tests, E2E sweep, gates, commit**

```bash
python3 - <<'EOF'
import re, pathlib
roots=['apps/web/app/components/projects','apps/web/app/components/pending-share','apps/web/app/routes/_authenticated/projects']
files=[f for r in roots for f in pathlib.Path(r).rglob('*.ts*')]
files+=[pathlib.Path('apps/web/app/routes/_authenticated/legend.tsx'),pathlib.Path('apps/web/app/routes/_authenticated/projects.tsx')]
for f in files:
    if re.search(r'__tests__|\.(spec|test)\.', str(f)) or not f.exists(): continue
    for n,l in enumerate(f.read_text(encoding='utf8').splitlines(),1):
        if re.match(r'\s*(//|\*|\{/\*)', l): continue
        if re.search('[ыЫэЭъЪёЁ]', l): print('RU  ', f, n, l.strip())
EOF
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- projects project-status-filter-ui projects-senior-share-override project-credentials legend projects-archive project-draft-status
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add \
  apps/web/app/routes/_authenticated/legend.tsx \
  apps/web/app/routes/_authenticated/projects/index.tsx \
  apps/web/app/routes/_authenticated/projects/constants.ts \
  apps/web/app/components/projects/ProjectRow.tsx \
  apps/web/app/components/projects/ProjectStatusBadge.tsx \
  apps/web/app/components/projects/ProjectApprovalActions.tsx \
  apps/web/app/components/projects/ProjectCredentialsSection.tsx \
  apps/web/app/components/projects/ProjectLegendSection.tsx \
  apps/web/app/components/projects/project-approval-caption.ts \
  apps/web/app/components/pending-share/cancel-pending-share.tsx \
  apps/web/app/components/projects/__tests__/ProjectApprovalActions.test.tsx \
  apps/web/app/components/projects/__tests__/ProjectRow.test.tsx \
  apps/web/app/components/projects/__tests__/ProjectStatusBadge.test.tsx \
  apps/web/app/components/projects/__tests__/project-approval-caption.test.ts \
  apps/web/app/components/pending-share/__tests__/cancel-pending-share.test.tsx \
  apps/web/app/routes/_authenticated/projects/__tests__/PendingShareApprovalBanner.copy.test.tsx \
  apps/web/app/routes/_authenticated/projects/__tests__/ProjectHeaderApprovalNote.test.tsx \
  apps/web/app/routes/_authenticated/projects/__tests__/constants.test.ts \
  apps/web/app/routes/_authenticated/projects/__tests__/InfoRow.structure.test.tsx \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3c wave (c) part 3 — projects list, legend, approval to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9,10 (11 — reviews after push)
EOF
)"
```

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: the project list (all four filter tabs — the full and short set), the legend (view and edit), the project row with the approval caption, the status badges, credentials/passwords, canceling a pending-share. Fidelity Mode B — all widths (the main risk — the filter tabs at 320/768). `copy-reviewer` — on `uk` and `en` separately. `security-reviewer` — mandatory.

---

## Task 4 (PR4): the project detail page, the junior hub, the admin contract templates

**Files:**

| File                                               | Cyr. lines (outside comm.) | Pattern(s)          | Audit findings / note                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ---------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/_authenticated/projects/$projectId.tsx`    | 165                    | A, B, C, F, G, H, K | The largest file of the wave (257 fragments). COPY-H-proj-3 (`corpTech`/`salaryReview`), H-4 (composition), M-8 (archive), M-12 («...» → «Додаємо…»), M-15 (money), L-21 (Drop-project), L-22 (Income); the local `labels: Record` inside `ProjectEditFields` (the static extractor does not see it — move it out); `ROLE_LABELS` → template H |
| `routes/_authenticated/project.tsx`                | 23                     | B, F                | COPY-H-proj-6 (`salaryMonth` «2026-04» → `formatDate 'monthYear'`), M-8 (`isActive ? 'Активный' : 'Завершён'`), M-15 (`.toLocaleString('ru-RU')`)                                                                                                                                                                             |
| `routes/_authenticated/admin/contracts.$role.tsx`  | 25                     | B, C, H, K          | COPY-M-core-9 (`ROLE_LABELS` `HR-менеджер` → canon); the concatenation «Шаблон для роли ${…} опубликован» → `<Trans>` with a role slot; the template editor statuses/texts                                                                                                                                                      |
| `routes/_authenticated/admin/contracts.index.tsx`  | 9                      | B, H                | COPY-M-core-9 (`ROLE_LABELS` → canon); the role card headers                                                                                                                                                                                                                                                                  |
| `components/contracts/VariablesPanel.tsx`          | 45                     | B, C                | The template variables panel; there is a test `VariablesPanel.i18n.test.tsx` — update the assertions                                                                                                                                                                                                                          |
| `components/contracts/AddCustomVariableDialog.tsx` | 20                     | B, C                | The dialog for adding a custom variable                                                                                                                                                                                                                                                                                       |

Do not migrate (checked, 0 Cyrillic): `components/contracts/contractTokenHighlight.ts`, `hooks/use-contract-tokens.ts`, `lib/contract-variables.ts`.

Outside the product: `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests: `routes/_authenticated/projects/__tests__/ProjectEditFields.test.tsx` (29 — asserts `гіг-контракт`, moves to the catalog **here**), `routes/_authenticated/admin/__tests__/contracts-editor-layout.test.tsx` (35), `components/contracts/__tests__/VariablesPanel.i18n.test.tsx` (1). The tests `admin/__tests__/{route.test.tsx, login-as.spec.tsx, tos.index.test.tsx}` **do not touch** — these are web-people (login-as) and web-docs-notify (tos), already migrated or another slice.

E2E: see "E2E spec distribution", the PR4 row, plus the sweep output. `cache/anti-stale.spec.ts` (`/^Синьор/`) asserts the role caption in the project dialog — it lands in the sweep here.

**Interfaces:**

- Consumes: `PAYMENT_TYPE_MESSAGES` (`projects/constants.ts`, **from PR3** — a precondition), `ROLE_LABEL_MESSAGES`/`useRoleLabel` (`@/components/ui/role-select`), `formatDate`, `formatNumber`, `formatMoney` (`@crm/shared`), `useLocale()`, `getApiErrorMessage`, `translateZodCode` (`@/lib/axios-utils`), the catalog test helpers.
- Does not touch: `fmtUsd`, `type ExchangeRates`, `financeApi`, `TransactionRow`, `TransactionDetailDialog` (imports from `finance/**` — wave d).
- Produces: the three local `ROLE_LABELS` are removed (`$projectId.tsx`, `admin/contracts.index.tsx`, `admin/contracts.$role.tsx`). After PR4 `git grep -nP '\bROLE_LABELS\b' apps/web/app/routes/_authenticated/{projects,admin}` — empty.

### Danger: cross-slice finance in `$projectId.tsx` — do not drag it into this wave

`$projectId.tsx` imports five symbols from `finance/**`: `financeApi`, `TransactionDetailDialog`, `TransactionRow` (components with Russian text), `fmtUsd`, `type ExchangeRates` (a formatter and a type). All of this — the `web-finance` slice (wave d), **not yet migrated**. Decision (checked `git grep` — there is no import of `TYPE_LABELS`/`STATUS_LABELS` from finance in the perimeter, only these five symbols):

- **do not touch the finance components**: `$projectId` renders them, their Russian text lives until wave (d). A line in "Findings outside the perimeter" and in the PR4 body.
- **do not replace `fmtUsd` with `formatMoney`**: this is the shared finance formatter, and wave (d) will reduce money formatting to one source. Replacing now = reaching into the finance zone for one place and creating a conflict with wave (d). Migrate only the money formatted **inside** this wave's files: `project.rate.toLocaleString()` → `formatNumber(project.rate, locale)`, `.toLocaleString('ru-RU')` in `project.tsx` → `format.ts`.
- **Recommendation** (contested decision, A1): do **not** take the finance canon now — wait for 3d. Rationale: (1) the finance zone is not in this wave's perimeter and not in the PR4 coder's zone; (2) `fmtUsd`/`TYPE_LABELS`/`STATUS_LABELS` on translation in 3d will become message maps, and any "preliminary" translation of them here would be rewritten anyway; (3) a number is not text, the `[ыэъё]` guard does not catch it, so an "incomplete migration" here is only visual (different number formats), and COPY-M-proj-15 asks to reduce it "at least to one explicit value" — this is feasible without finance, via the `format.ts` formatter for the local calls. Finance transactions inside `$projectId` stay Russian until 3d — this is a **known** limitation, noted in the PR body, not an omission.

### Danger: the local `labels: Record<string,string>` inside `ProjectEditFields` — the static extractor does not see it

The audit (danger "Text in constants/Record") notes that `$projectId.tsx` holds `const labels: Record<string, string>` **inside** the render of `ProjectEditFields`. `lingui extract` will not see such a map if it is left as a string and only the call is wrapped. Move the map out of the render to the module level as `Record<…, MessageDescriptor>` (template G) and resolve via `i18n._()`, otherwise the strings will not get into the catalog, and the stage 6 guard will fail on them later. The test `ProjectEditFields.test.tsx` (asserts `гіг-контракт`) moves to the catalog here.

### Danger: removing the local `ROLE_LABELS` — «HR-менеджер» becomes «HR»

`admin/contracts.{index,$role}.tsx` declare `ROLE_LABELS: Record<ContractTargetRole, string>` with `HR: 'HR-менеджер'`, and `$projectId.tsx` — `Record<string, string>` with a `?? role` fallback. All three → `ROLE_LABEL_MESSAGES`/`useRoleLabel` (template H), the fallback removed (the map covers `Role`). This changes «HR-менеджер» → «HR» (canon COPY-M-core-9: one role map per application). A line in the PR4 body for `copy-reviewer`. The concatenation «Шаблон для роли ${ROLE_LABELS[role]} опубликован» → `<Trans>Шаблон договору для ролі «{roleLabel}» опубліковано</Trans>` (the role in the nominative inside quotes, lesson #702 item 9).

### Acceptance criteria (PR4)

1. `$projectId.tsx` in `uk`/`en`: `corpTech`/`salaryReview` — one word from the canon (COPY-H-proj-3); composition — «склад»/«додати до складу»/«прибрати зі складу», not «команда»/«участники» (COPY-H-proj-4); archive — «в архіві»/«в архіві з {дата}», without «Завершён» (COPY-M-proj-8); the request button — «Додаємо…», not «...» (COPY-M-proj-12); «Drop-проект» → «проєкт з дропом» (L-21); «Приходы…» → canon (L-22); the local `labels` map moved out and landed in the catalog; the money inside the file — via `format.ts` (M-15).
2. `project.tsx` in `uk`/`en`: `salaryMonth` is formatted by the same function as the fallback (`formatDate 'monthYear'`, COPY-H-proj-6); «Активный»/«Завершён» → «Активний»/«в архіві» (M-8); `.toLocaleString('ru-RU')` → `format.ts` (M-15).
3. The three local `ROLE_LABELS` removed; roles — from `ROLE_LABEL_MESSAGES`; «HR-менеджер» → «HR» (COPY-M-core-9); the concatenation «Шаблон для роли …» — `<Trans>` with a role slot without a case; `git grep -nP '\bROLE_LABELS\b' apps/web/app/routes/_authenticated/{projects,admin}` empty.
4. `admin/contracts.{index,$role}.tsx` and `components/contracts/{VariablesPanel,AddCustomVariableDialog}.tsx` in `uk`/`en`; the test `VariablesPanel.i18n.test.tsx` and `contracts-editor-layout.test.tsx` green on the catalog.
5. The finance components and `fmtUsd` are **not touched**; a line "finance transactions in `$projectId` — until wave d" in the PR body.
6. In the PR4 files 0 lines of `[ыэъё]` outside comments (the final Step check); lines with a raw enum/status parsed.
7. Unit tests assert text from the catalog; the E2E sweep is done, a table in the PR body; the PR4 E2E specs are green.
8. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
9. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
10. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS on `uk` and `en`; `security-reviewer` APPROVE (project share, composition, credentials, contract templates).

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel
git fetch origin main
gh pr view <PR3> --json state -q .state      # MERGED, otherwise stop: PAYMENT_TYPE_MESSAGES does not exist yet
git grep -n "PAYMENT_TYPE_MESSAGES" origin/main -- apps/web/app/routes/_authenticated/projects/constants.ts   # present => PR3 merged
git grep -nP '\bROLE_LABELS\b' origin/main -- apps/web/app/routes/_authenticated/projects/\$projectId.tsx apps/web/app/routes/_authenticated/admin
```

If `PAYMENT_TYPE_MESSAGES` is not in `main` — PR3 is not merged: stop, `.blocked.md`. The admin contract templates (`admin/contracts`, `components/contracts`) do not depend on PR3 and may, if needed, be migrated first.

- [ ] **Step 1: Tests (fail)** — the roles in `$projectId`/`admin/contracts` from the canon without a raw enum; `salaryMonth` formatted via the locale; `ProjectEditFields` reads the payment type from the catalog. Run: `pnpm --filter @crm/web test -- ProjectEditFields contracts-editor-layout VariablesPanel` → FAIL.

- [ ] **Step 2: `$projectId.tsx` — by section (`wip:` after each)** — header/status/archive → composition → field editing (`ProjectEditFields`, move out the `labels` map, template G) → payment type (`PAYMENT_TYPE_MESSAGES` from PR3) → credentials/drop (L-21, L-22) → roles (template H) → the «додати/прибрати» dialogs (COPY-H-proj-4) → toasts/money (`format.ts`, M-12, M-15). Do not touch the finance components.

- [ ] **Step 3: `project.tsx`** (COPY-H-proj-6, M-8, M-15) — `salaryMonth` → `formatDate 'monthYear'`, «Активний»/«в архіві», `format.ts` for numbers.

- [ ] **Step 4: The admin contract templates** — `admin/contracts.{index,$role}.tsx` (template H, the concatenation «Шаблон…» → `<Trans>`), `components/contracts/{VariablesPanel,AddCustomVariableDialog}.tsx` (B/C).

- [ ] **Step 5: The final wave (c) check, tests, E2E sweep, gates, commit**

The final wave (c) check — performed in PR4 and inserted into the PR body:

```bash
# 1. there are no Russian letters in the wave's migrated files
python3 - <<'EOF'
import re, pathlib, subprocess
out = subprocess.run(['git','ls-files',
  'apps/web/app/components/projects','apps/web/app/components/pending-share','apps/web/app/components/contracts',
  'apps/web/app/routes/_authenticated/projects','apps/web/app/routes/_authenticated/interviews',
  'apps/web/app/routes/_authenticated/vacancies','apps/web/app/routes/_authenticated/admin/contracts.index.tsx',
  'apps/web/app/routes/_authenticated/admin/contracts.$role.tsx',
  'apps/web/app/routes/_authenticated/project.tsx','apps/web/app/routes/_authenticated/projects.tsx',
  'apps/web/app/routes/_authenticated/legend.tsx','apps/web/app/hooks/use-vacancies.ts'],
  capture_output=True, text=True).stdout.split()
bad=0
for f in out:
    if re.search(r'__tests__|\.(spec|test)\.', f): continue
    for n,l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(),1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f,n,l.strip()); bad+=1
print('violations:', bad)
EOF
# 2. there are no local role maps in the perimeter
git grep -nP '\bROLE_LABELS\b' -- apps/web/app/routes/_authenticated/projects apps/web/app/routes/_authenticated/admin apps/web/app/components/projects apps/web/app/components/contracts
# 3. there is no branching by the server error text
git grep -nE "message\)?\.(toLowerCase\(\)\.)?includes\('" -- apps/web/app/routes/_authenticated/projects apps/web/app/routes/_authenticated/vacancies apps/web/app/routes/_authenticated/interviews
```

Expected: 1 — `violations: 0`; 2 — empty; 3 — empty.

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- junior-hub drop-attach-project project-payment-type-and-drop-share drop-project-create senior-project-distribution-regression
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add \
  "apps/web/app/routes/_authenticated/projects/\$projectId.tsx" \
  apps/web/app/routes/_authenticated/project.tsx \
  apps/web/app/routes/_authenticated/admin/contracts.index.tsx \
  "apps/web/app/routes/_authenticated/admin/contracts.\$role.tsx" \
  apps/web/app/components/contracts/VariablesPanel.tsx \
  apps/web/app/components/contracts/AddCustomVariableDialog.tsx \
  apps/web/app/routes/_authenticated/projects/__tests__/ProjectEditFields.test.tsx \
  apps/web/app/routes/_authenticated/admin/__tests__/contracts-editor-layout.test.tsx \
  apps/web/app/components/contracts/__tests__/VariablesPanel.i18n.test.tsx \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3c wave (c) part 4 — project detail, junior hub, contract templates to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)
EOF
)"
```

**Design tier 2.** Screenshots 320 and 1440 × `uk` and `en`: the project detail page (header, composition, editing, payment type, drop credentials, add/remove-from-composition dialogs, the approval status), the junior hub (salary cards with `salaryMonth`), the admin contract template editor (the variables panel, adding a custom variable, publishing). The main risk at 320 — long Ukrainian field captions in the two-column `InfoRow`. `copy-reviewer` — on `uk` and `en` separately. `security-reviewer` — mandatory.

---

## Trace of the `web-projects` audit findings

The slice's `Findings:` — 23. Each identifier below.

| Finding        | Status on `0420499b`                         | Where it is closed                                                                                                                                   |
| -------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| COPY-H-proj-1  | open (6 Eng + 3 rus stages)                  | PR1 Step 3                                                                                                                                            |
| COPY-H-proj-2  | open (case `от {имя}`)                       | PR3 Step 3 (template K)                                                                                                                               |
| COPY-H-proj-3  | open (three names of one field)              | PR1 Step 4 (`InterviewDetailSheet`), PR4 Step 2 (`$projectId`)                                                                                        |
| COPY-H-proj-4  | open (composition — 4 words)                 | PR4 Step 2                                                                                                                                            |
| COPY-H-proj-5  | open (гіг/гиг/крипта)                         | PR3 Step 2 (`PAYMENT_TYPE_MESSAGES`), PR1 Step 4 (placeholder), PR4 Step 2 (consumer)                                                                 |
| COPY-H-proj-6  | open (`salaryMonth` «2026-04»)               | PR4 Step 3                                                                                                                                            |
| COPY-M-proj-7  | open (gender in the vacancy maps)            | PR2 Step 2                                                                                                                                            |
| COPY-M-proj-8  | open («Завершён» about archive)              | PR3 Step 2–3 (`ProjectStatusBadge`, filter), PR4 Step 2–3 (`$projectId`, `project.tsx`)                                                               |
| COPY-M-proj-9  | open (`zodIssueRu` without branching)        | PR2 Step 2 (template J)                                                                                                                               |
| COPY-M-proj-10 | open («страница карьеры»/«заявка»)           | PR2 Step 4                                                                                                                                            |
| COPY-M-proj-11 | open («Откл.»/«Просм.»)                       | PR2 Step 4                                                                                                                                            |
| COPY-M-proj-12 | open (the «...» button)                      | PR4 Step 2                                                                                                                                            |
| COPY-M-proj-13 | open (six dead ends)                         | PR1 Step 5 (`ArchiveSection`, `interviews/index`), PR3 Step 4–6 (`legend`, `ProjectCredentialsSection`), PR4 Step 2 (`$projectId` «Некого добавлять») |
| COPY-M-proj-14 | open («карточка» ≠ interview)                | PR1 Step 5                                                                                                                                            |
| COPY-M-proj-15 | open (three number formatters)               | PR3 Step 3 (`ProjectRow`), PR4 Step 2–3 (`$projectId`, `project.tsx`); finance `fmtUsd` — wave d ("Danger")                                           |
| COPY-M-proj-16 | open («оригинал английский»)                 | PR2 Step 5                                                                                                                                            |
| COPY-M-proj-17 | open (placeholders Kyiv/MSU)                 | PR3 Step 5                                                                                                                                            |
| COPY-M-proj-18 | open (`aria-label` cover story ≠ caption)    | PR3 Step 5                                                                                                                                            |
| COPY-L-proj-19 | open (`...` vs `…`)                           | Global Constraints (`…`), all four PRs                                                                                                                |
| COPY-L-proj-20 | open (the counter format)                    | PR2 Step 4                                                                                                                                            |
| COPY-L-proj-21 | open («Drop-проект» in Latin)                | PR4 Step 2                                                                                                                                            |
| COPY-L-proj-22 | open («Приходы…»)                            | PR4 Step 2                                                                                                                                            |
| COPY-L-proj-23 | open («Позиция для клиента»)                 | PR3 Step 5                                                                                                                                            |

Findings: COPY-H-proj-1 … COPY-H-proj-6, COPY-M-proj-7 … COPY-M-proj-18, COPY-L-proj-19 … COPY-L-proj-23 (23) — 23 rows in the table.

**Admin contract templates (outside the 23 findings of the `web-projects` slice).** The assignment added these files to the wave beyond the slice; their findings live in other slices/plans:

| Finding                                 | Source                                                             | Where it is closed |
| --------------------------------------- | -------------------------------------------------------------------- | --------------- |
| COPY-M-core-9                           | the `web-core` slice (one role map; «HR-менеджер» ≠ «HR»)           | PR4 Step 4      |
| The concatenation «Шаблон для роли … опубликован» | the wave b plan, "Findings outside the perimeter" (contracts admin → wave c) | PR4 Step 4      |

---

## Findings outside the perimeter (we do not expand, we record)

| What                                                                                                                                                                               | Whose wave / where to                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Finance components embedded in `$projectId.tsx` (`TransactionRow`, `TransactionDetailDialog`, `financeApi`) and `fmtUsd`/`ExchangeRates` — Russian text and the `en-US` money formatter | (d) `web-finance`. `$projectId` only renders them; after 3d their text becomes `uk`/`en` |
| `finance/constants.ts` → `TYPE_LABELS`/`STATUS_LABELS` (the consumer `user-profile/tabs/FinanceTab.tsx`)                                                                           | (d) — this is a web-people file, not in this wave's perimeter; noted by plan b         |
| `routes/_authenticated/stats.tsx` (`ROLE_LABEL`), `routes/invoice.v.$transactionId.tsx` (`ROLE_LABEL`)                                                                             | (d) `web-finance`/invoices. Template H from this plan                                   |
| `components/admin-actions/AdminActionsMenu.tsx` — the file is not imported anywhere (dead code with Russian strings)                                                               | A candidate for removal as a separate light-track PR (as noted by plan b)              |

---

## What is NOT included

- **`apps/api`** — the wave does not touch it (FM-5 does not apply; if needed — Global Constraints).
- **Waves (d)–(e)**: finance, statistics, invoices, documents, notifications, `/pending`. Their files are not edited, even when duplicates are found in them (see "Findings outside the perimeter"). Finance transactions inside `$projectId` stay Russian until wave (d).
- **Stage 6**: ESLint `lingui/no-unlocalized-strings` in error mode, the guard for Russian letters, `extract --clean` as a hard gate.
- Texts with an explicit id (`api-error.*`, `zod-error.*`) the wave does not change, only uses.
- `DOMAIN_LABELS`/`SENIORITY_LABELS` (vacancies) — proper names/grades, not translated (remain string maps).

---

## Assumptions (A1 — reversible, recorded)

1. **Perimeter = the `web-projects` audit slice + vacancies (the audit assigned them to this slice) + the admin contract templates (the wave b plan assigned them to wave c).** Excluded: the already-migrated onboarding contract and `user-profile/contract` (wave b), files without Cyrillic (`ProjectLogo`, `contractTokenHighlight`, `use-contract-tokens`, `contract-variables`, `use-board-seniors`). Each deviation — a line in the "Perimeter" table.
2. **4 PRs, not 3.** The slice is larger (786 lines against 880 of wave b, but with one giant file `$projectId.tsx` at 165 lines). Four PRs give ≤ ~240 lines per review and three parallel perimeters; three PRs would put `$projectId` into one PR with half the project list, and the diff review would become unreadable (which the audit explicitly says to avoid: "one file — one PR").
3. **The admin contract templates — in PR4 with the project detail page, not a separate PR.** Rationale: keeps the wave within 4 PRs; the admin templates do not depend on PR3 (may start first inside PR4) and do not overlap with anything file-wise; the "large editing screens" pairing is thematically tolerable. If the team prefers 5 PRs — the admin templates are split into a separate parallel PR without changing the rest of the plan.
4. **We do not touch the cross-slice finance in `$projectId`: we take the finance canon in 3d, not now.** The rationale is in "Danger: cross-slice finance". Finance transactions in the detail page stay Russian until 3d — a known limitation, noted in the PR4 body, not an omission. The local `toLocaleString` calls in the wave's files are nevertheless moved to `format.ts` (COPY-M-proj-15 is feasible without finance).
5. **`OFFER_RECEIVED` — the draft «Оффер отримано» / «Offer received».** The glossary puts «оффер» into `_Избегать_` (the «Vacancy» term), but the audit's own COPY-H-proj-1 recommendation writes «Оффер получен». The final form («Оффер отримано» or «Пропозицію надіслано») is approved by `copy-reviewer`; a divergence from the plan's draft is not a plan violation.
6. **«HR-менеджер» → «HR» on migrating `admin/contracts`** (COPY-M-core-9): one role map per application. `copy-reviewer` may reconsider — then an edit of one canon line (`ROLE_LABEL_MESSAGES.HR`), but this would change the role across the whole application, not only in the admin.
7. **The project status filter tabs are re-measured for `uk` anew** (we do not trust the pixel values from the `projects/constants.ts` comment — they refer to the Russian text). A live run 320/375/768/1024, the values — into the PR3 body. The finding is not from the audit as such, but a consequence of the danger "The width is tuned to the Russian text".
8. **`legend.tsx` and `ProjectLegendSection.tsx` are reduced to shared catalog keys** (~80% of the text is duplicated). The legend masking invariant (glossary **Legend**) is preserved verbatim — the placeholders are translated as examples, not as a revelation of the masking.
9. **The `uk`/`en` drafts in the steps** — a guide, not the final text. The final text is approved by `copy-reviewer` per the "two originals" rubric; a divergence from the plan's draft in the PR is not a plan violation.
10. **`zodIssueRu` is preferably moved to the `translateZodCode` code registry** (stage 4), if there are already codes for the vacancy schemas; if not — `<Plural>`/`i18n._(msg,{n})` without a new code in the registry. Introducing a new code — a separate "Assumptions" line of PR2 and a manual edit of both `.po`.

## Questions for the owner (A2)

The wave creates no open blocking questions: the perimeter is derived from the audit and the wave b plan, the contested decisions (finance, the number of PRs, `OFFER_RECEIVED`, «HR-менеджер») are resolved as A1 on the record above and/or handed to `copy-reviewer` in his regular rubric. The owner question about the `job-sourcing` module is already raised in the wave b plan (A2) — this wave does not concern it.

---

## Wave (c) readiness check

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — green after each PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` on the specs from the "Distribution" and the sweep output — green; CI on all shards green. `project-status-filter-ui.spec.ts` — green at all widths after the tab re-measurement.
- `pnpm i18n:extract` twice in a row — the second run does not change `.po`; in `en` 0 empty `msgstr`.
- `pnpm mutation:changed` — `survived 0`; a `NoCoverage` without an integration-hint closed by a unit test; `node scripts/devops/check-mutation-suppressions.mjs` — green.
- PR4 final check: 0 lines with `[ыэъё]` outside comments in the perimeter; 0 local `ROLE_LABELS` in the perimeter; 0 branchings by the server error text.
- In `CONTEXT.md` there is a subsection "Wave c — `web-projects`".
- `copy-reviewer`: `PASS` on `uk` and on `en` for each of the 4 PRs.
- `security-reviewer`: `APPROVE` for PR3 and PR4 (share approval, legend, passwords, contract templates).
- Screenshots 320/1440 × `uk`/`en` for each migrated screen — in each PR's body; fidelity Mode B — all widths.
- Trace: 23 `web-projects` audit identifiers + 2 admin-template findings — each with a line in the body of the PR that closes it (`review-findings-transfer.md`).
