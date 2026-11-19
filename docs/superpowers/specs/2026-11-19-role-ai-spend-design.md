# Role-AI spend: relevance gate (`OUT_OF_SCOPE`) + foreign developer nouns

Status: approved by the owner 2026-11-19 (variant A). Project 1 of 2; project 2 (jitter on
job-source requests) gets its own spec and PR.

## Intent

The role-AI pass (`job-sourcing/role-ai/`) spends its daily budget (`JOB_ROLE_AI_DAILY_BUDGET`,
default 18 calls) minutes after 00:00 UTC on vacancies no senior could ever take. HR sees the same
result whether those rows are classified or not. Spend the calls only where an answer can become a
LEAD, and stop the detail fetches (external GETs) the PENDING rows trigger.

## Measured baseline (prod, read-only, 2026-11-19)

- `role_status`: RULE 2366, NON_IT 1977, PENDING 3702, UNCLEAR 35, AI 2.
- Every one of the 36 cached AI answers is irrelevant: 34 UNCLEAR ("site manager", "senior auditor",
  "mechanical engineer iii", …) and 2 AI roles (SYSTEM_ADMINISTRATOR, BUSINESS_APPLICATIONS_ENGINEER)
  no senior holds. All 807 opportunities with a LEAD row have `role_status = RULE`: **the AI has
  produced zero LEADs.**
- Roster (SENIOR, not archived, on a team): BACKEND ×2, FRONTEND, FULLSTACK, ANDROID. With one hop of
  `ROLE_WIDENING` the reachable vacancy roles are those plus SOFTWARE_ENGINEER and
  CROSS_PLATFORM_MOBILE_ENGINEER.
- 596 of 3702 PENDING rows already carry `LAYER1_REJECT`: they stay excluded whatever the AI says.
  There are no GLOBAL rows in `job_exclusion_filters`.
- New PENDING rows: ~800–1700 per day (first_seen 2026-11-16..18).
- The rule misses non-English developer nouns: "java backend entwickler", "softwareentwickler c++",
  "développeur backend php" stay PENDING (`JOB_NOUN` has no `entwickler` / `développeur` / …).
  46 PENDING rows; 39 of them get a role from the rule once the noun is known.
- Prototype gate (below), run locally with the real classifier over a title + `stack_keywords` dump:
  171 of 3702 PENDING pass (4.6 %); ~27 pass per day of inflow (2026-11-18).

## Goals

- AI calls only for rows that could become a LEAD for the current roster.
- Recover the LEADs lost to foreign developer nouns, by rule, at zero AI cost.
- PENDING drains: rows without a signal leave PENDING for a terminal status at their next recompute.
- No detail fetch for a row the gate rejects.

## Non-goals / anti-goals

- No new paid service, no paid model, no embeddings model, no ESCO import (levers 4a/4b: not needed
  — the gate already removes ~95 % of PENDING; revisit only if the success measures below miss).
- No change to the budget, the cron, or the classifier prompt.
- Anti-goal: a gate that hides a vacancy a senior's role covers by rule. The gate runs only on rows
  the rule left unclassified; RULE / NON_IT rows never pass through it.

## Approaches considered

- **A. New terminal `role_status = 'OUT_OF_SCOPE'` (chosen by the owner).** PENDING drains, the
  detail-fetch trigger (`roleAiEnabled && status === 'PENDING'`) and `candidates()` need no change,
  the health query stays readable. Cost: prod DDL (CHECK constraint widened) through a manual SQL file
  plus deploy wiring.
- B. Keep rows PENDING, filter in `candidates()` and at the detail-fetch trigger. No DDL, but PENDING
  never drains, the gate must live in SQL or a TS filter over a bounded window that can starve the
  pass, and drain time is unmeasurable. Rejected.
- Ordering by relevance score (lever 3): dropped. After the gate the candidate set is small and
  homogeneous; a stored score would need another column for no measured gain.
- More NON_IT rules (lever 2, negative side): dropped. Rows the gate rejects never reach the AI, so
  NON_IT vs OUT_OF_SCOPE changes nothing for spend.

## Design

### 1. Status `OUT_OF_SCOPE`

- `RoleStatus` (`store/opportunity-roles.ts`) gains `'OUT_OF_SCOPE'`; no roles
  (`ck_job_opportunities_roles_iff_status` already requires roles only for RULE / AI).
