# Senior technical roles + skills-overlap indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A senior gets 1..N technical roles from a fixed 34-role list. A vacancy gets roles from a
deterministic title classifier, with an AI fallback. A vacancy is LEAD for a senior when the roles
intersect after one-hop widening. A vacancy whose roles stay unknown is hidden from everyone. Each
matched senior's card shows a display-only "k of n skills" overlap.

**Architecture:** Shared data (enum, labels, widening, skill dictionary, overlap) lives in
`@crm/shared`. The classifier is a pure API function. The canonical store calls it at ingest, and the
recompute worker calls it lazily for old rows. The result goes into three new `job_opportunities`
columns. A bounded cron sends only `PENDING` rows to a new extraction-worker route and caches each
answer. Matching reads the stored roles through the existing `evaluate` stages. Every "hidden" case is
an opportunity-level `EXCLUDED` verdict in `CLASSIFICATION`, so no new list predicate is needed.

**Tech Stack:** NestJS 11 + Fastify, Drizzle (raw `sql` in job-sourcing), PostgreSQL, Zod v4, React +
Vite + TanStack, Lingui 5.9.5 (`@lingui/core` pin in `packages/shared` and `apps/web`), Vitest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-senior-roles-design.md`. Its "Review round 1
corrections" override its earlier sections. Research and fixtures:
`docs/architecture/research/2026-11-16-it-role-taxonomy.md` (§1 enum, §3.1–3.3 rules, §3.4 dry-run
titles, Appendix A scratch classifier).

## Global Constraints

- English everywhere in the repo. Product text is `uk` (source) + `en` through Lingui. uk role labels go
  to copy-reviewer before they reach the catalog.
- Roles are stored as `text[]` with a CHECK, never as a pgEnum.
  - `users.technical_roles` holds only the 33 senior-selectable roles. `SOFTWARE_ENGINEER` is
    vacancy-only.
  - `job_opportunities.technical_roles` holds all 34 roles.
- `role_status` takes exactly these values: `RULE` | `AI` | `PENDING` | `UNCLEAR` | `NON_IT`.
- Evaluation reasons: `ROLE_PENDING`, `ROLE_UNCLEAR`, `NON_IT` (opportunity level, stage
  `CLASSIFICATION`) and `ROLE_MATCH` (LEAD). The new error code is `SENIOR_MIN_ROLES`.
- The AI confidence threshold is `0.7`. AI runs on free models only, never paid OpenRouter. It sends
  public vacancy text only and never personal data.
- The AI cache key is (normalised title = `job_opportunities.title_key`, description hash, classifier
  version).
- Widening is one-hop and non-transitive. Use exactly the spec matrix ("Widening matrix"). Any pair
  not listed is a non-match.
- Indicator copy: `"{matched} з {total} навичок"` / `"{matched} of {total} skills"`; no resume →
  `"немає резюме"` / `"no resume"`. A vacancy with no technologies shows no indicator. Never "0 of n"
  for a senior with an empty resume. The indicator is display-only: ranking does not change.
- Roles are for `SENIOR` only. `users.tech_stack` stays in the table and is hidden for seniors. It is
  not dropped in this plan.
- Prod DDL goes through a forward SQL file in `apps/api/drizzle/manual/` plus the deploy wiring.
  - Agents never run `db:push`, `db:seed` or `db:migrate` against `crm_db`. Live `crm_db` is
    read-only.
  - Push feature branches as `DATABASE_URL= git push`.
- No user id, email or name appears in the repo, a PR body or a report. The prod role assignment
  happens at runtime through the ADMIN API.
- RBAC does not change. Whoever may edit a senior's stack today may edit their roles: ADMIN, HR on
  create, the senior on self-edit.
- Never `--no-verify`. Stage files with explicit `git add`. Every final commit carries
  `ac_verified:`.
- UI goes through the design gate (`.claude/rules/common/design-gate.md`) and responsive rules. The
  redesign is pending, so UI review gives findings only, with no scoring.

## Review Focus

1. **Form ↔ API floor skew.** A web form that still sends only `techStack` must never get a 400 from a
   floor it cannot satisfy. Pinned in Task 5.3 (`floor flips in the same PR as the forms`) and Task 2.4
   (`roles are optional before PR 5`).
2. **A title-only record reuses a full-text answer, or the reverse.** A detail-pending on-demand record
   must never pick up an `UNCLEAR` cached from a description-less record with the same `title_key`.
   Pinned in Task 3.3 (`no cache lookup while detailPending`).
3. **Read-side and write-side profile versions disagree.** If the queue's live `profileVersion` differs
   from the one stamped on match rows, every LEAD goes invisible with no error. Pinned in Task 4.2
   (`queue liveVersions equals the stamped senior_profile_version`).
4. **A legacy senior with empty roles makes an unrelated edit.** That edit must still pass, as it does
   today under the stack floor. A real roles change below the floor must be refused. Pinned in
   Task 5.3.
5. **A vacancy stays `PENDING` while its detail is never fetched.** No projection means no
   `DETAIL_FETCH`, so the AI never runs. Pinned in Task 4.4 (`PENDING with detail pending enqueues
