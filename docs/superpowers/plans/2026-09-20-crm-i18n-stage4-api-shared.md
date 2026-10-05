# CRM i18n — stage 4 "API and shared" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the server-side and shared (server+client) CRM text to the same scheme that already works for the eight codes of `api-errors.ts`: `apps/api` exceptions return `code` + `params` instead of Russian/English prose, `packages/shared` Zod messages become codes of the same kind instead of literals, notification titles/bodies on display and the ten emails render by type through the `uk`/`en` catalog in the recipient's locale. Not one of the ~337 current throw-sites with Cyrillic and not one of the 96 Zod messages remains a literal by the end of the stage — they are either in the code registry or explicitly moved out of scope (see "What is NOT included").

**Architecture:** The mechanism is already chosen and works in `origin/main` for the eight codes — this plan **extends** it, does not reinvent it. `apps/api` and `packages/shared` are CommonJS, without babel; strings there live as `MessageDescriptor` objects (`{ id: 'namespace.CODE', message: '<in Ukrainian>' }`, marked `/* i18n */`) in `Record` registries, not as the macros `t`/`msg`. Each registry is read by BOTH sides (`apps/api` to render the email/response in the recipient's/request's locale via `createI18n(locale)`, `apps/web` — via the shared `i18n` singleton of `@lingui/react`). API errors continue to travel as the envelope `{ statusCode, code, params?, message }`; Zod messages travel the same way — `message` in the schema stops being translatable text and becomes a stable code resolved by the new `ZOD_ERROR_MESSAGES` registry on both sides. Notifications and emails continue NOT to store text in the DB — they are rendered by `type` + `data` at the moment of display/send, in the locale of the reader (the popup/`/pending`) or the recipient (the email, `users.locale`, the cron).

**Tech Stack:** Lingui **5.9.5 EXACT** (`@lingui/core`; `@lingui/core/macro` is NOT available in `apps/api`/`packages/shared` — the proof below), NestJS 11 + Fastify, Drizzle, Zod 4, Vitest 4, pnpm 7.32.4, Node 22 LTS.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.3–4.4, §7 item 4, §8. Audit: `docs/architecture/2026-09-19-crm-i18n-audit.md` (the `api`, `shared` slices). Neighboring plans of the same family (the format, already-verified decisions — do not reopen): `2026-09-19-crm-i18n-stage2-foundation.md` (the `createI18n` mechanism, `api-errors.ts`, `request-locale.ts` — already in `main`), `2026-09-20-crm-i18n-stage3a-web-core.md` (the "Test access to the catalog" section, `ROLE_LABEL_MESSAGES`/`useRoleLabel` — a transitional shim).

## Spike: are the Lingui babel macros expanded in `nest build`?

**The question from the assignment:** can `t`/`msg` from `@lingui/core/macro` be used in `apps/api`, given that `nest build` = `tsc`, and the macros are expanded only by a babel/swc plugin.

**The method — only reading configs, without edits in the repository:**

```bash
cat apps/api/nest-cli.json        # compilerOptions.tsConfigPath → tsconfig.build.json, builder not specified → default tsc
cat apps/api/tsconfig.json        # module: CommonJS, no babel preprocessor
grep '"build"\|"test"' apps/api/package.json   # "build": "nest build && ...", "test": "vitest run"
grep -iE '"@babel|babel-plugin|lingui' apps/api/package.json packages/shared/package.json
```

**Result (all four commands run on `origin/main`):**

- `nest-cli.json`: `compilerOptions.tsConfigPath = "tsconfig.build.json"`, the `builder` field is absent → the Nest CLI uses the **default TypeScript compiler** (`tsc`), not `webpack`/`swc` (the only Nest CLI builders that can run babel/swc plugins).
- `apps/api/tsconfig.json`: `"module": "CommonJS"`, `"moduleResolution": "Node"` — plain `tsc`, no preprocessor.
- `apps/api/package.json` scripts: `"build": "nest build && node scripts/check-di-metadata.cjs"`, `"test": "vitest run"` — both paths (the build and the tests) go past babel.
- `grep -iE '"@babel|babel-plugin|lingui'` on **both** `package.json` (`apps/api`, `packages/shared`) returns **exactly one line** in each: `"@lingui/core": "5.9.5"`. Neither `@babel/core`, nor `@lingui/babel-plugin-lingui-macro`, nor `@lingui/vite-plugin` is among the dependencies.