- `ROLE_GATE` in `funnel/evaluate.ts`: `OUT_OF_SCOPE: 'ROLE_OUT_OF_SCOPE'` — hidden from every scope,
  like PENDING / UNCLEAR / NON_IT. New reason code goes wherever the existing role reason codes are
  enumerated (shared schemas, i18n labels if the evidence code is rendered).
- Prod DDL: `apps/api/drizzle/manual/2026-11-19_role_status_out_of_scope.sql` drops and re-adds
  `ck_job_opportunities_role_status` with the new value (idempotent, follows the shape of
  `2026-11-17_technical_roles.sql`), wired into `deploy.yml` and `scripts/devops/deploy-stack-on-vps.sh`
  exactly like the 2026-11-17 / 2026-11-18 files. The Drizzle schema check is updated for dev/CI.
  **Deploy order:** DDL before the code that writes the value (the deploy already applies manual SQL
  before the app starts — verify).

### 2. The gate — `funnel/role-scope-gate.ts` (pure)

`roleScopeGate({ title, tags, layer1Rejected, reachable }): 'PENDING' | 'OUT_OF_SCOPE'`, where
`reachable` = union of `widenRoles(senior.roles)` over the loaded roster.

PENDING (send to AI) only when all hold:

- layer 1 did not reject the revision;
- `reachable` is non-empty;
- a signal for a reachable role:
  - a tech hint (`TECH_HINTS`) or a board tag (`EQ_BOARD_CATEGORIES`) that maps to a reachable role; or
  - a generic engineering keyword (`GENERIC_KEYWORDS`) in the title, when SOFTWARE_ENGINEER is
    reachable, and the title names no non-software engineering field (a `NON_SOFTWARE_ENGINEERING`
    list: mechanical, electrical, civil, chemical, process, structural, hvac, field, customer, gtm /
    go-to-market, technician, photonics, controls, propulsion, manufacturing, quality, construction,
    power, rf, hardware, sales, solutions, support, … — the prototype list in this spec's
    measurement is the starting point);
  - a gate-local mobile hint (`GATE_HINTS`: `android` for ANDROID_ENGINEER; `mobile`, `ios`,
    `flutter`, `react native` for CROSS_PLATFORM_MOBILE_ENGINEER) for a reachable role, in a title
    with no `NON_SOFTWARE_ENGINEERING` word (no `TECH_HINTS` entry exists for mobile); or
  - a gate-local lead signal (`GATE_GENERIC`: `tech lead`, `technical lead`, `software architect` /
    `softwarearchitekt`) when any of SOFTWARE_ENGINEER, SOFTWARE_ARCHITECT, ENGINEERING_MANAGER or CTO
    is reachable (those three lead roles widen to nothing, so a leadership-only roster still sees a
    lead title), under the same `NON_SOFTWARE_ENGINEERING` veto. `GENERIC_KEYWORDS` and a role-less
    tech hint stay SOFTWARE_ENGINEER-only.

Otherwise OUT_OF_SCOPE. The gate reads title + `stack_keywords` only, never the description
(owner decision: a vacancy with no signal in title + stack may stay hidden).

The classifier internals the gate needs (`GENERIC_KEYWORDS`, `TECH_HINTS`, `EQ_BOARD_CATEGORIES`)
are exported from `role-classifier.ts`, not copied.

### 3. Where the gate runs — `runtime/recompute-worker.ts` `recomputeOpportunity`

That is the one place where the roster, the revision and the role status are all loaded under the
row lock. After the lazy backfill and `loadRoster`, for a row whose status is PENDING or
OUT_OF_SCOPE: compute layer 1 on the loaded revision, run the gate, and if the answer differs from the
stored status, `writeOpportunityRoles` before the verdict. The verdict then sees the new status.

- Ingest (`canonical.store.ts`) keeps writing PENDING; the first recompute gates it.
- Re-evaluation when a senior gains a role: the existing SENIOR dirty fan-out re-enqueues every
  OPEN / UNKNOWN opportunity, so the recompute re-gates OUT_OF_SCOPE rows back to PENDING. No new path.
- `deriveOpportunityRoles` (rule → AI cache → PENDING) does not change; the gate refines its PENDING.
- Race: the AI pass could pick a fresh PENDING row before its first recompute. Builder's call:
  `candidates()` additionally requires the row to have been evaluated at its current revision
  (`evaluated_revision = revision`), which only the recompute writes.
