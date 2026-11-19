# Role-AI relevance gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI role calls go only to PENDING vacancies that could become a LEAD for the current roster; the rest get a terminal `OUT_OF_SCOPE` status; foreign developer nouns are classified by rule.

**Architecture:** A pure gate (`funnel/role-scope-gate.ts`) runs inside `recomputeOpportunity` (roster + revision + roles all loaded under the row lock) and flips PENDING ↔ OUT_OF_SCOPE before the verdict. OUT_OF_SCOPE is hidden like PENDING. Prod gets the widened CHECK through a manual SQL file wired into deploy. The rule classifier learns de/fr/es/it/nl/pl developer nouns and moves to `rc.2`.

**Tech Stack:** NestJS 11, Drizzle (raw `sql`), Vitest, PostgreSQL manual DDL, GitHub Actions deploy.

**Spec:** `docs/superpowers/specs/2026-11-19-role-ai-spend-design.md`

## Global Constraints

- New status literal: `'OUT_OF_SCOPE'`; evidence reason code: `'ROLE_OUT_OF_SCOPE'`.
- Classifier version: `ROLE_CLASSIFIER_VERSION = 'rc.2'`; no `job_role_classifications` copy-forward.
- Gate inputs: title + `stack_keywords` + layer-1 verdict + roster roles only — never the description.
- Reachable roles = union of `widenRoles(profile.roles)` (`@crm/shared`) over `RosterInputs.profiles`.
- No change to `JOB_ROLE_AI_DAILY_BUDGET`, `ROLE_AI_PASS_LIMIT`, crons, or the worker prompt.
- Prod DDL only via `apps/api/drizzle/manual/2026-11-19_role_status_out_of_scope.sql`, applied by deploy before the app swap; never by hand.
- One PR, squash-merged: Task 1 (`rc.2`) is never deployed without Tasks 2–4. The bump re-enqueues the backlog, and that recompute must already run the gate.
- Any later change to the gate's signal lists bumps `ROLE_CLASSIFIER_VERSION`: OUT_OF_SCOPE rows have no other staleness hook (the SENIOR fan-out re-gates only on roster change). State this in the gate file header.
- Integration specs run on a scratch DB only (`live-db-access.md`); push with `DATABASE_URL=` empty.

## Review Focus

1. Empty roster (no SENIOR with roles): every unclassified row must go OUT_OF_SCOPE, and come back to PENDING when a senior gains a role (SENIOR fan-out) — test in Task 3.
2. Invalid / missing canonical revision: the gate must not run and must not write a status (evaluate returns INVALID_INPUT) — test in Task 3.
3. A row that is RULE / NON_IT / AI / UNCLEAR is never touched by the gate — test in Task 3.
4. A freshly ingested PENDING row not yet recomputed must not be sent to the AI — test in Task 4.
5. Reconciliation sweep on a row with old `ROLE_PENDING` evidence and status OUT_OF_SCOPE recomputes once, then stops — test in Task 4.

---

### Task 1: Foreign developer nouns, classifier `rc.2`

**Files:**

- Modify: `apps/api/src/job-sourcing/funnel/role-classifier.ts` (`ROLE_CLASSIFIER_VERSION`, `JOB_NOUN`, `ENG_NOUN`, `HINT_NOUN`, `GENERIC_KEYWORDS`, `GENERIC_NOUN`; export `GENERIC_KEYWORDS`, `TECH_HINTS`, `EQ_BOARD_CATEGORIES`)
- Test: `apps/api/src/job-sourcing/funnel/__fixtures__/role-titles.ts`, `funnel/role-classifier.spec.ts`
- Grep and update every spec/fixture asserting `'rc.1'`.

**Interfaces:**

- Produces: exported `GENERIC_KEYWORDS: readonly RegExp[]`, `TECH_HINTS: readonly { pattern: RegExp; role: TechnicalRole | null }[]` (keep the existing element type), `EQ_BOARD_CATEGORIES: ReadonlyMap<string, TechnicalRole>` (existing type: one role per tag).