**Conclusion: the `t`/`msg` macros from `@lingui/core/macro` are not available in `apps/api` and `packages/shared`** — importing the virtual macro package without a babel transform resolves neither at runtime (`ts-node`/`vitest`) nor at `tsc` build. This is also confirmed by already-merged code: `packages/shared/src/schemas/api-errors.ts` uses not a macro but an **explicit object** `MessageDescriptor` with the id `api-error.<CODE>`, marked with a comment `/* i18n */` (the same convention that `lingui extract`'s babel-plugin understands even without a transform — it scans the literal by the comment, instead of expanding a call). Verified through context7 too (`/lingui/js-lingui/v5.9.5`, `i18n._(messageId, values?, options?)` and `i18n._({id, message, values})` — both forms are documented as the standard non-macro API, `defineMessage`/`msg` are described separately as the thing that "is expanded by the compiler").

**Decision, fixed in Global Constraints:** all new `apps/api`/`packages/shared` text of this stage — `MessageDescriptor` objects (`{ id, message }` with `/* i18n */`) in `Record` registries, the call — `i18n._(id, values, { message })` (the form from `axios-utils.ts`'s `translateApiError`, not `i18n._(<object>)` — that form fails on the extractor on a `SpreadElement`, see the comment in the file). The `i18n` instance — **only** via `createI18n(locale)` (`packages/shared/src/i18n/catalog.ts`, already in `main`), never a global `activate` on the server.

## Global Constraints

- **The api/shared string mechanism — `MessageDescriptor` + explicit id, NOT macros** (the spike above). The id format: `<namespace>.<CODE>` (namespace = `api-error`, `zod-error`, `notification`, `email`). Each registry — a `Record<Code, MessageDescriptor>`, marked `/* i18n */` on each record, lives in `packages/shared/src/schemas/*.ts` (read by both sides) or `apps/api/src/**` (server only — emails).
- **Lingui 5.9.5 EXACT**, the languages `uk` (source/default) `en`. The source text in the registries — **Ukrainian** (not Russian: spec §1 decision 1 — Russian is removed from the product entirely, new text is written in uk+en right away).
- **`params` — never PII**, compiled into the type via the `ParamsFor<C>` pattern (`api-errors.ts` — extend THE SAME schema, do not start a second one). The parameter value — either a primitive without user data (a role enum, a status enum, a number), or absent; a human name, email, amount — never a parameter of an HTTP error.
- **`i18n` — per-request/per-recipient, never a global singleton on the server** (`createI18n(locale)` from `@crm/shared`; the error's locale — `resolveRequestLocale`/`@RequestLocale()` of the request; the email's/notification's locale — the `users.locale` of the **recipient**, not of the sender and not of the cron).
- **Test access to the catalog in the `apps/api` Vitest** (no React, no `activateLocale`):
  ```ts
  import { createI18n } from '@crm/shared'
  const i18n = createI18n('uk')
  i18n._(SOME_DESCRIPTOR.id, params, { message: SOME_DESCRIPTOR.message })
  ```
  **A gotcha, confirmed by commands:** `turbo.json`'s `test` task carries `"dependsOn": ["//#i18n:compile", "^build"]`, but `apps/api/package.json`'s `"test": "vitest run"` — the shortcut documented in `CLAUDE.md`, `pnpm --filter @crm/api test` calls this script **directly**, bypassing turbo's dependency graph. If `packages/shared/src/i18n/locales/*/messages.ts` is stale or absent — a registry test will fail `MODULE_NOT_FOUND` regardless of what the catalog does. Before `pnpm --filter @crm/api test` (or `@crm/shared test`) in this stage — **always** `pnpm i18n:compile` as the first command, or `pnpm turbo run test --filter=@crm/api` instead of the shortcut.
- **Zod messages — a code, not a translation, in the schema itself** (spec §4.3, the decision is already made, do not reconsider): `message: 'zod.<CODE>'` in the schema — a stable key string, not on-screen text. The new registry `ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor>` (the same shape as `API_ERROR_MESSAGES`) resolves it into text on both sides: `ZodExceptionFilter` (the server, the 400 response) and `translateZodError` in `axios-utils.ts` (the client) — **both are part of Task 4, the first PR of track B, not a separate "later" task**: the stage rule — no PR leaves the user without text, and `ZodExceptionFilter`'s Step 6 changes the envelope format for migrated fields in the same PR, so the client render by code is obliged to be in it too (SPEC-H-1, fix-round 1).
- **The glossary (`CONTEXT.md`, `_Избегать_`) — is fixed ALONG WITH moving the code, not in a separate pass:** "инвойс" → "рахунок"/"invoice" **only** as an object name, not a term (the glossary: "Счёт", `_Избегать_`: инвойс/акт/платёжка); "платёж" for `transactions` → "транзакція"/"transaction" (`_Избегать_`: платёж, проводка); "IOU"/"obligation" in the ledger → "зобов'язання"/"obligation" per the glossary ("Обязательство", `_Избегать_`: долг, IOU). Translating a defect to a "third" language does not fix it — move the text into the registry strictly in the corrected wording already (audit §696 item 3: "before the translation, so as not to translate the defect").
- **The real volume (verified by commands on `origin/main` today, not by the 2026-09-19 audit — see the discrepancy with the spec estimate below)**, see the "Volume" table in each Track.
- Tests: unit `apps/api`/`packages/shared` with `createI18n`; integration — where the throw comes from a branch with a DB/RLS (the mutation gate does not see them — a unit duplicate is mandatory, `mutation-gate-integration-specs.md`).
- `git add` by an explicit list; `DATABASE_URL= git push`; without `--no-verify`; commits with `ac_verified: <N>`.
- `security-reviewer` is mandatory on PRs touching `finance/`, `auth/`, `users/` (critical-path, `pm.md`), even when the diff is only replacing text with a code (params — a new surface, requires a leak check).
- `copy-reviewer` — a verdict on `uk` **and** `en` separately on each PR touching the catalog.
- The zone: `apps/api/**`, `packages/shared/**` — Coder. The test files (`*.spec.ts`) — also Coder (editing assertions inside an already-migrating module, not a new E2E spec — `zone-of-write.md`, the footnote about AutoTest).

## Discrepancy with the spec estimate (289) — recorded, not silently fixed

Spec §7 item 4 and `api-errors.ts`'s comment cite "289 remaining exceptions" — a figure from the audit summary (§3: "289 Russian + 214 English"). A direct check **today** on `origin/main`:

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src | grep -v '\.spec\.ts' \
  | grep -P "[А-Яа-яЁё]" | wc -l                                    # single-line: 266
git grep -n -A1 "Exception($" origin/main -- apps/api/src | grep -v '\.spec\.ts' \
  | grep -P "[А-Яа-яЁё]" | wc -l                                    # multi-line: 71
```

In total **337** throw-sites with a Cyrillic message today (266+71), not 289. The discrepancy — not a regression: the detailed table of the same audit (`docs/architecture/…audit.md`, the `api` slice, the row "with a Cyrillic message") already named **339** (266+73); it just was not carried into the §3 summary. The difference 339→337 is explained by the seven files that partially migrated to `apiError()` over the past week (`employee-contracts.service.ts`, `signed-contracts.service.ts`, `invoices.service.ts`, `notifications.controller.ts`, `projects.service.ts`, `tos.service.ts`, `users.service.ts` — 10 `apiError(` calls total, eight registered codes). **In this plan — 337, the number from the detailed audit table, not 289 from its summary.** The discrepancy — not a review finding, if the disclosure in the PR body and here is one: 289 was never a measurement, it was a sum rewritten from another section of the same document.

---

## File map

| File                                                                                                                                                                                                 | Responsibility                                                                                                                                              | Task |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/shared/src/schemas/api-errors/{base,index}.ts`                                                                                                                                             | The barrel + today's 8 codes — created by Task 1, not touched by any other task of the track                                                                | 1    |
| `packages/shared/src/schemas/api-errors/auth-users-projects.ts`                                                                                                                                      | The codes of wave A1 (SPEC-M-1: its own file per task, not a shared `api-errors.ts` — see "Parallelism discipline")                                         | 1    |
| `packages/shared/src/schemas/api-errors/finance-invoices.ts`                                                                                                                                         | The codes of wave A2 (created by Task 1 as an empty stub, filled by Task 2)                                                                                 | 1,2  |
| `packages/shared/src/schemas/api-errors/documents-contracts-notifications.ts`                                                                                                                        | The codes of wave A3 (created by Task 1 as an empty stub, filled by Task 3)                                                                                 | 1,3  |
| `apps/api/src/{auth,users,projects}/**`                                                                                                                                                              | The throw-sites of the wave A1 modules → `apiError()`                                                                                                       | 1    |
| `apps/api/src/{finance,invoices}/**`                                                                                                                                                                 | The throw-sites of wave A2 (the largest concentration)                                                                                                      | 2    |
| `apps/api/src/{documents,contracts,teams,legends,approvals,interviews,notifications}/**`                                                                                                             | The throw-sites of wave A3                                                                                                                                  | 3    |
| `packages/shared/src/schemas/zod-errors.ts` (new)                                                                                                                                                    | `ZodErrorCode`, `ZOD_ERROR_MESSAGES: Record<Code, MessageDescriptor>`                                                                                       | 4    |
| `apps/api/src/zod-exception.filter.ts`                                                                                                                                                               | Issues return `code` instead of a bare `message`                                                                                                            | 4    |
| `packages/shared/src/schemas/{money,finance,users,payment-requisites}.ts`                                                                                                                            | The Zod messages of wave B1 (the duplicates, the most numerous)                                                                                             | 4    |
| `packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts` | The Zod messages of wave B2                                                                                                                                 | 5    |
| `packages/shared/src/schemas/notification-registry.ts`                                                                                                                                               | `NOTIFICATION_TITLES`/`ACTION_LABELS`/`SUBJECT_*_LABELS` → `MessageDescriptor`, `describeNotification`/`subjectPhrase` on `i18n`, `money()` → `formatMoney` | 6    |
| `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/vacancies/applications.service.ts`                                                                                                        | Registering the 3 "frozen" types in the registry (COPY-H-shared-5)                                                                                          | 6    |
| `apps/api/src/notifications/notification-email-copy.ts`                                                                                                                                              | 10 emails → `MessageDescriptor`/`select`/`plural`, `i18n._()` in the recipient's locale                                                                     | 7    |
| `apps/api/src/notifications/notification-email-copy.spec.ts`                                                                                                                                         | A snapshot of the subject+body on `uk` and `en`, instead of Russian substrings                                                                              | 7    |
| `apps/api/src/notifications/notification-email.cron.ts`                                                                                                                                              | Activating the recipient's locale before the render                                                                                                         | 7    |
| `apps/api/src/users/personal-email-invite-mailer.service.ts`                                                                                                                                         | The invitation — the locale is decided (the A2 question below)                                                                                              | 7    |

Order: (**1 first** — creates the barrel + the stubs for 2/3, see "Parallelism discipline"; **2 ∥ 3** — after the merge of 1, in parallel with each other, different files, without mutual dependency) → 4 → (5 — on its own, depends on the Task 4 registry) → 6 → 7.
Stage 5 (invoice PDFs) starts after Task 6/7 — the shared catalog and the activation of the recipient's locale must exist (spec §7: "5 — after 4").

---

## Track A — error codes by module (289/337 throw-sites)

### Parallelism discipline: `api-errors.ts` — a barrel, not a shared file (SPEC-M-1)

The three tasks of this track were declared "in parallel, a wave of ≤3 PRs" (the File map above) — which `orchestration-routing.md` Decision 1 allows ONLY for non-overlapping files AND without an explicit sequential dependency between the tasks (both conditions — "AND", not "or"). Today's `api-errors.ts` — one file, into which all three PRs would write at once: this violates the first condition of the wave, not just raises the risk of a merge conflict. For the structurally same risk in Track B (Task 4/5 extend one `zod-errors.ts` Record) the plan already applies an explicit ordering ("Task 4 first, Task 5 rebases onto it") — here the structural solution (a split by files) applies, but **not without a remainder**: the three MODULE files (Task 1/2/3) do not depend on each other, however all three depend on a ONE-TIME bootstrap — the barrel + the stubs for the Task 2/3 files — which must exist before these two files type anything. The honest result, not "all three in parallel": **Task 1 — first** (the bootstrap + its own codes, single-pipeline), **Task 2 ∥ Task 3 — after the merge of Task 1**, truly parallel with each other (disjoint files, no dependency between them). This is less overlap than in the original plan (was: 3 PRs fighting over one file) and more honest than declared (does not hide the single real dependency that the assignment requires to be made explicit: "the files do not overlap AND the dependencies are explicit").

- `packages/shared/src/schemas/api-errors/base.ts` — the eight CURRENT codes (`GENERIC`, `CONTRACT_TEMPLATE_MISSING`, five `*_IMPERSONATION`) are moved as is (`BASE_ERROR_CODES`/`BASE_ERROR_PARAMS`/`BASE_ERROR_MESSAGES`/`BASE_ERROR_FALLBACK_EN`). No Track A task touches them — frozen until a separate task, if needed.
- `packages/shared/src/schemas/api-errors/auth-users-projects.ts` (owned by Task 1), `finance-invoices.ts` (owned by Task 2), `documents-contracts-notifications.ts` (owned by Task 3) — each carries its own `<MODULE>_ERROR_CODES`/`<MODULE>_ERROR_PARAMS`/`<MODULE>_ERROR_MESSAGES`/`<MODULE>_ERROR_FALLBACK_EN` (the same shape as today's `API_ERROR_*`, with the module prefix). **Task 1 creates all three files in this PR** — its own with real content, two others (`finance-invoices.ts`, `documents-contracts-notifications.ts`) — as empty stubs (`export const FINANCE_INVOICES_ERROR_CODES = [] as const`, `export const FINANCE_INVOICES_ERROR_PARAMS = {} as const satisfies Record<never, readonly string[]>`, etc. for the two remaining records), otherwise the barrel (the next item) does not type until Task 2/3 start. Task 2/3 fill THEIR already-existing file — do not touch the barrel.
- `packages/shared/src/schemas/api-errors.ts` — becomes a barrel: imports the four modules, merges via spread — `API_ERROR_CODES = [...BASE_ERROR_CODES, ...AUTH_USERS_PROJECTS_ERROR_CODES, ...FINANCE_INVOICES_ERROR_CODES, ...DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES] as const`, likewise for `API_ERROR_PARAMS`/`API_ERROR_MESSAGES`/`API_ERROR_FALLBACK_EN` (the three others — the same spread trick). `ParamsFor<C>`/`apiErrorEnvelopeSchema`/`ApiErrorCode` — UNCHANGED, read the merged `API_ERROR_CODES`/`API_ERROR_PARAMS` indirectly, as before. **Task 1 creates the barrel in the same PR** — together with the three module files (the empty Task 2/3 stubs are typecheck-compatible with the barrel right away, so Task 1 does not block Task 2/3 even if it starts first).
- `export * from './api-errors'` in `packages/shared/src/schemas/index.ts` — UNCHANGED: it resolves to the directory `api-errors/index.ts` the same way it used to resolve to the file `api-errors.ts` (Node/TS module resolution). The only external consumer — this `export *`; there are no other direct imports `from '.../api-errors'` outside the package (`git grep -rn "from '.*api-errors'" origin/main -- apps packages` — the only match is `schemas/index.ts` itself). `packages/shared/src/schemas/api-errors/index.ts` — a new file, the barrel body (moved from today's `api-errors.ts`, extended with the spread imports of the four modules).

**What this gives:** Task 2 and Task 3 write ONLY their module file — zero path overlap with each other, and between themselves they go truly in parallel (Decision 1 `orchestration-routing.md` — 2 disjoint tasks without mutual dependency, a legitimate small wave). The only dependency — "2 and 3 wait for the merge of 1" — is explicit, recorded here and in the Order below, not hidden under the label "in parallel". The existing consumers (`API_ERROR_MESSAGES.CONTRACT_NOT_DRAFT`, `api-errors.spec.ts`'s invariant tests) do not change — the barrel returns the same merged names.

### Task 1: Error codes — `auth`/`users`/`projects`

**Files:**

- Create: `packages/shared/src/schemas/api-errors/base.ts` (today's eight codes, moved without changes), `packages/shared/src/schemas/api-errors/auth-users-projects.ts` (this wave's codes), `packages/shared/src/schemas/api-errors/finance-invoices.ts` (an empty stub for Task 2), `packages/shared/src/schemas/api-errors/documents-contracts-notifications.ts` (an empty stub for Task 3), `packages/shared/src/schemas/api-errors/index.ts` (the barrel — a spread of the four modules, `ParamsFor`/`apiErrorEnvelopeSchema` moved here without changes)
- Delete: `packages/shared/src/schemas/api-errors.ts` (replaced by the directory `api-errors/`)
- Modify: `apps/api/src/auth/*.service.ts` (6 throw-sites with Cyrillic), `apps/api/src/users/users.service.ts` (54 Cyrillic + 26 English — **the largest file of the wave**, split into sub-PRs by sub-feature if needed: the team decides by the actual diff size), `apps/api/src/projects/projects.service.ts` (12 Cyrillic + 28 English; **already partially migrated** — 2 `apiError()` calls, do not rewrite)
- Test: `apps/api/src/{auth,users,projects}/*.spec.ts` — pointwise on the changed throw-sites; `packages/shared/src/schemas/api-errors.spec.ts` — the new codes in the existing invariant tests ("every code has a message descriptor", "the EN fallback matches en/messages.po")

**Interfaces:**

- Consumes: `apiError<C>(code, status, ...params)` from `apps/api/src/common/api-error.ts` (not changed by this task — the signature is already generic over `ParamsFor<C>`), `createI18n(locale)` from `@crm/shared`
- Produces: an extended `API_ERROR_CODES` — this wave's codes are visible to Task 6/7 (they do not overlap by name) and `apps/web`'s `getApiErrorMessage`/`translateApiError` (not touched by this task — they already read the whole registry by construction, nothing to add on the client)

- [ ] **Step 1: Fix the pattern — one throw-site fully, test first**

A working example — `employee-contracts.service.ts:163/202` (`markReady`), both still raw `ConflictException` with English text (COPY-H-api-2), the file is already partially migrated — 2 `apiError()` calls (lines 100/314), **both on the same code** `CONTRACT_TEMPLATE_MISSING` (not two different codes — SPEC-L-1), do not touch them.

```ts
// packages/shared/src/schemas/api-errors/auth-users-projects.ts — add to
// AUTH_USERS_PROJECTS_ERROR_CODES:
'CONTRACT_NOT_DRAFT',
// AUTH_USERS_PROJECTS_ERROR_PARAMS:
CONTRACT_NOT_DRAFT: [],
// AUTH_USERS_PROJECTS_ERROR_MESSAGES:
CONTRACT_NOT_DRAFT: /* i18n */ {
  id: 'api-error.CONTRACT_NOT_DRAFT',
  message: 'Контракт більше не в статусі чернетки — оновіть сторінку',
},
// AUTH_USERS_PROJECTS_ERROR_FALLBACK_EN:
CONTRACT_NOT_DRAFT: 'This contract is no longer a draft — refresh the page',
```

The barrel (`api-errors/index.ts`) is not touched by this step — it already spreads `AUTH_USERS_PROJECTS_ERROR_CODES`/`..._PARAMS`/`..._MESSAGES`/`..._FALLBACK_EN` wholesale (Task 1 created the barrel and the spread imports in the same PR, see "Parallelism discipline" above); the test below reads the merged `API_ERROR_MESSAGES`/`API_ERROR_FALLBACK_EN` from the barrel, without changes to its body.

```ts
// packages/shared/src/schemas/api-errors.spec.ts — a new case (fails first)
it('CONTRACT_NOT_DRAFT has a message descriptor and an EN fallback', () => {
  expect(API_ERROR_MESSAGES.CONTRACT_NOT_DRAFT.message).toBeTruthy()
  expect(API_ERROR_FALLBACK_EN.CONTRACT_NOT_DRAFT).toBeTruthy()
})
```

- [ ] **Step 2: Make sure the test fails**

Run: `pnpm i18n:compile && pnpm --filter @crm/shared test -- src/schemas/api-errors.spec.ts`
Expected: FAIL — `CONTRACT_NOT_DRAFT` does not exist in `API_ERROR_CODES`.

- [ ] **Step 3: Add the code (the block above), run the test**

Run: the same command → PASS.

- [ ] **Step 4: Replace both throw-sites in `employee-contracts.service.ts`**

```ts
// was (line 162-164):
throw new ConflictException(`Cannot mark ready: contract is ${contract.status}, expected DRAFT`)
// became:
throw apiError('CONTRACT_NOT_DRAFT', HttpStatus.CONFLICT)

// was (line 201-203):
throw new ConflictException('Cannot mark ready: contract is no longer DRAFT (concurrent update)')
// became — the same code: both branches tell the user THE SAME THING ("the contract is no longer
// a draft"), the difference in "why" (a race vs an ordinary repeat call) — a detail for the
// developer, not for the user, stays in a code comment, does not travel in the response:
throw apiError('CONTRACT_NOT_DRAFT', HttpStatus.CONFLICT)
```

Add the import of `apiError` and `HttpStatus` from `@nestjs/common`, if not already imported in the file (the file already imports `apiError` for the two `CONTRACT_TEMPLATE_MISSING` calls — check before adding).

- [ ] **Step 5: A service test (fails → passes)**

```ts
// employee-contracts.service.spec.ts — extend the existing 409 case
it('markReady rejects a non-DRAFT contract with CONTRACT_NOT_DRAFT', async () => {
  await expect(service.markReady(userId, viewer)).rejects.toMatchObject({
    response: { code: 'CONTRACT_NOT_DRAFT' },
  })
})
```

Run: `pnpm --filter @crm/api test -- src/contracts/employee-contracts.service.spec.ts` → PASS.

- [ ] **Step 6: Apply the same pattern to the rest of the wave's throw-sites**

The exact list — by command before starting the work (the numbers above were taken today, may shift by 1-2 if something merged between this plan and the task start — recount, do not trust the table):

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/auth apps/api/src/users apps/api/src/projects \
  | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/auth apps/api/src/users apps/api/src/projects \
  | grep -v '\.spec\.ts' | grep -vP "[А-Яа-яЁё]" | grep -E "\(('|\`)[A-Za-z]"
```

Each message → one code (or an existing one is reused, if the text semantically matches — merge duplicates BEFORE registering a new code, do not start two codes for one meaning, audit §696 item 5). The rule for "message = a raw enum" (COPY-H-api-3, does not occur here — it is the `contracts` wave, Task 3) and "the RBAC matrix in the text" (COPY-H-api-6, `finance/balance.service.ts` — Task 2) do not apply here.

**A separate fix-finding of this wave (do not defer to Task 3 — the file is of its own wave):** `users.service.ts` contains the role in the text of several messages as a raw enum — the same 4 throw-sites where `${role}` occurs inside a Russian phrase, move with `{role, select, ADMIN {адміністратор} SENIOR {синьйор} JUNIOR {джуніор} HR {HR} ACCOUNTANT {бухгалтер} DROP {дроп} other {співробітник}}` inside `message`, not by substituting the raw enum as a parameter (verified through context7: the `select` ICU format is standard, `{value, select, ...}`, without a macro it is written directly as a string in `message`).

- [ ] **Step 7: Commit**

```bash
git rm packages/shared/src/schemas/api-errors.ts
git add packages/shared/src/schemas/api-errors/base.ts \
  packages/shared/src/schemas/api-errors/auth-users-projects.ts \
  packages/shared/src/schemas/api-errors/finance-invoices.ts \
  packages/shared/src/schemas/api-errors/documents-contracts-notifications.ts \
  packages/shared/src/schemas/api-errors/index.ts packages/shared/src/schemas/api-errors.spec.ts \
  apps/api/src/auth apps/api/src/users apps/api/src/projects
git commit -m "feat(api,shared): route auth/users/projects exceptions through api-error codes

Splits api-errors.ts into a barrel (api-errors/index.ts) over per-module files
so Track A's 3 PRs write disjoint files instead of one shared file
(fix-round 1, SPEC-M-1) — finance-invoices.ts/documents-contracts-notifications.ts
land here as empty stubs for Task 2/3 to fill.

ac_verified: 1"
```

---

### Task 2: Error codes — `finance`/`invoices` (the largest concentration)

**Files:**

- Modify: `packages/shared/src/schemas/api-errors/finance-invoices.ts` (created by Task 1 as an empty stub — filled here; **the barrel `api-errors/index.ts` is not touched**, see "Parallelism discipline" at the start of the track, SPEC-M-1)
- Modify: `apps/api/src/finance/transactions.service.ts` (60 Cyrillic + 60 English), `apps/api/src/finance/balance.service.ts`, `apps/api/src/finance/company-account.service.ts`, `apps/api/src/finance/pending-settlement.service.ts`, `apps/api/src/invoices/invoices.service.ts` (16 Cyrillic; already 1 `apiError()` — do not touch)
- Test: the `*.spec.ts` of the changed services

**Interfaces:**

- Consumes: the same as Task 1
- Produces: this wave's codes do not overlap with Task 1/3 by name (the namespace `api-error.FINANCE_*`, `api-error.INVOICE_*` — a convention, not enforced by types, but mandatory for the registry's readability)

- [ ] **Step 1: A working example — COPY-H-api-4 (an internal analysis inside a 400), test first**

`finance/transactions.service.ts`, the `derivativePlan.needsReconfirm` branch (the `amount`/`settled_amount` discrepancy guard) today prints a five-line analysis with a reference to PR `#598` to the user. Find the exact text:

```bash
git grep -n "needsReconfirm" origin/main -- apps/api/src/finance/transactions.service.ts
```

The migration pattern: a user-facing code without details + a **log** with the full analysis (the audit: "The analysis — to the log").

```ts
// packages/shared/src/schemas/api-errors/finance-invoices.ts (FINANCE_INVOICES_ERROR_MESSAGES) —
// the barrel is not touched, it already spreads this Record wholesale
FINANCE_ROW_AMOUNT_MISMATCH: /* i18n */ {
  id: 'api-error.FINANCE_ROW_AMOUNT_MISMATCH',
  message: 'Сума рядка і фактичні виплати розходяться — правка недоступна. Повідомте номер рядка адміністратору',
},
```

```ts
// transactions.service.ts — was: throw new BadRequestException(`five-line analysis...`)
this.logger.warn(
  `Row ${row.id} needsReconfirm: amount=${row.amount} settled=${row.settledAmount} — see PR #598`,
)
throw apiError('FINANCE_ROW_AMOUNT_MISMATCH', HttpStatus.BAD_REQUEST)
```

- [ ] **Step 2-5: the test fails → the code is added → the throw is replaced → the test passes** (the same cycle as Task 1 Step 2-5; the specific assertion — `rejects.toMatchObject({ response: { code: 'FINANCE_ROW_AMOUNT_MISMATCH' } })`, plus `expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('needsReconfirm'))` — the analysis is not lost, it just moved to the log)

- [ ] **Step 6: COPY-H-api-6 — the RBAC matrix in the text (`balance.service.ts`)**

```bash
git grep -n "Доступ к pending obligations\|assert.*Access" origin/main -- apps/api/src/finance/balance.service.ts
```

The pattern: remove the enumeration of roles from the message, keep the action.

```ts
FINANCE_PENDING_OBLIGATIONS_FORBIDDEN: /* i18n */ {
  id: 'api-error.FINANCE_PENDING_OBLIGATIONS_FORBIDDEN',
  message: 'Цей розділ доступний бухгалтеру та адміністратору',
},
```

- [ ] **Step 7: COPY-H-api-7 — "IOU/obligation" in the ledger (`pending-settlement.service.ts`, the `notes` field)**

This is not a throw, but text written into the DB (`transactions.notes`) — **outside the error-code perimeter** (codes — only HTTP responses). The fix here is terminological, along the way: replace `` `Выплата drop IOU (obligation ${id})` `` with `` `Закриття зобов'язання дропа (${id})` `` as a direct `uk` literal (not via a registry — the ledger is read by the accountant, not by the end UI user; the text in `notes` is not localized by recipient, it is an internal accounting record, a decision separate from the error registry). Record it as the only reasonable deviation from "everything through the catalog" — put the reason in the PR body, do not stay silent.

- [ ] **Step 8: Apply the same pattern (error codes) to the rest of the wave's throw-sites**

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/finance apps/api/src/invoices \
  | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/finance apps/api/src/invoices \
  | grep -v '\.spec\.ts' | grep -vP "[А-Яа-яЁё]" | grep -E "\(('|\`)[A-Za-z]"
```

COPY-M-api-13 (the paragraph about the rate in `pending-settlement.service.ts`) and COPY-M-api-8 (the gender "подписал" in `invoices.service.ts` — "Инвойс подписан: {counterpartyName}" without gender) — the same cycle, the texts are rewritten in the corrected wording BEFORE registering the code (audit §696 item 3).

- [ ] **Step 9: An integration spec — where the throw comes from a branch with a real Drizzle query**

The mutation gate does not see `*.integration.spec.ts` (`mutation-gate-integration-specs.md`) — for each code of this wave whose throw is reachable only after a real DB query (the guards on `amount`/`settled_amount`, the RLS-dependent branches of `balance.service.ts`), a unit duplicate with a mocked repository is mandatory IN ADDITION to the integration spec, not instead of it.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/schemas/api-errors/finance-invoices.ts apps/api/src/finance apps/api/src/invoices
git commit -m "feat(api,shared): route finance/invoices exceptions through api-error codes

ac_verified: 1"
```

---

### Task 3: Error codes — `documents`/`contracts`/`teams`/`legends`/`approvals`/`interviews`/`notifications`

**Files:**

- Modify: `packages/shared/src/schemas/api-errors/documents-contracts-notifications.ts` (created by Task 1 as an empty stub — filled here; **the barrel `api-errors/index.ts` is not touched**, see "Parallelism discipline" at the start of the track, SPEC-M-1)
- Modify: `apps/api/src/documents/documents.service.ts` (18 Cyrillic + 4 English), `apps/api/src/contracts/{contract-templates,signed-contracts}.service.ts` (partially migrated — `signed-contracts.service.ts` already 1 `apiError()`), `apps/api/src/teams/teams.service.ts` (18+19), `apps/api/src/legends/*.ts` (6), `apps/api/src/approvals/approvals.service.ts` (3), `apps/api/src/interviews/*.ts` (2+11 English), `apps/api/src/notifications/notifications.service.ts` (4 — **logs only**, not a throw, see Step 4)
- Test: the corresponding `*.spec.ts`

**Interfaces:**

- Consumes/Produces: as Task 1/2

**The scope does NOT include** (check against the controller before starting — the public landing endpoints are read by `apps/landing`'s `errorKindForStatus` by status, not by text, COPY-M-api-14): `apps/api/src/{vacancies,job-sourcing,resumes,contact}/**`, if a throw-site is reachable ONLY from a public (non-CRM, no `@Roles`) route. If the same service carries a CRM-facing method too (an admin views an application) — migrate only the CRM-facing throw-sites, leave the public ones at a status code without a text code (already works per the spec — "The server returns a code [status], the landing — its own text. This is the target scheme").

- [ ] **Step 1: A working example — COPY-H-api-3 (message = an identifier)**

```bash
git grep -n "CONTRACT_NOT_EDITABLE\|DUPLICATE_ACTIVE_TEMPLATE\|ADMIN_DOES_NOT_HAVE_CONTRACT_TEMPLATE" \
  origin/main -- apps/api/src/contracts
```

11 places, of which two are already caught by the client via `.includes()` (`SignContractStep.tsx` — codes, leave them as exception strings OR give them a real `apiError` code and switch the client to `getApiErrorCode`, which is part of the general task of abandoning `.includes()` on prose anyway — if the client already matches these two constants as codes, registering them under THE SAME names is redundant: move them 1:1 into `API_ERROR_CODES` as codes with these names, replace `.includes()` on the client with `getApiErrorCode(err) === 'CONTRACT_NOT_EDITABLE'`), the other nine — new texts by the rule "object + next step".

- [ ] **Step 2: A working example — COPY-M-api-11 (raw enums in the text, `documents.service.ts:993/1012/1019`)**

```ts
DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN: /* i18n */ {
  id: 'api-error.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN',
  message:
    '{role, select, JUNIOR {Джуніор} HR {HR} ACCOUNTANT {Бухгалтер} SENIOR {Синьйор} DROP {Дроп} other {Співробітник}} ' +
    'не може завантажувати {category, select, CONTRACT {договори} RECEIPT {чеки} LOGO {логотипи} other {документи}}',
},
```

```ts
// packages/shared/src/schemas/api-errors/documents-contracts-notifications.ts —
// DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_PARAMS (the barrel is not touched)
DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN: ['role', 'category'],
```

```ts
// documents.service.ts:993 — was:
throw new ForbiddenException(`Роль ${role} не может загружать ${category}`)
// became:
throw apiError('DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN', HttpStatus.FORBIDDEN, { role, category })
```

`role`/`category` — enum values, not PII: they pass through the `ParamsFor<C>` pin without exceptions. `.../1012` and `.../1019` (the special cases "чеки"/"логотипи") merge into the same code via the same `select` (the duplicate is removed — there were three similar messages, it became one code).

- [ ] **Step 3-4: the test fails → the code is added → the throw is replaced → the test passes**, plus a unit test for each `select` branch (at least `JUNIOR`+`CONTRACT`, `other`+`other` — the mutation gate will catch an uncovered `select` branch, as it catches an uncovered ternary, see `mutation-gate-integration-specs.md`):

```ts
it('renders role and category labels for every combination the guard can hit', () => {
  const i18n = createI18n('uk')
  expect(
    i18n._(
      API_ERROR_MESSAGES.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN.id,
      { role: 'JUNIOR', category: 'CONTRACT' },
      {
        message: API_ERROR_MESSAGES.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN.message,
      },
    ),
  ).toBe('Джуніор не може завантажувати договори')
})
```

- [ ] **Step 5: `notifications.service.ts` — 4 logs, NOT a throw (COPY-L-api-18)**

This is a project rule ("logs — English"), not a migration to the catalog. Translate verbatim to English on the first touch of the file (already part of this wave's scope — the file is in the list):

```
'Уведомление пропущено (событие не откатываем): …' → 'Notification skipped (event not rolled back): …'
'Путь производителя уведомлений упал (событие не откатываем): …' → 'Notification producer path failed (event not rolled back): …'
'Обработчик отказа уведомлений сам упал (наблюдение потеряно, …): …' → 'Notification failure handler itself failed (observability lost, …): …'
'Телеметрия не приняла отказ уведомления: …' → 'Telemetry did not accept the notification failure: …'
```

- [ ] **Step 6: Apply the error-code pattern to the rest of the wave's throw-sites**

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/documents apps/api/src/contracts \
  apps/api/src/teams apps/api/src/legends apps/api/src/approvals apps/api/src/interviews \
  | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/documents apps/api/src/contracts \
  apps/api/src/teams apps/api/src/legends apps/api/src/approvals apps/api/src/interviews \
  | grep -v '\.spec\.ts' | grep -vP "[А-Яа-яЁё]" | grep -E "\(('|\`)[A-Za-z]"
```

COPY-L-api-17 (17 similar "{object} not found" across different modules) — reduce to **one code with an object parameter**: `NOT_FOUND: { message: '{object, select, PROJECT {Проєкт} DOCUMENT {Документ} USER {Користувача} RECORD {Запис} other {Об'єкт}} не знайдено' }`, instead of starting 17 separate codes — it saves the registry and closes the finding "different specificity for one class" at once.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas/api-errors/documents-contracts-notifications.ts \
  apps/api/src/documents apps/api/src/contracts \
  apps/api/src/teams apps/api/src/legends apps/api/src/approvals apps/api/src/interviews \
  apps/api/src/notifications/notifications.service.ts
git commit -m "feat(api,shared): route documents/contracts/teams/legends/approvals/interviews exceptions through api-error codes

ac_verified: 1"
```

---

## Track B — shared Zod messages

### Task 4: The mechanism + wave B1 (`money.ts`/`finance.ts`/`users.ts`/`payment-requisites.ts`)

**The mechanism choice (spec §4.3 already decides "codes through the same registry" — here it is fixed HOW):**

Zod v4 allows only `message: string` on a validator — there is no separate "code" field. The `z.setErrorMap` option — a global map by `issue.code`/`issue.path`, not by business meaning (it does not distinguish "email is invalid" from "email is required" without manually parsing the issue) — rejected: the registry by code is read in the same place where `getApiErrorMessage` already stands, adding a second issue-parsing mechanism next to it is redundant. **The choice: `message` in the schema — a stable key string of the form `'zod.<CODE>'`, not text.** It travels as is in `issue.message` (Zod does not distinguish it from ordinary text), and the translation into text — on the output, in two places: `ZodExceptionFilter` (the server, the envelope of the 400 response) and the client's field-error render.

**Files:**

- Create: `packages/shared/src/schemas/zod-errors.ts` — `ZodErrorCode`, `ZOD_ERROR_MESSAGES: Record<Code, MessageDescriptor>`
- Create: `packages/shared/src/schemas/zod-errors.spec.ts`
- Modify: `apps/api/src/zod-exception.filter.ts` — issues return `{ path, code, params? }` instead of `{ path, message }`
- Modify: `packages/shared/src/schemas/money.ts`, `finance.ts`, `users.ts`, `payment-requisites.ts`
- Modify: `apps/web/app/lib/axios-utils.ts` — `translateZodError(code)` (the same pattern as `translateApiError`); `extractBackendMessage`'s Priority 1 prefers `code` (translated through the catalog) where it exists, `message` — only for a non-migrated schema (SPEC-H-1)
- Test: `apps/api/src/zod-exception.filter.spec.ts` (new or extend an existing one — check whether there is one), `packages/shared/src/schemas/{money,finance,users,payment-requisites}.spec.ts`, `apps/web/app/lib/axios-utils.spec.ts`
- Modify (generated, not by hand): `packages/shared/src/i18n/locales/{uk,en}/messages.po` — `pnpm i18n:extract` picks up the `zod-error.*` ids created in Step 3

**Interfaces:**

- Produces: `ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor>` — read by Task 5 (extends the same `Record`) and `apps/web/app/lib/axios-utils.ts`'s `translateZodError` (this same PR, Step 8 below — not a separate task of another stage)
- Produces: `translateZodError(code)` in `axios-utils.ts` — an internal module function (not exported, like `translateApiError`); the observable effect — `extractBackendMessage` returns the translated text for a migrated field instead of an empty string after the `code`
- Consumes: `createI18n`, `MessageDescriptor` — as Track A

- [ ] **Step 1: The registry — test first, on the most numerous duplicate (`bankUahRnokpp`, 3 places)**

```bash
git grep -n "РНОКПП должен быть 10 цифр\|РНОКПП обязателен" origin/main -- packages/shared/src/schemas
```

```ts
// packages/shared/src/schemas/zod-errors.spec.ts
import { createI18n } from '../i18n/catalog'
import { ZOD_ERROR_MESSAGES } from './zod-errors'

describe('ZOD_ERROR_MESSAGES', () => {
  it('RNOKPP_FORMAT has a uk message descriptor', () => {
    const i18n = createI18n('uk')
    expect(
      i18n._(ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.id, undefined, {
        message: ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.message,
      }),
    ).toBe('РНОКПП має містити 10 цифр')
  })
})
```

- [ ] **Step 2: Make sure it fails** — `pnpm i18n:compile && pnpm --filter @crm/shared test -- src/schemas/zod-errors.spec.ts` → FAIL (the file is absent).

- [ ] **Step 3: Create the registry**

```ts
// packages/shared/src/schemas/zod-errors.ts
import type { MessageDescriptor } from '@lingui/core'

export const ZOD_ERROR_CODES = ['RNOKPP_FORMAT', 'RNOKPP_REQUIRED', 'TX_HASH_MIN_LENGTH'] as const
export type ZodErrorCode = (typeof ZOD_ERROR_CODES)[number]

export const ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor> = {
  RNOKPP_FORMAT: /* i18n */ {
    id: 'zod-error.RNOKPP_FORMAT',
    message: 'РНОКПП має містити 10 цифр',
  },
  RNOKPP_REQUIRED: /* i18n */ {
    id: 'zod-error.RNOKPP_REQUIRED',
    message: "РНОКПП обов'язковий",
  },
  TX_HASH_MIN_LENGTH: /* i18n */ {
    id: 'zod-error.TX_HASH_MIN_LENGTH',
    message: 'txHash має містити щонайменше 10 символів',
  },
}
```

- [ ] **Step 4: Run the test → PASS**, then replace both literal duplicates with a key code:

```ts
// packages/shared/src/schemas/payment-requisites.ts:17 — was:
bankUahRnokpp: z.string().regex(/^\d{10}$/, 'РНОКПП должен быть 10 цифр'),
// became:
bankUahRnokpp: z.string().regex(/^\d{10}$/, 'zod.RNOKPP_FORMAT'),

// packages/shared/src/schemas/users.ts:159 — the same duplicate, the same code:
const bankUahRnokppField = z.string().regex(/^\d{10}$/, 'zod.RNOKPP_FORMAT')
// users.ts:196 — was:
ctx.addIssue({ code: 'custom', message: 'РНОКПП обязателен', path: ['bankUahRnokpp'] })
// became:
ctx.addIssue({ code: 'custom', message: 'zod.RNOKPP_REQUIRED', path: ['bankUahRnokpp'] })
```

The key `'zod.<CODE>'` — with the `zod.` prefix, so `ZodExceptionFilter` distinguishes this stage's translated schemas from the not-yet-migrated ones (whose `issue.message` is still free text, see Step 6).

- [ ] **Step 5: `finance.ts:1181/1476` — the same `txHash` duplicate**, with the same code `TX_HASH_MIN_LENGTH`.

- [ ] **Step 6: `ZodExceptionFilter` — issues return a code if there is one, otherwise the former text (transitional period)**

```ts
// apps/api/src/zod-exception.filter.ts — was:
errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
// became:
errors: exception.issues.map((i) => {
  const isMigrated = i.message.startsWith('zod.')
  return {
    path: i.path.join('.'),
    ...(isMigrated ? { code: i.message.slice('zod.'.length) } : { message: i.message }),
  }
}),
```

A non-migrated schema continues to return `message` as before — nothing breaks the neighboring 25 files until their own PR (Task 5). The `isFinanceCritical && !isAdmin` branch (COPY-H-api-1, `'Invalid request body'`) — replace with `apiError('VALIDATION_FAILED', HttpStatus.BAD_REQUEST)` from the Track A registry (add the code `VALIDATION_FAILED` in Task 1, if not yet started — this PR reads the Task 1 result, so physically after it).

- [ ] **Step 7: A filter test**

```ts
it('returns a code for a migrated schema message, text for a non-migrated one', () => {
  const migrated = new ZodError([
    { code: 'custom', path: ['bankUahRnokpp'], message: 'zod.RNOKPP_FORMAT' },
  ])
  const legacy = new ZodError([{ code: 'custom', path: ['email'], message: 'Некорректный email' }])
  // ... call filter.catch on both, check errors[0] contains code / message respectively
})
```

- [ ] **Step 8: The client render by code — `apps/web` in the same PR, not "in the future" (SPEC-H-1)**

Without this step, Step 6 — a regression in the same PR, not "later" debt: today the only client consumer of the envelope, `extractBackendMessage`'s Priority 1 (`apps/web/app/lib/axios-utils.ts`), reads `e['message']` directly and knows nothing about `code`. For a migrated field (`bankUahRnokpp`, `txHash` — exactly what this wave moves) the form would show `"bankUahRnokpp: "` — a path without text.

```ts
// apps/web/app/lib/axios-utils.ts — add the import:
import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES, type ZodErrorCode } from '@crm/shared'

// next to translateApiError — the same pattern (MessageOptions.message only when the descriptor carries it):
function isZodErrorCode(value: unknown): value is ZodErrorCode {
  return typeof value === 'string' && (ZOD_ERROR_CODES as readonly string[]).includes(value)
}

function translateZodError(code: ZodErrorCode): string {
  const descriptor = ZOD_ERROR_MESSAGES[code]
  const options = descriptor.message !== undefined ? { message: descriptor.message } : undefined
  return i18n._(descriptor.id, undefined, options)
}
```

```ts
// extractBackendMessage, Priority 1 — was:
const msgStr = typeof e['message'] === 'string' ? e['message'] : ''
// became — code (a migrated schema) is translated through the catalog, message (a non-migrated one) — as before:
const rawCode = e['code']
const msgStr = isZodErrorCode(rawCode)
  ? translateZodError(rawCode)
  : typeof e['message'] === 'string'
    ? e['message']
    : ''
```

`ZOD_ERROR_CODES` is already exported by the registry (Step 3, an `as const` array) — here it is used as a runtime list to narrow the type, not only as a type.

- [ ] **Step 9: A test — a migrated and a non-migrated field in one response**

```ts
// apps/web/app/lib/axios-utils.spec.ts
it('translates a migrated field (code) and keeps prose for a non-migrated one, in the same response', () => {
  const err = {
    response: {
      data: {
        message: 'Validation failed',
        errors: [
          { path: 'bankUahRnokpp', code: 'RNOKPP_FORMAT' },
          { path: 'email', message: 'Некорректный email' },
        ],
      },
    },
  }
  expect(getApiErrorMessage(err)).toBe(
    'bankUahRnokpp: РНОКПП має містити 10 цифр; email: Некорректный email',
  )
})
```

Run: `pnpm i18n:compile && pnpm --filter @crm/web test -- app/lib/axios-utils.spec.ts` → PASS.

- [ ] **Step 10: Apply the same move to the rest of the wave B1 messages**

```bash
git grep -cP "message:.*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{money,finance,users,payment-requisites}.ts
git grep -cP "\.(min|max|email|regex|refine|length)\([^)]*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{money,finance,users,payment-requisites}.ts
```

Merge the known duplicates BEFORE registering (COPY-L-shared from the audit, the item "22 different strings"): "Некорректный email" (5× in `users.ts`), "Причина отказа обязательна"/"слишком длинная" (in `approvals.ts`, `pending-share.ts`, `projects.ts` — those are **outside** wave B1, leave them to Task 5, but start the code in the registry already here, if the first appearance is in this wave, so Task 5 does not start a duplicate code). `transactionAmountError`/`moneyFloorAndPrecisionError` (`money.ts`↔`finance.ts`, COPY-M-shared-10) — one function, not two nearly identical ones: reduce to a call from `money.ts` in `finance.ts` (removes `finance.ts:514/519/520`, `finance.ts` starts calling `moneyFloorAndPrecisionError` from `./money` directly instead of its own copy) — a passing refactor, does not expand the perimeter (the same file, the same PR). `AMOUNT_DECIMAL_PLACES`/`COMPANY_REQUISITES_MAX` (numbers in the message) — `plural` ICU: `{n, plural, one {# знак} few {# знаки} many {# знаків} other {# знаку}}` for `uk`, `{n, plural, one {# digit} other {# digits}}` for `en` (the syntax confirmed by context7: `{numBooks, plural, one {# book} other {# books}}`).

- [ ] **Step 11: Commit**

```bash
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales  # idempotency
git add packages/shared/src/schemas/zod-errors.ts packages/shared/src/schemas/zod-errors.spec.ts \
  packages/shared/src/schemas/money.ts packages/shared/src/schemas/finance.ts \
  packages/shared/src/schemas/users.ts packages/shared/src/schemas/payment-requisites.ts \
  apps/api/src/zod-exception.filter.ts apps/web/app/lib/axios-utils.ts \
  apps/web/app/lib/axios-utils.spec.ts packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po
git commit -m "feat(api,shared,web): zod validation messages become stable codes, client renders by code (money/finance/users/payment-requisites)

ac_verified: 1"
```

---

### Task 5: Zod messages — wave B2 (the remaining 13 files)

**Files:**

- Modify: `packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts`
- Modify: `packages/shared/src/schemas/zod-errors.ts` — extending the registry (the same file that Task 4 created — a merge conflict is unlikely: Task 4 touches money/finance/users/payment-requisites, Task 5 — the remaining 13; both add records to one `Record`, the PR order — Task 4 first, Task 5 rebases onto it)

**Interfaces:**

- Consumes: `ZOD_ERROR_MESSAGES`, the Task 4 Step 1-7 pattern (the same cycle: a code into the registry → `'zod.<CODE>'` instead of text in the schema → a test for the resolve through `createI18n`)

- [ ] **Step 1: A working example — COPY-H-shared-1 (`CONTRACT_VARIABLE_DESCRIPTIONS`, 5 Ukrainian captions inside a Russian map)**

```bash
git grep -n "Адреса реєстрації\|human-readable Russian" origin/main -- packages/shared/src/schemas/contracts.ts
```

This is not a Zod message, but a `Record<string, string>` — the same principle (a top-level map, computed on import), but structurally closer to Task 6 (`NOTIFICATION_TITLES`). It is moved here because the file `contracts.ts` is already in this wave's perimeter (other Zod messages of the same file), rather than a separate PR for 24 strings: `CONTRACT_VARIABLE_DESCRIPTIONS: Record<string, MessageDescriptor>`, the five already-Ukrainian records are simply moved as is (the text is already correct), the other 19 are translated on the move. The comment "human-readable Russian descriptions" above the map is removed — it was already inaccurate before this task, the audit confirmed it.

- [ ] **Step 2: COPY-M-shared-8 — three role dictionaries (`ROLE_LABELS`/`role: '...'`/a raw `ADMIN`)**

The role canon on the client already exists (`role-select.tsx`'s `ROLE_LABEL_MESSAGES`/`useRoleLabel`, stage 3a). Here — `contracts.ts`'s `role: 'Роль (HR / Синьор / Джун / Дроп / Бухгалтер)'` (ADMIN is missing) is rewritten as a full list without a role-as-text in the string itself: either by a reference to the canon (if `contracts.ts` can import from `apps/web` — it **cannot**, different packages; so here — its own `Record<Role, MessageDescriptor>` with THE SAME six captions as the canon, verify by hand with the command `git grep -n "ROLE_LABEL_MESSAGES" origin/main -- apps/web/app/components/ui/role-select.tsx` before writing, so as not to diverge in text).

- [ ] **Step 3: Apply the Task 4 pattern to the rest of the wave's 13 files**

```bash
git grep -cP "message:.*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts
git grep -cP "\.(min|max|email|regex|refine|length)\([^)]*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts
```

Known duplicates to merge into one code in this wave: "Причина отказа обязательна" / "Причина отказа слишком длинная (максимум 500 символов)" — `approvals.ts`, `pending-share.ts`, `projects.ts` (3 files of this wave — one code `REJECTION_REASON_REQUIRED`/`REJECTION_REASON_TOO_LONG` for all three). `legends.ts`'s `'ФИО обязательно'` vs `legendEntrySchema.fullName`'s `'Имя обязательно'` (COPY-L-shared-17) — reduce to one field caption before registering the code. `'Неизвестный тип уведомления'` (COPY-M-shared-14, `notification-preferences.ts`) — per the audit this is not a user error (the interface itself sent an invalid type): a code is started, but the text — "Налаштування застаріли, оновіть сторінку", not a literal translation.

Also the 13 English `message:` (COPY-H-shared-3) in this wave and Task 4 — those that a human can fix are translated and get a code like the rest; those that are an API-contract diagnostic (example: ``'`locked` must be derived from the type, not sent independently'`` — a user cannot fix this by any action in a form) — are not registered in the catalog at all, remain English text ONLY for the log/developer: `ZodExceptionFilter`'s Step 6 `isMigrated` branch for them stays `false` (no `zod.` prefix), and this is a deliberate decision, not a miss — record in the PR body the list of such messages with the rationale "not a user error".

- [ ] **Step 4: `notifications.ts`'s `safeNotificationLinkSchema` — an English message**, similarly: if reachable only by an internal data desync (not by user input) — do not translate, log-only.

- [ ] **Step 5: Tests — one per each new code** (the Task 4 Step 1/7 template), plus a regression test for duplicates: do not add a `git grep` to the CI script (outside the perimeter — this is a Coder check before the PR, not a permanent gate), but the command is run before the commit:

```bash
git grep -h "message: 'zod\." packages/shared/src/schemas -- '*.ts' | grep -v spec | sort | uniq -c | sort -rn | head
```

A repeated code for different literals (before the move) — a signal that the duplicate was not merged; zero lines with count > 1 where the meaning is DIFFERENT — a signal of readiness.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/zod-errors.ts packages/shared/src/schemas/approvals.ts \
  packages/shared/src/schemas/pending-share.ts packages/shared/src/schemas/projects.ts \
  packages/shared/src/schemas/credentials.ts packages/shared/src/schemas/legends.ts \
  packages/shared/src/schemas/notification-preferences.ts packages/shared/src/schemas/notifications.ts \
  packages/shared/src/schemas/documents.ts packages/shared/src/schemas/resume.ts \
  packages/shared/src/schemas/employee-contracts.ts packages/shared/src/schemas/contracts.ts \
  packages/shared/src/schemas/teams.ts packages/shared/src/schemas/tos.ts \
  packages/shared/src/schemas/admin-actions.ts
git commit -m "feat(shared): remaining zod validation messages become stable codes

ac_verified: 1"
```

---

## Track C — notifications on display

### Task 6: `notification-registry.ts` → `MessageDescriptor`, 3 frozen types, formatting

**Files:**

- Modify: `packages/shared/src/schemas/notification-registry.ts` — adds a NEW export `NOTIFICATION_TITLE_MESSAGES` (the legacy `NOTIFICATION_TITLES` does NOT change its type — SPEC-H-2, see "Danger" in Step 3), changes `ACTION_LABELS`, `SUBJECT_MISSING_LABELS`, `SUBJECT_ARCHIVED_LABELS`, `APPROVAL_SUPERSEDED_LABEL`/`APPROVAL_DECIDED_LABEL`, `describeNotification`, `renderNotification`, `subjectPhrase`, `percentText`, `money()`, `quoteWithinBudget`, `NOTIFICATION_DETAIL_LINE_CHARS`
- Modify: `apps/api/src/invoices/invoices.service.ts:1311-1312` (`INVOICE_SIGNED` — register the type in the registry instead of a raw `title`), `apps/api/src/invoices/invoices.service.ts:403/565` (`INVOICE_SIGN_REQUIRED`), `apps/api/src/vacancies/applications.service.ts:669` (`VACANCY_APPLICATION`)
- Modify: `packages/shared/src/schemas/notification-registry.spec.ts`
- Test: the same file + `apps/api/src/invoices/invoices.service.spec.ts`, `apps/api/src/vacancies/applications.service.spec.ts` (a check that the record no longer carries `title`/`body`)

**Interfaces:**

- Consumes: `createI18n`, `formatMoney(amount, currency, locale)` from `packages/shared/src/i18n/format.ts` (already exists, Task 6 changes `money()`'s hardcode `toLocaleString('ru-RU')` to a call of this function)
- Produces: `NOTIFICATION_TITLE_MESSAGES: Record<NewNotificationType, MessageDescriptor>` — a NEW export (Template A, the legacy `NOTIFICATION_TITLES: Record<NewNotificationType, string>` stays UNCHANGED for the six producers + `NotificationSettingsTab.tsx`, see "Danger" in Step 3, SPEC-H-2)
- Produces: `renderNotification(n, locale)` — **a new signature with the `locale` parameter** (currently without it — Task 7 and `apps/web`'s calling code must pass the viewer's locale; for display in the interface this is the current user's locale from `I18nProvider`, for an email — the recipient's locale from `createI18n(recipientLocale)`)

- [ ] **Step 1: A working example — COPY-H-shared-5, registering `INVOICE_SIGNED` (fails with the test first)**

```ts
// notification-registry.spec.ts
it('INVOICE_SIGNED renders from the registry, not from a frozen DB title', () => {
  const rendered = describeNotification('INVOICE_SIGNED', { counterpartyName: 'ТОВ Ромашка' }, 'uk')
  expect(rendered.title).toBe('Рахунок підписано')
  expect(rendered.title).not.toContain('ТОВ Ромашка') // §10: an email/popup does not name people/counterparties by name needlessly — a detail behind a button
})
```

- [ ] **Step 2: Make sure it fails** — `INVOICE_SIGNED` is not in `NEW_NOTIFICATION_TYPES` today.

- [ ] **Step 3: Add the type to the registry — `NOTIFICATION_TITLE_MESSAGES` as a NEW export, do not touch the legacy `NOTIFICATION_TITLES` (SPEC-H-2, the same Template A trick as `ROLE_LABELS`/`SORT_OPTIONS` in the 3a plan). SPEC-H-3 (fix-round 2):** the previous revision of this step prescribed "the same text as in `NOTIFICATION_TITLES` below" — and that text is Russian (legacy, see "Danger"). A copy of the Russian into the new canon would violate this same plan's Global Constraints ("the source text in the registries — Ukrainian, not Russian"). `NOTIFICATION_TITLE_MESSAGES` is written **anew in Ukrainian** (per the `CONTEXT.md` glossary, without calques from the Russian original) with an English `msgstr` in the same PR — the legacy is NOT a translation source, only a sample of meaning.**

Along the way a neighboring factual error is fixed (not the subject of a finding, but of the same origin): both here and in "Danger" below the previous revision called the number of existing keys "seven" — in fact there are **ten** (`NOTIFICATION_TITLES` on `origin/main` — the file header says it in plain text: "Ten types", `INFORMING_NOTIFICATION_TYPES` (5) + `ACTION_REQUIRED_NOTIFICATION_TYPES` (3) + `ADMIN_NOTIFICATION_TYPES` (2) = 10 records). "Seven" — is the number of OTHER entities of the same section (six producer files + `NotificationSettingsTab.tsx` = seven READERS of the legacy registry, not seven keys in it) — the proximity of the two "sevens" in one Task, it seems, caused the mix-up. The table below — all ten.

```ts
// NEW_NOTIFICATION_TYPES — add 'INVOICE_SIGNED', 'INVOICE_SIGN_REQUIRED', 'VACANCY_APPLICATION'

// NOTIFICATION_TITLE_MESSAGES — a NEW export, Record<NewNotificationType, MessageDescriptor>.
// The canon for display (Step 7 moves renderNotification/describeNotification to it, both in this
// same file — the only reading sites that this PR changes).
// message — Ukrainian text (the default locale, the extraction source for .po); the en-msgstr for the
// same id is added in this same commit in packages/shared/src/i18n/locales/en/messages.po (not deferred
// to a separate translation) — copywriting §5, "two originals", copy-reviewer PASS mandatory on BOTH:
export const NOTIFICATION_TITLE_MESSAGES: Record<NewNotificationType, MessageDescriptor> = {
  // The ten existing types — written anew, NOT copied from NOTIFICATION_TITLES (see the table
  // TYPE | uk | en right under the block):
  TRANSACTION_ADDED: /* i18n */ { id: 'notification.TRANSACTION_ADDED.title', message: 'Вам додали транзакцію' },
  TRANSACTION_STATUS_CHANGED: /* i18n */ { id: 'notification.TRANSACTION_STATUS_CHANGED.title', message: 'Рішення щодо доходу' },
  TEAM_MEMBER_ADDED: /* i18n */ { id: 'notification.TEAM_MEMBER_ADDED.title', message: 'Вас додали до команди' },
  PROJECT_MEMBER_ADDED: /* i18n */ { id: 'notification.PROJECT_MEMBER_ADDED.title', message: 'Вас додали до проєкту' },
  TEAM_NEW_MEMBER: /* i18n */ { id: 'notification.TEAM_NEW_MEMBER.title', message: 'У команді новий учасник' },
  PROJECT_CONFIRM_REQUIRED: /* i18n */ { id: 'notification.PROJECT_CONFIRM_REQUIRED.title', message: 'Проєкт очікує рішення' },
  SHARE_CONFIRM_REQUIRED: /* i18n */ { id: 'notification.SHARE_CONFIRM_REQUIRED.title', message: 'Пропозиція щодо частки' },
  DOCUMENT_SIGN_REQUIRED: /* i18n */ { id: 'notification.DOCUMENT_SIGN_REQUIRED.title', message: 'Контракт на підпис' },
  APPROVAL_CONFIRMED: /* i18n */ { id: 'notification.APPROVAL_CONFIRMED.title', message: 'Пропозицію прийнято' },
  APPROVAL_REJECTED: /* i18n */ { id: 'notification.APPROVAL_REJECTED.title', message: 'Пропозицію відхилено' },
  // The three new frozen types — already written anew in Ukrainian (not a copy from anywhere, the legacy
  // did not know them), without changes:
  INVOICE_SIGNED: /* i18n */ { id: 'notification.INVOICE_SIGNED.title', message: 'Рахунок підписано' },
  INVOICE_SIGN_REQUIRED: /* i18n */ { id: 'notification.INVOICE_SIGN_REQUIRED.title', message: 'Рахунок очікує підпису' },
  VACANCY_APPLICATION: /* i18n */ { id: 'notification.VACANCY_APPLICATION.title', message: 'Новий відгук на вакансію' },
}

// NOTIFICATION_TITLES — LEGACY, the type and text stay RUSSIAN (Record<NewNotificationType, string>,
// the type UNCHANGED) — see "Danger" below. NOT a translation source for NOTIFICATION_TITLE_MESSAGES
// above (SPEC-H-3) — only a historical reference point of meaning, the words are different. The Record is
// closed over NewNotificationType, so the three new keys are mandatory by the compiler even without a
// translation — the same (already Ukrainian) text as in the new canon, without the i18n wrapper:
INVOICE_SIGNED: 'Рахунок підписано',
INVOICE_SIGN_REQUIRED: 'Рахунок очікує підпису',
VACANCY_APPLICATION: 'Новий відгук на вакансію',
```

The ten existing types of `NOTIFICATION_TITLE_MESSAGES` — the old (legacy, for reference, NOT a source) and the new uk/en texts:

| TYPE                         | legacy `NOTIFICATION_TITLES` (for reference, not a source) | uk (the new canon)      | en                              |
| ---------------------------- | ---------------------------------------------------------- | ----------------------- | ------------------------------- |
| `TRANSACTION_ADDED`          | Вам добавили транзакцию                                    | Вам додали транзакцію   | A transaction was added for you |
| `TRANSACTION_STATUS_CHANGED` | Решение по доходу                                          | Рішення щодо доходу     | Decision on income              |
| `TEAM_MEMBER_ADDED`          | Вас добавили в команду                                     | Вас додали до команди   | You were added to a team        |
| `PROJECT_MEMBER_ADDED`       | Вас добавили в проект                                      | Вас додали до проєкту   | You were added to a project     |
| `TEAM_NEW_MEMBER`            | В команде новый участник                                   | У команді новий учасник | New team member                 |
| `PROJECT_CONFIRM_REQUIRED`   | Проект ждёт решения                                        | Проєкт очікує рішення   | Project awaiting decision       |
| `SHARE_CONFIRM_REQUIRED`     | Предложение по доле                                        | Пропозиція щодо частки  | Share proposal                  |
| `DOCUMENT_SIGN_REQUIRED`     | Контракт на подпись                                        | Контракт на підпис      | Contract to sign                |
| `APPROVAL_CONFIRMED`         | Предложение принято                                        | Пропозицію прийнято     | Proposal accepted               |
| `APPROVAL_REJECTED`          | Предложение отклонено                                      | Пропозицію відхилено    | Proposal rejected               |

The uk column — per the `CONTEXT.md` glossary (for example, "Рахунок" for the invoice is already fixed by it for the three frozen types above; "частка" — the accepted form of "доли"). The exact final wording (in particular the line budget of the `w-80` popup, COPY-H-1 — ≤19 characters, `PROJECT_CONFIRM_REQUIRED`/`SHARE_CONFIRM_REQUIRED` here are slightly wider) — up to `copy-reviewer` in the Task 6 implementation PR (the design-gate/copywriting gate is mandatory on that PR already); this table — not the final copy-freeze, but proof that the canon is written anew, not copied.

The other Tasks of the plan (1–5, 7) are checked for the same question — nowhere is there an instruction "copy the text from the legacy" (`grep -n 'тот же текст\|копи' docs/superpowers/plans/2026-09-20-crm-i18n-stage4-api-shared.md` based on fix-round 1: the only match was this Step 3, fixed above). All the other steps of the plan write `message:` anew in Ukrainian anyway (Task 1–5 — error codes, taken apart one by one without a legacy equivalent; Task 7 reads the `NOTIFICATION_TITLE_MESSAGES` already fixed here, not the legacy).

### Danger: `NOTIFICATION_TITLES` — six producers and one web consumer outside the perimeter (SPEC-H-2)

`NOTIFICATION_TITLES[type]` (legacy, `string`) is written into the column `title: string` (`CreateNotificationInput`, `notifications.service.ts`) by **six files, eleven calls** (`git grep -n 'NOTIFICATION_TITLES' origin/main` — the list below must match at the task start, the numbers/lines may shift by 1-2):

- `apps/api/src/approvals/approvals.service.ts:269,293`
- `apps/api/src/contracts/employee-contracts.service.ts:216`
- `apps/api/src/finance/transactions.service.ts:9115,9163`
- `apps/api/src/projects/projects.service.ts:1147,1399,2281,2448`
- `apps/api/src/teams/teams.service.ts:959,986`
- `apps/api/src/users/users.service.ts:226`

Plus `apps/web/app/components/user-profile/tabs/NotificationSettingsTab.tsx:178` — `rowTitle(): string` renders `NOTIFICATION_TITLES[row.type as NewNotificationType]` as a type label in the settings list (not the title of a specific notification — the title of the TYPE).

**What happens to them in this PR: nothing.** None of the seven files is edited, imports `NOTIFICATION_TITLE_MESSAGES`, or enters this Task's Files. The legacy `NOTIFICATION_TITLES` does not change the type or the values of the existing ten keys (only adds three new ones by a line, see Step 3 above, SPEC-H-3 fix-round 2 — the previous revision mistakenly wrote "seven" here, confusing it with the number of files below) — all seven consumers continue to compile and work as before, without edits.

**Why this is safe, not "deferred debt":** `renderNotification` (Step 6 below) for NEW types already recomputes the title anew on every display today — `title: NOTIFICATION_TITLES[n.type]` reads the LIVE registry, not a frozen string from the DB (`RenderedNotification`'s `title` does not read `n.title` for `isNewNotificationType` branches, see the current implementation). The same principle in `composeBody`'s fallback branch (Task 7) — `subject: NOTIFICATION_TITLES[source.type]`. The column `title` frozen in the DB, which the six producers write, **is not read by any display path** for new types — it exists because of the schema's `NOT NULL` constraint and as a fallback for unparseable data. Replacing `NOTIFICATION_TITLES[type]` (legacy) with `NOTIFICATION_TITLE_MESSAGES[type]` (the new canon) in these six files would mean changing what is written into a never-read-for-display column — an edit with no observable effect, but with a blocking typecheck risk outside this PR's zone.

**In which PR the legacy is removed:** not in this plan. Removing `NOTIFICATION_TITLES` (or moving the six producers + `NotificationSettingsTab.tsx` to `NOTIFICATION_TITLE_MESSAGES`) — a separate task, started when the last external consumer migrates (the same trick as `ROLE_LABELS`/`SORT_OPTIONS` in the 3a plan: the legacy is removed by the wave that touches the LAST consumer, not earlier — here it is `apps/web`'s `web-docs-notify` wave for `NotificationSettingsTab.tsx` and/or the task removing `NOT NULL` from the `title` column, both outside stage 4's perimeter). Recorded as a backlog item, if not picked up by a separate task before the start of stage 6.

- [ ] **Step 4: Add a `dataSchemaFor` for the three types** (every new `NewNotificationType` is obliged to have a data schema in `dataSchemas` — `notificationDataSchemaFor` otherwise throws on an unknown type):

```ts
INVOICE_SIGNED: z.object({ counterpartyName: z.string() }),
INVOICE_SIGN_REQUIRED: z.object({ amount: moneyFields.amount, currency: moneyFields.currency }),
VACANCY_APPLICATION: z.object({ vacancyTitle: z.string() }),
```

- [ ] **Step 5: Replace the producers with structured `data` instead of `title`/`body`**

```ts
// invoices.service.ts:1311-1312 — was:
type: 'INVOICE_SIGNED',
title: `${counterpartyRow.displayName} подписал инвойс`,
// became:
type: 'INVOICE_SIGNED',
data: { counterpartyName: counterpartyRow.displayName },
```

Similarly `INVOICE_SIGN_REQUIRED` (lines 403, 565 — remove `title`/`body`, pass `data`) and `VACANCY_APPLICATION` (`applications.service.ts:669`).

- [ ] **Step 6: `describeNotification`/`renderNotification` — read `NOTIFICATION_TITLE_MESSAGES` (the new canon), not the legacy `NOTIFICATION_TITLES`; run the Step 1 test → PASS**

```ts
// notification-registry.ts, renderNotification — was:
title: NOTIFICATION_TITLES[n.type],
detail: describeNotification(n.type, parsed.data as never),
// became — both via the new canon, the locale comes as a parameter (Interfaces: renderNotification(n, locale)):
title: i18n._(NOTIFICATION_TITLE_MESSAGES[n.type].id, undefined, {
  message: NOTIFICATION_TITLE_MESSAGES[n.type].message,
}),
detail: describeNotification(n.type, parsed.data as never, locale),
```

`createI18n(locale)` is called once in `renderNotification`, not on every field — the same trick as `i18n` as a parameter in `notification-email-copy.ts`'s `BODIES` (Task 7 Step 2-4).

Plus a test for old records in the DB (backward compatibility, the legacy branch is not touched by this task):

```ts
it('a legacy row with a frozen title still renders (fallback path stays)', () => {
  const rendered = renderNotification(
    { type: 'SOME_OLD_TYPE', title: 'старая строка', body: null /* ... */ },
    'uk',
  )
  expect(rendered.title).toBe('старая строка') // composeBody's fallback branch — not touched by this task
})
```

- [ ] **Step 7: `money()` → `formatMoney`, the formatting locale**

```ts
// notification-registry.ts — was:
function money(d: { amount: string; currency: string }): string {
  const num = Number(d.amount)
  return `${num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${d.currency}`
}
// became:
import { formatMoney } from '../i18n/format'
function money(d: { amount: string; currency: string }, locale: Locale): string {
  return formatMoney(d.amount, d.currency as 'USDT' | 'USD' | 'EUR' | 'UAH', locale)
}
```

All `money(d)` calls inside the file get a second argument `locale`, which itself comes as a parameter in `describeNotification`/`renderNotification` (Step 1 already introduced this parameter).

- [ ] **Step 8: `subjectPhrase`/`percentText` — cases, not text-with-a-placeholder**

```bash
git grep -n "function subjectPhrase\|function percentText" origin/main -- packages/shared/src/schemas/notification-registry.ts
```

`subjectPhrase()` (project/share by cases) is rewritten via `select`, not a string concatenation:

```ts
// was: `проект ${named}` / `доля по проекту ${named}` (genitive/prepositional by hand)
// became — ONE message with a subject-type parameter, the case — part of the translation:
function subjectPhrase(
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  name: string | null,
): MessageDescriptor {
  return /* i18n */ {
    id: 'notification.subjectPhrase',
    message:
      '{kind, select, PROJECT {проєкт{name, select, null {} other { «{name}»}}} ' +
      'PROJECT_SHARE {доля за проєктом{name, select, null {} other { «{name}»}}} ' +
      'other {доля за замовчуванням}}',
  }
}
```

(The nested `select` on `name` — a standard ICU "empty or value" pattern; check in `pnpm i18n:extract` that `lingui` does not stumble on the nesting — if it does, two separate messages `subjectPhraseNamed`/`subjectPhraseUnnamed` instead of the nested `select`, record in the PR body which option was chosen and why.)

`percentText(null) → 'не задана'` (feminine, agreed with "долей" in Russian; in uk — "не задано" neuter or its own form, in en there is no gender) — not a parameter, but part of the same `message`, a `select` on `null`/non-`null`.

- [ ] **Step 9: `NOTIFICATION_DETAIL_LINE_CHARS`/`quoteWithinBudget` — a budget for the longest language**

```bash
git grep -n "NOTIFICATION_DETAIL_LINE_CHARS\|quoteWithinBudget" origin/main -- packages/shared/src/schemas/notification-registry.ts
```

The budget (22 characters/line, 2 lines) is tuned for Russian. A test on the longest realistic Ukrainian string (the audit: uk is longer than en by 15-30%) — if the truncation cuts mid-word with the active locale `uk`, raise `NOTIFICATION_DETAIL_LINE_CHARS` or adapt `quoteWithinBudget` to a locale parameter. This is UI polish (the `w-80` popup) — **design-gate Tier 3** (editing an existing component, a conformance check, not a full generation) applies separately to `apps/web`'s render component, here — only the budget function itself in `shared`.

- [ ] **Step 10: Quote typography** — `quoteWithinBudget`'s `«…»` hardcoded for any locale (COPY: "The typography is baked into the templates"). Parameterize: `uk` → `«…»`, `en` → `"…"`, the choice — by the `locale` parameter that Step 1 already introduced into the whole call chain.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/schemas/notification-registry.ts packages/shared/src/schemas/notification-registry.spec.ts \
  apps/api/src/invoices/invoices.service.ts apps/api/src/invoices/invoices.service.spec.ts \
  apps/api/src/vacancies/applications.service.ts apps/api/src/vacancies/applications.service.spec.ts
git commit -m "feat(shared): render notification titles/details by locale, register 3 legacy DB-frozen types

ac_verified: 1"
```

---

## Track D — uk/en emails

### Task 7: `notification-email-copy.ts` and the invitation — the recipient's locale

**Files:**

- Modify: `apps/api/src/notifications/notification-email-copy.ts` — all 10 `BODIES`, `acceptedLine`/`rejectedLine`/`projectPhrase`/`sharePhrase` (rewrite wholly in sentences, not a concatenation — audit §696 item 4), `renderNotificationEmail` gets `locale` as a parameter
- Modify: `apps/api/src/notifications/notification-email-copy.spec.ts` — a snapshot on `uk` and `en` instead of `startsWith('Запрос на')`/literal Russian substrings
- Modify: `apps/api/src/notifications/notification-email.cron.ts` — activate the **recipient's** locale (`users.locale`) before calling `renderNotificationEmail`, not the cron's/sender's locale
- Modify: `apps/api/src/users/personal-email-invite-mailer.service.ts` — the invitation locale (see "Questions for the owner" A2 below — until answered, the recommended option is implemented)
- Test: the same files

**Interfaces:**

- Consumes: `NOTIFICATION_TITLES` (Task 6, for `composeBody`'s fallback branch), `createI18n(locale)`, `renderNotification(n, locale)` (Task 6 — the email uses the same `describeNotification` where applicable, instead of a parallel text)
- Produces: `renderNotificationEmail(source, opts, locale)` — a new signature; the calling code (`notification-email.cron.ts`) is obliged to pass `locale`, otherwise typecheck is red (deliberately — so as not to forget one of the two callers)

- [ ] **Step 1: A working example — `TRANSACTION_ADDED`, test first on two locales**

```ts
// notification-email-copy.spec.ts
it('TRANSACTION_ADDED renders the project name on both locales', () => {
  const uk = renderNotificationEmail(
    source('TRANSACTION_ADDED', { projectName: 'Мобільний банк' }),
    opts,
    'uk',
  )
  const en = renderNotificationEmail(
    source('TRANSACTION_ADDED', { projectName: 'Mobile Bank' }),
    opts,
    'en',
  )
  expect(uk.subject).toBe('Транзакція за проєктом «Мобільний банк»')
  expect(en.subject).toBe('Transaction on “Mobile Bank”')
  // §10 invariant (already in the file) — not a single number/name except the object name:
  expect(uk.text).not.toMatch(/\d/)
})
```

- [ ] **Step 2-4: the test fails → the descriptor is written → `BODIES.TRANSACTION_ADDED` is moved to `i18n._()` → the test passes**

```ts
// was:
TRANSACTION_ADDED: (d) => ({
  subject: d.projectName === null ? 'Вам добавили транзакцию' : `Транзакция по проекту «${d.projectName}»`,
  lines: ['В ваших финансах новая транзакция. Сумма и детали — в CRM.'],
}),
// became:
TRANSACTION_ADDED: (d, i18n) => ({
  subject: i18n._(
    /* i18n */ { id: 'email.TRANSACTION_ADDED.subject', message: '{projectName, select, null {Вам додали транзакцію} other {Транзакція за проєктом «{projectName}»}}' },
    { projectName: d.projectName },
  ),
  lines: [i18n._(/* i18n */ { id: 'email.TRANSACTION_ADDED.body', message: 'У ваших фінансах нова транзакція. Сума та деталі — в CRM.' })],
}),
```

Each function in `BODIES` gets a second argument `i18n: I18n` (an instance of `createI18n(locale)`, created once in `renderNotificationEmail`, not in each function — avoids 10 separate `createI18n` calls per email).

- [ ] **Step 5: `acceptedLine`/`rejectedLine`/`projectPhrase`/`sharePhrase` — rewrite in whole sentences, not a concatenation (audit §696 item 4 — the cases cannot be assembled otherwise for `uk`)**

```ts
// was (fragments, genitive by hand):
function acceptedLine(subjectKind: ApprovalSubjectKind, subjectTitle: string | null): string {
  return subjectKind === 'PROJECT'
    ? `Сотрудник согласился участвовать ${projectPhrase(subjectTitle)}.`
    : `Сотрудник согласился на смену ${sharePhrase(subjectKind, subjectTitle)}.`
}
// became — three whole sentences (by subjectKind), not an assembly from fragment functions:
function acceptedLine(
  i18n: I18n,
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
): string {
  return i18n._(
    /* i18n */ {
      id: 'email.acceptedLine',
      message:
        '{subjectKind, select, ' +
        'PROJECT {Співробітник погодився брати участь у {subjectTitle, select, null {проєкті} other {проєкті «{subjectTitle}»}}.} ' +
        'PROJECT_SHARE {Співробітник погодився на зміну частки за {subjectTitle, select, null {проєктом} other {проєктом «{subjectTitle}»}}.} ' +
        'other {Співробітник погодився на зміну частки за замовчуванням.}}',
    },
    { subjectKind, subjectTitle },
  )
}
```

`projectPhrase`/`sharePhrase` as separate functions — **are removed** (not marked deprecated: they have exactly two callers, `acceptedLine`/`rejectedLine`, both rewritten by this step). `rejectedLine` — the same pattern, a separate function (audit §691's "two functions, not one with a decision parameter" — a MUTATION-GATE-confirmed reason, the comment in the file already explains; keep this architectural decision, do not fold it back into one function with a branch).

- [ ] **Step 6: Apply the Step 2-4 pattern to the other 8 emails**

The list — the whole `BODIES` (10 functions: `TRANSACTION_ADDED` ✓ Step 4, `TRANSACTION_STATUS_CHANGED`, `TEAM_MEMBER_ADDED`, `PROJECT_MEMBER_ADDED`, `TEAM_NEW_MEMBER`, `PROJECT_CONFIRM_REQUIRED`, `SHARE_CONFIRM_REQUIRED`, `DOCUMENT_SIGN_REQUIRED`, `APPROVAL_CONFIRMED` ✓ Step 5, `APPROVAL_REJECTED` ✓ Step 5). A snapshot test for each, on both locales (spec §8: "a snapshot of the subject and body on uk and en").

- [ ] **Step 7: The email subject typography** (analogous to Task 6 Step 10 — `«…»` for `uk`, `"…"` for `en`, already built into the Step 4/5 examples through the ICU message text itself, a separate parameter is not needed — the quotes are written directly in the `message` of each catalog locale).

- [ ] **Step 8: `notification-email.cron.ts` — the recipient's locale**

```bash
git grep -n "renderNotificationEmail" origin/main -- apps/api/src/notifications/notification-email.cron.ts
```

```ts
// was (presumably, without locale — check the exact call by the command above before the edit):
const email = renderNotificationEmail(source, opts)
// became:
const email = renderNotificationEmail(source, opts, recipientUser.locale)
```

Make sure `recipientUser` (or the equivalent) already carries `locale` in the DB selection of this cron — `users.locale` was added in Task 3 of stage 2 (already in `main`), but the cron's SELECT may not have included the column so far: check `select`/`with` in the query, add the field if absent.

- [ ] **Step 9: A snapshot test of the emails on both locales — the whole file**

```ts
// notification-email-copy.spec.ts — modeled on the existing DATA object (10 types), for each:
it.each(NEW_NOTIFICATION_TYPES)('%s renders on uk and en without literal Russian', (type) => {
  const uk = renderNotificationEmail(source(type, DATA[type]), opts, 'uk')
  const en = renderNotificationEmail(source(type, DATA[type]), opts, 'en')
  expect(uk.subject).not.toBe(en.subject)
  expect(uk.subject).toMatch(/[а-яіїєґ]/i) // contains Ukrainian letters, did not fall back to the fallback code
  expect(en.subject).not.toMatch(/[а-яіїєґ]/i)
})
```

The existing invariant checks (`startsWith('Запрос на')` etc.) are rewritten to a check by **structure** (the type is in `ACTION_REQUIRED_NOTIFICATION_TYPES` → the subject starts with the prefix from the catalog for the active locale, not with a literal — `i18n._(PREFIX_ID)`, comparing the result with a result, not with a Russian string, audit §693: "you will have to check the message identifier, not the rendered text").

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/notifications/notification-email-copy.ts apps/api/src/notifications/notification-email-copy.spec.ts \
  apps/api/src/notifications/notification-email.cron.ts
git commit -m "feat(api): render all 10 notification emails on recipient locale (uk/en), whole-sentence phrasing

ac_verified: 1"
```

---

## What is NOT included in this plan

- **`apps/web`** (except the already-mentioned integration points — `getApiErrorMessage`/`translateApiError`, which ALREADY read the whole registry by construction and require no edit when the codes are extended, and `axios-utils.ts`'s `translateZodError`, which Task 4 adds in its own PR — SPEC-H-1: the client render of a Zod-field error by code is part of track B's first PR, not deferred).
- **`apps/api/src/contact/**`, the public throw-sites of `vacancies`/`job-sourcing`/`resumes`** — landing-facing, read by `apps/landing`'s `errorKindForStatus` by status code, not by text (COPY-M-api-14, already the target scheme). The CRM-facing throw-sites of the same modules (if the controller carries `@Roles`) — migrate per the Track A pattern, check against the controller before starting Task 3.
- **Invoice PDFs** (`invoice-pdf.service.ts`) and **contracts** (`contract-pdf.service.ts`, `contract-rendering.ts`) — spec stage 5, starts after this plan (the shared catalog must exist). COPY-M-api-9/10 (the document language discrepancy) — a finding for stage 5, not here. `contract-rendering.ts`'s `COMPANY_REQUISITES_HEADING`/`'не указано'` (COPY-M-api-10) — also stage 5.
- **`resume-text-extraction.service.ts`/`resume-source.util.ts`** (COPY-M-api-12, the DOCX parser messages) — the error messages are not Zod and not an `HttpException` with a direct throw into the controller; a separate finding, not part of any Track of this plan; record as a backlog item, if not picked up by a separate task before the start of stage 6.
- **`invoice-pdf.service.ts`'s "ЗАКАЗЧИК" block** (COPY-L-api-15) — part of stage 5 (PDF).
- **`pending/pending.service.ts`'s `proposedByName: 'Неизвестно'`** (COPY-L-api-16) — cosmetics of DTO assembly without a direct throw/Zod message; not Track A/B/C/D by construction (this is neither an error nor a notification, but a fallback value of a response field) — a backlog item.
- **The Signal bot "+"** — outside the spec §5 boundaries, not reconsidered.
- **Contracts** — `uk` only (owner decision, spec §5), the UA\|EN logic — separately, later.

## Assumptions (A1 — reversible, ≤ one PR, recorded)

- The id namespace convention (`api-error.*`, `zod-error.*`, `notification.*`, `email.*`) — not enforced by types, purely conventional; the rollback = renaming the id in one PR, does not affect the runtime (the id — just a catalog key string).
- "Message = a raw enum, but the client already matches by it" (`CONTRACT_NOT_EDITABLE` and the like, Task 3 Step 1) — registered as codes under the same names instead of new names; the rollback = rename the code, the client updates in the same PR.
- `subjectPhrase`'s nested `select` (Task 6 Step 8) — if `lingui extract` does not parse the nesting, it unfolds into two flat messages; the choice is fixed in the PR body, the rollback is trivial (editing one file).
- `api-errors.ts` → the directory `api-errors/{base,auth-users-projects,finance-invoices,documents-contracts-notifications,index}.ts` (fix-round 1, SPEC-M-1) — the rollback = glue it back into one file in one PR, the external contract (`export * from './api-errors'` in `schemas/index.ts`, the names `API_ERROR_CODES`/`API_ERROR_MESSAGES`/`API_ERROR_PARAMS`/`API_ERROR_FALLBACK_EN`) does not change either at the split step or at a hypothetical rollback.
- `NOTIFICATION_TITLES` stays legacy (Template A, does not change the type) instead of a full move to `MessageDescriptor` (fix-round 1, SPEC-H-2) — the rollback in the other direction (finish removing the legacy, move the six producers + `NotificationSettingsTab.tsx` to `NOTIFICATION_TITLE_MESSAGES`) — a separate task, not this PR, not this plan; until it, both exports exist in parallel.

## Questions for the owner (A2)

**1. The locale of the invitation email, when the address is not yet confirmed.**
`personal-email-invite-mailer.service.ts` sends an invitation to an email for which there is not yet a `users` row with a `locale` (the user is just being created by the wizard — see audit §B "The email texts exist in two copies" and "There is no locale infrastructure on the server"). At the moment of sending, the recipient's locale is unknown to the system by any means (no cookie, no `Accept-Language` — this is not the recipient's HTTP request, this is an outgoing email).
➡️ **Recommend:** the locale of the creating admin (the one who enters the email in the wizard and most likely knows what language the new employee speaks) — as an explicit choice field in the user-creation wizard form (not an implicit fallback), the value is written into the `users.locale` of the new record right away. If the admin did not specify — `uk` (the spec default). Reversible: a form field, the rollback = remove the field, keep the hardcoded `uk`.
🔓 Reversible · silence → I take the recommendation, record it in the "Assumptions" of Task 7, the rollback = one PR (remove the choice field, keep the default).

**2. The `notifications.service.ts` logs — translate to English on the first touch (Task 3 Step 5) — confirm that this does not require a separate code-review circle.**
➡️ **Recommend:** yes, along the way — the `russian-language.md` rule already requires English logs, this is not a new decision but the execution of an existing one.
🔓 Reversible · silence → I do as recommended.

## Stage readiness check

- `git grep -nE "throw new [A-Za-z]*Exception\(" apps/api/src | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"` — 0 lines (except the explicitly documented exceptions in "What is NOT included").
- `git grep -cP "message:.*[А-Яа-яЁё]|\.(min|max|email|regex|refine|length)\([^)]*[А-Яа-яЁё]" packages/shared/src/schemas` — 0.
- In the canon registries (`*_MESSAGES`) there are no characters `ы`/`э`/`ъ`/`ё` — a marker distinguishing Russian and Ukrainian text where the general Cyrillic check (the item above) does not distinguish (SPEC-H-3 fix-round 2: the finding "Russian text was copied" contained not a single one of these letters in any of the seven examples — the general gate would not have caught it): `git grep -nE '[ыэъёЫЭЪЁ]' packages/shared/src/schemas` — 0 (except the legacy `NOTIFICATION_TITLES`, see Task 6 "Danger" — the only deliberate exception).
- `packages/shared/src/schemas/notification-registry.ts` — not a single NEW `Record<..., string>` with visible text; the legacy `NOTIFICATION_TITLES: Record<NewNotificationType, string>` — the only deliberate exception (SPEC-H-2, Template A, six external producers + `NotificationSettingsTab.tsx` stay on it until a separate task, see Task 6 "Danger"), the new canon `NOTIFICATION_TITLE_MESSAGES` — the only one that should grow further; all three "frozen" types are registered (`NEW_NOTIFICATION_TYPES` includes `INVOICE_SIGNED`/`INVOICE_SIGN_REQUIRED`/`VACANCY_APPLICATION`).
- `notification-email-copy.spec.ts` — a snapshot on `uk` and `en` for all 10 types, not a single `startsWith`/`toContain` on a Russian literal.
- `pnpm i18n:extract` is idempotent (the second run does not change `.po`), `copy-reviewer` — `PASS` on `uk` and `en` for each PR of the track.
- `security-reviewer` — `APPROVE` on the Task 1 PR (auth/users), Task 2 (finance/invoices).
- Both A2 questions are closed by the owner's answer OR the silence deadline passed and the recommendation is applied (recorded in "Assumptions").
