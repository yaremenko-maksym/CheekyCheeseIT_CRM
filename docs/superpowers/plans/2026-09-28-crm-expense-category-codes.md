# Expense Category Codes Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Russian free-text expense category stored at rest in `transactions.receiver_label` (for `type = 'EXPENSE'`) with stable, language-neutral codes `SERVICE` / `BANK_FEE` / `OTHER`, backed by a uk/en Lingui catalog, so the finance UI (wave i18n stage 3d, PR3) can render the label in the viewer's locale instead of persisting a localized string that new records would write in the operator's language.

**Architecture:** A stable enum + `MessageDescriptor` catalog lands in `@crm/shared`. The API keeps writing the category into the existing `transactions.receiver_label` column but now stores a **code**, not a Russian label; it accepts BOTH the new codes and the three legacy Russian dropdown values on write (transition window) and normalizes them to a code before persisting, and it exposes a read resolver that maps any stored value (code, legacy Russian, or unexpected) to a code for rendering. A single idempotent, fail-loud manual DDL rewrites the existing prod rows Russian→code, wired into `deploy.yml` the same PR it is added (repo invariant). No new column: `receiver_label` is reused because it already IS the expense category storage and no backend logic branches on its value.

**Tech Stack:** NestJS 11 + Fastify + Drizzle (PostgreSQL 16), Zod v4, `@lingui/core` 5.9.5 (`MessageDescriptor` + `.po` catalogs), Vitest (unit + realdb integration), manual SQL migration applied by `.github/workflows/deploy.yml` via `docker compose … exec -T postgres psql -v ON_ERROR_STOP=1`.

**Spec / decision source:**

- Owner decision 2026-09-27 (recorded in `.claude/tasks/` task-plan-expense-codes): a separate api+shared+DDL change, precondition for i18n stage 3d PR3, security-reviewer + DDL-review mandatory.
- Wave format reference: `docs/superpowers/plans/2026-09-27-crm-i18n-stage3d-web-finance.md` («Contested decision 1» + «Task 3»).
- Term canon: `CONTEXT.md` (finance-category row, COPY-L-fin-17) — «Комиссия» expense category → uk «Банківський збір» / en «Bank fee» («Комісія» is reserved in the glossary for the drop share).

---

## Global Constraints

- **Zod is SSOT.** All types flow from `@crm/shared`; no `any` — use `unknown` + `.parse()`. The new enum + schema live in `packages/shared/src/schemas/finance.ts` and are exported from the shared index.
- **No `pnpm.overrides`, no version bumps.** Lingui pinned `5.9.5` across the board (`version-pins.md`).
- **Language:** code / commits / PR body — English. Assistant reports to owner — Russian. Product strings — uk (default) + en via catalog; NO raw Russian literal shipped as a rendered label in migrated code.
- **Term canon (verbatim, do not paraphrase):**
  - `SERVICE` → uk «Оплата послуги», en «Service payment»
  - `BANK_FEE` → uk «Банківський збір», en «Bank fee» (NOT «Комісія» — reserved for drop share; NOT «Комиссия»)
  - `OTHER` → uk «Інше», en «Other»
  - `copy-reviewer` gives the final verdict per language (`Copy Review: PASS|ISSUES|BLOCK`) — these strings are proposals to confirm, not to invent past.
- **Prod financial data + irreversible migration → critical-path.** security-reviewer + a DDL review are MANDATORY before merge (`orchestration-routing.md` critical-path zones, `git-policy.md`). Autonomy A3 for the actual prod data rewrite.
- **DDL discipline (repo invariant):** a manual SQL file MUST be idempotent (applied on EVERY deploy — there is no applied-migrations registry), MUST run under `ON_ERROR_STOP=1`, and MUST be wired into `deploy.yml` in the SAME PR in all three places (rollback-preflight file list, SCP copy step, psql apply step). `scripts/devops/check-prod-ddl-wiring.py` enforces this. Mirror the shape and header of `apps/api/drizzle/manual/2026-09-20_user_locale.sql`.
- **guard-test-gate (FM-5):** `guard-test-gate.yml` fires only when a file matching `apps/api/src/finance/*.controller.ts` changes. This plan changes `transactions.service.ts` + shared schemas + a DDL file, NOT `transactions.controller.ts` (the controller only calls `schema.parse(body)` → `svc.*`, unchanged). So the gate is N/A. **If any task ends up editing `transactions.controller.ts`, that task MUST add a 403 RBAC integration spec in the same PR.**
- **Push discipline:** explicit `git add <files>`, `wip:` chunks, final commit carries `ac_verified:`. Feature-branch pushes use `DATABASE_URL= git push`.

---

## Reconnaissance findings (established, not assumptions)

These were verified read-only against the code and a scratch DB; they are the factual basis of every decision below.