DETAIL_FETCH when the AI step is enabled`).

---

## PR map and deploy order

Each PR ships on its own and leaves prod in a working state. The deploy order follows the spec's
correction 8: (a) migration, (b) backfill, (c) AI pass, (d) roles set, then one full recompute.

| PR  | Branch                  | What ships                                                                                                                                                                          | Prod effect after deploy                                                                                                                  | Reviewers                                                                                      |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `feat/roles-1-shared`   | Enum, labels, widening, `seniorRolesSchema`, `SENIOR_MIN_ROLES`, skill dictionary extension, `skillOverlap`, pure API classifier                                                    | None (nothing calls it)                                                                                                                   | code-reviewer, copy-reviewer (uk labels)                                                       |
| 2   | `feat/roles-2-storage`  | DDL (3 opportunity columns, `users.technical_roles`, cache table) + deploy wiring; classifier at ingest; lazy backfill under the recompute lock; users API accepts roles (optional) | Deploy steps **(a)** and **(b)**: columns exist and are filled. Matching is unchanged. ADMIN can set roles through the API                | code-reviewer, **security-reviewer** (users write path), DevOps                                |
| 3   | `feat/roles-3-ai`       | Worker route `/classify-roles`, API client, bounded cron, cache writes, backoff                                                                                                     | Deploy step **(c)**, only if the worker env is wired. Unwired: a silent `NOT_CONFIGURED` skip; rows stay `PENDING`. Matching is unchanged | code-reviewer, **security-reviewer** (outbound text to a model)                                |
| —   | ops                     | Step **(d)**: the orchestrator sets the 3 seniors' roles through `PATCH /users/:id`                                                                                                 | Roles are stored; nothing reads them yet                                                                                                  | —                                                                                              |
| 4   | `feat/roles-4-matching` | `evaluate` reads roles; role exclusions; `ROLE_MATCH`; overlap evidence; roster loads roles + resume skills; versions bumped; `senior.roles` / `senior.resume` dirty                | The version bump **is** the one full recompute. Seniors already have roles, so no senior has an empty-queue window                        | code-reviewer, **security-reviewer** (queue visibility = RBAC)                                 |
| 5   | `feat/roles-5-ui`       | `RolesSection` in the 3 forms, role chips, card indicator, floor flip `SENIOR_MIN_TECHNOLOGIES` → `SENIOR_MIN_ROLES` (API + web together)                                           | Seniors edit roles in the UI; the stack field is hidden for `SENIOR`                                                                      | code-reviewer, **security-reviewer**, copy-reviewer, ui-ux-designer (findings only), manual-qa |

PR 4 must not deploy before step (d). Its merge gate is an owner-run count (Task 6.2). PR 5 needs PR 4
for the indicator DTO. PR 3 can deploy after PR 2 in either order with step (d).

## File Structure

**PR 1 — shared + pure classifier**

- Create `packages/shared/src/schemas/technical-roles.ts`: `TECHNICAL_ROLES` (34 ids, in research §1
  order), `TECHNICAL_ROLE_GROUPS` (11 groups), `SENIOR_SELECTABLE_ROLES` (33),
  `technicalRoleSchema`, `seniorRolesSchema`, `ROLE_WIDENING`, `widenRoles`, `rolesMatch`, and the
  label descriptors `TECHNICAL_ROLE_LABELS` / `TECHNICAL_ROLE_GROUP_LABELS`.
- Create `packages/shared/src/utils/skill-overlap.ts`: `vacancyTechnologies` and `skillOverlap`.
- Modify `packages/shared/src/schemas/resume-skills.ts`: extend `SKILL_SYNONYM_GROUPS` to cover the
  common stacks of the 34 roles.
- Modify `packages/shared/src/schemas/zod-errors.ts` and
  `packages/shared/src/schemas/api-errors/auth-users-projects.ts`: add `SENIOR_MIN_ROLES`.
- Modify `packages/shared/src/index.ts` (barrel), plus the catalogs `packages/shared/src/i18n/locales/{uk,en}`.
- Create `apps/api/src/job-sourcing/funnel/role-classifier.ts`: `classifyRoles`,
  `ROLE_CLASSIFIER_VERSION`.
- Create `apps/api/src/job-sourcing/funnel/__fixtures__/role-titles.ts`: the research §3.4 titles with
  expected outcomes.

**PR 2 — storage, backfill, users API**

- Create `apps/api/drizzle/manual/2026-11-17_technical_roles.sql`.
- Modify `apps/api/src/database/schema/users.ts` (`technicalRoles`) and
  `apps/api/src/database/schema/job-opportunities.ts` (`technicalRoles`, `roleStatus`,
  `roleClassifierVersion`, GIN index, CHECKs).
- Create `apps/api/src/database/schema/job-role-classifications.ts`. Register it in `apps/api/src/database/schema.ts`.
- Modify `apps/api/src/database/privileges/privilege-classes.ts`: put `job_role_classifications` in
  class A, add a `MANUAL_DDL_RELATIONS` entry.
- Create `apps/api/src/database/technical-roles-forward-ddl.integration.spec.ts`.
- Create `apps/api/src/job-sourcing/store/opportunity-roles.ts`: `deriveOpportunityRoles`,
  `writeOpportunityRoles`.
- Modify `apps/api/src/job-sourcing/store/canonical.store.ts`: `createOpportunity`,
  `refreshOpportunity`.
- Modify `apps/api/src/job-sourcing/runtime/recompute-worker.ts` (lazy backfill) and
  `apps/api/src/job-sourcing/runtime/recompute-inputs.ts` (`EVALUATION_RECORD_VERSION` → `'rf.2'`).
- Modify `packages/shared/src/schemas/users.ts`: add an optional `technicalRoles` to
  `createUserSchema`, `hrCreateSeniorSchema`, `updateProfileSchema`, `adminUpdateUserSchema`,
  `userProfileSchema` and `profileOverviewDataSchema`.
- Modify `apps/api/src/users/role-guards.util.ts` (`assertSeniorOnlyRoles`, `rolesChanged`),
  `users.service.ts`, `user-creation.service.ts`, `admin-user-update.service.ts`, plus the user
  read mapping.
- DevOps (separate commit, DevOps zone): `.github/workflows/deploy.yml` (rollback preflight list + SCP
  step for the new SQL file), `scripts/devops/deploy-stack-on-vps.sh` (apply block),
  `docs/runbooks/deployment.md` (row).

**PR 3 — AI classification**

- Modify `packages/inference/src/adapters/extraction-worker.ts`: add `'/classify-roles'` to
  `ExtractionWorkerRoute`.
- Create `apps/api/src/extraction-worker/classify-roles.ts` and modify
  `apps/api/src/extraction-worker/server.ts`.
- Create `apps/api/src/job-sourcing/role-ai/role-classifier.client.ts`: `RoleClassifierClient`.
- Create `apps/api/src/job-sourcing/role-ai/role-ai-pass.ts`: `runRoleAiPass`.
- Create `apps/api/src/job-sourcing/role-ai/role-ai.cron.ts`: `RoleAiCron`. Register it in the
  job-sourcing module.
- Modify `apps/api/src/config/env.ts`: `JOB_ROLE_AI_ENABLED`.
- DevOps: set `JOB_ROLE_AI_ENABLED=true` in `deploy.yml`, next to `JOB_MATCH_RECONCILIATION_ENABLED`,
  only when the worker env is wired.

**PR 4 — matching**

- Modify these files in `apps/api/src/job-sourcing/funnel/`:
  - `evaluate.types.ts`: `EvaluateInput.roles`, `EVALUATE_RULE_VERSION` → `'eval.2'`.
  - `evaluate.ts`: role gate, `buildScopes` / `projectScope`.
  - `tech-match.ts`: role criterion, overlap evidence.
- Modify `apps/api/src/job-sourcing/runtime/recompute-inputs.ts`: `loadRoster`, `loadOpportunity`,
  `profileVersion`, `opportunityInputsVersion`, `EVALUATION_RECORD_VERSION` → `'rf.3'`.
- Modify `apps/api/src/job-sourcing/runtime/recompute-worker.ts`: `DETAIL_FETCH` for `PENDING`.
- Modify `apps/api/src/job-sourcing/dirty-producers.ts` (`senior.roles`, `senior.resume`), plus the
  resume write sites listed in Task 4.5.
- Modify `apps/api/src/job-sourcing/queue/job-queue.service.ts` (`matchFacts`, `toSenior`) and
  `packages/shared/src/schemas/job-sourcing.ts` (`jobQueueCardSeniorSchema.skillOverlap`).

**PR 5 — UI + floor flip**

- Create `apps/web/app/components/users/user-dialog/RolesSection.tsx` and
  `apps/web/app/components/users/RoleChips.tsx`.
- Modify the user dialog files in `apps/web/app/components/users/user-dialog/`: `payloads.ts`,
  `validation.ts` and `form-defaults.ts`.
- Modify these components:
  - `users/UserDialog.tsx`, `users/UserRow.tsx`
  - `user-profile/self-edit/ProfileEditFields.tsx`, `user-profile/tabs/OverviewTab.tsx`
  - `routes/_authenticated/team/team-list/components/HrCreateSeniorDialog.tsx`
  - `routes/_authenticated/team/team-detail/components/MembersCard.tsx`
- Modify `apps/web/app/components/job-queue/MatchedSeniors.tsx` and
  `apps/web/app/components/job-queue/__tests__/card-fixtures.ts`.
- Modify `apps/api/src/users/role-guards.util.ts`: `assertSeniorRoleFloor` replaces
  `assertSeniorTechFloor` for `SENIOR`.
- Create E2E `apps/e2e/tests/senior-roles.spec.ts`.

---

## PR 1 — Shared role model + pure classifier (`feat/roles-1-shared`)

Inert: nothing in prod calls any of it. It ships first, so later PRs import stable names.

### Task 1.1: Role enum, groups, widening, senior schema

**Files:**

- Create: `packages/shared/src/schemas/technical-roles.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Test: `packages/shared/src/schemas/technical-roles.spec.ts`