- [ ] **Step 1: Add fixture rows** (title → expected):
  - `java backend entwickler (m/w/d)` → ROLES [BACKEND_ENGINEER]
  - `java full-stack entwickler (m/w/d)` → ROLES [FULLSTACK_ENGINEER]
  - `softwareentwickler c++ / qt` → ROLES [SOFTWARE_ENGINEER] (or the C++ hint role the table already gives — pin what the rule returns)
  - `werkstudent softwareentwicklung (m/w/d)` → ROLES [SOFTWARE_ENGINEER]
  - `mobile applikationsentwickler (m/w/d)` → pin what the rule returns (expected: the `mobile` tech hint → CROSS_PLATFORM_MOBILE_ENGINEER once `HINT_NOUN` knows `entwickler`; no new `ROLE_PATTERNS` entry)
  - `développeur backend php (alternance 12 mois)` → ROLES [BACKEND_ENGINEER]
  - `desarrollador de software | acsel` → ROLES [SOFTWARE_ENGINEER]
  - `programista java` → ROLES [BACKEND_ENGINEER]
  - guards: `expansion manager france / développeur.se immobilier - nord et idf` → not SOFTWARE_ENGINEER (UNCLASSIFIED or NON_IT); `hardware-entwickler / elektronikentwickler (m/w/d)` → no software role; `business development manager` → NON_IT (unchanged); one existing hardware title that is RULE today (pick from the fixtures) → unchanged.
- [ ] **Step 2:** `pnpm --filter @crm/api test -- role-classifier` → the new rows FAIL.
- [ ] **Step 3:** Add the nouns: de `entwickler` left-unbounded (German compounds), `softwareentwicklung` — written as its own regex, not through `keyword()`/`rx()`, whose `(?<!\w)` bound would miss `softwareentwickler`; fr `d[ée]veloppeu(r|se)`; es `desarrollador(a)?`; it `sviluppat(ore|rice)`; nl `ontwikkelaar`; pl `programist(a|ka)`. Add to `JOB_NOUN`, `HINT_NOUN`, `ENG_NOUN`, `GENERIC_KEYWORDS`, `GENERIC_NOUN`. Exclude `immobilier` and the `hardware-|elektronik` compound inside the new noun patterns only (e.g. a negative lookbehind on the compound). Never through `EXCLUDE_PHRASE` / `EXCLUDE_BARE`: those make a title NON_IT and would demote hardware titles that are RULE today. Bump to `'rc.2'`; extend the header note with one line: rc.2 bumped without copy-forward because every rc.1 answer was irrelevant (spec §4).
- [ ] **Step 4:** Same command → PASS, case count non-zero; whole `funnel/` suite green.
- [ ] **Step 5:** Commit `feat(job-sourcing): classify foreign developer nouns by rule (rc.2)` with `ac_verified: 1`.

### Task 2: The pure gate

**Files:**

- Create: `apps/api/src/job-sourcing/funnel/role-scope-gate.ts`
- Test: `apps/api/src/job-sourcing/funnel/role-scope-gate.spec.ts`

**Interfaces:**

- Consumes: Task 1 exports; `widenRoles`, `SeniorSelectableRole`, `TechnicalRole` from `@crm/shared`.
- Produces:

  ```ts
  export type ScopeGateInput = {
    title: string
    tags: readonly string[]
    layer1Rejected: boolean
    reachable: ReadonlySet<TechnicalRole>
  }
  export function reachableRoles(
    profiles: readonly { roles: readonly SeniorSelectableRole[] }[],
  ): ReadonlySet<TechnicalRole>
  export function roleScopeGate(input: ScopeGateInput): 'PENDING' | 'OUT_OF_SCOPE'
  ```

- [ ] **Step 1: Table test** with `reachable = reachableRoles([{roles:['BACKEND_ENGINEER']},{roles:['ANDROID_ENGINEER']}])`:
  - `forward deployed engineer`, tags [] → PENDING
  - `product engineer` → PENDING
  - `staff engineer` → PENDING
  - `mechanical design engineer` → OUT_OF_SCOPE
  - `senior customer engineer - vancouver bc` → OUT_OF_SCOPE
  - `gtm system engineer` → OUT_OF_SCOPE
  - `site manager` → OUT_OF_SCOPE
  - `product engineer`, `layer1Rejected: true` → OUT_OF_SCOPE
  - `product engineer`, `reachable: new Set()` → OUT_OF_SCOPE
  - `operations lead`, tags that `EQ_BOARD_CATEGORIES` maps to BACKEND_ENGINEER → PENDING
  - `data platform engineer` with reachable = only `DATA_ENGINEER` widening (senior DATA_ENGINEER) and no SOFTWARE_ENGINEER → OUT_OF_SCOPE unless a hint/tag maps to DATA_ENGINEER (pin the result)
  - `php / java engineer` (first hint unreachable, a later one reachable) → PENDING
  - a title whose only hint has `role: null` (e.g. `c++ engineer`): PENDING iff SOFTWARE_ENGINEER is reachable and no `NON_SOFTWARE_ENGINEERING` match; `embedded c++ hardware engineer` → OUT_OF_SCOPE
  - Task 1's guard titles (`… développeur.se immobilier …`, `hardware-entwickler / elektronikentwickler (m/w/d)`) → OUT_OF_SCOPE
  - each of the 34 UNCLEAR titles and the 2 AI titles listed in the spec's baseline (copy from the PR's measurement note) → OUT_OF_SCOPE
