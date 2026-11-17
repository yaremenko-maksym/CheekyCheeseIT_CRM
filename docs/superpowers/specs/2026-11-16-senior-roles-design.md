# Senior technical roles + skills-overlap indicator — design

**Date:** 2026-11-16 · **Status:** draft, awaiting owner approval · **Stage:** 1 of 2
**Research:** `docs/architecture/research/2026-11-16-it-role-taxonomy.md` (34 roles, 11 groups, sources)

## Intent and why

Today a senior is described by a free list of technologies (`users.tech_stack`, at least 3), and the
vacancy matcher decides LEAD / TRIAGE / EXCLUDED by keyword overlap between that list and the
vacancy. The owner wants the senior described by **what they do** (1..N technical roles from a fixed,
complete IT taxonomy), the HR queue filtered by those roles, and the technologies taken **from the
senior's resume** instead — shown as a soft "how well does this fit" indicator, not as a gate.
Stage 2 (later, once resumes are filled) adds a Jev relevance score 0–100 for the top N vacancies or
on demand.

## Goals

1. A fixed enum of 34 technical roles in `@crm/shared` (ids, en/uk labels, groups) — the taxonomy from
   the research file, unchanged except for copy review of the uk labels.
2. Every senior has 1..N roles, set where the tech stack is set today (admin create/edit, HR create
   senior, senior self-edit).
3. Every ingested vacancy gets 0..N roles from a deterministic title classifier (title first, then
   provider tags/categories; technology words only when the title names no function).
4. The queue shows a vacancy for a senior when their roles intersect, with widening (below).
5. Each queue card shows a skills-overlap indicator per matched senior: "k of n" — how many of the
   vacancy's technologies are in the senior's resume (`skills` ∪ `experience[].technologies`), folded
   through the existing `SKILL_SYNONYM_GROUPS` / `stackTokens`.
6. Migration assigns roles to the 3 prod seniors (mapping below) and re-evaluates every match.

## Non-goals

- Jev relevance score (stage 2).
- Per-technology roles ("React developer"), seniority as a role.
- Changing `role_family` and the team triage subscriptions that use it (kept; each role maps to a
  family for them).
- Editing resumes or adding new resume fields (`experience[].technologies` already exists on main).

## Anti-goals (a failure even if it works)

- A good IT vacancy disappears only because the keyword rules missed it (44 of 109 real WWR titles
  were unclassified by rules in the research test run; most non-technical, 4 arguably technical).
  Guard: the AI step looks at every one of them before anything is hidden, and the per-run count of
  `ROLE_UNCLEAR` / `ROLE_PENDING` is logged so a classifier gap is visible. Hiding what the AI also
  cannot place is the owner's explicit choice.
- The indicator is used as a filter or hides vacancies — it only informs.
- A senior with no resume sees a misleading "0 of 7"; no resume must read as "no resume", not as a
  bad fit.

## Constraints

- Prod DDL only through the deploy migration path; live `crm_db` is read-only for agents.
- Postgres cannot drop a pgEnum value: roles are stored as `text[]` with a CHECK against the shared
  list (adding a role later = code change + CHECK replace), not as a pgEnum.
- Product text in `uk` + `en` via Lingui; uk role labels go through copy-reviewer.
- The match pipeline versioning (`MATCH_RULE_VERSION`, `senior_profile_version`,
  `policy_signature`) must change so every generation and match is recomputed after the switch.

## Approaches (picked by the owner 2026-11-16)

1. **Roles filter + deterministic skills overlap (picked, stage 1).** Cheap, instant after each run,
   no provider quota. Cannot read meaning (Kotlin + Java on an Android vacancy count as two hits).
2. Roles filter + Jev score on every vacancy × senior pair. Smarter, but ~2400 × 3 requests against
   free-model quotas, and needs `@crm/inference` enabled in prod. Rejected for now.
3. Hybrid: approach 1 for all, Jev on the top N or on demand. **Stage 2**, after resumes are filled.

## Design

### Data

- `packages/shared`: `TECHNICAL_ROLES` (id, group, en/uk labels via Lingui ids), `technicalRoleSchema`
  (Zod enum), `seniorRolesSchema` = 1..N distinct roles (replaces `seniorTechStackSchema` and the
  `SENIOR_MIN_TECHNOLOGIES` floor with "at least 1 role"; new error code `SENIOR_MIN_ROLES`).
- `users.technical_roles text[] NOT NULL DEFAULT '{}'` + CHECK every element is in the list.
- `job_opportunities.technical_roles text[] NOT NULL DEFAULT '{}'` + GIN index, written by the
  canonical store at ingest from the classifier.