1. **Write path.** `TransactionsService.createExpense` (in `apps/api/src/finance/transactions.service.ts`) writes `receiverLabel: data.category` verbatim into the `EXPENSE` row. `TransactionsService.adminUpdateTransaction` (route `@Patch(':id/admin-edit')`) writes `receiverLabel: data.category` on edit and records an audit `receiverLabel: { before, after }`.
2. **Read path.** The service maps the raw `tx.receiverLabel` into the transaction DTO (subject to counterparty masking, which overwrites it with `'CheekyCheeseIT'` for masked non-expense rows). The web `AdminEditTransactionDialog` seeds its category dropdown from `tx.receiverLabel ?? EXPENSE_CATEGORIES[0]`; `CreateTransactionDialog` sends `EXPENSE_CATEGORIES[0..2]`.
3. **The constant.** `apps/web/app/routes/_authenticated/finance/constants.ts` → `export const EXPENSE_CATEGORIES = ['Оплата сервиса', 'Комиссия', 'Прочее']`. These three Russian strings are the ONLY values the UI dropdown can send today.
4. **Schema is free-form, not an enum.** `packages/shared/src/schemas/finance.ts`: `createExpenseSchema.category = z.string().min(1).max(255)` and `adminUpdateTransactionSchema.category = z.string().min(1).max(255).optional()`. The DB column `transactions.receiver_label` is `varchar(255) NULL`. So the column accepts arbitrary strings; the 3-value restriction is UI-only.
5. **No backend logic branches on the category value.** A repo-wide search for the literal strings (`Оплата сервиса` / `Комиссия` / `Прочее`) outside tests found only the `EXPENSE_CATEGORIES` constant. Nothing compares, switches, or filters on the value — it is display-only. **This is why an in-place value migration is safe: it cannot break any equality logic.**
6. **`receiver_label` is shared with non-EXPENSE rows.** For income/payout/transfer rows it holds counterparty labels (`'CheekyCheeseIT'`, `'Счёт компании'`, senior/drop names). Therefore any migration MUST be scoped `WHERE type = 'EXPENSE'` and MUST NOT touch other types.
7. **The local `crm_db` is empty and prod is unreachable from here.** Confirmed `SELECT current_database()` → `crm_db` on the docker Postgres (PostgreSQL 16.15), which has 0 public tables; the native Homebrew `postgresql@15` service is stopped; prod has no SSH. The scratch DB `crm_db_scratch_i18n3d2pr2` (146 tx, 8 EXPENSE) shows EXPENSE `receiver_label` values `AWS Hosting` (×5), `Figma Business`, `GitHub Team`, `Оплата сервиса` — but those English vendor names are **seed data** (`apps/api/src/database/seed.ts` writes exactly `receiverLabel: 'AWS Hosting' / 'GitHub Team' / 'Figma Business'`), NOT production. **Therefore the real prod distinct-value set is UNKNOWN from this workspace and MUST be obtained by running Task 0's SELECT against prod before the DDL map is finalized.**

---

## Contested decision 1 — Reuse `receiver_label` vs a new `expense_category` column

**Recommendation: REUSE `receiver_label`.** Store the code in the existing column; do not add a column.

**Why reuse wins here:**

- For `EXPENSE` rows, `receiver_label` already IS the category storage (finding 1). It is not a description with a separate meaning being clobbered — the dropdown value has always been the only thing written there for expenses.
- No backend logic branches on the value (finding 5), so replacing Russian strings with codes changes nothing except the bytes displayed. The read resolver + catalog turn those bytes back into a localized label at render time.
- A new column would mean: a new enum type, a new Drizzle column, dual-write, a read that falls back across two columns, and a data backfill anyway — strictly more surface for zero data-safety benefit, because the reuse path is made non-destructive by the fail-loud DDL (Contested decision 3) rather than by hoarding the old value in a second column.
- Owner framed the task as "migrate the Russian values" (an in-place rewrite), which is the reuse shape.

**When to switch to a new column instead (decision gate):** if Task 0's prod SELECT reveals that `EXPENSE` `receiver_label` holds free-form _descriptions_ that carry information beyond the category (e.g. genuine per-vendor names an operator typed and relies on), then rewriting them to a 3-value code destroys data. In that case, add a nullable `transactions.expense_category` enum column, keep `receiver_label` as the free-form description, and dual-read (`expense_category ?? resolveLegacy(receiver_label)`). **This branch is contingent on Task 0's finding and must be escalated to the owner (A3) before proceeding, because it changes the schema and the read path.** The reconnaissance suggests prod expenses came through the 3-value dropdown, but the actual distinct set is unverified from here (finding 7).

---

## Contested decision 2 — Write-side back-compat during the cross-PR window

This change is a precondition for PR3 (the web finance i18n), which ships LATER. Between this deploy and PR3's deploy, the OLD web bundle is still live and still sends the three Russian dropdown values. If the API tightened `category` to codes-only, every expense create/edit from the still-deployed old UI would 400 until PR3 ships.