- Gate versioning: OUT_OF_SCOPE rows are re-gated only by the SENIOR fan-out or a classifier bump. Any change to the gate's signal lists therefore bumps `ROLE_CLASSIFIER_VERSION`; a dedicated gate version is not worth a column.
- Reconciliation (`runtime/reconciliation.ts`): the `role_stale` disjunct excludes OUT_OF_SCOPE next to
  PENDING / UNCLEAR, so a row the gate hid is never re-enqueued by stale `ROLE_PENDING` evidence (the
  roster fan-out re-gates it instead). Pinned by the reconciliation integration spec.

### 4. Foreign developer nouns — `role-classifier.ts`, version `rc.2`

- `JOB_NOUN`, `HINT_NOUN`, `GENERIC_KEYWORDS` / `GENERIC_NOUN` (and `ENG_NOUN` where a developer noun
  belongs) learn: de `entwickler` (incl. compounds `softwareentwickler`, `softwareentwicklung`,
  `applikationsentwickler`), fr `développeur` / `developpeur` / `développeuse`, es `desarrollador(a)`,
  it `sviluppatore` / `sviluppatrice`, nl `ontwikkelaar`, pl `programista`. Compounds need a
  left-unbounded match for `entwickler` (German glues it), so its pattern is written for that.
- False-positive guards with fixtures: "développeur immobilier" (real-estate developer),
  "hardware-entwickler / elektronikentwickler" must not become SOFTWARE_ENGINEER, "business
  development" stays excluded.
- `ROLE_CLASSIFIER_VERSION` → `rc.2`. The bump re-enqueues OPEN / UNKNOWN rows through the
  reconciliation sweep (as `rc.1` did). **No cache copy-forward:** all 36 `rc.1` rows are irrelevant
  answers; their rows re-enter as PENDING and the gate sends almost all of them to OUT_OF_SCOPE.
  The header note on bumps stays true and is satisfied by this accepted recovery.

### 5. Tests

- Gate: table-driven unit spec (each signal branch, empty roster, layer-1 reject, non-software field,
  role not reachable).
- Classifier: fixture rows in `__fixtures__/role-titles.ts` for each new noun and each guard.
- Recompute: PENDING → OUT_OF_SCOPE, OUT_OF_SCOPE → PENDING after a senior gains a reachable role,
  no DETAIL_FETCH enqueued for OUT_OF_SCOPE, verdict reason `ROLE_OUT_OF_SCOPE`.
- Store: `candidates()` never returns OUT_OF_SCOPE (and the race guard).
- DDL: the forward-DDL integration spec covers the new constraint value.

## Success measures (checked on prod, read-only, 7 days after deploy)

| Measure                         | Now                              | Target                                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI calls / day                  | 18 (budget, spent by ~00:10 UTC) | ≤ 18, spent on gated rows only                                                                                                                                                                                                                |
| AI calls returning a role       | 2 / 36, 0 reachable              | ≥ 30 % return a role (any); report reachable share                                                                                                                                                                                            |
| PENDING count                   | 3702                             | ≤ ~200 (gated backlog; measured after 10fa60228: PENDING 223); OUT_OF_SCOPE holds the rest                                                                                                                                                    |
| PENDING drain                   | never (inflow ≫ budget)          | gated inflow ≈ 34/day (measured after 10fa60228, 2026-11-18) vs the 18/day budget: the gated backlog does not fully drain; rows age out by availability. If PENDING grows week over week, follow-up = batch several vacancies per worker call |
| Detail fetches for PENDING rows | every PENDING row                | gated rows only                                                                                                                                                                                                                               |
| LEADs                           | 807 (all RULE)                   | ≥ 807 + the foreign-noun recoveries; no LEAD lost                                                                                                                                                                                             |

**No-LEAD-lost sample:** (a) every opportunity with a LEAD row before deploy still has one after
(SELECT of LEAD opportunity ids before/after, set difference = ∅ among still-OPEN rows); (b) the
2 AI-role rows and the 34 UNCLEAR rows: the gate's answer for each is recorded in the PR (expected:
all OUT_OF_SCOPE, none reachable); (c) a hand check of 100 random OUT_OF_SCOPE titles, listed as
"would a backend/frontend/fullstack/android senior take this?" counts, in the PR body.

## Left to the builder

Exact non-software list and regex shapes (pinned by fixtures), file split, the race-guard form,
where the reason code is enumerated, the DDL file text. Security review is mandatory (queue visibility).