- `users.tech_stack` stays in the table, read-only, no longer shown or required; dropped in a
  follow-up PR after stage 1 is live (rollback path).

### Classifier (vacancy → roles)

- Pure function in `packages/shared` (or `apps/api/src/job-sourcing/funnel/`), rules and keyword
  table from the research file §1/§3: title tokens on word boundaries, uk/ru stems, seniority words
  ignored, tech hints only without a function word, ambiguous tech (C++, Kotlin) never decides alone.
- Provider categories/tags (DOU/Djinni/Remotive/WWR categories, Greenhouse/Ashby departments) are a
  second signal when the title gives nothing.
- Backfill: one batch job re-classifies every stored opportunity (dirty-work, existing drain).
- `role_family` is not derived from roles (see call 4); it stays the layer-1 value.

### AI fallback for unclassified vacancies (owner 2026-11-16)

Owner: "use our inference and AI to analyse the vacancy; if the role is still not clear, do not show
the vacancy at all".

- Order: deterministic classifier → explicit non-IT phrase = EXCLUDED (layer 1) → roles found = done
  → otherwise status `ROLE_PENDING` and one AI classification through `@crm/inference`
  (title + description + provider category; output Zod-parsed: `roles: TechnicalRole[]` from the
  enum only, plus `confidence`).
- AI returns ≥1 role with confidence ≥ threshold (builder picks, start 0.7) → those roles, source
  `AI`. Otherwise → EXCLUDED, reason `ROLE_UNCLEAR`. Neither the pending nor the unclear vacancy is
  shown to anyone (ADMIN sees it only in the existing exclusion audit view, if any).