- [ ] **Step 2:** `pnpm --filter @crm/api test -- role-scope-gate` → FAIL (module missing).
- [ ] **Step 3:** Implement. PENDING iff `!layer1Rejected && reachable.size > 0 && (hintOrTagHit || genericHit)`, where `hintOrTagHit` = any `TECH_HINTS` entry (all matches, not the classifier's `find`) whose non-null role is in `reachable`, or any tag whose `EQ_BOARD_CATEGORIES` role is in `reachable`; a matching hint with `role: null` counts as `genericHit` input, not as `hintOrTagHit`; `genericHit` = `reachable.has('SOFTWARE_ENGINEER')` && a `GENERIC_KEYWORDS` match && no `NON_SOFTWARE_ENGINEERING` match. `NON_SOFTWARE_ENGINEERING` is one Unicode `rx`-style regex; start from: mechanic(al)?, electric(al)?, civil, chemical, process, structural, hvac, field, customer, gtm, go-to-market, technician, estimat, photonic, layout, controls?, propulsion, manufacturing, production, quality, construction, power, rf, hardware, sales, solutions?, support, maintenance, service, medical, assurance, cell culture, airspace, timber, immobilier, real estate, and German stems matched without a word bound (`elektro`/`elektronik`, `maschinen`, `instandhaltung`, `hardware`).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(job-sourcing): role scope gate` with `ac_verified: 2`.

### Task 3: `OUT_OF_SCOPE` status end to end (DDL + recompute + evaluate)

**Files:**

- Create: `apps/api/drizzle/manual/2026-11-19_role_status_out_of_scope.sql`
- Modify: `apps/api/src/database/schema/job-opportunities.ts` (role_status CHECK), `apps/api/src/job-sourcing/store/opportunity-roles.ts` (`RoleStatus`), `funnel/evaluate.ts` (`ROLE_GATE`; export `invalidRevision`), the `roleStatus` `$type<…>` union in the same schema file, `runtime/recompute-worker.ts` (`recomputeOpportunity`), `.github/workflows/deploy.yml` + `scripts/devops/deploy-stack-on-vps.sh` (wire the file like `2026-11-18_job_opportunities_role_pending_index.sql`: file list near the other manual files, scp step, apply block after the 2026-11-18 one)
- Test: `apps/api/src/database/job-opportunities-schema.spec.ts` (asserts the exact CHECK string), `apps/api/src/database/technical-roles-forward-ddl.integration.spec.ts` (or a sibling spec), `funnel/evaluate.spec.ts`, a recompute integration spec next to the existing `recompute-*.integration.spec.ts`

**Interfaces:**

- Consumes: `roleScopeGate`, `reachableRoles` (Task 2); `classifyLayer1`, `RULE_VERSION` (`funnel/layer1.ts`); `writeOpportunityRoles`.
- Produces: `RoleStatus` includes `'OUT_OF_SCOPE'`; evaluate emits reason `ROLE_OUT_OF_SCOPE` with evidence `role_status=OUT_OF_SCOPE`.

- [ ] **Step 1: Tests.**
  - DDL spec: after applying the 2026-11-17, 2026-11-18 and 2026-11-19 files, `UPDATE … SET role_status='OUT_OF_SCOPE', technical_roles='{}'` succeeds; `role_status='BOGUS'` fails with 23514; applying 2026-11-19 twice succeeds.
  - evaluate spec: roles `{status:'OUT_OF_SCOPE', roles:[]}` → EXCLUDED at CLASSIFICATION with reason `ROLE_OUT_OF_SCOPE`.
  - recompute integration (one senior BACKEND_ENGINEER): a PENDING `mechanical design engineer` → after recompute `role_status='OUT_OF_SCOPE'`, no `DETAIL_FETCH` dirty row with `roleAiEnabled=true`; a PENDING `product engineer` stays PENDING; with an empty roster `product engineer` → OUT_OF_SCOPE, then the senior is added + SENIOR fan-out processed → PENDING; a RULE row is unchanged; a row whose canonical revision is invalid keeps its status.
- [ ] **Step 2:** Run each spec → FAIL.
- [ ] **Step 3: DDL file.** Header in the style of `2026-11-18_…sql` (WHAT / ORDER after 2026-11-18 / rollback = re-add the 5-value CHECK after moving OUT_OF_SCOPE rows back to PENDING). Body, idempotent in one transaction: `ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_role_status; ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_role_status CHECK (role_status IS NULL OR role_status IN ('RULE','AI','PENDING','UNCLEAR','NON_IT','OUT_OF_SCOPE'));` Mirror in the Drizzle schema check.
- [ ] **Step 4: Recompute.** In `recomputeOpportunity`, after `loadOpportunity` + `loadRoster` and before `verdictOf`: if `loaded.roles.status` is PENDING or OUT_OF_SCOPE and `invalidRevision(loaded.canonical) === null` (the exported evaluate check, not a copy; an invalid revision must reach `verdictOf` and poison as today, never throw here), compute `layer1Rejected = classifyLayer1(loaded.canonical.fields, { ruleVersion: RULE_VERSION, evaluationTime: batch.evaluationTime }).rejectedBy.length > 0`, run the gate on `title` / `stack_keywords` from the locked row, and when the answer differs, `writeOpportunityRoles` and use the new roles for `verdictOf` and the DETAIL_FETCH check. Add `OUT_OF_SCOPE: 'ROLE_OUT_OF_SCOPE'` to `ROLE_GATE` and retype it `Readonly<Record<Exclude<RoleStatus, 'RULE' | 'AI'>, string>>` so a missing hidden status fails typecheck.
- [ ] **Step 5: Deploy wiring.** Copy the 2026-11-18 blocks verbatim with the new path / variable name (`ROLE_OUT_OF_SCOPE_FILE`); keep apply-before-swap order. `bash -n scripts/devops/deploy-stack-on-vps.sh` passes; `actionlint` (if present) passes.
- [ ] **Step 6:** Run the specs from Step 1 on the scratch DB → PASS; `pnpm --filter @crm/api typecheck` clean.
- [ ] **Step 7:** Commit `feat(job-sourcing): OUT_OF_SCOPE role status gated in recompute` with `ac_verified: 3`.

### Task 4: AI pass + reconciliation guards

**Files:**

- Modify: `apps/api/src/job-sourcing/role-ai/role-ai.store.ts` (`candidates`)
- Test: `role-ai/role-ai-pass.integration.spec.ts`, `runtime/reconciliation.spec.ts` (+ its integration spec if the predicate is SQL-only)

**Interfaces:**

- Consumes: Task 3 status.

- [ ] **Step 1: Tests.**
  - candidates: an OUT_OF_SCOPE row is never returned; a PENDING row with `evaluated_revision IS DISTINCT FROM revision` is not returned; the same row after recompute is returned.
  - reconciliation: a row with status OUT_OF_SCOPE and a match row carrying `ROLE_PENDING` evidence is `role_stale` once; after the recompute writes `ROLE_OUT_OF_SCOPE` evidence the next sweep does not pick it.
- [ ] **Step 2:** Run → the evaluated-revision test FAILS.
- [ ] **Step 3:** Add `AND o.evaluated_revision = o.revision` to `candidates()` (check `lockUnchanged` needs nothing more). Accepted: a PENDING row whose recompute never installs (poisoned / VERSION_STALE) is no longer a candidate — an AI answer would only enqueue another failing recompute. Touch the reconciliation predicate only if its test fails.
- [ ] **Step 4:** Run → PASS; whole `job-sourcing` unit suite green, count non-zero.
- [ ] **Step 5:** Commit `feat(job-sourcing): AI pass reads only gated, evaluated rows` with `ac_verified: 4`.

### Task 5: Measurement note + PR

- [ ] Run the gate (built code) over the read-only prod dump in `/tmp/roleai-measure/pending.jsonl` (scratch, never committed): counts PENDING vs OUT_OF_SCOPE, the 36 cached titles' answers, 100 random OUT_OF_SCOPE titles hand-checked (counts only).
- [ ] Open the PR with: spec link, Assumptions block (spec "Left to the builder" calls), measurement counts, deploy note (DDL applied before swap; rc.2 bump re-enqueues OPEN/UNKNOWN rows), post-deploy checks = the spec's success-measure table. Reviewers: code-reviewer, security-reviewer (queue visibility), spec-reviewer.
