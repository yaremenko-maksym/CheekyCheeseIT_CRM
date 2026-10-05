# CRM i18n — stage 3, wave (e) "web-docs-notify" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate to `uk`/`en` everything in the CRM that concerns documents and "what awaits a decision": the `/documents` page (list, toolbar, filters, counter, empty states), the document card/row/detail dialog, the status badge, image and PDF previews, the upload dialog, the `/pending` screen (sections, rows, share actions) and the Russian tail remaining in the notifications shell (`use-notification-preferences.ts`). Four PRs, merged **sequentially** (shared `.po` + the shared document-labels hub). After the wave no Russian text remains in the migrated files, three divergent `CATEGORY_LABELS_RU` maps are consolidated into one message map, and the behavior is already decoupled from the text by the previous stages (see below).

**Architecture:** The same single catalog `packages/shared/src/i18n/locales/{uk,en}/messages.po` and the same templates A–L as in waves (a)–(d). A feature of this wave — **most of the "notify" surface is already done**, and the plan knows this by name (the "What is already closed before start" section): the notifications registry (`NOTIFICATION_TITLE_MESSAGES`, `describeNotification`, `renderNotification`) is fully migrated in stage 4 (#698/#702/#714) and is **consumed, not duplicated**; the bell `notifications-bell.tsx` and the `NotificationSettingsTab.tsx` tab are already in `uk`; the testid built from the localized title (`PendingKindSection`/`focusSelectorsAfterActing`), and `localeCompare('ru')` in the document sort are **already decoupled from the text in stage 2** — that is, the two only places where the translation would break not the look but the work are closed BEFORE this wave. Three things are new in the wave. First — **the document labels hub** (`components/documents/document-labels.ts`): one `CATEGORY_LABEL_MESSAGES` instead of three `CATEGORY_LABELS_RU`, one `READY_TO_SIGN` status canon (COPY-H-docs-4), one set of deletion-confirmation texts — the hub is introduced by PR1 and consumed by PR2–PR4, the old local maps live `@deprecated` until the PR of their last consumer (as `TYPE_LABELS` in wave d). Second — **`SORT_OPTION_MESSAGES` was already introduced in stage 3a** in `documents-filter-sort.ts`, but its consumer `documents.tsx` still renders the legacy `SORT_OPTIONS` (Russian) directly in JSX; PR1 migrates the consumer and removes the legacy export (the handoff is already prepared by stage 3a — see its doc comment naming this wave "wave (e)"). Third — **A-defects HIGH that would carry over into both languages** (a recovery promise to the wrong recipient, the caption "К транзакции" above a project id, "инвойс" instead of "счёт", an English axios on a Russian screen) are closed DURING the migration of their files, not multiplied by the translation.

**There is no data-in-DB requiring translation in this wave** (unlike `EXPENSE_CATEGORIES` in wave d) — see "Contested decision 1": notification titles/bodies on the screen are rendered from the catalog by type, and the columns `notifications.title`/`body` are read only as a fallback for unknown/legacy types; their text is written by the producers in `apps/api` (the `api` slice), not the web.

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`), set up in stage 2. React 18, Vite 6, Vitest 4, TanStack Router, Tailwind v4, shadcn/ui, `eslint-plugin-lingui` 0.16.0 (`warn`), Playwright, Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §5 (gates), §7 (wave order), §8 (tests), §12 (a11y focus after an action on `/pending`). Audit: `docs/architecture/2026-09-19-crm-i18n-audit.md`, the `web-docs-notify` slice (21 findings COPY-H/M/L-docs-1…21, `Findings:` at the end of the slice + "Slice boundary correction" + "Recommended migration order"). Samples of format, quality and templates A–L: the wave plans (a) `2026-09-20-crm-i18n-stage3a-web-core.md`, (b) `2026-09-24-crm-i18n-stage3b-web-people.md`, (c) `2026-09-26-crm-i18n-stage3c-web-projects.md`, (d) `2026-09-27-crm-i18n-stage3d-web-finance.md` (the freshest lessons #700–#735).

**Measurement:** all the numbers below were taken by commands on `origin/main` `025c28a0a` (#735, i18n 3d PR4) 2026-09-28, in a clean worktree. The metric — **visible Cyrillic lines outside comments** (a block-comment-aware scan: `/*…*/`, `{/*…*/}`, `//` are removed), tied to **symbols** (`CATEGORY_LABELS_RU`, `pluralizeDocuments`, `KIND_SECTIONS`, …) and **per-file counters**, not to line numbers (`doc-durability.md`). Before starting each PR the implementer repeats the measurement (step 0 of each task): between the plan and execution other branches may have merged into `main`.

---

## What is already closed before start (check at step 0, do NOT redo)

Checked by commands on `025c28a0a`. Each item — what the audit counted in the slice but which was closed earlier. Touching these files in this wave means redoing someone else's work.

| Already done                                                                                                                                                                                                                    | By whom / where                                                                 | How checked                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The notifications registry: `NOTIFICATION_TITLE_MESSAGES` (13 types), `describeNotification`, `notificationActions`, `renderNotification`, `MISC/DETAIL/ACTION` maps — fully `uk`/`en`                                          | stage 4 (#698/#702/#714), `packages/shared/src/schemas/notification-registry.ts` | all 13 `message:` are Ukrainian; `en` in the `.po`; the spec `notification-registry.spec.ts` green    |
| The bell `notifications-bell.tsx` — all visible text in `uk` (`t\`Сповіщення\``, `<Trans>Прочитати все</Trans>`, the empty state, the footer)                                                                                   | stage 4                                                                          | 0 visible Russian strings (all the rest — comments)                                                   |
| The `NotificationSettingsTab.tsx` tab — all `msg` in `uk`, consumes `NOTIFICATION_TITLE_MESSAGES` via `renderMessage`                                                                                                           | stage 4 (position 7b/7c)                                                         | all 20 `msg`/strings — Ukrainian; the Russian remainder — only comments                               |
| `notification-type-icon.tsx`, `context/notifications.tsx` (a dead stub), `use-notifications-api.ts`                                                                                                                             | —                                                                               | 0 visible Cyrillic                                                                                    |
| **The testid from the localized title is decoupled:** `PendingKindSection` builds the testid from `${zone}-${kind}` (not `${title}`); `focusSelectorsAfterActing`/`sectionKindOf` in `pending/index.tsx` are tied to `kind`, not `title` | stage 2 (task-i18n-stage2-task8), doc comments in place                         | `git grep 'pending-kind-heading-\${zone}-\${kind}'`, `sectionKindOf`                                  |
| **`localeCompare('ru')` in the document sort is replaced** with `compareNames(locale)` (`@crm/shared`)                                                                                                                          | stage 2, `lib/documents-filter-sort.ts` `sortDocuments`                         | there is no `localeCompare` in the file; there is `compareNames`                                      |
| **`SORT_OPTION_MESSAGES` is already introduced** (canon, `uk`), next to the legacy `SORT_OPTIONS` (Russian, `@deprecated`-by-meaning)                                                                                           | stage 3a, `lib/documents-filter-sort.ts`                                         | both exports present; the legacy one marked with a comment "removed once wave (e) migrates documents.tsx" |

**Conclusion for the perimeter:** the "notify" part of the slice reduces to one file with two strings (`use-notification-preferences.ts`, COPY-H-docs-6). All the rest of the wave's work is **documents** (`/documents` + `components/documents`) and **pending** (`/pending` + `components/pending`).

---

## Global Constraints

Apply to each task. Items marked "lesson" are taken from the reviews of PR #700–#735 (waves a–d) and already cost a separate review round once.

**Lingui versions and mechanics**

- `@lingui/*` — **5.9.5 EXACT**, a single version (`version-pins.md`). This plan upgrades nothing.
- Source text in the code — **Ukrainian** (`sourceLocale: 'uk'`). English is written by the same coder in the same PR as a second original (skill `copywriting` §5, owner decision #7). The default interface is `uk`, the second language is `en`.
- At the module level — only `msg`. `t`, `plural`, `select` at the module level are forbidden: the string freezes on import. In a component `t`/`i18n` are taken from `useLingui()` (`@lingui/react/macro`).
- **Lesson (#700): the `plural()` macro is incompatible with Stryker.** Under instrumentation `#` is not substituted. For numbers in JSX — the `<Plural>` component; outside JSX — `msg` with an ICU string and `i18n._(descriptor, { count })`. In this wave this concerns primarily `documents.tsx` `pluralizeDocuments` (mod10/mod100 «документ/документа/документов») and the plural phrases in `PendingItemRow`.
- **Lesson (#707): `as const satisfies Record<…, MessageDescriptor>` on a map of `msg` templates disables Stryker for the whole block** (0 mutants). Write `satisfies Record<…>` without `as const` and without `as const satisfies`. This concerns the new `CATEGORY_LABEL_MESSAGES`, `DOCUMENT_STATUS_MESSAGES`, `KIND_SECTION_MESSAGES`.
- `i18n._()` accepts only an **expression**: `i18n._(CATEGORY_LABEL_MESSAGES[cat])`. An object literal with a spread breaks `lingui extract`. Three-arg — `i18n._(id, values, options)`, not a spread.
- **Lesson (#707): for records with an explicit id (`api-error.*`, `zod-error.*`, `notification.*`) the `msgstr` is edited by hand in both `.po`.** `i18n:extract` does not overwrite an existing `msgstr`. This wave does not introduce or change texts with an explicit id — only the `renderMessage` consumption of the registry (already in `main`). If such an edit is needed — a separate line in the PR's "Assumptions" and a manual edit of both `.po`.
- **Reuse-first by captions, not by hub.** Simple repeated JSX texts (`«Отмена»` ×5, `«Другое»` ×3, `«Переместить в корзину?»` ×3) are automatically deduplicated under Lingui **by msgid**: the same source text = one catalog record. A hub is needed only where the text lives in a **structural map/`Record`** consumed programmatically (categories, statuses) — there different copies give divergent translations. Do not introduce a hub for what Lingui will consolidate itself; consolidate into a hub what it does not see.

**Server error text (#704) and the notifications registry (#698/#702/#714) — consume, do not duplicate**

- The API error codes and the client resolvers `getApiErrorMessage`/`translateZodCode`/`translateZodMessage` (`apps/web/app/lib/axios-utils.ts`) — already in `main`. **COPY-H-docs-6 (a raw English axios: `Request failed with status code 413`, `Network Error`)** is closed via `getApiErrorMessage` + a meaningful fallback text with an action (modeled on wave d, COPY-H-fin-3). Do not hand a raw `.message` outward. This concerns `upload-document-dialog.tsx` `handleSubmit` and `hooks/use-notification-preferences.ts`.
- `NOTIFICATION_TITLE_MESSAGES`/`renderNotification`/`renderMessage` — **consume**. The wave does not touch them and does not reproduce their defensive branches (`renderMessage` was exported exactly so as not to duplicate them — SPEC-H-2, #714).

**Texts (`CONTEXT.md` → "`uk`/`en` forms" + the canon table below)**

- The apostrophe — `’` (U+2019). The ellipsis — `…` (U+2026), not `...` (COPY-L-docs-19: three ASCII dots against the symbol in neighboring states). Quotes: `uk` — guillemets `«…»`, `en` — typographic `“…”`.
- **Terms are taken from the `CONTEXT.md` glossary verbatim:**
  - **Invoice = «Рахунок»** (`_Избегать_`: інвойс, акт, платіжка). Hence COPY-H-docs-5: `«Инвойс»`/`«Инвойсы»` ×… → «Рахунок» (the same defect was already fixed in the bell #664).
  - **Document = «документ»**; for the category `CONTRACT` the glossary flags "a contract in general" as a term to clarify (COPY-H-docs-3) — **PR1 fixes the choice in `CONTEXT.md`** (recommendation below), after which one map, one word per category.
  - **Archive = «Архів»** (documents), «архів» — a state, not an action.
  - The contract status `draft` (COPY-H-docs-4/-16): the glossary forbids «Черновик» for a **project** status, for a contract there is no word — **PR2 enters it into `CONTEXT.md`** next to `employeeContracts`.
- **Lesson (#702, item 13): a raw enum/status/type/MIME in visible text is a finding.** After replacing a literal, scan the **whole** file for a raw enum/identifier in JSX text, `aria-label`, `title`, `placeholder`. Hence COPY-M-docs-10 (raw MIME `application/vnd.openxml…` → «PDF»/«Зображення JPEG»), COPY-M-docs-11 (`#{shortId(projectId)}` → the project name), COPY-M-docs-9 («…из S3 и базы» → «без можливості відновлення» — remove the storage name from the screen). Exceptions: `PDF`, `JPEG`, `S3`/`R2` as names in the `title` attribute, if the code needs them.
- **Lesson (#702, item 9): substitution into an oblique case breaks `uk`.** A name/role is substituted only in the nominative. The construction is chosen to not require a case (template K). This concerns the concatenations in `PendingItemRow` (`` `Сейчас ${cur}% → предложено ${pct}%` ``, `` `Предлагает ${proposedBy}` ``, `` `Ждём: ${waitingFor}` ``), `document-card` (`` `Открыть документ «${name}»` ``), `pdf-preview` (`` `Предпросмотр: ${filename}` ``), `upload-document-dialog` (`` `Файл больше ${max}. Ваш файл: ${size}` ``).
- **Audit lesson (COPY-H-docs-1..6): close an A-defect during the migration, not translate it as is.** Translating a defective string means multiplying the defect into two languages. Each HIGH from the trace is fixed on its merits, not transliterated.
- A toast and a refusal — **one sentence, no period at the end**, with a verb; a dead end without a next step is a finding (COPY-M-docs-13 «У вас нет доступа» → name the recipient; COPY-M-docs-14 «Доля неизвестна. Обновите» → say what to do when refreshing does not help; COPY-M-docs-12 a PDF error → «Повторити»+«Завантажити»). One situation — one text.
- Jargon/infrastructure name is forbidden outward (COPY-M-docs-9 «S3», COPY-M-docs-10 a raw MIME).
- **Lesson (#701, item 5): check russisms by unicode, not a byte `grep`.** Before each push:

```bash
python3 -c "import re,sys,subprocess;fs=subprocess.run(['git','diff','--name-only','origin/main','--','apps/web/app'],capture_output=True,text=True).stdout.split();[print(f,i,l.strip()) for f in fs if f.endswith(('.ts','.tsx')) for i,l in enumerate(open(f,encoding='utf8'),1) if re.search('[ыЫэЭъЪёЁ]',l) and not re.match(r'\s*(//|\*|\{/\*)',l)]"
```

Strings from this output in files of **your** PR are an incomplete migration. Exceptions — test fixtures with Russian data (file names like `резюме-тест.pdf`) and comments. The letters `і ї є ґ` are already Ukrainian, not a russism; the guard targets `ы э ъ ё`.

**Tests**

- Anchors — `data-testid` and roles. Text in assertions is taken from the **`uk` catalog**, not a literal:
  - Vitest — `loadCatalog(locale)` and `I18nTestProvider` from `apps/web/app/test/i18n.tsx` (already in `main`);
  - E2E — `loadMessages('uk')` and `assertInCatalog(uk, '<text>')` from `apps/e2e/fixtures/catalog.ts` (already in `main`).
- **Audit lesson (COPY-B "tests duplicate literals"): 9 unit files (79 occurrences) and 7 E2E files (20 selectors) check Russian text.** Where an assertion by text is not the subject of the check — anchor by `data-testid`; where the wording itself is checked — text from the catalog. E2E fixtures with Russian **file names** (`резюме-тест.pdf`) are excluded from the replacement (they are data, not UI).
- **Lesson (#700, item 2): the E2E sweep is over the whole `apps/e2e`, not over the specs in the diff.** A regression — any literal of a migrated component in any spec. The procedure and script — "Common step: E2E sweep" below. "Pre-existing" is allowed only if CI on `origin/main` is red on the same spec.
- **Lesson (#700, item 3): the mutation gate on the full diff is a mandatory AC**, `survived 0`. If a `NoCoverage` has no integration-hint, a unit test closes it (`mutation-gate-integration-specs.md`). A local SKIP on timeout is not a PASS.
- **Lesson (#699, item 12): each Stryker suppression — with a reason on the same directive line** (`// Stryker disable next-line <Mutator>: <reason>`, no shorter than 12 characters). Before push — `node scripts/devops/check-mutation-suppressions.mjs`: a local `pnpm mutation:changed` does not call it, and CI with it fails all Mutation Gate jobs before even starting.
- Tests are edited by the same coder in the same PR. The wave does not introduce new `*.spec.ts` E2E scenarios; new unit cases (one category map instead of three; `pluralizeDocuments`→ICU at 1/2/5/11/21; a status without a raw enum; an error fallback with an action) — inside the existing test files.

**Process**

- `git add` by an explicit list (each task has one). Push — `DATABASE_URL= git push`, without `--no-verify`. Each commit carries `ac_verified:` with the numbers from the "Acceptance criteria" of its task.
- **Lesson (#700, item 6): a cadence for 20+ files** — `wip:` commits locally, one push at the end. Pre-push under load flakes. `documents.tsx` (36 lines, PR1) and `document-detail-dialog.tsx` (31, PR2) — by section, `wip:` after each.
- **Lesson (#700, item 5): screenshots and live passes are done with the `npx playwright` script in your own scratchpad**, not via `mcp__playwright__*`: the MCP browser is shared across all parallel agents.
- **Lesson (#700, item 7): CI is the E2E arbiter.** Do not run a full local E2E green on a loaded machine (the wave d finance coders hung on monitoring dev servers). An **isolated run of the affected specs** (`DATABASE_URL= pnpm --filter @crm/e2e test -- <spec>`) in ONE foreground command with a timeout is enough; the full run of all shards is confirmed by CI on the PR.
- **Lesson (#704/#707): the `.po` conflict on sequential PRs is additive.** Take both sides, then `pnpm i18n:extract` twice, the second run gives an empty diff. Check by numbers: `msgid` = `main` + the PR's new records, and fuzzy/`#-#-#`/empty `msgstr` in `en` — 0. The `.po` merge is not given to haiku.
- After each Edit/Write of `.ts`/`.tsx` — `mcp__eslint__lint-files`. On the touched lines there must be no new `lingui/no-unlocalized-strings` warnings.
- **`security-review`:** `/pending` (shares, confirmations) and `SeniorShareApprovalActions` — money/RBAC (`viewerSharePercent`, `approvalId`, `supersededAt` generations). PR4 (pending) requires `security-reviewer` **mandatorily**. Documents behind an RBAC filter (`availableCategories`, `canRestore = isDeleted && isAdmin`, receipt masking) — PR1/PR2 carry a line for `security-reviewer` (we change the text, not RBAC). PR3 (upload/pdf) — `security-reviewer` on file upload.
- Each PR passes design-gate **Tier 2** (editing existing screens: a ui-ux-designer conformance check, without generation in Claude Design) and fidelity Mode B on all device classes. The `copy-reviewer` verdict — on `uk` and on `en` **separately**.
- **Responsive AC for each PR:** the screens are checked at 320/375 (mobile), 768 (tablet), 1024/1280 (laptop), 1440/1920 (large) in **both** languages. No horizontal scroll (`document.scrollWidth <= clientWidth`), labels not truncated without `truncate`+`title`, touch targets ≥44×44. Screenshots 320 and 1440 × `uk` and `en` — to the PR. **A special risk of the wave is the notifications popup (320px, `w-80`) and the dense document card grid**: the Ukrainian captions are longer than the Russian ones; re-measure wrapping at 320/375.

---

## Test access to the catalog (helpers already in `main`)

```tsx
// Vitest (apps/web)
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
await loadCatalog('uk')
render(<DocumentCard doc={doc} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Рахунок')).toBeInTheDocument()
```

```ts
// E2E (apps/e2e) — `pnpm i18n:compile` is mandatory before a run
import { loadMessages, assertInCatalog } from '../fixtures/catalog'
const uk = await loadMessages('uk')
await expect(page.getByText(assertInCatalog(uk, 'Документів ще немає'))).toBeVisible()
```

`assertInCatalog` fails with a clear error if the text is not in the catalog: an outdated literal does not turn into a Playwright timeout. The relative import path depends on the spec's depth (`'../fixtures/catalog'` for `tests/*.spec.ts`, `'../../fixtures/catalog'` for `tests/crm/*.spec.ts`).

**Lesson (#700, recurred 4× in wave d): an E2E assert — via `assertInCatalog`, NOT a literal.**

```ts
// ❌ was — a literal breaks silently on a wording change
await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible()
// ✅ became — the catalog = the source; a mismatch = an explicit error, not a timeout
const uk = await loadMessages('uk')
await expect(
  page.getByTestId('documents-page').getByText(assertInCatalog(uk, 'Документи')),
).toBeVisible()
```

---

## Perimeter of wave (e) — how it was obtained

Commands (the boundaries of the `web-docs-notify` audit slice + the "Slice boundary correction"):

```bash
git ls-tree -r --name-only origin/main -- \
  apps/web/app/routes/_authenticated/documents.tsx apps/web/app/components/documents/ \
  apps/web/app/routes/_authenticated/pending/ apps/web/app/components/pending/
# visible Cyrillic outside comments — a block-comment-aware scan (see "Measurement")
```

Result on `025c28a0a`: **~186 visible Cyrillic lines requiring translation in 14 product files** (excluding the already done). The visible-text metric (comments removed) is below the audit metric "≈226 fragments" — the difference is that the bell/`NotificationSettingsTab`/registry out of the audit's 19 product files are already migrated. The heaviest: `documents.tsx` 36 · `document-detail-dialog.tsx` 31 · `upload-document-dialog.tsx` 25 · `document-card.tsx` 21 · `document-row.tsx` 17 · `pending/index.tsx` 13 · `PendingItemRow.tsx` 12.

Each deviation of the perimeter from the audit — a line in the table below.

| What                                                                                                                                            | Decision                           | Why                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notifications-bell.tsx`, `NotificationSettingsTab.tsx`, `notification-type-icon.tsx`, `context/notifications.tsx`, `use-notifications-api.ts` | **do not touch (already done)**   | Migrated in stage 4 / no text. See "What is already closed before start". Verification — yes, editing — no                                                                                                                                                                         |
| `packages/shared/.../notification-registry.ts` (`NOTIFICATION_TITLE_MESSAGES`, `renderNotification`)                                           | **consume (#698/#702/#714)**      | The `shared` slice, fully migrated. The wave reads it via the bell/tab, does not change it                                                                                                                                                                                         |
| `lib/documents-filter-sort.ts` — `localeCompare`, `SORT_OPTION_MESSAGES`                                                                       | **PR1 (only remove the legacy)**  | The behavior (`compareNames`) and the canon (`SORT_OPTION_MESSAGES`) are done in stages 2/3a. PR1 migrates the consumer `documents.tsx` and removes the legacy `SORT_OPTIONS` (the handoff is prepared by the stage 3a doc comment)                                                 |
| the testid `PendingKindSection`/`focusSelectorsAfterActing`                                                                                    | **do not touch (already decoupled)** | Stage 2 tied the testid to `kind`, not `title`. Our wave translates only the visible `title` — now this is safe. `PendingKindSection.tsx` itself carries no text (0 Cyrillic)                                                                                                       |
| `pdf-preview.tsx`, `document-image.tsx`                                                                                                        | **include (cross-consumed)**      | Both live in `components/documents` and are native here, but consumed outside the slice (`PdfPreview` — resume/vacancies/admin-contracts; `DocumentImage` — ProjectLogo/UserAvatar/image-upload). Keep the signatures; the text is internal — the edit is safe, but the E2E sweep must cover their specs |
| `hooks/use-notification-preferences.ts`                                                                                                        | **include (PR4)**                 | The only "notify" file with Russian (COPY-H-docs-6): `Не удалось сохранить настройку`, `Сохранено`                                                                                                                                                                                 |
| `document-list.tsx` (`internalEmpty` dead + `<iframe>` fallback)                                                                               | **PR2/PR3 — remove the dead**     | COPY-M-docs-8: the `DocumentList` empty state is unreachable (the parent always passes `emptyState`); the `<iframe>` content is not rendered in HTML5. The dead text is removed, not translated                                                                                     |
| `apps/api/**` — the `NOTIFICATION_TITLES` producers into the `title` column                                                                    | **do not touch (the `api` slice)** | The Russian text the producers write to the DB is a migration of the `api` slice (backend). It is not read on the screen (see "Contested decision 1")                                                                                                                              |
| `document-card.tsx` branch `isReceipt && doc.projectId` («К транзакции #…»)                                                                     | **include (PR2, COPY-H-docs-2)**  | The defect would carry over into both languages; the branch is almost dead (`ReceiptInput` loads a receipt without `projectId`). The decision — remove the chip/link to the transaction (see the trace)                                                                            |

---

## Summary by PR (sequential merge; the sum ~186 lines)

| PR      | What                                                                                                                                                                                                                                              | Product files | Cyrillic lines |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | --------------- |
| **PR1** | Hub `document-labels.ts` (one category map + status canon + deletion texts) + the `/documents` page (`documents.tsx`) + cleanup of `documents-filter-sort.ts` (consume `SORT_OPTION_MESSAGES`, remove `SORT_OPTIONS`) + `CONTEXT.md` canon | 2 + hub            | ~36 + hub       |
| **PR2** | Card/row/detail dialog/status/image/list: `document-card`, `document-row`, `document-detail-dialog`, `document-status-badge`, `document-image`, `document-list`                                                                                 | 6                  | ~80             |
| **PR3** | Upload + PDF preview: `upload-document-dialog`, `pdf-preview`                                                                                                                                                                                   | 2                  | ~33             |
| **PR4** | Pending + the notifications tail: `pending/index.tsx`, `PendingItemRow`, `SeniorShareApprovalActions`, `PendingKindSection` (test), `use-notification-preferences.ts` + removing the `@deprecated` maps from the hub                            | 5                  | ~37             |

**Alternative (Assumption 2):** combine PR2+PR3 into one "document-components" PR (3 PRs total) — the perimeters do not overlap with PR1/PR4, but the PR becomes ~113 lines / 8 files. The choice is up to the orchestrator if the review turns out easy. Splitting finer than 4 PRs makes no sense.

---

## Sequence discipline

The wave is **sequential**, not parallel: a shared `.po` and a shared hub `document-labels.ts`. Each next PR starts after the previous is merged and is rebased onto it.

| Step | PR      | Waits for | Why                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PR1** | —        | Introduces the hub `CATEGORY_LABEL_MESSAGES`/`DOCUMENT_STATUS_MESSAGES`/`DELETE_CONFIRM_MESSAGES`. **Does NOT remove the local `CATEGORY_LABELS_RU` in `upload`/`detail`** (consumers in PR2/PR3) — their Russian remains until their PR. Migrates `documents.tsx` to the hub + `SORT_OPTION_MESSAGES`, removes the legacy `SORT_OPTIONS`. Enters the wave (e) canon into `CONTEXT.md` |
| 2   | **PR2** | merge of PR1 | Consumes the hub; removes the local `CATEGORY_LABELS_RU` from `document-detail-dialog`; the status `READY_TO_SIGN` is taken from the hub (COPY-H-docs-4). Rebase onto PR1                                                                                                                                                                                 |
| 3   | **PR3** | merge of PR2 | Consumes the hub; removes the **last** local `CATEGORY_LABELS_RU` (in `upload-document-dialog`). After PR3 `git grep 'CATEGORY_LABELS_RU'` — empty                                                                                                                                                                                                      |
| 4   | **PR4** | merge of PR3 | Pending + `use-notification-preferences`. Removes the `@deprecated` remainders from the hub, if any. The final wave check (script below)                                                                                                                                                                                                                |

**E2E spec distribution** (whichever's text a line asserts, that PR edits it; the exact list — with the sweep at the push step). Slice specs with Cyrillic: `crm/documents-search-sort.spec.ts`, `crm/documents-status-badges.spec.ts`, `documents-pdf-preview.spec.ts`, `documents-pr1.spec.ts`, `documents-pr3.spec.ts`, `pending.spec.ts`, `pending-settlement.spec.ts`, `notification-settings.spec.ts`, `notification-types.spec.ts`, `notifications-popup-overflow.spec.ts` (the last three — on the already-migrated bell/tab; their Russian selectors, if any remain, are a regression from the sweep, not our migration).

| PR  | Specs (guide — refine with the sweep)                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| PR1 | `documents-pr1.spec.ts`, `crm/documents-search-sort.spec.ts` (list, toolbar, sort, counter, empty)                      |
| PR2 | `crm/documents-status-badges.spec.ts`, `documents-pr1.spec.ts`, `documents-pr3.spec.ts` (card/row/status/detail)        |
| PR3 | `documents-pr3.spec.ts`, `documents-pdf-preview.spec.ts` (upload, PDF)                                                   |
| PR4 | `pending.spec.ts`, `pending-settlement.spec.ts` (sections, rows, shares)                                                |

---

## Wave (e) term canon — `uk`/`en`

PR1 moves this table into `CONTEXT.md` (the "`uk`/`en` forms" section, a continuation of waves a–d) in the first commit. PR2–PR4 take the words from here verbatim. The `uk` forms — a draft; the final text is approved by `copy-reviewer` ("two originals").

| Term (rus., for reference)                        | `uk`                                                                      | `en`                                                                           | `_Избегать_` (`uk`/`en`)                              | Source                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------- |
| Document                                          | документ                                                                  | document                                                                       | «файл» as a synonym for a document                    | glossary                                  |
| Category `INVOICE` (invoice)                      | Рахунок                                                                   | Invoice                                                                        | «Інвойс», «акт», «платіжка»                           | COPY-H-docs-5; glossary **Invoice**       |
| Category `CONTRACT`                               | **Договір** (recommendation — see "Contested decision 2")                | Contract                                                                       | mixing «договір»/«контракт» in one scenario           | COPY-H-docs-3; `CONTEXT.md` (clarify)     |
| Category `RESUME`                                 | Резюме                                                                    | Résumé                                                                         | —                                                     | COPY-H-docs-3                             |
| Category `SCAN`                                   | Скан                                                                      | Scan                                                                           | «Скан документа»/«Сканы документов» inconsistently    | COPY-H-docs-3 (one word per category)     |
| Category `AVATAR` / `LOGO` / `OTHER`              | Аватар / Логотип / Інше                                                   | Avatar / Logo / Other                                                          | —                                                     | COPY-H-docs-3                             |
| Archive (of documents)                            | Архів                                                                     | Archive                                                                        | —                                                     | COPY-H-docs-1                             |
| Can be restored from the "Archive"                | Документ піде в архів. Повернути його може адмін                          | The document goes to the archive. An admin can restore it                      | «можна відновити пізніше» (promise to the wrong one)  | COPY-H-docs-1 (promise to the wrong recipient) |
| Delete permanently (from S3 and the DB)           | Файл буде видалено без можливості відновлення                             | The file will be deleted permanently                                           | «…назавжди з S3 і бази» (storage name on the screen)  | COPY-M-docs-9                             |
| Status `READY_TO_SIGN`                            | Готовий до підпису                                                        | Ready to sign                                                                  | «Готово до підпису»/«Готовий до підписання» inconsistently | COPY-H-docs-4 (one canon, from the hub)   |
| Contract status `draft`                           | Чернетка (recommendation — see "Contested decision 2")                   | Draft                                                                          | «Драфт» (transliteration)                             | COPY-M-docs-16; `CONTEXT.md` (clarify)    |
| Status `signed`                                   | Підписано                                                                 | Signed                                                                         | —                                                     | COPY-H-docs-4                             |
| An invoice is awaiting signature                  | Очікує підпису                                                            | Awaiting signature                                                             | «Вимагає підпису»/«Очікує підпису» inconsistently     | COPY-M-docs-15 (one canon)                |
| Search by name…                                   | Пошук за назвою файлу                                                     | Search by file name                                                            | «Пошук за іменем» (ambiguous with the owner filter)   | COPY-L-docs-17                            |
| Empty: no documents                               | Документів ще немає                                                       | No documents yet                                                               | «Немає даних», «Порожньо»                             | COPY-M-docs-6; audit                      |
| Empty: a filter found nothing                     | Нічого не знайдено — скиньте фільтри                                      | No matches — clear the filters                                                 | «Немає даних»                                         | wave b catalog (key already exists)       |
| No access to documents                            | Документи вам не відкриті. Потрібен доступ — напишіть адміну              | You don’t have access to documents. Ask an admin if you need it                | «У вас немає доступу» (dead end)                      | COPY-M-docs-13                            |
| Format (value)                                    | PDF / Зображення JPEG (human)                                            | PDF / JPEG image                                                               | raw MIME `application/vnd.…`                          | COPY-M-docs-10 (MIME — in `title`)        |
| Project (in the document details)                 | назва проєкту                                                             | project name                                                                   | `#<8 chars of a UUID>`                                | COPY-M-docs-11 (id — in the link `title`) |
| Open/Download PDF                                 | Завантажити PDF (if `download`) / Відкрити PDF (if it opens)             | Download PDF / Open PDF                                                        | «Відкрити PDF» on `<a download>` (promises the wrong) | COPY-M-docs-7                             |
| PDF load error                                    | Не вдалося завантажити PDF                                                | Couldn’t load the PDF                                                          | without «Повторити»/«Завантажити»                     | COPY-M-docs-12 (+ retry/download)         |
| Loading…                                          | Завантаження…                                                            | Loading…                                                                       | «Загрузка...» (ASCII dots)                            | COPY-L-docs-19                            |
| Sort `SORT_OPTION_MESSAGES`                       | (already in `main`, stage 3a — consume)                                   | (already in the `.po`)                                                         | naming the alphabet in the caption, if copy-review decides | COPY-L-docs-18 (behavior closed)          |
| Sections `/pending` (Projects/Shares/Contracts/Other) | Проєкти / Частки / Контракти / Інше                                       | Projects / Shares / Contracts / Other                                          | —                                                     | audit B (testid already decoupled)        |
| Your share is unknown (refresh)                   | Частка не прийшла із сервера. Не підтверджуйте наосліп — запитайте адміна | Your share didn’t arrive from the server. Don’t confirm blindly — ask an admin | «Оновіть сторінку» (doesn’t cure)                     | COPY-M-docs-14                            |
| Share actions (confirm/reject)                    | Підтвердити / Підтвердження… / Відхилити                                  | Confirm / Confirming… / Reject                                                 | «Подтверждение...» (ASCII dots)                       | COPY-L-docs-19                            |
| Couldn’t save the setting                         | Не вдалося зберегти налаштування — <reason via `getApiErrorMessage`>      | Couldn’t save the setting — <reason>                                           | raw `err.message` (English axios)                     | COPY-H-docs-6                             |
| Saved                                             | Збережено                                                                 | Saved                                                                          | —                                                     | COPY-H-docs-6 (the neighboring toast)     |

The apostrophe, ellipsis, quotes, `en` refusals "Couldn’t …" — per the common `CONTEXT.md` section "`uk`/`en` forms". Document categories and the contract status — **the own enums of this slice**, translated by a map (template G), not via the app-`Role`.

---

## Migration templates

**A–L — the same as in waves (a)–(d)** (see `docs/superpowers/plans/2026-09-26-crm-i18n-stage3c-web-projects.md` + the "Templates" section of wave d). Refinements of this wave:

**G-docs. Three `CATEGORY_LABELS_RU` → one `CATEGORY_LABEL_MESSAGES` (hub).**

```ts
// was — three copies in documents.tsx / upload-document-dialog.tsx / document-detail-dialog.tsx,
//        with WORDS diverging between themselves (CONTRACT: «Договоры»/«Договор»/«Контракт»)
const CATEGORY_LABELS_RU: Record<DocumentCategory, string> = { CONTRACT: 'Договоры' /* … */ }

// became — ONE map in the new components/documents/document-labels.ts; satisfies without as const
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
export const CATEGORY_LABEL_MESSAGES = {
  CONTRACT: msg`Договір`, // en: Contract  (one word per category — COPY-H-docs-3)
  INVOICE: msg`Рахунок`, // en: Invoice   (COPY-H-docs-5)
  // … all DocumentCategory keys
} satisfies Record<DocumentCategory, MessageDescriptor>
```

The consumer — `i18n._(CATEGORY_LABEL_MESSAGES[cat])`. **Lowercasing the translated string is forbidden:** the `documents.tsx` counter does `CATEGORY_LABELS_RU[cat].toLowerCase()` (audit B) — under Lingui a SEPARATE `msg` in lowercase is introduced («у категорії {категорія}»), not `.toLowerCase()` on the result of `i18n._()`.

**J-docs. `pluralizeDocuments` → ICU.** `documents.tsx` `pluralizeDocuments(n)` (mod10/mod100 «документ/документа/документов») — correct forms, but hardcoded and Russian; for `en` two forms, for `uk` its own.

```tsx
<Plural value={n} one="# документ" few="# документи" many="# документів" other="# документа" />
// en: one="# document" other="# documents"
```

Remove the self-written function. The counter `«${n} ${pluralizeDocuments(n)}${' · в архиве'}${scope}`` is reassembled from `<Plural>`+`<Trans>` slots (concatenation — template K), without the genitive-case concatenation.

**K-docs. `PendingItemRow` concatenations → `<Trans>` slots / `select`.** Four variants of one phrase in `metaLinesFor` (`Сейчас…→предложено…`, `Предлагает…`, `Ждём:…`, `Ваша доля:…·синьор:…`) — a candidate for `select` by the branch feature (audit: "four variants of one phrase — a candidate for `select`"). Percentages — via `<Plural>`/ICU, names (`proposedBy`, `seniorName`) — only in the nominative, as a slot. The ternary `{cat === 'AVATAR' ? 'аватаров' : 'логотипов'}` (genitive inside a ternary, `documents.tsx` `internalEmpty`) → `select` by `cat`, not a case concatenation.

**L-docs. `date-fns/locale/ru` → `formatRelativeTime`/`formatDate` from `@crm/shared`.** `ru` is imported in `document-card`, `document-row`, `document-detail-dialog` (PR2), `PendingItemRow` (PR4). `fmtRelative` is duplicated (`PendingItemRow` — a comment admits it) — reduce to `formatRelativeTime(iso, locale)`. `format(d, 'd MMMM yyyy', { locale: ru })` (the order "day month year" is hardcoded) → `formatDate(iso, locale, 'long')`. `locale` is taken from `useLocale()` in the component (do not call the hook in `.map()`).

**The status and confirmation hub (COPY-H-docs-4, -1, -9).** `document-labels.ts` also holds `DOCUMENT_STATUS_MESSAGES` (`READY_TO_SIGN`/`SIGNED`/`DRAFT`/`invoice awaiting signature` — one canon) and `DELETE_CONFIRM_MESSAGES` (archive: «Повернути може адмін»; permanent: «без можливості відновлення»). `document-status-badge.tsx` (PR2) and `PendingItemRow.tsx` (PR4) take `READY_TO_SIGN` from here — otherwise one status on neighboring screens diverges again. The three copies of the deletion-confirmation dialog (card/row/detail) take the texts from `DELETE_CONFIRM_MESSAGES`.

---

## Common step: E2E sweep (in each PR before push)

The script collects the Russian fragments that **this PR removed** and searches for them across the whole `apps/e2e`. Each hit — a line to check. It remained in another not-yet-migrated component and a spec asserts exactly it — do not touch. It asserts a migrated screen — move to `assertInCatalog` (template I). **Fixture file names with Cyrillic (`резюме-тест.pdf`) are data, not UI: exclude.**

```bash
SCRATCH="${TMPDIR:-/tmp}/wave-e-$(git rev-parse --abbrev-ref HEAD | tr / -)"   # own directory from your branch
mkdir -p "$SCRATCH"
git diff origin/main -- apps/web/app > "$SCRATCH/wave-e.diff"
```

```python
# $SCRATCH/e2e_sweep.py — python3 e2e_sweep.py <path-to-wave-e.diff>
import re, sys, pathlib
ru = re.compile(r'[А-Яа-яЁё]')
frag = re.compile(r"""['"`]([^'"`\n]*[А-Яа-яЁё][^'"`\n]*)['"`]|>\s*([^<>{}\n]*[А-Яа-яЁё][^<>{}\n]*?)\s*(?:<|\{|$)|^-\s+([А-Яа-яЁё][^<>{}\n]*?)\s*(?:<|\{|$)""")
FIXTURE = re.compile(r'\.(pdf|png|jpe?g|docx?|xlsx?)$', re.I)   # fixture file names — not UI
removed = set()
for line in open(sys.argv[1], encoding='utf8'):
    if line.startswith('-') and not line.startswith('---') and ru.search(line) \
            and not re.match(r'^-\s*(//|\*|\{/\*)', line):
        for m in frag.finditer(line):
            text = next(g for g in m.groups() if g).strip()
            if len(text) >= 4 and ru.search(text) and not FIXTURE.search(text):
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
python3 "$SCRATCH/e2e_sweep.py" "$SCRATCH/wave-e.diff" > "$SCRATCH/sweep.txt"
cut -d: -f1 "$SCRATCH/sweep.txt" | sort -u > "$SCRATCH/sweep-specs.txt"   # list for git add
```

The whole output — into the PR body (the "E2E sweep" section) with a mark on each line: "moved to the catalog", "testid" or "not our text — <which component outside the wave renders it>". A line without a mark is unclosed. The specs enter the commit via `git add $(cat "$SCRATCH/sweep-specs.txt")`.

---

## Task 1 (PR1): hub `document-labels.ts` + the `/documents` page + sort cleanup

**Files** (visible Cyrillic on `025c28a0a`):

| File                                            | Cyr. | Pattern(s)  | Audit findings / note                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/documents/document-labels.ts` (NEW) | —    | G           | Hub: `CATEGORY_LABEL_MESSAGES` (COPY-H-docs-3/-5), `DOCUMENT_STATUS_MESSAGES` (COPY-H-docs-4), `DELETE_CONFIRM_MESSAGES` (COPY-H-docs-1/-9), lowercase category                                                                                              |
| `routes/_authenticated/documents.tsx`           | 36   | A,B,C,G,J,K | COPY-M-docs-13 (`documents-no-access`), M-6 (empty), L-17 (placeholder «Поиск по имени…»), H-5 («Инвойс»/`invoiceEmpty`), `pluralizeDocuments`→ICU, `.toLowerCase()` on the translation, `statusOptions`, consume `SORT_OPTION_MESSAGES` + remove `SORT_OPTIONS` |
| `lib/documents-filter-sort.ts`                  | ~1   | —           | Remove the legacy `SORT_OPTIONS` (the consumer is migrated); do not touch `SORT_OPTION_MESSAGES`/`sortDocuments`/`compareNames` (done in stages 2/3a)                                                                                                        |

Outside the product: `CONTEXT.md` (the wave e canon), `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Tests (assertions to the catalog): `documents/__tests__/*` (where they assert `documents.tsx`), `lib/__tests__/documents-filter-sort*` (sort/options). New cases (one category map; `pluralizeDocuments`→ICU at 1/2/5/11/21; empty states with a reason) — inside the existing files.

E2E: the PR1 "Distribution" row + the sweep output.

**Interfaces:**

- Consumes: `SORT_OPTION_MESSAGES` (`lib/documents-filter-sort`), `useLocale()` (`@/lib/i18n`), `useLingui()`, `formatDate` (`@crm/shared`), the catalog helpers.
- Produces: `CATEGORY_LABEL_MESSAGES: Record<DocumentCategory, MessageDescriptor>`, `DOCUMENT_STATUS_MESSAGES`, `DELETE_CONFIRM_MESSAGES` in `document-labels.ts`. The wave (e) canon section in `CONTEXT.md`. Removes the legacy `SORT_OPTIONS` from `documents-filter-sort.ts`.

### Danger: `document-labels.ts` — a hub, the local maps live until their PR

`CATEGORY_LABELS_RU` lives in three files. PR1 introduces the hub and migrates `documents.tsx`, but **does not remove** the copies in `upload`/`detail` — their Russian remains until PR2 (`detail`) and PR3 (`upload`). The final check `git grep 'CATEGORY_LABELS_RU'` → empty — only after PR3.

### Danger: `documents.tsx` behind RBAC — we change the text, not the access

`availableCategories`/`statusOptions`/`documents-no-access` depend on the role (`isAdmin`, `canRestore`). The translation changes the **text**, not which categories/statuses are visible and who restores. The test — the set of visible options per-role did not change. A line in the PR body for `security-reviewer`.

### Acceptance criteria (PR1)

1. In `CONTEXT.md` there is a subsection "Wave e — `web-docs-notify`" with the canon forms (including the choice `CONTRACT`=«Договір» and `draft`=«Чернетка», see "Contested decision 2").
2. `document-labels.ts`: `CATEGORY_LABEL_MESSAGES` (one map, `satisfies` without `as const`), `DOCUMENT_STATUS_MESSAGES`, `DELETE_CONFIRM_MESSAGES` — terms per the canon (Рахунок/Договір/Архів); the test "the map returns text without a raw enum" is green.
3. `documents.tsx` in `uk`/`en`: categories/statuses from the hub; `pluralizeDocuments`→`<Plural>` (test 1/2/5/11/21); placeholder «Пошук за назвою файлу» (L-17); `documents-no-access` with a recipient (M-13); empty states with a reason (M-6); «Рахунок» instead of «Инвойс» (H-5); the counter without `.toLowerCase()` on the translation.
4. `documents.tsx` consumes `SORT_OPTION_MESSAGES` via `i18n._()`; the legacy `SORT_OPTIONS` removed from `documents-filter-sort.ts`; `git grep 'SORT_OPTIONS\b'` — empty.
5. In the PR1 files 0 lines of `[ыэъё]` outside comments.
6. Unit asserts the catalog; the E2E sweep is done, a table in the PR body; the PR1 E2E specs are green (isolated run; CI — the arbiter).
7. `pnpm i18n:extract` twice — an empty diff; in `en` 0 empty `msgstr`.
8. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` green.
9. Design tier 2, fidelity Mode B on all widths, screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk` and `en`; `security-reviewer` APPROVE (category/status RBAC, receipt masking).

- [ ] **Step 0: Measurement and preconditions**

```bash
git rev-parse --show-toplevel                       # == the assigned worktree
git fetch origin main && git log --oneline -1 origin/main
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/routes/_authenticated/documents.tsx
git grep -l 'CATEGORY_LABELS_RU' origin/main -- apps/web/app       # the current list of copies
git grep -n 'SORT_OPTIONS\b' origin/main -- apps/web/app           # confirm the sole consumer
```

If the numbers differ from the table by more than 10% — update the table in the task file before starting.

- [ ] **Step 1: Canon → `CONTEXT.md`** — the subsection "Wave e — `web-docs-notify`". A separate commit `docs(context): wave e uk/en term forms`, `ac_verified: 1`.
- [ ] **Step 2: Test for the hub (fails)** — `it.each` by locale: `CATEGORY_LABEL_MESSAGES.INVOICE`=«Рахунок»/«Invoice», no «Інвойс»; `DOCUMENT_STATUS_MESSAGES.READY_TO_SIGN`=«Готовий до підпису». FAIL.
- [ ] **Step 3: `document-labels.ts` (hub) → PASS** — maps per G (`satisfies` without `as const`).
- [ ] **Step 4: `documents.tsx` by section (`wip:`)** — toolbar/filters/sort (consume `SORT_OPTION_MESSAGES`) → counter+`<Plural>` → empty states/no-access → placeholder.
- [ ] **Step 5: `documents-filter-sort.ts`** — remove the legacy `SORT_OPTIONS`.
- [ ] **Step 6: Check, tests, E2E sweep, gates, commit** (the russism scan; `i18n:extract ×2`; `typecheck`/`lint`/`test`; isolated E2E; `mutation:changed`; `check-mutation-suppressions.mjs`; `git add` by an explicit list + `sweep-specs.txt`).

Commit: `feat(web,i18n): stage 3e wave (e) part 1 — documents page + category hub to uk/en` + `ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)`.

---

## Task 2 (PR2): card/row/detail/status/image/list

**Files:**

| File                                              | Cyr. | Pattern(s) | Audit findings / note                                                                                                                                                                                                                         |
| ------------------------------------------------- | ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/documents/document-detail-dialog.tsx` | 31   | B,C,G,K,L  | by section (`wip:`); remove the local `CATEGORY_LABELS_RU`→hub; M-10 (raw MIME→human format), M-11 (project id→name), M-9 (S3/DB), dates `date-fns/ru`→`format.ts`                                                                            |
| `components/documents/document-card.tsx`          | 21   | B,C,G,K,L  | H-1 (recovery promise to the wrong one — from `DELETE_CONFIRM_MESSAGES`), H-2 («К транзакции #…» above a project id), H-5 («Инвойс #…»), M-9, M-15 (invoice pending signature), L-20 (`aria` unavailable with a reason), the concatenation `«Открыть документ «…»»` |
| `components/documents/document-row.tsx`           | 17   | B,C,G,L    | H-5, M-9, M-15, L-20 (one `aria` wording with a reason in both views), «Удалён»→status from the hub, dates                                                                                                                              |
| `components/documents/document-status-badge.tsx`  | 7    | G          | H-4 (`READY_TO_SIGN` from the hub, one canon), M-16 (`draft` «Драфт»→a word from `CONTEXT.md`), M-15                                                                                                                                         |
| `components/documents/document-image.tsx`         | 2    | C          | L-21 (`aria-label` on a `<div>` without a role → `role="img"`/`role="status"` or visible text); a cross-consumed component                                                                                                                  |
| `components/documents/document-list.tsx`          | 2    | —          | M-8: the empty state is unreachable (the parent passes `emptyState`) — **remove the dead text**, do not translate                                                                                                                           |

Tests: `documents/__tests__/{document-card,document-row,document-status-badge,document-image}.test.tsx` + the detail dialog. New cases (a status without a raw enum; the format from the MIME; the project name instead of the id) — inside the existing ones.

**Interfaces:** Consumes `CATEGORY_LABEL_MESSAGES`/`DOCUMENT_STATUS_MESSAGES`/`DELETE_CONFIRM_MESSAGES` (the PR1 hub), `format.ts`, `useLocale`, the catalog helpers. Removes the local `CATEGORY_LABELS_RU` from `document-detail-dialog`.

### Danger: `document-image` is cross-consumed

`DocumentImage` is used by `ProjectLogo`, `UserAvatar`, `image-upload-field`. The `aria-label` edit (L-21) is internal, do not change the signature. The E2E sweep must cover the project/profile specs.

### Acceptance criteria (PR2)

1. `document-detail-dialog` in `uk`/`en`: categories from the hub (the local map removed); the format human, raw MIME — in `title` (M-10); the project name, id — in `title` (M-11); «без можливості відновлення» (M-9); dates via `format.ts`, `date-fns/ru` removed.
2. `document-card` in `uk`/`en`: H-1 (who restores — from the hub), H-2 (the «К транзакции» chip removed/links to the transaction — see the trace), H-5 («Рахунок»), M-15 (one canon «очікує підпису»), L-20 (`aria` with a reason), the concatenation via a slot.
3. `document-row` in `uk`/`en`: H-5, M-9, M-15, L-20 (the same wording as in card), the status from the hub.
4. `document-status-badge`: `READY_TO_SIGN`/`SIGNED`/`draft` from the hub/`CONTEXT.md`, «Драфт»→a word (M-16), no raw enum.
5. `document-image`: the `aria-label` works (a role or visible text, L-21). `document-list`: the dead text removed (M-8).
6. In the PR2 files 0 lines of `[ыэъё]` outside comments; `git grep 'CATEGORY_LABELS_RU'` does not find `document-detail-dialog`.
7. Unit asserts the catalog; the E2E sweep; the PR2 E2E specs are green.
8. `i18n:extract ×2` empty; `en` 0 empty `msgstr`. `mutation:changed survived 0`; suppressions green.
9. Design tier 2, fidelity Mode B; screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (receipt/invoice masking, `canRestore`).

Steps: Step 0 measurement → Step 1 tests (fail) → Step 2 `document-detail-dialog` by section → Step 3 `document-card` (H-1/H-2/H-5) → Step 4 `document-row` → Step 5 `document-status-badge` (+ `draft` in `CONTEXT.md`) → Step 6 `document-image`/`document-list` → Step 7 check/gates/commit. Commit: `feat(web,i18n): stage 3e wave (e) part 2 — document card, row, detail, status to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)`.

---

## Task 3 (PR3): upload + PDF preview

**Files:**

| File                                              | Cyr. | Pattern(s) | Audit findings / note                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/documents/upload-document-dialog.tsx` | 25   | B,C,G,K    | remove the **last** local `CATEGORY_LABELS_RU`→hub; H-6 (`e.message` axios→`getApiErrorMessage`), H-5 («Инвойс»), the K-concatenation «Файл больше {max}. Ваш файл: {size}», «Загрузка...»→«Завантаження…» (L-19)                                          |
| `components/documents/pdf-preview.tsx`            | 8    | B,C,K      | M-7 (the «Открыть PDF» button on `<a download>`→«Завантажити PDF» or remove `download`), M-8 (the dead `<iframe>` fallback text — remove), M-12 (a PDF error without «Повторити»/«Завантажити»), the `title`/`aria` concatenation «Предпросмотр: {filename}»; cross-consumed |

Tests: `documents/__tests__/{upload-document-dialog,pdf-preview}.test.tsx`. New cases (parsing the upload error by status; «Завантажити» vs «Відкрити» by `download`) — inside the existing ones.

**Interfaces:** Consumes `CATEGORY_LABEL_MESSAGES` (the hub), `getApiErrorMessage` (`@/lib/axios-utils`), `format.ts`, the catalog helpers. Removes the last `CATEGORY_LABELS_RU`.

### Danger: `pdf-preview` is cross-consumed

`PdfPreview` is used by resume/vacancies/admin-contracts. The text is internal, do not change the signature; the E2E sweep covers `documents-pdf-preview.spec.ts` + the consumer specs.

### Acceptance criteria (PR3)

1. `upload-document-dialog` in `uk`/`en`: categories from the hub (the last local map removed — `git grep 'CATEGORY_LABELS_RU'` empty across all `apps/web`); H-6 (axios→`getApiErrorMessage`+the action «оберіть файл менше 20 МБ»); H-5; the size concatenation via a slot; «Завантаження…» (L-19).
2. `pdf-preview` in `uk`/`en`: M-7 (the text = the button behavior), M-8 (the dead `<iframe>` text removed), M-12 (an error+«Повторити»+«Завантажити»), the `title`/`aria` concatenations via a slot.
3. In the PR3 files 0 lines of `[ыэъё]` outside comments.
4. Unit asserts the catalog; the E2E sweep; the PR3 E2E specs are green.
5. `i18n:extract ×2` empty; `en` 0 empty. `mutation:changed survived 0`; suppressions green.
6. Design tier 2, fidelity Mode B; screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (file upload, size/type).

Steps: Step 0 measurement + `git grep CATEGORY_LABELS_RU` → Step 1 tests (fail) → Step 2 `upload-document-dialog` (axios/categories/concatenations) → Step 3 `pdf-preview` (M-7/M-8/M-12) → Step 4 check/gates/commit. Commit: `feat(web,i18n): stage 3e wave (e) part 3 — upload dialog + PDF preview to uk/en`, `ac_verified: 1,2,3,4,5 (6 — reviews after push)`.

---

## Task 4 (PR4): pending + the notifications tail + the final check

**Files:**

| File                                                | Cyr. | Pattern(s) | Audit findings / note                                                                                                                                                     |
| --------------------------------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes/_authenticated/pending/index.tsx`           | 13   | A,B,K      | `KIND_SECTIONS` titles («Проекты»/«Доли»/«Контракты») + `OTHER_SECTION_TITLE` («Другое») — now safe (testid by `kind`, stage 2); the empty-state ternaries                 |
| `components/pending/PendingItemRow.tsx`             | 12   | B,C,K,L    | M-14 (`viewerSharePercent==null` «Обновите»→what to do), four variants of the `metaLinesFor` phrase→`select` (K), percentages→ICU, `date-fns/ru`→`format.ts`, reconcile `fmtRelative` |
| `components/pending/SeniorShareApprovalActions.tsx` | 10   | B,C        | L-19 («Подтверждение…»/«Отклонение…» ASCII→the symbol), action captions, error fallbacks (`seniorShareErrorMessage`)                                                        |
| `components/pending/PendingKindSection.tsx`         | 0    | I          | no text; the testid is already by `kind` — **do not touch**, only update the test to the catalog if it asserts `title`                                                      |
| `hooks/use-notification-preferences.ts`             | 2    | C          | H-6 (`Не удалось сохранить настройку: ${err.message}`→`getApiErrorMessage`), «Сохранено»→«Збережено»                                                                      |
| `components/documents/document-labels.ts`           | —    | —          | remove the `@deprecated` remainders, if any after PR2/PR3; the final check                                                                                                 |

Tests: `pending/__tests__/{PendingItemRow,PendingKindSection,SeniorShareApprovalActions}.test.tsx`, `routes/_authenticated/pending/__tests__/{index,index.gate}.test.tsx`. New cases (the `select` share phrase on all branches; percentages 1/2/5) — inside the existing ones.

**Interfaces:** Consumes `DOCUMENT_STATUS_MESSAGES.READY_TO_SIGN` (the PR1 hub, for `CONTRACT_TO_SIGN`), `getApiErrorMessage`, `format.ts`, `useLocale`, the catalog helpers.

### Danger: `/pending` — shares/confirmations, critical-path

`PendingItemRow`/`SeniorShareApprovalActions` — shares, `approvalId`, `supersededAt` generations. The translation changes the **text**, not the confirmation/grouping logic (`sectionTitleOf`/`sectionKindOf`) nor whose share the viewer sees. The test — the grouping behavior and focus-after-action (spec §12) did not change. `security-reviewer` is **mandatory**.

### Acceptance criteria (PR4)

1. `pending/index.tsx` in `uk`/`en`: `KIND_SECTIONS` titles «Проєкти»/«Частки»/«Контракти», `OTHER_SECTION_TITLE` «Інше»; the empty-state ternaries via `select`/slots; the testid (`pending-kind-*`) unchanged (check that it is by `kind`, not `title`).
2. `PendingItemRow` in `uk`/`en`: M-14 («не підтверджуйте наосліп — запитайте адміна»); four variants of the phrase→`select`; percentages→ICU; the `CONTRACT_TO_SIGN` status from the hub (H-4); dates via `format.ts`, the `fmtRelative` duplicate reconciled.
3. `SeniorShareApprovalActions` in `uk`/`en`: the symbol `…` (L-19), error fallbacks with an action.
4. `use-notification-preferences.ts`: H-6 (`getApiErrorMessage`+a fallback text), «Збережено».
5. `PendingKindSection` test — assertions to the catalog/testid; the product file not changed by text.
6. In the PR4 files 0 lines of `[ыэъё]` outside comments; the hub cleared of `@deprecated`.
7. Unit asserts the catalog; the E2E sweep; the PR4 E2E specs are green.
8. `i18n:extract ×2` empty; `en` 0 empty. `mutation:changed survived 0`; suppressions green.
9. **The final wave (e) check** (script below) — `violations: 0`; `git grep 'CATEGORY_LABELS_RU|SORT_OPTIONS'` over `apps/web/app` — empty.
10. Design tier 2, fidelity Mode B; screenshots 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (shares, confirmations, focus-after-action).

The final wave (e) check — into the PR4 body:

```bash
python3 - <<'EOF'
import re, pathlib, subprocess
out = subprocess.run(['git','ls-files',
  'apps/web/app/routes/_authenticated/documents.tsx',
  'apps/web/app/components/documents',
  'apps/web/app/routes/_authenticated/pending',
  'apps/web/app/components/pending',
  'apps/web/app/hooks/use-notification-preferences.ts'], capture_output=True, text=True).stdout.split()
bad=0
for f in out:
    if re.search(r'__tests__|\.(spec|test)\.', f): continue
    for n,l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(),1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f,n,l.strip()); bad+=1
print('violations:', bad)
EOF
git grep -nP '\bCATEGORY_LABELS_RU\b|\bSORT_OPTIONS\b' -- apps/web/app   # expected: empty
```

Steps: Step 0 measurement → Step 1 tests (fail) → Step 2 `pending/index.tsx` → Step 3 `PendingItemRow` (`select`/ICU/M-14) → Step 4 `SeniorShareApprovalActions` → Step 5 `use-notification-preferences` → Step 6 `PendingKindSection` test + hub cleanup + the final check → Step 7 gates/commit. Commit: `feat(web,i18n): stage 3e wave (e) part 4 — pending screen + notification prefs to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)`.

---

## Trace of the `web-docs-notify` audit findings

The slice's `Findings:` — 21. Each identifier below.

| Finding        | Status on `025c28a0a`                                                       | Where it is closed                                                                            |
| -------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| COPY-H-docs-1  | open (recovery promise to the wrong one)                                    | PR1 (`DELETE_CONFIRM_MESSAGES` hub), PR2 (card/row/detail consume)                             |
| COPY-H-docs-2  | open («К транзакции #…» above a project id)                                 | PR2 (`document-card`: remove the chip / link to the transaction — see the decision in AC2)    |
| COPY-H-docs-3  | open (3 category maps, the CONTRACT word)                                   | PR1 (one `CATEGORY_LABEL_MESSAGES` + the choice in `CONTEXT.md`); the last copies removed PR2/PR3 |
| COPY-H-docs-4  | open (`READY_TO_SIGN` two words)                                            | PR1 (`DOCUMENT_STATUS_MESSAGES` canon), PR2 (`status-badge`), PR4 (`PendingItemRow`)           |
| COPY-H-docs-5  | open («Инвойс» instead of «Счёт»)                                           | PR1 (`documents.tsx`), PR2 (card/row/detail), PR3 (upload)                                     |
| COPY-H-docs-6  | open (English axios on a Russian screen)                                    | PR3 (`upload-document-dialog`), PR4 (`use-notification-preferences`)                           |
| COPY-M-docs-7  | open («Открыть PDF» on `<a download>`)                                      | PR3 (`pdf-preview`)                                                                            |
| COPY-M-docs-8  | open (dead `<iframe>`/`document-list` text)                                 | PR2 (`document-list`), PR3 (`pdf-preview`)                                                     |
| COPY-M-docs-9  | open («…из S3 и базы»)                                                      | PR2 (card/row/detail — `DELETE_CONFIRM_MESSAGES`)                                              |
| COPY-M-docs-10 | open (raw MIME)                                                             | PR2 (`document-detail-dialog`)                                                                 |
| COPY-M-docs-11 | open (project id instead of the name)                                       | PR2 (`document-detail-dialog`)                                                                 |
| COPY-M-docs-12 | open (a PDF error without retry/download)                                   | PR3 (`pdf-preview`)                                                                            |
| COPY-M-docs-13 | open («У вас нет доступа» dead end)                                         | PR1 (`documents.tsx` `documents-no-access`)                                                    |
| COPY-M-docs-14 | open («Доля неизвестна. Обновите»)                                         | PR4 (`PendingItemRow`)                                                                         |
| COPY-M-docs-15 | open (invoice pending signature 2 words)                                    | PR2 (card/row/status — one canon)                                                             |
| COPY-M-docs-16 | open («Драфт» transliteration)                                             | PR2 (`document-status-badge` + the word in `CONTEXT.md`)                                       |
| COPY-L-docs-17 | open («Поиск по имени…»)                                                   | PR1 (`documents.tsx` placeholder)                                                              |
| COPY-L-docs-18 | **behavior closed (stage 2/3a)**; the caption form — in `SORT_OPTION_MESSAGES` | PR1 (consume); `copy-reviewer` decides whether to name the alphabet in the existing canon      |
| COPY-L-docs-19 | open (ASCII dots vs the symbol `…`)                                         | PR3 (`upload`/`pdf-preview`), PR4 (`SeniorShareApprovalActions`)                               |
| COPY-L-docs-20 | open (`aria` unavailable, two degrees)                                      | PR2 (`document-card`/`document-row` — one wording)                                             |
| COPY-L-docs-21 | open (`aria-label` on a `<div>` without a role)                             | PR2 (`document-image`)                                                                         |

Findings: COPY-H-docs-1 … COPY-H-docs-6, COPY-M-docs-7 … COPY-M-docs-16, COPY-L-docs-17 … COPY-L-docs-21 (21) — 21 rows in the table.

Separately from the audit's "B. Dangers" section (not numbered COPY): **the testid from the localized title** and **`localeCompare('ru')`** — **closed in stage 2** (see "What is already closed before start"). Manual plural forms, concatenations, `Record`-at-module, dates with a fixed locale — distributed across templates J-docs/K-docs/L-docs/G-docs in the tasks above.

---

## Findings outside the perimeter (we do not expand, we record)

| What                                                                                                   | Whose wave / where to                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The `NOTIFICATION_TITLES` producers (Russian) into the `notifications.title` column — `apps/api` services | The `api` slice (backend). Not read on the screen (see "Contested decision 1"); a separate task       |
| `NotificationSettingsTab.tsx` `IMPERSONATION_EXPLANATION` = `` `${MSG}.` `` (punctuation outside the translation) | web-people / already migrated in stage 4; if the period-outside remained — a fix as a separate web-people line |
| `ContractTab`/`UserDialog` empty-state branching by the English error prose                            | The web-people slice (profile/contracts), not docs-notify. Check in its wave                          |
| `lib/format-amount.ts` (`formatAmount` `ru-RU`) — the amount-formatting root                           | Cross-slice web-core/web-finance (wave d Contested decision 3). Documents do not format amounts       |

---

## What is NOT included

- **`apps/api`** — the `apps/web` wave does not touch it. The Russian text the producers write to `notifications.title`/`body` is a migration of the `api` slice.
- **The already migrated** (the notifications registry, the bell, `NotificationSettingsTab`, the testid decoupling, `localeCompare`, `SORT_OPTION_MESSAGES`) — consume/verify, do not redo.
- **Stage 6**: ESLint `lingui/no-unlocalized-strings` in error mode, the guard for Russian letters, `extract --clean` as a hard gate.
- Texts with an explicit id (`api-error.*`, `zod-error.*`, `notification.*`) the wave does not change, only uses.
- Names/brands/extensions (`PDF`, `JPEG`, `S3`/`R2` in `title`) — not translated.
- E2E fixtures with Russian file names (`резюме-тест.pdf`) — data, not UI.

---

## Contested decision 1 — notification title data-in-DB: translation NOT required

**Checked on `025c28a0a` by reading `notification-registry.ts` + `notifications-bell.tsx`.**

The assignment poses the risk "three notification types take the title from the DB" by analogy with `EXPENSE_CATEGORIES` in wave d. The analysis shows that **there is no analogy and no blind data translation will happen**, because the display path and the storage path are separated by design (spec §7.1, implemented in stage 4):

- **Display** (`renderNotification(n, i18n)` in the bell): for any of the 13 known types whose `data` passes Zod, the title is taken from **`NOTIFICATION_TITLE_MESSAGES`** (fully `uk`/`en`, #714), the detail — from `describeNotification`. The columns `n.title`/`n.body` are **not read** here.
- **Storage**: the producers (`approvals/employee-contracts/transactions/projects/teams/users.service.ts` in `apps/api`) write neutral text to `notifications.title` (the legacy `NOTIFICATION_TITLES` — Russian for the 10 original types; **Ukrainian** for the three "frozen" ones — invoices/vacancies). This text is **read only in the fallback** of `renderNotification` for an **unknown/legacy type before the registry** or when the `data` does not parse.

Hence:

1. **The web wave translates nothing in the data** — the titles on the screen are already migrated (the registry), the three "frozen" types already store Ukrainian.
2. **Russian in `notifications.title` for the 10 original types** — this is backend text of the `api` slice, reaching the screen only as a fallback for broken/legacy strings; its fate is a separate task of the `api` slice, not this wave.
3. **A prod query to the data is not needed** (unlike EXPENSE): the values are known from the code (`NOTIFICATION_TITLES`), the display path does not use them.

**Recommendation:** translate nothing in the data in this wave; record in the PR4 body the fact "notification title data-at-rest — display via the registry (done #714), storage — the `api` slice". **There is NO owner question on prod title data** (see "Questions for the owner"). The only optional follow-up (low priority): a backfill of the old legacy `notifications.title` strings during the `api`-slice migration — but the fallback honestly shows the stored value anyway, the value is low.

## Contested decision 2 — the words for `CONTRACT` and the status `draft` (a glossary gap)

`CONTEXT.md` gives no single word either for the category `CONTRACT` (COPY-H-docs-3: three maps give «Договоры»/«Договор»/«Контракт»), or for the contract status `draft` (COPY-M-docs-16: «Драфт» — transliteration; «Черновик» is forbidden only for a **project** status).

**Recommendation (A1, reversible, fixed in `CONTEXT.md` PR1/PR2, finally — `copy-reviewer`):**

- `CONTRACT` → `uk` «Договір» / `en` «Contract» (matches the domain «договір» in `employeeContracts`; leave «контракт» as a colloquial synonym in the reference, but in the UI — one word).
- `draft` (contract) → `uk` «Чернетка» / `en` «Draft» («Чернетка» ≠ the project-forbidden «Черновик»; this is a contract status, where there is no ban).

Both forms are a draft; `copy-reviewer` may choose otherwise, then the canon line and the `.po` are edited. This is **not** an owner question — domain terminology is in the `copy-reviewer` zone.

## Contested decision 3 — the `document-card` chip «К транзакции #…» (COPY-H-docs-2)

The branch `isReceipt && doc.projectId` prints `doc.projectId` (the **project** id) under the caption «К транзакции», links to the general `/finance`, and is almost dead (`ReceiptInput` loads a receipt without `projectId`).

**Recommendation (A1):** remove the number and link to "Фінанси" without a false binding — the chip «Чек із Фінансів» without a number (minimal truth), since the receipt↔transaction link is absent in the data. Linking to a specific transaction is impossible without its id, which is not in the `doc`. Record in the PR2 body; if the owner/`spec-reviewer` wants a real binding — a separate task (data + API), outside the i18n wave.

---

## Assumptions (A1 — reversible, recorded)

1. **Perimeter = the `web-docs-notify` audit slice minus the already migrated** (the notifications registry, the bell, `NotificationSettingsTab`, the testid decoupling, `localeCompare`, `SORT_OPTION_MESSAGES`). The cross-consumed `pdf-preview`/`document-image` are included (native in `components/documents`). Excluded: `apps/api`, `format-amount.ts` (cross-slice). Each deviation — a line in the "Perimeter" table.
2. **4 PRs, sequential merge.** ~186 lines / 14 files. **Alternative:** combine PR2+PR3 into one (3 PRs) — the perimeters do not overlap; the choice is up to the orchestrator if the review is light.
3. **The hub `document-labels.ts` is introduced by PR1, the local `CATEGORY_LABELS_RU` live until their PR** (detail — PR2, upload — PR3), as `TYPE_LABELS` @deprecated PR1→PR4 in wave d. `git grep 'CATEGORY_LABELS_RU'` empty only after PR3.
4. **`security-reviewer` is mandatory on PR4** (shares/confirmations — critical-path); PR1/PR2/PR3 carry a line for `security-reviewer` (RBAC/masking/upload — we change the text, not the logic).
5. **The words `CONTRACT`/`draft`** — the recommendation of "Contested decision 2", finally approved by `copy-reviewer`; a divergence from the draft is not a plan violation.
6. **The «К транзакции» chip** — the recommendation of "Contested decision 3" (remove the number); a real binding — a separate task outside i18n.
7. **The `uk`/`en` drafts in the canon** — a guide; the final text — `copy-reviewer` ("two originals").

## Questions for the owner (A2/A3 — irreversible/expensive)

**There is NO question on prod notification title data** (unlike EXPENSE in wave d). The "Contested decision 1" analysis showed: the display path renders from the migrated registry, the `title`/`body` columns — only a fallback for legacy types, the values are known from the code, a prod query is not needed. There will be no blind data translation.

The other forks (`CONTRACT`/`draft` words, the «К транзакции» chip) — A1, resolved by `copy-reviewer`/`spec-reviewer` within the PR, do not block the owner.

---

## Wave (e) readiness check

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — green after each PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test -- <the specs from the "Distribution" + the sweep>` — an isolated run green; CI on all shards green (the arbiter — CI, not the locale).
- `pnpm i18n:extract` twice in a row — the second run does not change `.po`; in `en` 0 empty `msgstr`.
- `pnpm mutation:changed` — `survived 0`; a `NoCoverage` without an integration-hint closed by a unit test; `node scripts/devops/check-mutation-suppressions.mjs` — green.
- PR4 final check: 0 lines of `[ыэъё]` outside comments in the perimeter; `git grep 'CATEGORY_LABELS_RU|SORT_OPTIONS'` over `apps/web/app` — empty.
- In `CONTEXT.md` there is a subsection "Wave e — `web-docs-notify`" (including `CONTRACT`/`draft`).
- `copy-reviewer`: `PASS` on `uk` and on `en` for each of the 4 PRs.
- `security-reviewer`: `APPROVE` for PR4 (shares/confirmations) and a confirmation line for PR1–PR3 (RBAC/masking/upload unchanged).
- Screenshots 320/1440 × `uk`/`en` for each migrated screen — in each PR's body; fidelity Mode B — all widths (risk — the 320px popup, the dense card grid).
- Trace: 21 `web-docs-notify` audit identifiers — each with a line in the body of the PR that closes it (`review-findings-transfer.md`); COPY-L-docs-18 marked as "behavior closed in stage 2/3a".
