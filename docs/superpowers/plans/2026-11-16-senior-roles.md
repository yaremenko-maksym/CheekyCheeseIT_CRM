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
- Create `apps/api/src/database/schema/job-role-classifications.ts`. Register it in the schema barrel
  the other job tables use.
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