**Interfaces:**

- Produces:
  - `TECHNICAL_ROLES: readonly TechnicalRole[]`: the 34 ids exactly as in research §1.1–§1.11.
  - `type TechnicalRole = (typeof TECHNICAL_ROLES)[number]`
  - `TECHNICAL_ROLE_GROUPS: readonly { id: TechnicalRoleGroup; roles: readonly TechnicalRole[] }[]`:
    11 groups, with the ids from the research headings (`SOFTWARE_ENGINEERING` … `ADJACENT_ANALYSIS_DESIGN`).
  - `SENIOR_SELECTABLE_ROLES`: the 33 roles. It is `TECHNICAL_ROLES` without `SOFTWARE_ENGINEER`.
  - `technicalRoleSchema = z.enum(TECHNICAL_ROLES)`, `seniorSelectableRoleSchema = z.enum(SENIOR_SELECTABLE_ROLES)`
  - `seniorRolesSchema`: an array of `seniorSelectableRoleSchema` with `min(1, 'zod.SENIOR_MIN_ROLES')`
    and distinct elements. On parse it outputs the roles sorted in `TECHNICAL_ROLES` order.
  - `ROLE_WIDENING: Readonly<Record<SeniorSelectableRole, readonly TechnicalRole[]>>`: the spec matrix,
    with `SWE` = `SOFTWARE_ENGINEER`. The names are short in the matrix: `FULLSTACK` =
    `FULLSTACK_ENGINEER`, `ML` = `ML_ENGINEER`, `AI` = `AI_ENGINEER`, `DATABASE` =
    `DATABASE_ENGINEER`, `SRE` = `SITE_RELIABILITY_ENGINEER`, and so on.
  - `widenRoles(roles: readonly SeniorSelectableRole[]): ReadonlySet<TechnicalRole>`: the roles
    themselves ∪ one hop. It never applies the table twice.
  - `rolesMatch(senior: readonly SeniorSelectableRole[], vacancy: readonly TechnicalRole[]): { matched: readonly TechnicalRole[]; widened: boolean }`.
    `matched` = the vacancy roles inside `widenRoles(senior)`. `widened` = true when no matched role
    is in `senior` itself.