**Recommendation:** the API accepts BOTH shapes on write and normalizes to a code before persisting. `category` becomes a Zod schema that accepts `SERVICE | BANK_FEE | OTHER` OR the three legacy Russian strings and `.transform`s the legacy strings to their code. Anything else → validation error (the only callers are our own frontends, which never send anything else). After PR3 ships codes-only, this union is harmless (codes still pass). A follow-up cleanup task (out of scope here) can drop the legacy arm once PR3 is deployed and verified.

---

## Contested decision 3 — DDL handling of unexpected values (fact-finding-gated + fail-loud)

The DDL rewrites `EXPENSE` `receiver_label` Russian→code. The three known mappings are fixed. The risk is a value the map does not cover (finding 7: prod actuals unknown from here).

**Recommendation:**

1. **Task 0 runs first** (prod SELECT, read-only) and produces the exact distinct set. The DDL map is authored from that set — so no _known_ value is missed at authoring time.
2. The DDL maps the confirmed Russian values → codes (idempotent: re-running matches nothing after the first pass).
3. **After the UPDATEs, the DDL asserts** that no `EXPENSE` row remains with a `receiver_label` outside `{SERVICE, BANK_FEE, OTHER}` — if any remain, `RAISE EXCEPTION` with the offending values, aborting the transaction (`ON_ERROR_STOP=1` fails the deploy loudly). This guards the gap between Task 0's SELECT and the actual apply (a value that appeared after fact-finding), and refuses silent data loss.

**Why fail-loud, not silent `→ OTHER`:** silently bucketing an unknown into `OTHER` on irreversible financial data, with the owner AFK, is exactly the class of change that should stop and ask. A blocked deploy that prints "these 2 expense rows have an unmapped label" is cheap; a silent mislabel discovered months later in an audit is not. The assert will not spuriously fire in the normal case, because the only values reachable via the dropdown are the three known ones and, post-deploy, the codes themselves.

**Alternative if the owner prefers no deploy-block:** replace the `RAISE EXCEPTION` with an `UPDATE … SET receiver_label = 'OTHER' WHERE type='EXPENSE' AND receiver_label NOT IN (<mapped>, 'SERVICE','BANK_FEE','OTHER')` plus a `RAISE NOTICE` listing what was rebucketed. This is idempotent and never blocks, at the cost of silent loss of the original unmapped string. **Recommended only if Task 0 confirms the sole values are the three known strings (making the branch dead anyway).**

---

## Contested decision 4 — One PR or two, and deploy order

**Recommendation: ONE PR**, containing both zones (Coder: shared + api + the `.sql` file + specs; DevOps: `deploy.yml` wiring), because:

- The repo invariant (`check-prod-ddl-wiring.py`) requires a manual `.sql` file to be wired into `deploy.yml` in the SAME PR it is added — a DDL-only second PR cannot exist without its wiring, and splitting code from wiring buys nothing.
- The write-side back-compat (Contested decision 2) and the read resolver make the single-deploy window non-breaking: even in the brief in-deploy moment where data has flipped to codes but a request hits an old process, the value is display-only and the old UI simply shows the raw code or defaults the dropdown — no crash, no data corruption (unlike a required-column migration such as `2026-09-20_user_locale.sql`, which MUST ship with its image).
- Owner phrased it as "a separate api+shared+DDL PR" (singular).

**Deploy order (within the one deploy run):** the new image (with the read resolver + write normalization) becomes the live process and the idempotent DDL applies as part of the same deploy; after the run completes, the new code is live AND the data is codes, so all steady-state reads are correct. The task's "code-with-back-compat before DDL" requirement is satisfied in substance by the back-compat read (the code understands both shapes regardless of apply order).

**Conservative alternative (two PRs), if security/DDL review wants the strongest ordering guarantee:** PR-A = shared + api back-compat + tests (no data touched); deploy and verify in prod; then PR-B = the `.sql` + `deploy.yml` wiring + migration integration spec. This guarantees the back-compat code is live and verified before any row is rewritten, at the cost of two deploy cycles. Document the chosen option in the PR body and let the DDL reviewer confirm.

---

## Task 0: Fact-finding — real prod `receiver_label` distinct set (BLOCKING, read-only)

**Owner / DevOps runs this against PROD before the DDL map is frozen. It is read-only (`live-db-access.md`: SELECT allowed) and produces the map that Task 4's SQL encodes.**

