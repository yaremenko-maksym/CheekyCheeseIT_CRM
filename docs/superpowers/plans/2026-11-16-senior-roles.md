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