- [ ] **Step 1: Write the failing tests**

```ts
it('has 34 roles in 11 groups, each role in exactly one group', ...)
expect(TECHNICAL_ROLES).toHaveLength(34)
expect(TECHNICAL_ROLE_GROUPS.flatMap((g) => g.roles).sort()).toEqual([...TECHNICAL_ROLES].sort())

it('SOFTWARE_ENGINEER is vacancy-only', ...)
expect(SENIOR_SELECTABLE_ROLES).toHaveLength(33)
expect(seniorRolesSchema.safeParse(['SOFTWARE_ENGINEER']).success).toBe(false)

it('seniorRolesSchema refuses [] with zod.SENIOR_MIN_ROLES and duplicates', ...)
it('seniorRolesSchema sorts to TECHNICAL_ROLES order', ...)
expect(seniorRolesSchema.parse(['FRONTEND_ENGINEER', 'BACKEND_ENGINEER'])).toEqual(['BACKEND_ENGINEER', 'FRONTEND_ENGINEER'])

it('widening is one-hop, non-transitive', ...)
expect(widenRoles(['BACKEND_ENGINEER']).has('FULLSTACK_ENGINEER')).toBe(true)
expect(widenRoles(['BACKEND_ENGINEER']).has('FRONTEND_ENGINEER')).toBe(false)
expect(widenRoles(['HARDWARE_ENGINEER']).has('SOFTWARE_ENGINEER')).toBe(false)
expect([...widenRoles(['CTO'])]).toEqual(['CTO'])

it.each(Object.entries(SPEC_MATRIX))('row %s matches the spec matrix exactly', ...)
// SPEC_MATRIX: a literal copy of the spec table, in the test file, so a table edit fails the test

it('rolesMatch reports widened only when no exact role matched', ...)
expect(rolesMatch(['BACKEND_ENGINEER'], ['FULLSTACK_ENGINEER'])).toEqual({ matched: ['FULLSTACK_ENGINEER'], widened: true })
expect(rolesMatch(['BACKEND_ENGINEER'], ['BACKEND_ENGINEER', 'FULLSTACK_ENGINEER']).widened).toBe(false)
expect(rolesMatch(['QA_ENGINEER'], ['DATA_ANALYST']).matched).toEqual([])
```

- [ ] **Step 2: Run** `pnpm --filter @crm/shared test -- technical-roles`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `technical-roles.ts` with the interfaces above. `ROLE_WIDENING` is a plain
      literal object. Do not derive it.
- [ ] **Step 4: Run** the same command. Expected: PASS with a non-zero case count.
- [ ] **Step 5: Commit** `feat(shared): technical role enum, groups and widening`.

### Task 1.2: Labels, error code, catalogs

**Files:**

- Modify: `packages/shared/src/schemas/technical-roles.ts` (label descriptors)
- Modify: `packages/shared/src/schemas/zod-errors.ts`, `packages/shared/src/schemas/api-errors/auth-users-projects.ts`
- Modify: `packages/shared/src/i18n/locales/uk/*`, `packages/shared/src/i18n/locales/en/*` (through
  `pnpm i18n:extract`)
- Test: `packages/shared/src/schemas/technical-roles.spec.ts`, `packages/shared/src/schemas/api-errors.spec.ts`

**Interfaces:**

- Produces:
  - `TECHNICAL_ROLE_LABELS: Record<TechnicalRole, MessageDescriptor>`
  - `TECHNICAL_ROLE_GROUP_LABELS: Record<TechnicalRoleGroup, MessageDescriptor>`
  - Both follow the `ZOD_ERROR_MESSAGES` pattern: `/* i18n */ { id: 'technical-role.<ID>', message: '<uk label>' }`.
    The uk text is research §1 "UK (proposed)". The en text is "EN" and goes in the `en` catalog.
  - `'SENIOR_MIN_ROLES'` in the `ZodErrorCode` list and the api-error code list. Its en fallback is
    `'A senior needs at least one technical role'`. Its uk message goes through copy-reviewer.

- [ ] **Step 1: Write the failing tests.** Test name: "every role and group has a label descriptor
      with a stable id". The ids are `technical-role.<ID>` and `technical-role-group.<ID>`. Add
      `SENIOR_MIN_ROLES` to the existing completeness test in `api-errors.spec.ts`.
- [ ] **Step 2: Run** `pnpm --filter @crm/shared test`. Expected: FAIL.
- [ ] **Step 3: Implement** the descriptors and the code, then run `pnpm i18n:extract`. Every new id
      must exist in both catalogs, with no empty `en` translation.
- [ ] **Step 4: Run** `pnpm --filter @crm/shared test`, then `pnpm i18n:compile`. Expected: PASS;
      compile reports no missing translations for the new ids.
- [ ] **Step 5: Commit** `feat(shared): role labels and SENIOR_MIN_ROLES`. Request copy-reviewer on
      the uk labels: research §1 says every uk label is a proposal.

### Task 1.3: Skill dictionary extension + overlap

**Files:**

- Modify: `packages/shared/src/schemas/resume-skills.ts` (`SKILL_SYNONYM_GROUPS`)
- Create: `packages/shared/src/utils/skill-overlap.ts`
- Test: `packages/shared/src/utils/skill-overlap.spec.ts`, plus the existing resume-skills spec