**Files:** none (a query + a recorded result pasted into the PR description / this plan's map).

- [ ] **Step 1: Confirm the database before any query**

```sql
SELECT current_database(), version();
```

Expected: `crm_db` on the production Postgres. If it is anything else, STOP.

- [ ] **Step 2: Enumerate every distinct EXPENSE receiver_label with counts (byte-exact)**

```sql
SELECT
  '[' || receiver_label || ']' AS labeled_exact,
  length(receiver_label)        AS len,
  count(*)                      AS n
FROM transactions
WHERE type = 'EXPENSE'
GROUP BY receiver_label
ORDER BY n DESC;
```

The `[...]` wrapper + `length` surface leading/trailing whitespace and case variants that a bare value hides. Record EVERY row.

- [ ] **Step 3: Sanity-check nothing else uses these codes already and no non-EXPENSE row would be caught**

```sql
-- confirm the code words are not already present as EXPENSE labels (idempotency pre-check)
SELECT receiver_label, count(*) FROM transactions
WHERE type = 'EXPENSE' AND receiver_label IN ('SERVICE','BANK_FEE','OTHER')
GROUP BY receiver_label;

-- confirm the migration's WHERE (type='EXPENSE') is the correct scope: how many EXPENSE rows total
SELECT count(*) FROM transactions WHERE type = 'EXPENSE';
```

- [ ] **Step 4: Freeze the map**

Fill this table from Step 2 (this is the ONLY source of the DDL's UPDATE list). Do NOT include personal data — only category strings + counts.

| Prod `receiver_label` (verbatim)         | count | → code                               |
| ---------------------------------------- | ----- | ------------------------------------ |
| `Оплата сервиса`                         | ?     | SERVICE                              |
| `Комиссия`                               | ?     | BANK_FEE                             |
| `Прочее`                                 | ?     | OTHER                                |
| _(any unexpected value found in Step 2)_ | ?     | **escalate to owner — do not guess** |

If Step 2 returns ONLY the three known strings (± whitespace/case variants that Step 2 exposes), proceed with reuse + fail-loud (Contested decision 1/3). If it returns free-form descriptions, invoke the new-column branch of Contested decision 1 and escalate (A3).

---

## Task 1: Shared — `EXPENSE_CATEGORY` enum, catalog, and Zod schema

**Files:**

- Modify: `packages/shared/src/schemas/finance.ts` (add enum, catalog, category schema, legacy map; retarget `createExpenseSchema.category` and `adminUpdateTransactionSchema.category`)
- Modify: `packages/shared/src/index.ts` (export new symbols, if not re-exported via `schemas`)
- Modify: `packages/shared/src/i18n/locales/uk/messages.po` and `packages/shared/src/i18n/locales/en/messages.po` (via `pnpm i18n:extract`, then fill en)
- Test: `packages/shared/src/schemas/finance.expense-category.spec.ts` (new)

**Interfaces:**

- Produces (consumed by Task 2 api and by PR3 web):
  - `export const EXPENSE_CATEGORY_CODES = ['SERVICE', 'BANK_FEE', 'OTHER'] as const`
  - `export type ExpenseCategoryCode = (typeof EXPENSE_CATEGORY_CODES)[number]`
  - `export const expenseCategoryCodeSchema: z.ZodType<ExpenseCategoryCode>` (`z.enum(EXPENSE_CATEGORY_CODES)`)
  - `export const EXPENSE_CATEGORY_MESSAGES: Record<ExpenseCategoryCode, MessageDescriptor>` (uk canon text, extracted for Lingui)
  - `export const LEGACY_EXPENSE_LABEL_TO_CODE: Record<string, ExpenseCategoryCode>` — the exact map from Task 0 (`'Оплата сервиса' → 'SERVICE'`, `'Комиссия' → 'BANK_FEE'`, `'Прочее' → 'OTHER'`)
  - `export function resolveExpenseCategoryCode(stored: string | null | undefined): ExpenseCategoryCode` — read resolver: a code → itself; a legacy Russian label → its code; anything else (incl. null) → `'OTHER'` (display-only, never throws)
  - `export const expenseCategoryWriteSchema` — accepts a code OR a legacy Russian string and `.transform`s to `ExpenseCategoryCode` (Contested decision 2)

- [ ] **Step 1: Write the failing test**

`packages/shared/src/schemas/finance.expense-category.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  EXPENSE_CATEGORY_CODES,
  EXPENSE_CATEGORY_MESSAGES,
  LEGACY_EXPENSE_LABEL_TO_CODE,
  resolveExpenseCategoryCode,
  expenseCategoryWriteSchema,
} from './finance'

describe('expense category codes', () => {
  it('has exactly three stable codes', () => {
    expect(EXPENSE_CATEGORY_CODES).toEqual(['SERVICE', 'BANK_FEE', 'OTHER'])
  })

  it('maps each legacy Russian label to its code (map from prod fact-finding)', () => {
    expect(LEGACY_EXPENSE_LABEL_TO_CODE).toEqual({
      'Оплата сервиса': 'SERVICE',
      Комиссия: 'BANK_FEE',
      Прочее: 'OTHER',
    })
  })

  it('resolver: code passes through', () => {
    expect(resolveExpenseCategoryCode('SERVICE')).toBe('SERVICE')
    expect(resolveExpenseCategoryCode('BANK_FEE')).toBe('BANK_FEE')
    expect(resolveExpenseCategoryCode('OTHER')).toBe('OTHER')
  })

  it('resolver: legacy Russian resolves to code', () => {
    expect(resolveExpenseCategoryCode('Оплата сервиса')).toBe('SERVICE')
    expect(resolveExpenseCategoryCode('Комиссия')).toBe('BANK_FEE')
    expect(resolveExpenseCategoryCode('Прочее')).toBe('OTHER')
  })

  it('resolver: unknown / null → OTHER (display-only, never throws)', () => {
    expect(resolveExpenseCategoryCode('AWS Hosting')).toBe('OTHER')
    expect(resolveExpenseCategoryCode(null)).toBe('OTHER')
    expect(resolveExpenseCategoryCode(undefined)).toBe('OTHER')
  })

  it('write schema accepts a code and returns it', () => {
    expect(expenseCategoryWriteSchema.parse('BANK_FEE')).toBe('BANK_FEE')
  })

  it('write schema accepts a legacy Russian label and normalizes to code', () => {
    expect(expenseCategoryWriteSchema.parse('Комиссия')).toBe('BANK_FEE')
  })

  it('write schema rejects an arbitrary string', () => {
    expect(expenseCategoryWriteSchema.safeParse('freeform').success).toBe(false)
  })

  it('every code has a uk MessageDescriptor with the canonical term', () => {
    expect(EXPENSE_CATEGORY_MESSAGES.BANK_FEE.message).toBe('Банківський збір')
    expect(EXPENSE_CATEGORY_MESSAGES.SERVICE.message).toBe('Оплата послуги')
    expect(EXPENSE_CATEGORY_MESSAGES.OTHER.message).toBe('Інше')
  })
})
```

> Note: the `EXPENSE_CATEGORY_MESSAGES.*.message` assertions verify the uk source string. Because the compiled catalog wins over the inline `message` at render time (see `notification-registry.ts`'s note), these assertions pin the SOURCE that `i18n:extract` emits, not the rendered output — that is deliberate and is what makes the mutation gate see a change to the string.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crm/shared test finance.expense-category`
Expected: FAIL (symbols not exported yet).

- [ ] **Step 3: Implement in `finance.ts`**

Mirror the `notification-registry.ts` idiom exactly — a single exported `Record<…, MessageDescriptor>` with `/* i18n */ { id, message }` property values (so `pnpm i18n:extract`'s babel plugin sees them; it does NOT see `const X = /* i18n */ {…}` single-declarations):

```ts
import type { MessageDescriptor } from '@lingui/core'
// ...
export const EXPENSE_CATEGORY_CODES = ['SERVICE', 'BANK_FEE', 'OTHER'] as const
export type ExpenseCategoryCode = (typeof EXPENSE_CATEGORY_CODES)[number]
export const expenseCategoryCodeSchema = z.enum(EXPENSE_CATEGORY_CODES)

export const EXPENSE_CATEGORY_MESSAGES: Record<ExpenseCategoryCode, MessageDescriptor> = {
  SERVICE: /* i18n */ { id: 'finance.expenseCategory.SERVICE', message: 'Оплата послуги' },
  BANK_FEE: /* i18n */ { id: 'finance.expenseCategory.BANK_FEE', message: 'Банківський збір' },
  OTHER: /* i18n */ { id: 'finance.expenseCategory.OTHER', message: 'Інше' },
}

// Map frozen from Task 0's prod SELECT. Extend ONLY with values confirmed present in prod.
export const LEGACY_EXPENSE_LABEL_TO_CODE: Record<string, ExpenseCategoryCode> = {
  'Оплата сервиса': 'SERVICE',
  Комиссия: 'BANK_FEE',
  Прочее: 'OTHER',
}

export function resolveExpenseCategoryCode(stored: string | null | undefined): ExpenseCategoryCode {
  if (stored == null) return 'OTHER'
  if ((EXPENSE_CATEGORY_CODES as readonly string[]).includes(stored))
    return stored as ExpenseCategoryCode
  return LEGACY_EXPENSE_LABEL_TO_CODE[stored] ?? 'OTHER'
}

export const expenseCategoryWriteSchema = z
  .string()
  .min(1)
  .max(255)
  .transform((v, ctx) => {
    if ((EXPENSE_CATEGORY_CODES as readonly string[]).includes(v)) return v as ExpenseCategoryCode
    const mapped = LEGACY_EXPENSE_LABEL_TO_CODE[v]
    if (mapped) return mapped
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown expense category' })
    return z.NEVER
  })
```

Then retarget the two existing fields:

- `createExpenseSchema.category`: `z.string().min(1).max(255)` → `expenseCategoryWriteSchema`
- `adminUpdateTransactionSchema.category`: `z.string().min(1).max(255).optional()` → `expenseCategoryWriteSchema.optional()`

Export all new symbols from the shared entrypoint.

- [ ] **Step 4: Extract + fill catalogs**

Run: `pnpm i18n:extract` (adds the three `finance.expenseCategory.*` ids to `uk/messages.po` and `en/messages.po`). Fill the `en` translations: `Service payment` / `Bank fee` / `Other`. Confirm uk carries the canonical source.

- [ ] **Step 5: Run tests + typecheck + lint + i18n compile**

Run: `pnpm --filter @crm/shared test finance.expense-category && pnpm --filter @crm/shared typecheck && pnpm i18n:compile`
Expected: PASS. Also `mcp__eslint__lint-files` on the changed `.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/finance.ts packages/shared/src/schemas/finance.expense-category.spec.ts packages/shared/src/index.ts packages/shared/src/i18n/locales/uk/messages.po packages/shared/src/i18n/locales/en/messages.po
git commit -m "feat(shared): expense category codes enum + uk/en catalog + write/read resolvers"
```

---

## Task 2: API — write codes, accept legacy on write, keep read raw (resolver used by PR3)

**Files:**

- Modify: `apps/api/src/finance/transactions.service.ts` (`createExpense`, `adminUpdateTransaction` — `data.category` is now a normalized `ExpenseCategoryCode` off the schema, still written to `receiverLabel`; no functional change beyond the value being a code)
- Test: `apps/api/src/finance/transactions.expense-category.spec.ts` (new unit spec with a mocked repository — the mutation gate runs unit only, `mutation-gate-integration-specs.md`)
- Test: extend `apps/api/src/finance/transactions.expense-receipt.spec.ts` if it already covers `createExpense` shape (reuse-first: check before adding a parallel spec)

**Interfaces:**

- Consumes from Task 1: `expenseCategoryWriteSchema` (already wired via the controller's `createExpenseSchema.parse` / `adminUpdateTransactionSchema.parse` — so `data.category` arrives as a code). No controller edit (keeps guard-test-gate N/A).
- Produces: `EXPENSE` rows whose `receiver_label` is a code; audit-log `receiverLabel: { before, after }` now records codes.

- [ ] **Step 1: Write the failing test (unit double, mocked DB)**

`apps/api/src/finance/transactions.expense-category.spec.ts` — using the existing `makeTransactionsService` test helper (`apps/api/src/finance/__test-helpers__/make-transactions-service.ts`), assert that:

```ts
// createExpense with category 'BANK_FEE' inserts receiverLabel: 'BANK_FEE'
// createExpense with legacy 'Комиссия' (parsed by schema → 'BANK_FEE') inserts receiverLabel: 'BANK_FEE'
```

Capture the `insert(...).values({...})` payload via the helper's captured-where/values seam (see `makeServiceCapturingTransactionsWhere` referenced in the helper) and assert `receiverLabel === 'BANK_FEE'`. Include the legacy-string case by parsing through `createExpenseSchema` first (so the test exercises the real write schema, not a hand-built object).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crm/api test transactions.expense-category`
Expected: FAIL until the schema retarget from Task 1 is present in the built `@crm/shared` (run `pnpm --filter @crm/shared build` first if the API resolves shared from dist).

- [ ] **Step 3: Confirm the service needs no change beyond the value**

`createExpense`/`adminUpdateTransaction` already write `receiverLabel: data.category`. Because the schema now hands them a code, the stored value is a code with NO service edit. Verify by reading the two write sites; add a one-line comment at each pointing to this plan and `resolveExpenseCategoryCode` for the read side. Do NOT change the controller.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @crm/api test transactions.expense-category && pnpm --filter @crm/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/finance/transactions.service.ts apps/api/src/finance/transactions.expense-category.spec.ts
git commit -m "feat(api): expense category stored as code via shared write schema (legacy accepted, normalized)"
```

> **PR3 note (out of scope, documented for the executor):** the web finance PR3 replaces `EXPENSE_CATEGORIES` (Russian array) with `EXPENSE_CATEGORY_CODES` for the dropdown `value`, renders each option's label via `EXPENSE_CATEGORY_MESSAGES` + the existing `renderMessage(i18n, …)` helper, and seeds `AdminEditTransactionDialog`'s selected category from `resolveExpenseCategoryCode(tx.receiverLabel)` instead of `tx.receiverLabel ?? EXPENSE_CATEGORIES[0]`. That is what makes the resolver's legacy + unknown handling matter during the pre-DDL window. It is NOT part of this plan's PR.

---

## Task 3: Migration integration spec (idempotency + correctness, applied twice)

**Files:**

- Test: `apps/api/src/finance/expense-category-migration.integration.spec.ts` (new — mirror `apps/api/src/**/user-locale-migration.integration.spec.ts` shape: spin a real Postgres via the integration harness, seed EXPENSE rows with legacy + code + a non-EXPENSE row, apply the `.sql` file TWICE, assert the end state and that the second apply is a no-op)

**Interfaces:**

- Consumes: the SQL file from Task 4 (`apps/api/drizzle/manual/2026-09-28_expense_category_codes.sql`). This spec and Task 4 are co-dependent — write them together; the spec is what proves the SQL before it ever runs on prod.

- [ ] **Step 1: Write the failing test**

Seed (real DB, scoped scratch DB — never `crm_db`, `live-db-access.md`):

- EXPENSE rows: one each `receiver_label` = `'Оплата сервиса'`, `'Комиссия'`, `'Прочее'`, plus one already `'OTHER'` (idempotency), plus one already `'SERVICE'`.
- One non-EXPENSE row (e.g. `SENIOR_INCOME`) with `receiver_label = 'CheekyCheeseIT'`.

Apply the migration file, then assert:

```
EXPENSE rows: receiver_label ∈ {SERVICE, BANK_FEE, OTHER} for every row; the three legacy rows became SERVICE/BANK_FEE/OTHER; the already-code rows unchanged.
non-EXPENSE row: receiver_label still 'CheekyCheeseIT' (untouched — scope guard).
```

Apply the file a SECOND time and assert nothing changes (same counts) and it does not raise.
Add a negative case: seed an EXPENSE row with an unmapped `receiver_label` and assert the fail-loud branch RAISES on apply (if the fail-loud variant is chosen per Contested decision 3).

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @crm/api test expense-category-migration` → FAIL (no SQL yet).

- [ ] **Step 3:** implement is Task 4 (the SQL). Return here after Task 4.

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit** (together with Task 4's SQL):

```bash
git add apps/api/src/finance/expense-category-migration.integration.spec.ts apps/api/drizzle/manual/2026-09-28_expense_category_codes.sql
git commit -m "test(api): expense category migration idempotency + scope + fail-loud (realdb)"
```

---

## Task 4: The idempotent, fail-loud manual DDL (Coder authors; DevOps wires)

**Files:**

- Create: `apps/api/drizzle/manual/2026-09-28_expense_category_codes.sql`

**Interfaces:**

- Consumed by: Task 3 spec (applied twice) and Task 5 (`deploy.yml` wiring). The UPDATE list is frozen from Task 0.

- [ ] **Step 1: Write the SQL** (mirror the header discipline of `2026-09-20_user_locale.sql`: Context, idempotency rationale, How to apply, Wired-into note, Data risk, VERIFY block; no personal data read/printed).

```sql
-- =============================================================================
-- transactions.receiver_label (type='EXPENSE') — migrate Russian category
-- labels to stable codes (SERVICE / BANK_FEE / OTHER).
--   Plan: docs/superpowers/plans/2026-09-28-crm-expense-category-codes.md
--   Precondition for i18n stage 3d PR3.
--
-- Idempotent: re-running matches nothing after the first pass (every deploy
-- applies every manual/*.sql — there is no applied-migrations registry).
-- Scope guard: WHERE type='EXPENSE' ONLY — non-EXPENSE rows keep counterparty
-- labels in receiver_label and MUST NOT be touched.
-- Map frozen from prod fact-finding (Task 0). No data is read/printed.
-- Data risk: category strings become codes; rendered back to a localized label
-- by resolveExpenseCategoryCode + the uk/en catalog. Fail-loud on any unmapped
-- EXPENSE value (see final DO block) — refuses silent data loss.
-- =============================================================================

BEGIN;

UPDATE transactions SET receiver_label = 'SERVICE'
  WHERE type = 'EXPENSE' AND receiver_label = 'Оплата сервиса';

UPDATE transactions SET receiver_label = 'BANK_FEE'
  WHERE type = 'EXPENSE' AND receiver_label = 'Комиссия';

UPDATE transactions SET receiver_label = 'OTHER'
  WHERE type = 'EXPENSE' AND receiver_label = 'Прочее';

-- <ADD any additional confirmed mappings from Task 0 here, same shape>

-- Fail-loud guard: no EXPENSE row may remain outside the code set.
DO $$
DECLARE
  bad_count integer;
  bad_sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT '[' || receiver_label || ']', ', ')
    INTO bad_count, bad_sample
  FROM transactions
  WHERE type = 'EXPENSE'
    AND (receiver_label IS NULL OR receiver_label NOT IN ('SERVICE','BANK_FEE','OTHER'));
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'expense-category migration: % EXPENSE row(s) have an unmapped receiver_label: %. Extend the map in this file (and packages/shared LEGACY_EXPENSE_LABEL_TO_CODE) from Task 0 fact-finding before deploying.',
      bad_count, bad_sample;
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT receiver_label, count(*) FROM transactions
--    WHERE type='EXPENSE' GROUP BY receiver_label ORDER BY receiver_label;
--   Expected: only SERVICE / BANK_FEE / OTHER. No personal data is read.
-- =============================================================================
```

> If the owner chooses the non-blocking variant (Contested decision 3 alternative), replace the `DO $$ … RAISE EXCEPTION` block with an `UPDATE … SET receiver_label='OTHER' WHERE … NOT IN (…)` plus `RAISE NOTICE`. Keep the choice consistent with the negative case in Task 3.

- [ ] **Step 2:** Return to Task 3 Step 4 and make the integration spec green (apply twice).

- [ ] **Step 3: Commit** — committed with Task 3.

---

## Task 5: DevOps — wire the DDL into `deploy.yml` (3 places) + wiring guard

**Files:**

- Modify: `.github/workflows/deploy.yml` — add `apps/api/drizzle/manual/2026-09-28_expense_category_codes.sql` to (a) the rollback-preflight `for FILE in \` hard-required list, (b) the `Copy compose files and DDL via SCP` `source:` list, (c) the psql apply step in the deploy job's SSH script (mirror the `2026-09-20_user_locale.sql` apply line: `docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < .../2026-09-28_expense_category_codes.sql`).

**Interfaces:**

- Consumes: the exact filename from Task 4. This is DevOps zone (`deploy.yml`). It MUST be in the SAME PR as Task 4's `.sql` (`check-prod-ddl-wiring.py`).

- [ ] **Step 1: Add the filename to all three places** in `deploy.yml`, following the existing `2026-09-20_user_locale.sql` lines as the template for each place.

- [ ] **Step 2: Run the wiring guard**

Run: `python3 scripts/devops/check-prod-ddl-wiring.py`
Expected: PASS (COPY + APPLY both present for the new file).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "infra(deploy): wire 2026-09-28 expense-category-codes DDL (preflight + scp + psql apply)"
```

---

## Task 6: Verification, review gates, and PR

- [ ] **Step 1: Full local gates** — `pnpm typecheck && pnpm lint && pnpm --filter @crm/shared test && pnpm --filter @crm/api test` (integration specs need a scratch Postgres; run the migration integration spec explicitly). One foreground command per long run.
- [ ] **Step 2: Mutation gate** on the new shared + api unit specs (the migration integration spec is invisible to the gate by design — `mutation-gate-integration-specs.md`; the unit double in Task 2 is what the gate sees).
- [ ] **Step 3: `i18n:extract` drift check** — no uncommitted `.po` changes after extract; en filled.
- [ ] **Step 4: Confirm guard-test-gate N/A** — `git diff --name-only origin/main` shows no `apps/api/src/finance/*.controller.ts`. If it does, add the 403 spec.
- [ ] **Step 5: PR** — one PR, English body, label `ai-review-ready`. Body states: reuse-vs-column decision, one-vs-two-PR decision + deploy order, the frozen Task 0 map, and that security-reviewer + a DDL review are required (critical-path finance + irreversible migration). End with the 🤖 attribution line.
- [ ] **Step 6: Review** — security-reviewer + DDL review MANDATORY; resolve all H/M/L before merge; merge only on owner's explicit "merge it".

---

## Decomposition summary (zones)

| Task | Zone                                    | Deliverable                                                        |
| ---- | --------------------------------------- | ------------------------------------------------------------------ |
| 0    | Owner / DevOps (read-only prod SELECT)  | Frozen Russian→code map + confirmation reuse is safe               |
| 1    | Coder (`packages/shared`)               | Enum + catalog + write/read resolvers + Zod retarget + uk/en `.po` |
| 2    | Coder (`apps/api`)                      | Category stored as code (no controller change) + unit double       |
| 3    | Coder/AutoTest (`apps/api`)             | Migration idempotency/scope/fail-loud integration spec             |
| 4    | Coder (`apps/api/drizzle/manual`)       | The idempotent fail-loud `.sql`                                    |
| 5    | DevOps (`.github/workflows/deploy.yml`) | 3-place DDL wiring + `check-prod-ddl-wiring.py` green              |
| 6    | Coder + reviewers                       | Gates, PR, security + DDL review                                   |

**One PR, two agent-zones (Coder + DevOps).** security-reviewer + DDL-review mandatory.

## Self-review

- **Spec coverage:** fact-finding (Task 0), shared enum+catalog+Zod (Task 1), api write/read back-compat (Task 2, resolver for PR3), idempotent fail-loud DDL + spec (Tasks 3–4), deploy wiring (Task 5), decomposition + one/two-PR + deploy order (Contested decisions 4). All task-file bullets mapped.
- **Placeholder scan:** the only intentional "fill from Task 0" is the DDL map + the `LEGACY_EXPENSE_LABEL_TO_CODE` extension, which is a data fact that cannot be invented from this workspace (prod unreachable, finding 7) and is gated by the fail-loud assert.
- **Type consistency:** `ExpenseCategoryCode`, `EXPENSE_CATEGORY_CODES`, `EXPENSE_CATEGORY_MESSAGES`, `LEGACY_EXPENSE_LABEL_TO_CODE`, `resolveExpenseCategoryCode`, `expenseCategoryWriteSchema` used consistently across Tasks 1–3 and the PR3 note.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