- Runs as a step of the post-fetch processing (after records become opportunities, #1366 path),
  bounded per pass; cached by `(normalised title, description hash, classifier version)` so a
  re-post costs nothing.
- Provider outage degrades, never breaks: the vacancy stays `ROLE_PENDING` (hidden), retried on the
  next pass with backoff; structured log with provider + cause; deterministic results are unaffected.
- Only free models (no paid OpenRouter), vacancies are public data (no personal data sent). Prod
  needs the inference provider configured: today `@crm/inference` is inert in prod — wiring the
  provider env is a deploy step (owner / DevOps), tracked in the plan. Until it is wired every
  unclassified vacancy stays hidden, which is the owner's requested default anyway.
- Role source (`RULE` / `AI`) is stored with the roles so a later classifier version can re-run
  only `AI`/pending rows.

### Matching

- Outcome for (vacancy, senior):
  - roles intersect after widening → **LEAD**;
  - roles disjoint → **EXCLUDED** for that senior;
  - vacancy `ROLE_PENDING` / `ROLE_UNCLEAR` / non-IT → not in the queue at all.
  - The old "TRIAGE because the stack is unknown" path goes away for role reasons; other layer-1
    WARN reasons (location, salary unknown…) keep working as today.
- Widening is a fixed, **one-hop, non-transitive** table next to the enum (Backend sees Fullstack,
  Fullstack sees Frontend, but Backend does not see Frontend through Fullstack). A vacancy with
  several roles matches when **any** of its roles is in the senior's widened set. The full matrix is
  below; every pair was checked, unlisted pairs are deliberate non-matches.
- `profileVersion` = digest(sorted roles, teamIds); `MATCH_RULE_VERSION` bumped; dirty producer
  `senior.roles` replaces `senior.stack`.
- Tech keyword overlap no longer decides the outcome.

#### Widening matrix (senior role → also sees vacancies tagged)

`SWE` = `SOFTWARE_ENGINEER` (generic, vacancy-only — never selectable for a senior).

| Senior role                    | Also sees                            |
| ------------------------------ | ------------------------------------ |
| BACKEND_ENGINEER               | FULLSTACK, SWE                       |
| FRONTEND_ENGINEER              | FULLSTACK, SWE                       |
| FULLSTACK_ENGINEER             | BACKEND, FRONTEND, SWE               |
| DESKTOP_ENGINEER               | SWE                                  |
| BUSINESS_APPLICATIONS_ENGINEER | SWE                                  |
| IOS_ENGINEER                   | CROSS_PLATFORM_MOBILE, SWE           |
| ANDROID_ENGINEER               | CROSS_PLATFORM_MOBILE, SWE           |
| CROSS_PLATFORM_MOBILE_ENGINEER | IOS, ANDROID, SWE                    |
| GAME_DEVELOPER                 | SWE                                  |
| BLOCKCHAIN_ENGINEER            | SWE                                  |
| EMBEDDED_ENGINEER              | HARDWARE, SWE                        |
| HARDWARE_ENGINEER              | EMBEDDED                             |
| DATA_ENGINEER                  | DATABASE                             |
| DATABASE_ENGINEER              | DATA_ENGINEER                        |
| DATA_ANALYST                   | — (exact)                            |
| DATA_SCIENTIST                 | ML, AI                               |
| ML_ENGINEER                    | DATA_SCIENTIST, AI                   |
| AI_ENGINEER                    | ML, DATA_SCIENTIST                   |
| DEVOPS_ENGINEER                | SRE                                  |
| SITE_RELIABILITY_ENGINEER      | DEVOPS                               |
| SYSTEM_ADMINISTRATOR           | — (exact)                            |
| NETWORK_ENGINEER               | — (exact)                            |
| SUPPORT_ENGINEER               | — (exact)                            |
| QA_ENGINEER                    | QA_AUTOMATION                        |
| QA_AUTOMATION_ENGINEER         | QA                                   |
| SECURITY_ENGINEER              | SECURITY_ANALYST, PENETRATION_TESTER |
| SECURITY_ANALYST               | SECURITY_ENGINEER                    |
| PENETRATION_TESTER             | SECURITY_ENGINEER                    |
| SOFTWARE_ARCHITECT             | — (exact)                            |
| ENGINEERING_MANAGER            | — (exact)                            |
| CTO                            | — (exact)                            |
| BUSINESS_ANALYST               | — (exact)                            |
| UI_UX_DESIGNER                 | — (exact)                            |

Pairs considered and rejected (one line each, so they are not re-litigated):

- BACKEND ↔ FRONTEND directly — different work; Fullstack covers the overlap.
- FRONTEND ↔ CROSS_PLATFORM_MOBILE (React Native) — the skills indicator shows the overlap instead.
- AI_ENGINEER ↔ BACKEND (LLM apps) — same, indicator.
- DEVOPS ↔ SYSTEM_ADMINISTRATOR / NETWORK — sysadmin vacancies are mostly on-site ops; exact.
- DATA_ANALYST ↔ DATA_SCIENTIST — analyst roles rarely qualify for DS vacancies.
- HARDWARE → SWE — hardware engineers do not do generic software roles.
- Data / infra / QA / security roles → SWE — a generic "Software Engineer" is a developer vacancy.
- Architect / EM / CTO → their specialists or back — owner: exact only.
- SUPPORT_ENGINEER → SYSTEM_ADMINISTRATOR — support is L2/L3 product support, exact.

### Skills-overlap indicator

- Computed at match time per (vacancy, senior) and stored in match evidence:
  `{ matched: string[], total: number }`: n = dictionary technologies named in the vacancy title +
  description, k = those in the senior's resume `skills` ∪ `experience[].technologies`, both
  canonicalised by `SKILL_SYNONYM_GROUPS` (see call 3).
- Resume change marks the senior dirty (`senior.resume`) so the indicator refreshes.
- Card: "5 з 7 навичок" / "5 of 7 skills" per matched senior, tooltip lists the matched ones; no
  resume → "немає резюме" / "no resume"; vacancy with no technologies → hidden.

### UI

- `TechStackSection` → `RolesSection`: grouped multi-select of the 34 roles (same places: UserDialog,
  HrCreateSeniorDialog, ProfileEditFields), required ≥1 for SENIOR.
- Profile / team / users list show role chips instead of the stack.
- Queue: the senior picker (top of filters, #1364) unchanged; card shows the indicator.
- Responsive + design gate per repo rules (redesign pending: no UI scoring, findings only).

### Migration of prod data

- DDL only in the deploy migration; **no user ids in the repo** (public repo).
- Right after deploy the orchestrator sets the roles through the existing ADMIN user-update API
  (owner approved this prod write 2026-11-16): one senior → BACKEND; one → FULLSTACK + BACKEND +
  FRONTEND; one → ANDROID (ids kept out of the repo and reports).
- Until a senior has roles they match nothing (empty queue for them), never everything; the window
  is minutes.
- Then the backfill classifier run and a full match recompute (version bump does it).

### RBAC

Unchanged: whoever may edit a senior's tech stack today may edit their roles (ADMIN; HR on create;
the senior on self-edit). Security review required (users write path).

## Left to the builder

- Exact file split, the classifier's internal structure, test fixtures from the research appendix.
- Whether the classifier lives in shared or api (shared if the web needs it; it does not today).
- PR slicing (suggested: 1 shared enum + classifier + skill dictionary; 2 schema + backfill + matching; 3 UI +
  indicator).

## Calls made after the builder check (orchestrator, owner may overrule)

1. **Classifier `EXCLUDED`** (explicit non-IT phrases from the research: sales engineer, recruiter,
   project/product manager, customer support…) is a hard layer-1 exclusion with a new reason code in
   the CLASSIFICATION stage. Only titles with neither a role nor a non-IT phrase are "unclassified".
2. **Widening:** the matrix above (owner approved the core pairs and asked to check every
   combination; the extra pairs — Embedded↔Hardware, Data↔Database, the security trio — are calls).
   `SOFTWARE_ENGINEER` is a vacancy-only fallback, not selectable for a senior (33 options).
3. **n in "k of n"** = technologies the vacancy names (title + description) that are in the shared
   skill dictionary (`SKILL_SYNONYM_GROUPS`, extended in PR 1 to cover the common stacks of the 34
   roles); k = how many of those are in **this** senior's resume. Only that senior's own skills are
   used, so no cross-senior data reaches another team. Provider tags are not technologies.
4. **`role_family`** stays as today (layer-1 title regex) and keeps feeding triage subscriptions;
   no DDL on it.
5. **Roles are for SENIOR only.** Other users keep `tech_stack` as today; the column is not dropped
   (PR 4 removed from the plan). For a SENIOR the stack field is hidden.
6. **Indicator is display-only** in stage 1; ranking unchanged.
7. The resume read follows `JobSourcingService.getSeniorStack` (`content.skills`), plus
   `experience[].technologies`; empty → "no resume", never "0 of n".

## Owner decisions (2026-11-16)

1. Unclassified vacancy → AI classification via `@crm/inference`; still unclear → hidden from
   everyone.
2. Prod roles for the 3 seniors → set by the orchestrator through the ADMIN API after deploy.
3. Widening → approved; every combination checked (matrix above).

## Review round 1 corrections (verified against origin/main)

These override the sections above where they disagree.

1. **Hiding goes through the existing verdict, not a new filter.** `listableOpportunityPredicate`
   (`queue/queue-scope.ts`) lists in STUDIO every opportunity not `EXCLUDED` at its current
   revision, and one not yet evaluated stays listed as triage. So `ROLE_PENDING`, `ROLE_UNCLEAR` and
   non-IT are **opportunity-level evaluation outcomes**: verdict `EXCLUDED` at the current revision
   with reason `ROLE_PENDING` / `ROLE_UNCLEAR` / `NON_IT` in the CLASSIFICATION stage. Every list,
   generation and subscription read that already honours `EXCLUDED` hides them with no new
   predicate. Tests must cover STUDIO list, TEAM list, a team subscription, and the generation.
2. **Storage.** `job_opportunities` gets `technical_roles text[]` (CHECK: every element in the
   34-role list), `role_status text` (`RULE` | `AI` | `PENDING` | `UNCLEAR` | `NON_IT`, CHECK) and
   `role_classifier_version text`. AI results are cached in a new table keyed by
   `(normalised title, description hash, classifier version)` with roles, confidence and model.
   `users.technical_roles` CHECK uses the **33 senior-selectable roles** (no `SOFTWARE_ENGINEER`).
3. **No race with the AI step.** Evaluation reads `role_status`. `PENDING` evaluates to `EXCLUDED`
   (`ROLE_PENDING`). When the AI step writes a result it marks the opportunity dirty (existing
   `OPPORTUNITY` dirty work), which re-evaluates it with the new roles. An early evaluation is
   therefore correct (hidden), not stale.
4. **Detail-on-demand sources.** The AI step runs only when the description is present (IN_LIST
   source, or detail already fetched). While the detail is pending the status stays `PENDING`, and
   `PENDING` must never block the detail fetch (`evaluate.types.ts` detail-pending path). Never
   classify `UNCLEAR` from a title-only record of a detail-on-demand source.
5. **Per-senior role mismatch** stays an `EXCLUDED` match row in the CLASSIFICATION stage. Checked:
   `stop_listed` counts only `evidence.stage = 'SCOPED_RESTRICTIONS'` (`queue/queue-read-sql.ts`), so
   it does not inflate the stop-list count or produce a false `STOP_LISTED` reason (finding refuted).
6. **`profileVersion`** = digest(sorted roles, teamIds, **digest of the canonicalised resume
   skills**), so a resume edit changes `policySignature` and the cached generation is rebuilt.
7. **Evidence shape.** LEAD by role carries a `ROLE_MATCH` reason (exact or widened) plus the
   indicator `{ matched, total }`. `matchFacts` (`queue/job-queue.service.ts`) is changed so a role
   match is not "approximate" and `matchedKeywords` shows the matched skills; its tests move with it.
8. **Deploy order:** (a) migration; (b) backfill classifier over all stored opportunities; (c)
   AI pass over the `PENDING` ones (if inference is wired); (d) set the 3 seniors' roles; one full
   recompute after (d). Not (d) before (b).