**Interfaces:**

- Consumes: `canonicalSkill`, `mentionsSkill`, `SKILL_SYNONYM_GROUPS` (existing).
- Produces:
  - `vacancyTechnologies(text: string): readonly string[]`: the canonical names of every
    `SKILL_SYNONYM_GROUPS` entry that `mentionsSkill(text, …)` finds, sorted and deduplicated. The
    text is title + description. Provider tags are never passed in.
  - `type SkillOverlap = { matched: readonly string[]; total: number }`
  - `skillOverlap(vacancy: readonly string[], seniorSkills: readonly string[] | null): SkillOverlap | 'NO_RESUME' | null`
    - `null` when `vacancy` is empty: the vacancy names no technology.
    - `'NO_RESUME'` when `seniorSkills` is null or empty.
    - Otherwise `matched` = the vacancy items whose `canonicalSkill` is in the senior set, and
      `total = vacancy.length`.
- Dictionary: add aliases only where research §1 tech hints name a technology missing today.
  Per role group, check at least one hint, for example Kotlin, Swift, Flutter, Solidity, Terraform,
  Kubernetes, Spark, dbt, Playwright, Selenium, Unity, Unreal, Verilog. No new canonical name may
  collide with an existing alias (an existing spec asserts this).

- [ ] **Step 1: Write the failing tests**

```ts
it('counts dictionary technologies from title + description only once', ...)
expect(vacancyTechnologies('Senior Kotlin dev. Kotlin, Android, Jetpack Compose')).toEqual(['Android', 'Jetpack Compose', 'Kotlin'])
it('null for a vacancy with no technologies', ...)        // skillOverlap([], ['Go']) === null
it('NO_RESUME for an empty or missing resume, never 0 of n', ...)
expect(skillOverlap(['Go'], [])).toBe('NO_RESUME')
it('matches through synonyms', ...)                      // vacancy 'Postgres' vs senior 'PostgreSQL'
it('k of n', ...)
expect(skillOverlap(['Go', 'Kafka', 'PostgreSQL'], ['golang', 'postgres'])).toEqual({ matched: ['Go', 'PostgreSQL'], total: 3 })
it('every role group has at least one dictionary entry', ...) // one hint per group, listed in the test
```

- [ ] **Step 2: Run** `pnpm --filter @crm/shared test -- skill-overlap resume-skills`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions and the dictionary entries.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): skill dictionary for role stacks and skill overlap`.

### Task 1.4: Deterministic vacancy classifier (API, pure)

**Files:**

- Create: `apps/api/src/job-sourcing/funnel/role-classifier.ts`
- Create: `apps/api/src/job-sourcing/funnel/__fixtures__/role-titles.ts`
- Test: `apps/api/src/job-sourcing/funnel/role-classifier.spec.ts`

**Interfaces:**

- Consumes: `TechnicalRole` (Task 1.1).
- Produces:
  - `ROLE_CLASSIFIER_VERSION = 'rc.1'`
  - `type RoleClassification = { kind: 'ROLES'; roles: readonly TechnicalRole[] } | { kind: 'NON_IT' } | { kind: 'UNCLASSIFIED' }`
  - `classifyRoles(input: { title: string; tags: readonly string[] }): RoleClassification`
    - `tags` = the opportunity's `stack_keywords`. Provider categories and departments land there.
    - Roles come back sorted in `TECHNICAL_ROLES` order.
- Rules: research §3.1 steps 1–9 in order, plus §3.2 hints and §3.3 non-role words.
  - Port the patterns of Appendix A, which is what was run, including the 8 traps from §3.4.
  - Implement step 9 (board category as tie-breaker). It was not in the dry run.
    - It applies only when the title gives `UNCLASSIFIED` or exactly `[SOFTWARE_ENGINEER]`.
    - Only an `eq` category fills a role (the DOU / Djinni / WWR / Remotive `eq` cells of research
      §1). A `hint` category never does.
    - Keep the eq table as a literal map in the same file.
  - `NON_IT` = an excluded role phrase from step 1(a), or a bare domain word with no engineering noun
    (step 1(b)).

- [ ] **Step 1: Write the fixture file and the failing tests.** `role-titles.ts` exports
      `ROLE_TITLE_CASES: readonly { title: string; tags?: string[]; expected: RoleClassification }[]`.
      It holds every §3.4 example with its stated outcome, the 8 traps and the 2 ATS bugs. Required
      rows (verbatim titles):
  - `'Senior Java Tech Lead'` → `ROLES [BACKEND_ENGINEER]`
  - `'Data Architect'` → `ROLES [DATA_ENGINEER, SOFTWARE_ARCHITECT]` (sorted in enum order)
  - `'Програміст 1С'` → `ROLES [BUSINESS_APPLICATIONS_ENGINEER]`
  - `'SRE / DevOps'` → both
  - `'Kotlin developer'`, `'C++ developer'` → `ROLES [SOFTWARE_ENGINEER]`
  - `'Business Development Manager'`, `'Landscape Architect'` → `NON_IT`
  - `'Software Engineer, Marketing Platform'`, `'Engineering Manager, Sales Tools'`,
    `'Backend Engineer - HR Tech'` → engineering roles, not `NON_IT`
  - `'DeFi Smart Contract Engineer'` → `[BLOCKCHAIN_ENGINEER]`; `'Definition Engineer'` → `UNCLASSIFIED`
  - `'Market Penetration Specialist'` → `UNCLASSIFIED`; `'CloudOps Engineer'` → `[DEVOPS_ENGINEER]`
  - `'Graphic designer'`, `'Technical Writer'`, `'Principal Engineer'` → `UNCLASSIFIED`
  - `'Automated Test Engineer'` → `[QA_AUTOMATION_ENGINEER]`
  - `'Enterprise Architect - Consumer Banking & Marketing'` → `[SOFTWARE_ARCHITECT]` only
  - `'Full-stack (React/Node) Developer'` → `[FULLSTACK_ENGINEER]` only
  - `'Engineering Manager, Security Platform'` → `[ENGINEERING_MANAGER]` only
  - step 9: `{ title: 'Team Lead', tags: ['Android'] }` → `[ANDROID_ENGINEER]`
  - step 9: `{ title: 'Kotlin developer', tags: ['Kotlin'] }` stays `[SOFTWARE_ENGINEER]`, because
    `Kotlin` is a hint, not an `eq` category

  ```ts
  it.each(ROLE_TITLE_CASES)('$title', ({ title, tags, expected }) =>
    expect(classifyRoles({ title, tags: tags ?? [] })).toEqual(expected))
  it('a title keyword always overrides a board category', ...)
  it('never returns SOFTWARE_ENGINEER together with another role', ...)
  ```

- [ ] **Step 2: Run** `pnpm --filter @crm/api test -- role-classifier`. Expected: FAIL.
- [ ] **Step 3: Implement** `classifyRoles` as an ordered list of small step functions in one file.
- [ ] **Step 4: Run** the same command. Expected: PASS, one case per fixture row.
- [ ] **Step 5: Commit** `feat(job-sourcing): deterministic vacancy role classifier`.

**PR 1 done when:** `pnpm --filter @crm/shared test`, `pnpm --filter @crm/api test -- role-classifier`
and `pnpm typecheck` are green. Final commit trailer: `ac_verified: 1.1,1.2,1.3,1.4`.

---

## PR 2 — Storage, ingest classification, backfill, users API (`feat/roles-2-storage`)

**Security-reviewer: mandatory.** This PR changes the users write path (`POST /users`,
`PATCH /users/:id`, `PATCH /users/me`).

**Ships safely because:**

- Matching does not read the new columns. Only `EVALUATION_RECORD_VERSION` changes, and evaluation
  output stays byte-identical.
- Roles are optional on every write. The web forms keep sending `techStack` only, under the existing
  stack floor.

### Task 2.1: Forward DDL + Drizzle schema + DDL spec

**Files:**

- Create: `apps/api/drizzle/manual/2026-11-17_technical_roles.sql`
- Modify: `apps/api/src/database/schema/users.ts`, `apps/api/src/database/schema/job-opportunities.ts`
- Create: `apps/api/src/database/schema/job-role-classifications.ts`. Register it in
  `apps/api/src/database/schema.ts`.
- Modify: `apps/api/src/database/privileges/privilege-classes.ts`
- Test: `apps/api/src/database/technical-roles-forward-ddl.integration.spec.ts`, plus the existing
  `privilege-classes.spec.ts`

**Interfaces:**

- Produces these columns and objects. The names are final; later tasks use them verbatim.
  - `users.technical_roles text[] NOT NULL DEFAULT '{}'` with
    `ck_users_technical_roles_known CHECK (technical_roles <@ ARRAY[<33 senior-selectable ids>]::text[])`.
  - `job_opportunities` gets 3 columns:
    - `technical_roles text[] NOT NULL DEFAULT '{}'`
    - `role_status text NULL`. NULL means "not classified by any version yet".
    - `role_classifier_version text NULL`
  - `job_opportunities` constraints and index:
    - `ck_job_opportunities_technical_roles_known`: `technical_roles` is contained in the 34 ids.
    - `ck_job_opportunities_role_status`: `role_status` is NULL or one of the 5 values.
    - `ck_job_opportunities_roles_iff_status`: when `role_status` is not NULL, the roles are
      non-empty exactly when the status is `RULE` or `AI`.
    - `idx_job_opportunities_technical_roles USING gin (technical_roles)`.
  - `job_role_classifications`, the AI cache:
    - `title_key text NOT NULL`
    - `description_sha256 text NOT NULL`
    - `classifier_version text NOT NULL`
    - `outcome text NOT NULL CHECK (outcome IN ('AI','UNCLEAR','FAILED'))`
    - `technical_roles text[] NOT NULL DEFAULT '{}'` (same 34-id CHECK)
    - `confidence numeric(4,3) NULL`
    - `model text NULL`
    - `attempts integer NOT NULL DEFAULT 0`
    - `next_attempt_at timestamptz NULL`
    - `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`
    - `PRIMARY KEY (title_key, description_sha256, classifier_version)`
  - Drizzle: `users.technicalRoles`, `jobOpportunities.technicalRoles` / `roleStatus` /
    `roleClassifierVersion`, and `jobRoleClassifications`.
  - Privileges: `job_role_classifications` in `PRIVILEGE_CLASSES` class A (a cron updates it, so not
    B), plus a `MANUAL_DDL_RELATIONS` entry that points at the SQL file.
- SQL file header: follow `2026-11-16_senior_resumes_recheck_needed.sql` (WHAT / PRIVILEGE CLASS /
  APPLY / Rollback). Add `SET LOCAL lock_timeout = '10s'`. Use `IF NOT EXISTS` everywhere so a re-run
  is a no-op. The CHECK id lists must be literal copies of `SENIOR_SELECTABLE_ROLES` /
  `TECHNICAL_ROLES`.
- Rollback line: drop the 3 opportunity columns, `users.technical_roles` and the table. Nothing else
  reads them in this PR.

- [ ] **Step 1: Write the failing DDL spec** in the pattern of
      `senior-resumes-recheck-ddl.integration.spec.ts`. Apply the SQL file to a scratch database
      twice. Assert:
  - `applying twice is a no-op`
  - `users.technical_roles refuses SOFTWARE_ENGINEER and an unknown id`
  - `job_opportunities refuses roles with status PENDING, and empty roles with status RULE`
  - `job_role_classifications refuses outcome 'MAYBE'`
  - `the GIN index exists` (`pg_indexes`)
  - `the CHECK id lists equal SENIOR_SELECTABLE_ROLES / TECHNICAL_ROLES` (parse `pg_get_constraintdef`)
- [ ] **Step 2: Run** `DATABASE_URL=<scratch url> pnpm --filter @crm/api test -- technical-roles-forward-ddl`.
      Expected: FAIL. Confirm the target first with `SELECT current_database()`, which must not
      return `crm_db`.
- [ ] **Step 3: Implement** the SQL file, the Drizzle declarations and the privilege entries.
- [ ] **Step 4: Run** the DDL spec and `pnpm --filter @crm/api test -- privilege-classes`. Expected:
      PASS, and the privilege spec reports `job_role_classifications` as classified.
- [ ] **Step 5: Commit** `feat(db): technical roles columns and role classification cache`.

### Task 2.2: Deploy wiring (DevOps zone; dispatch DevOps)

**Files:** `.github/workflows/deploy.yml` (rollback preflight list + SCP step for manual SQL files),
`scripts/devops/deploy-stack-on-vps.sh` (apply block), `docs/runbooks/deployment.md` (one row in each
of the 2 manual-DDL tables).

- Apply order: before the container swap, because the new code selects the new columns. Use the same
  `psql -v ON_ERROR_STOP=1 --single-transaction` form as the neighbouring blocks.
- [ ] **Step 1:** Add the file name to every list that names `2026-11-16_senior_resumes_recheck_needed.sql`.
      Grep for that name, and the count of hits must double.
- [ ] **Step 2: Verify** with `bash -n scripts/devops/deploy-stack-on-vps.sh` and the repo's
      workflow lint (actionlint, if CI runs it). Expected: no errors.
- [ ] **Step 3: Commit** `infra(deploy): apply technical roles DDL` (a DevOps commit inside PR 2).

### Task 2.3: Classify at ingest + lazy backfill

**Files:**

- Create: `apps/api/src/job-sourcing/store/opportunity-roles.ts`
- Modify: `apps/api/src/job-sourcing/store/canonical.store.ts` (`createOpportunity`, `refreshOpportunity`)
- Modify: `apps/api/src/job-sourcing/runtime/recompute-worker.ts` (`recomputeOpportunity`)
- Modify: `apps/api/src/job-sourcing/runtime/recompute-inputs.ts`: `EVALUATION_RECORD_VERSION = 'rf.2'`
- Test: `apps/api/src/job-sourcing/store/opportunity-roles.spec.ts` (unit, fake executor), plus
  `apps/api/src/job-sourcing/store/opportunity-roles.integration.spec.ts`

**Interfaces:**

- Consumes:
  - `classifyRoles` and `ROLE_CLASSIFIER_VERSION` (Task 1.4).
  - `CanonicalFields.title`, `.titleKey`, `.stackKeywords` and `.descriptionSha256`
    (`store/canonical-plan.ts`).
- Produces:
  - `type RoleStatus = 'RULE' | 'AI' | 'PENDING' | 'UNCLEAR' | 'NON_IT'`
  - `type OpportunityRoles = { status: RoleStatus; roles: readonly TechnicalRole[]; classifierVersion: string }`
  - `deriveOpportunityRoles(tx: SqlExecutor, f: { title: string; titleKey: string; tags: readonly string[]; descriptionSha256: string | null }): Promise<OpportunityRoles>`
    1. Run `classifyRoles`: `ROLES` → `RULE`; `NON_IT` → `NON_IT`.
    2. If that gives `UNCLASSIFIED` and `descriptionSha256` is not null, look up
       `job_role_classifications` at the current version:
       - an `AI` row gives `AI` and its roles
       - an `UNCLEAR` row gives `UNCLEAR`
       - a `FAILED` row or no row gives `PENDING`
    3. With `descriptionSha256` null there is **no lookup**. The result is `PENDING`.
  - `writeOpportunityRoles(tx: SqlExecutor, opportunityId: string, r: OpportunityRoles): Promise<void>`:
    an UPDATE of the 3 columns only. It never touches `revision`.
- Store rules:
  - `createOpportunity` writes the 3 columns in its INSERT.
  - `refreshOpportunity` re-derives only when `title`, `stack_keywords` or `description_sha256` is
    distinct from the stored row. Otherwise it keeps an existing `AI` / `UNCLEAR` answer.
  - The 3 columns stay **out** of the `IS DISTINCT FROM` tuple that bumps `revision`.
- Recompute rule: under the existing `FOR NO KEY UPDATE` lock, before `loadOpportunity`, a row whose
  `role_classifier_version` is NULL or not `ROLE_CLASSIFIER_VERSION` is re-derived and written. This
  is the backfill. The `rf.2` bump makes the reconciliation sweep re-enqueue every OPEN/UNKNOWN
  opportunity. That sweep needs `JOB_MATCH_RECONCILIATION_ENABLED=true`, which `deploy.yml` sets
  for prod.

- [ ] **Step 1: Write the failing tests**

```ts
// opportunity-roles.spec.ts
it('RULE for a classified title, no cache read', ...)            // executor records 0 SELECTs
it('NON_IT for an excluded phrase', ...)
it('PENDING and no cache lookup when descriptionSha256 is null', ...) // Review Focus 2
it('AI roles from an AI cache row at the current version only', ...)  // an rc.0 row is ignored
it('UNCLEAR from an UNCLEAR cache row; PENDING from a FAILED row', ...)
// opportunity-roles.integration.spec.ts (scratch DB)
it('createOpportunity stores roles, status and classifier version', ...)
it('refreshOpportunity with an unchanged title keeps an AI answer and does not bump revision', ...)
it('a reclassification-only write never changes revision', ...)
it('recompute backfills a NULL role_status row under the lock and leaves revision unchanged', ...)
it('evaluation output is unchanged by this PR', ...) // same EvaluationResult before/after for a fixture opportunity
```

- [ ] **Step 2: Run** `pnpm --filter @crm/api test -- opportunity-roles` (unit) and the integration file
      with a scratch `DATABASE_URL`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions and the 3 call sites.
- [ ] **Step 4: Run** the same commands, plus `pnpm --filter @crm/api test -- canonical recompute`.
      Expected: PASS. Existing canonical-store and recompute specs stay green with a non-zero count.
- [ ] **Step 5: Commit** `feat(job-sourcing): classify vacancy roles at ingest and backfill lazily`.

### Task 2.4: Users API accepts roles (optional, SENIOR only)

**Files:**

- Modify: `packages/shared/src/schemas/users.ts`:
  - `technicalRoles: seniorRolesSchema.optional()` on `createUserSchema`, `hrCreateSeniorSchema`,
    `updateProfileSchema` and `adminUpdateUserSchema`
  - `technicalRoles: z.array(technicalRoleSchema).default([])` on `userProfileSchema` and
    `profileOverviewDataSchema`
- Modify: `packages/shared/src/schemas/api-errors/auth-users-projects.ts`, `zod-errors.ts` and the
  catalogs: add the new code `TECHNICAL_ROLES_SENIOR_ONLY` (uk + en; copy-reviewer).
- Modify: `apps/api/src/users/role-guards.util.ts`, `users.service.ts` (`updateProfile`,
  `USER_LIST_PROJECTION`), `user-creation.service.ts` and `admin-user-update.service.ts`.
- Test: the existing specs plus one new spec:
  - existing `admin-update-user.unit.spec.ts`, `create-user.unit.spec.ts`, `users.service.spec.ts`
  - new `apps/api/src/users/senior-roles.realdb.integration.spec.ts`, in the pattern of
    `drop-profile-rbac.integration.spec.ts`

**Interfaces:**

- Produces:
  - `assertSeniorOnlyRoles(effectiveRole: Role, roles: readonly string[] | undefined): void`: throws
    `apiError('TECHNICAL_ROLES_SENIOR_ONLY', 400)` when roles are non-empty and the role is not
    `SENIOR`.
  - `rolesChanged(next: readonly string[] | undefined, current: readonly string[]): boolean`. It works
    like `techStackChanged`; compare sorted.
  - Reads return `technicalRoles`. A stored role is kept when a SENIOR becomes another role. It is
    harmless, because `loadRoster` reads only `SENIOR` (an A1 assumption).
  - **No role floor in this PR** (Review Focus 1). `assertSeniorTechFloor` stays exactly as it is.
- Endpoints and their existing guards are unchanged:

  | Endpoint                | Who may call it                  |
  | ----------------------- | -------------------------------- |
  | `POST /users`           | ADMIN, HR                        |
  | `PATCH /users/:id`      | ADMIN                            |
  | `PATCH /users/me`       | self                             |
  | `PATCH /users/:id/role` | ADMIN; does **not** accept roles |

- [ ] **Step 1: Write the failing tests**

```ts
it('ADMIN PATCH /users/:id sets technicalRoles on a SENIOR and returns them sorted', ...)
it('ADMIN PATCH /users/:id with technicalRoles on a JUNIOR -> 400 TECHNICAL_ROLES_SENIOR_ONLY', ...)
it('PATCH /users/:id with SOFTWARE_ENGINEER -> 400 (zod)', ...)
it('HR POST /users creating a SENIOR may set technicalRoles', ...)
it('a SENIOR PATCH /users/me sets own technicalRoles', ...)
it('roles are optional: a SENIOR write with techStack only still passes the stack floor', ...) // Review Focus 1
// RBAC 403 (real HTTP guard path, integration):
it('HR PATCH /users/:id with technicalRoles -> 403', ...)
it('JUNIOR / ACCOUNTANT / SENIOR PATCH /users/:id with technicalRoles -> 403', ...)
it('a SENIOR cannot set another user roles through PATCH /users/me (body has no id; target is self)', ...)
it('unauthenticated PATCH /users/me -> 401', ...)
```

- [ ] **Step 2: Run** `pnpm --filter @crm/api test -- admin-update-user create-user users.service senior-roles`.
      Use a scratch `DATABASE_URL` for the realdb file. Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `technicalRoles` through the 3 services next to `techStack`.
      Call `assertSeniorOnlyRoles` with the effective role, i.e. after any role change in the same
      write.
- [ ] **Step 4: Run** the same command and `pnpm --filter @crm/web typecheck`. Expected: PASS. The web
      compiles unchanged, because the field is optional.
- [ ] **Step 5: Commit** `feat(users): accept technical roles for seniors`.

**PR 2 done when:** all of Tasks 2.1–2.4 are green, plus `pnpm typecheck` and `pnpm --filter @crm/api test`.
Security-reviewer verdict is recorded. Trailer: `ac_verified: 2.1,2.2,2.3,2.4`.

**Deploy (owner merges):** steps (a) and (b). Verify after deploy with read-only SELECTs (owner, on
prod):

```sql
SELECT role_status, count(*) FROM job_opportunities GROUP BY 1;          -- NULL shrinks per 6-hour tick
SELECT count(*) FROM users WHERE role = 'SENIOR' AND cardinality(technical_roles) = 0;
```
