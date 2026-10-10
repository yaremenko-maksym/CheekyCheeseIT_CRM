# Vacancy auto-sourcing — adversarial audit of the r5 plan + design

**Date:** 2026-10-10 · **Pass:** 2 of 2 (audit; the author of this document did not write r5) · **Status:** findings
for a future **r6**; the feature stays DEFERRED. This document authorizes nothing — no code, tasks, deploys,
purchases, credentials or source contact.
**Audited:** `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`,
`docs/superpowers/plans/2026-10-10-vacancy-sourcing-design.r5.md`, the r4 plan/design uploads they correct, and the
r4-delta note.
**Verified against:** the code on the r5 branch head (`main` at `cff2ea12` + the two r5 docs): `apps/api/src/job-sourcing/**`,
`apps/api/src/common/hr-access.service.ts`, `apps/api/src/finance/active-teams.util.ts`,
`apps/api/src/database/schema.ts`, `apps/api/drizzle/manual/2026-10-05_*`, `apps/api/src/config/env.ts`,
`apps/api/src/app.module.ts` and every `@Cron` in `apps/api/src`, `apps/api/Dockerfile`, `apps/api/nest-cli.json`,
`docker-compose.prod.yml`, `.github/workflows/deploy.yml`, `scripts/devops/check-prod-ddl-wiring.py`,
`scripts/devops/check-no-russian-letters.mjs`, `packages/shared/src/schemas/job-sourcing.ts`,
`apps/web/app/components/job-sourcing/open-original.ts`, `CONTEXT.md`, `.claude/rules/common/*`,
`docs/runbooks/deployment.md`. Evidence is cited as `path:symbol` (doc-durability rule; no line numbers).

**Legend.** CONFIRMED = the defect is visible in the repository today. PLAUSIBLE = the reasoning is sound but the
decisive fact lives outside the repository (vendor docs, hardware, law) and must be checked with `external-research`
at resumption. Severity: HIGH = would make a shipped v1 wrong or unsafe; MED = would cost a redesign or a security/
money/RBAC review round; LOW = wording, naming or a missing sentence.

---

## Executive summary — what r4 and r5 both missed

r5 is a good reconciliation: its C-01…C-30 inventory of what exists is accurate in every item this audit re-checked
(see "r5 claims re-verified" at the end). The gaps are elsewhere — in the **runtime topology** (which process runs
what, on which network, with which secret), in **a definition r5 reuses without noticing the repo disagrees with
itself** (what an "active team" is), and in a handful of **shipped symbols r5 credits with properties they do not
have**. The material new findings, in priority order:

| ID       | Sev  | One line                                                                                                                                                                                            |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUDIT-01 | HIGH | "Worker = same image, separate process" has no process-role mechanism; a second Nest process would run **every** cron twice — including the monthly salary cron and the 15-second e-mail cron.      |
| AUDIT-02 | HIGH | r5 conflates two workers (collection worker with a DB role vs extractor with the model secret and no DB) and gives the single word "worker" contradictory network/secret properties in four places. |
| AUDIT-03 | MED  | A1m (`timeZone: 'Europe/Kyiv'` on the 05:00 cron) silently moves it to 02:00/03:00 UTC — on top of the 03:00–03:45 UTC retention crons the class doc explicitly sequences it after.                 |
| AUDIT-04 | MED  | The least-privileged worker DB role cannot be created through the existing "committed SQL re-applied by `psql < file`" pipeline: a role password cannot live in a committed file.                   |
| AUDIT-05 | MED  | "Active team" is undefined and the repo's two helpers disagree: `findEligibleSeniorIds`/`HrAccessService` ignore `teams.archivedAt` and `teams.type`; `findActiveTeamsForUser` filters archived.    |
| AUDIT-06 | MED  | `externalHttpsUrlSchema` and `isSafeExternalUrl` are `^https://\S+$`: they accept userinfo, IP literals and any port — r5 cites the schema as the thing that "rejects credentials".                 |
| AUDIT-07 | MED  | Every new API file r5 places under `apps/api/src/job-sourcing/**` is **excluded** from the cyrillic guard; D-07's claim that the guard covers the web `job-queue` directory is wrong (API-only).    |
| AUDIT-08 | MED  | Each forward DDL file raises the deploy pipeline's rollback floor; r5's rollback section promises "redeploy a compatible old API" that the pipeline will refuse once the first forward file lands.  |
| AUDIT-09 | MED  | Task 8.1's "v1 alerts" have no runtime delivery channel in this codebase (only in-app/e-mail notifications and CI-side GitHub-issue alerts exist).                                                  |
| AUDIT-16 | MED  | Model calls reconcile cost after the response; unlike TheirStack there is no worst-case reservation before the call — the OpenRouter key limit is the only hard cap.                                |
| AUDIT-P1 | MED  | Sourcing from the main VPS puts the IP reputation of every existing outbound integration (NBU rates, Cloudflare AI, R2, Resend, Google Indexing) in the blast radius of one block.                  |
| AUDIT-P4 | MED  | Postings carry third-party personal data (recruiter names/e-mails/phones); r4/r5 strip contacts only before the model, not before storage; content-addressed blobs complicate erasure.              |

Everything else (AUDIT-10…15, P2, P3, P5–P7) is LOW or a bounded external check.

---

## CONFIRMED findings (evidence in the repository)

### AUDIT-01 — HIGH — A second Nest process would run every scheduler twice

**Claim (r4 §6.1, r5 Task 2.5 / §7):** "The worker runs as a separate process from the HTTP API (same image, own
resource limits)"; cron "handlers only enqueue due work".

**Evidence.** `ScheduleModule.forRoot()` is imported by `finance/finance.module.ts`, `resumes/resumes.module.ts`,
`telemetry/telemetry.module.ts`, `integrations/meeting-recorder/meeting-recorder.module.ts` (and the vacancies/
documents/notifications modules carry `@Cron` handlers). There is **no** process-role switch anywhere: no
`PROCESS_ROLE`/`CRON_ENABLED`-style key in `config/env.ts`, no conditional registration. `apps/api/Dockerfile` has a
single `CMD ["node", "dist/main"]`; `apps/api/nest-cli.json` builds one entry. Crons that would double-fire in a
second process booting `AppModule`: `finance/salary-cron.service.ts` (`0 0 1 * *` — money),
`notifications/notification-email.cron.ts` (every 15 s — duplicate e-mails),
`resumes/resume-extraction.cron.ts` (every 5 min — duplicate Cloudflare AI spend), the four retention crons, and
`job-sourcing.cron.ts` itself.

**Why it matters.** The plan's whole concurrency story (durable ownership, fencing) protects the **new** job-sourcing
work. It says nothing about the crons that already exist, which have no ownership and assume a single process. A
worker container that boots the same `AppModule` is the one topology change that breaks that assumption.

**r6 correction.** (1) Introduce an explicit process role (`PROCESS_ROLE=api|collector`, validated in `env.ts`) and
make scheduler registration conditional — either a `SchedulerGate` provider that no-ops `@Cron` classes when the role is
not `api`, or a separate `worker.module.ts` that imports only `DatabaseModule` + job-sourcing collection providers and
**never** `ScheduleModule`. (2) A second compiled entry (`dist/worker`) through nest-cli's multi-project layout or a
bootstrap switch in `main.ts`. (3) Red test before any worker exists: boot with the collector role → `SchedulerRegistry`
lists zero cron jobs; boot with `api` → the current set. (4) Add the role to the compose service definition and to
`docs/runbooks/deployment.md`. This is an A1 design decision but it must be written down; today the plan reads as if
"separate process" were free.

### AUDIT-02 — HIGH — "The worker" is two different containers with contradictory properties

**Claim.** r5 D-05: extractor secrets are "read only by the worker process, which runs in a separate compose
project/profile with its own network and **never joins the prod `backend` network** where `postgres`/`redis` live".
r5 Task 1.3: "Dedicated least-privileged PostgreSQL role + connection string **for the collection worker**". r5 Task
5.2: "the worker holds **no DB credential**". r5 Task 2.2: undici `ProxyAgent` "used by the worker and the browser
container". r5 C-21: extractor keys "validated in `env.ts` and read only by the worker process" — `env.ts` is the Nest
app's schema, i.e. the process that also holds `DATABASE_URL`.

**Evidence.** `docker-compose.prod.yml` has exactly two networks (`backend`: postgres/redis/api; `frontend`: api/nginx)
and one application container. `config/env.ts` is loaded by `AppModule` only. A process that claims work with
`FOR UPDATE SKIP LOCKED` (Task 2.5) must be on `backend`; a process that "never joins `backend`" cannot claim work.

**Why it matters.** The security property r4 §6.2 wants — the thing that fetches untrusted pages holds no CRM
credentials — is only true if the fetching process and the DB-owning process are different containers. r5 collapses
them into one noun, so a coder can satisfy every sentence of the plan with a single container that holds the DB role,
the model key and the egress capability at once. That is the r4 anti-pattern restated.

**r6 correction.** Name three runtime roles and give each a row in one table: **api** (HTTP, crons, `backend` +
`frontend`, full `DATABASE_URL`, no sourcing secrets); **collector** (claims work, API/RSS fetches through the egress
proxy, `backend` + an `egress` network, worker DB role, no model key, no browser); **extractor/renderer** (model key
and/or headless browser, `egress` network only, no DB, speaks to the collector over a private request/response
contract). State which network carries collector↔extractor traffic and that the egress proxy is the only route to the
internet for both. Then rewrite D-05, 1.3, 2.2, 5.2 and C-21 against that table.

### AUDIT-03 — MED — A1m re-orders the nightly cron sequence the repo deliberately set

**Claim (r5 C-07, D-04, A1m):** add `timeZone: 'Europe/Kyiv'` to the existing `@Cron('0 5 * * *')` and to the new 02:30
HTML schedule; "05:00 is an existing fact".

**Evidence.** `job-sourcing.cron.ts:JobSourcingCronService` class doc: "Slot: 05:00 daily — **after** the 03:00 / 03:30
/ 04:00 retention jobs, so an external HTTP fetch never contends with them for DB connections." Those retention crons
are zoneless (container UTC): `vacancies-retention.cron.ts` `0 3 * * *` and `0 4 * * 1`,
`telemetry-retention.cron.ts` `30 3 * * *`, `document-access-log-retention.cron.ts` `30 3 * * *`,
`meeting-recorder-retention.cron.ts` `45 3 * * *`. 05:00 Europe/Kyiv is 03:00 UTC in winter and 02:00 UTC in summer —
i.e. **on top of or before** the jobs it was placed after. 02:30 Kyiv is 23:30/00:30 UTC. The zone evidence r5 cites
(`kyiv-day.ts`, `nbu-currency.service.ts`) is about finance date semantics, not scheduler slots.

**r6 correction.** Either (a) keep collection zoneless and express the business-time intent as a Kyiv-time check inside
the handler, or (b) zone **all** nightly crons in one small ADR and pick Kyiv slots that preserve the documented order
(e.g. retention 05:00–06:00 Kyiv, collection 07:00 Kyiv, HTML 04:30 Kyiv), updating each class doc. Add a test that
enumerates every `@Cron` expression + zone and asserts the UTC order (a regression test that would have failed r5).

### AUDIT-04 — MED — The worker DB role has no deployable path

**Claim (r5 Task 1.3):** "Dedicated least-privileged PostgreSQL role + connection string for the collection worker…
The single app `DATABASE_URL` cannot satisfy Task 2.2."

**Evidence.** `deploy.yml` writes `/opt/crm/.env.production` with one `DATABASE_URL=postgresql://crm_user:…` built
from `POSTGRES_PASSWORD`; every manual file is applied as `psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 < file` and
re-applied on every deploy; `scripts/devops/check-prod-ddl-wiring.py` recognises exactly that shape. A
`CREATE ROLE … PASSWORD '…'` cannot be committed, and a role created without a password cannot be used from a
container. Nothing in the pipeline passes a secret into `psql` (`-v`/`\set`) today.

**r6 correction.** A separate DevOps task with its own shape: (1) a new GitHub secret `JOB_WORKER_DB_PASSWORD` and a
derived `JOB_WORKER_DATABASE_URL` written to `.env.production`; (2) an idempotent role step
(`DO $$ … CREATE ROLE IF NOT EXISTS … ALTER ROLE … PASSWORD :'pw' … $$` via `psql -v pw=…`) that is **not** a
`manual/*.sql` file — or is one with the password injected through `\set`, and the wiring guard extended to accept
`-v`-parameterised applies; (3) GRANTs as a normal forward file (DML on the job-sourcing tables, SELECT on
`users`/`team_members`/`teams`/`projects`-derived inputs, nothing on finance/session/credential tables, no DDL);
(4) a scratch-DB test that connects as the role and proves DDL and finance `SELECT` fail. Note that AUDIT-P3 (pg-boss)
interacts with "no DDL".

### AUDIT-05 — MED — "Active team" is not one definition in this repository

**Claim (r5 Task 4.2, 6.1, C-09):** eligible seniors "reuse `findEligibleSeniorIds` semantics"; HR scope = "current
active-team membership"; team query "inside job-sourcing or a lift of `findActiveTeamsForUser`".

**Evidence.** `job-sourcing.service.ts:findEligibleSeniorIds` = `users.role='SENIOR' AND users.archivedAt IS NULL AND
team_members.leftAt IS NULL` — it never joins `teams`. `common/hr-access.service.ts:hrSharesActiveTeamWith` /
`getActiveTeamPeers` — `team_members.leftAt IS NULL` only. `finance/active-teams.util.ts:findActiveTeamsForUser` —
additionally `teams.archivedAt IS NULL` (its doc: "an archived team must never participate in a fresh override
decision"). `schema.ts:teams` also carries `type: SENIOR | DROP`; no helper filters it. `team_members` has no role or
"lead" column.

**Why it matters.** If visibility (6.1) lifts the finance definition and match counts (4.2) reuse the job-sourcing one,
an HR in an archived team sees nothing while the counts shown to ADMIN still include that team's seniors — "authorized
counts" become unexplainable. If both reuse the legacy one, an archived team keeps granting HR access to its seniors'
leads indefinitely. A DROP-type team as `teamId` scope is a valid-but-empty scope today.

**r6 correction.** One exported predicate in `apps/api/src/common/` (`activeSeniorTeamMembership`: `leftAt IS NULL AND
teams.archivedAt IS NULL AND teams.type = 'SENIOR'`) used by 4.2, 6.1 and the dirty-work producers; a policy-version
bump on team archive/unarchive; RBAC matrix rows "archived team", "DROP team", "team un-archived". Decide explicitly
whether the legacy DOU consumer keeps its looser definition (A1a says its wiring is preserved) — that is a second,
documented difference, not an accident.

### AUDIT-06 — MED — The shipped URL schema does not do what r5 says it does

**Claim (r5 Task 1.1):** "navigation URLs reject credentials/non-HTTPS (`externalHttpsUrlSchema`)"; Task 2.1: "stored
links reject userinfo/unsafe schemes/ports/IP literals"; r4 §11: "links use an explicit HTTPS URL policy with no
userinfo".

**Evidence.** `packages/shared/src/schemas/job-sourcing.ts:externalHttpsUrlSchema` = `z.string().url().max(2048)` +
`refine(/^https:\/\/\S+$/i)`. `apps/web/app/components/job-sourcing/open-original.ts:isSafeExternalUrl` is the same
regex. Both accept `https://user:pw@evil.example/`, `https://203.0.113.9/`, `https://host:8443/` — and the landed
`jobQueueItemSchema.url` / `jobAlsoSeenOnSchema.url` already use that schema.

**Why it matters.** The scheme check is real and the `javascript:` case is closed; the userinfo and IP-literal
requirements r4 wrote are simply not implemented, and r5 presents them as a property of an existing symbol.
`window.open` with userinfo is a phishing primitive (browser shows the host after `@` differently per vendor).

**r6 correction.** Add `navigationUrlSchema` (structural parse without the DOM `URL` type: authority has no `@`, host
is not an IPv4/IPv6 literal, no explicit port or only 443, no `\s`), use it for every **new** DTO and the new store;
keep `externalHttpsUrlSchema` for legacy DTOs (binary compatibility, C-01); harden `isSafeExternalUrl` the same way with
a red test for `https://a:b@host`; state in Task 1.1 that this is new work, not reuse.

### AUDIT-07 — MED — The cyrillic guard will not see a single new API file

**Claim (r5 C-13 / D-07):** `check-no-russian-letters.mjs` "excludes the legacy `job-sourcing` directory, guards the
new `job-queue` one".

**Evidence.** `scripts/devops/check-no-russian-letters.mjs` scans `API_SRC = <root>/apps/api/src` only (its header:
Lingui's `no-unlocalized-strings` covers `apps/web` + `packages/shared`); `EXCLUDED_DIRS` matches the **first path
segment**, and contains `job-sourcing`. r5 §7 places every new API file under `apps/api/src/job-sourcing/**`
(`providers/`, `collection/`, `funnel/`, `identity/`, `queue/`, `structuring/`, `worker/`). The web
`components/job-queue/**` directory is never scanned by this script at all.

**Why it matters.** The one mechanical guard the repo has against Russian literals in API text is blind to the entire
feature, while the plan believes the opposite. The legacy exception literals r5 keeps (C-13) are the precedent that
proves the exclusion exists for a reason — a reason that does not extend to new code.

**r6 correction.** Either place new API code in a sibling module (`apps/api/src/job-queue/**` — also a cleaner seam
for AUDIT-01's worker module) or narrow `EXCLUDED_DIRS` to the specific legacy files. Fix the D-07 sentence: web is
covered by Lingui lint, not by this script.

### AUDIT-08 — MED — Forward DDL files raise the rollback floor; r5's rollback promise ignores it

**Claim (r5 Rollback):** "redeploy a compatible old API/UI if needed"; C-15: each new file "costs four edits".

**Evidence.** `deploy.yml` step "Verify rollback target commit has all hard-required files" fails the deploy for any
target commit that lacks a file in the hard-required list (its error text: "the deploy pipeline treats this file as
unconditionally present"); `docs/runbooks/deployment.md` §9 documents the resulting rollback-depth floor. The
2026-10-05 files are already in that list. r5 Task 1.3 adds every new forward file to it.

**Why it matters.** After the first new forward file merges, the pipeline cannot deploy any commit older than that file
— the "compatible old API" rollback exists only as a manual VPS operation. The plan's rollback table reads as if the
pipeline could do it.

**r6 correction.** State the floor as a rollback property ("rollback target ≥ the newest forward file; older = manual
runbook procedure"), and let the migration-ledger ADR decide whether ledger-tracked files can be **absent** at a
rollback target (applied-and-recorded ⇒ skip) — which would decouple the floor from the file list and is the strongest
argument for the ledger r5 did not make.

### AUDIT-09 — MED — The v1 alerts have no delivery channel in this codebase

**Claim (r5 Task 8.1):** "v1 alerts: sustained failed/PARTIAL runs, parse-validity collapse, freshness beyond policy,
missing heartbeat, unreconciled costly requests, isolation errors, growing backlog, exhausted budgets, access-health
events".

**Evidence.** Runtime notification surfaces: `NotificationsModule` (in-app subjects + e-mail via
`notification-email.cron.ts`). Alerting that exists is CI-side only: `ci.yml` `post_merge_alert` →
`scripts/devops/resolve-alert-channel.sh` + `post-merge-alert.sh` (GitHub issue). No metrics exporter, no pager, no
webhook sink. r5 names thresholds and "alert delivery confirmed" (8.3) but never the mechanism.

**r6 correction.** Choose and name it: an ADMIN-targeted notification subject kind (reuses the existing in-app + e-mail
path, uk/en catalogues, no new infra) with de-duplication by (source, class, day); or a GitHub issue through the
telemetry-alert scripts for infra-class events (isolation errors, heartbeat loss). Add an MP row for alert volume
(alerts/day during the shadow period) so "no noisy notification on every unchanged run" is measured, not asserted.

### AUDIT-10 — LOW — D-02 overstates "no code reads these columns"; Task 2.5 cites a mechanic that does not exist

**Evidence.** `job-sourcing.service.ts:listSources` (the `GET sources` mapper) reads `row.minIntervalHours` and
`row.disabledReason` into `jobSourceSchema`, which `SourceBudgetPanel.tsx` renders. What is true: nothing **enforces**
`min_interval_hours` — `collectAll` filters only `enabled` + `sourceAcceptsTrigger`, so every enabled source runs on
every 05:00 tick. r5 Task 2.5 says "the legacy 10-minute early-due slack cannot override quota/cooldown"; there is no
such slack in the repository (no interval arithmetic in `collectAll`/`collectSource`).

**r6 correction.** Reword D-02 ("read into the ADMIN DTO, never enforced"); delete the slack sentence; treat cadence
enforcement as **new behaviour** with its own characterization: today's golden fact is "enabled ⇒ daily".

### AUDIT-11 — LOW — "Team-lead triage grants" names an actor the schema does not have

**Evidence.** A1b: "team-lead triage grants". `schema.ts:teamMembers` has `joinedAt`/`leftAt` only; `teams` has
`type` and `seniorSharePercentOverride`; no lead/owner column, no per-membership role. Task 6.1 then correctly says
grants are ADMIN-assigned.

**r6 correction.** Drop "team-lead" from A1b or define it as "ADMIN, acting for a team".

### AUDIT-12 — LOW — `LEAD` means two things inside one domain

**Evidence.** Landed `job_seniority` enum (`schema.ts`, `2026-10-05_vacancy_sourcing_schema.sql`) contains `LEAD`; r5
Task 1.2 `job_opportunity_matches.outcome` is `LEAD | TRIAGE | EXCLUDED`, and the design text uses "lead" for a
compatible item throughout.

**r6 correction.** The seniority value is shipped; rename the match outcome (`ELIGIBLE`/`CANDIDATE`) and the prose
("eligible item"), and add the term to `CONTEXT.md` with the implementing PR.

### AUDIT-13 — LOW — The DOU bridge seam is private, and the legacy path stays unguarded by design

**Evidence.** `job-sourcing.service.ts:collectSource` is public, but `persistPostings` and `createSuggestions` —
which Task 4.6 says the bridge must "feed the complete array" — are `private`, and `collectSource` performs
charge → fetch → persist → suggest inline. The characterization test therefore lives at `collectAll` → database state
(integration, outside the mutation gate per `mutation-gate-integration-specs.md`), not at a pure seam. Separately,
`collectAll` has no ownership: the 05:00 cron and the ADMIN `POST /job-sourcing/collect` (10/min) can overlap and
charge DOU twice; A1a keeps that path "independent", so the overlap survives v1.

**r6 correction.** Task 4.6's first leaf is an extraction (`LegacyDouConsumer` with the two methods made injectable),
with the golden-fixture test written **before** the extraction and run on a scratch DB. Record the DOU overlap as an
accepted legacy property in the rollout notes (or route the legacy collector through the new ownership as a later
leaf).

### AUDIT-14 — LOW — Per-row budget columns on non-DOU seeded rows become dead or misleading

**Evidence.** Seed rows carry `budget_limit`/`budget_window` (Jooble 6/MONTH, JSearch 3 × 60/MONTH, TheirStack 8/MONTH);
`chargeBudget` (CAS on `budget_used` + `budget_window_started_at`) is "for DOU only" after A1h; the account meter (Task
3.5) owns spend. `SourceBudgetPanel.tsx` and `jobSourceSchema` still show the per-row numbers.

**r6 correction.** Decide the fate of `budget_limit/budget_used` for account-metered sources (NULL them in the forward
seed delta and have the extended DTO (6.5) expose meter figures), so ADMIN sees one truth.

### AUDIT-15 — LOW — A silent default `teamId` is a scope the HR did not choose

**Evidence.** Task 6.1: "default first active team in stable order". "Stable order" is undefined (`teams.name`?
`joinedAt`?), and a silent default means the first list request of an HR in two teams returns one team's queue with no
visible selection.

**r6 correction.** Define the order (`joinedAt, teamId`), persist the last chosen scope per user, and make the UI show
the active scope whenever the actor has more than one.

### AUDIT-16 — MED — Model calls are billed after the fact; only the vendor key limit is a hard cap

**Claim (r5 Task 5.4):** "OpenRouter USD limit is the hard cap with per-request cost reconciled"; "Shared budget: 20
calls per collection cycle … daily usage reservations frozen by policy".

**Evidence.** The plan's own metering rule for paid providers (Task 3.5: reserve worst case atomically **before** the
request, uncertain debit on timeout) is not applied to model calls; the 20-call cycle budget counts calls, not money;
the per-request cost is known only from the response `usage`. A timeout or a provider that bills a partially streamed
response leaves spend unrecorded until the next reconciliation.

**r6 correction.** Treat the model endpoint as one more metered account: reserve `max_output_tokens × max price +
input_tokens × price` (from the pinned model's price, refreshed by MP-03) before each call against a daily USD meter
row, convert to used from `usage`, uncertain-debit on timeout, and pause at the daily cap. Keep the vendor key limit
as the backstop, not the mechanism.

---

## PLAUSIBLE findings (need an external check at resumption)

### AUDIT-P1 — MED — IP-reputation blast radius of sourcing from the main VPS

**Reasoning.** The CX33's single public IP already carries outbound calls the CRM depends on:
`finance/nbu-currency.service.ts` (`bank.gov.ua`), `resumes/resume-ai.service.ts` (`api.cloudflare.com`), R2 uploads,
Resend e-mail, Google Indexing, the meeting-recorder integration. r4/r5 justify a separate egress only by capacity and
"ban avoidance"; neither lists what else shares the address. A reputation listing (or a Cloudflare-fronted board
flagging the IP) hurts those integrations, not just sourcing.

**Check / r6.** Price a second IP (Hetzner floating/secondary IP with its own rDNS) bound only to the collector's
egress proxy — much cheaper than a second VPS and it gives the "stable egress IP with reverse DNS" r4 wants without
sharing it. Add the integration list to MP-11 as the blast-radius column.

### AUDIT-P2 — MED — A local model on the main VPS is a candidate only on paper

**Reasoning.** `docs/runbooks/deployment.md` §1.1: CX33, 4 vCPU, 8 GB RAM, shared with PostgreSQL, Redis, the API and
nginx. A model good enough for grounded structured extraction (≥ 7B parameters, 4-bit) needs ≈ 5 GB resident and
CPU-bound inference measured in minutes per page; MP-04 is near-certain to fail on this host.

**Check / r6.** Keep "local model on **another** host" as a candidate; demote "local on the main VPS" to "not a
candidate unless the VPS is upgraded" so MP-04 is not spent on a foregone conclusion. (Owner money decision, A2.)

### AUDIT-P3 — MED — pg-boss self-manages its schema

**Reasoning.** pg-boss creates its own schema and runs its migrations at `start()`, which requires `CREATE` on the
database — conflicting with AUDIT-04's "no DDL" worker role and with the manual-SQL/ledger policy (C-15). r5 lists
only "version/engines" as the open point.

**Check / r6.** Verify in the pinned release whether schema management can be disabled and the DDL exported as a
forward file; if not, the "design it twice" comparison in Task 2.5 should score pg-boss on this constraint first.

### AUDIT-P4 — MED — Personal data inside postings (Legal zone)

**Reasoning.** Job descriptions routinely contain recruiter names, e-mails and phone numbers (third-party personal
data under Law 2297-VI and, for EU boards, GDPR). r4 §6.2 / r5 5.2 strip contacts **before text leaves the host** (the
model boundary) but the full text is persisted in revisions and content-addressed `job_text_blobs`; Task 1.4 mentions
"legal deletion" as a test without a mechanism; content-addressed blobs are shared across revisions/records, so
erasure needs reference counting.

**Check / r6.** A Legal-agent item: lawful basis and retention for third-party contact data in stored postings; a
minimization option (strip or hash contact spans at ingest, keep them only in the bounded original sample under the
retention policy); blob reference counting and an erasure procedure in Task 1.4.

### AUDIT-P5 — LOW — Web Bot Auth needs a hosted key directory

**Reasoning.** The draft protocol expects the signing agent to publish its keys at a well-known path on the bot's
domain (`/.well-known/http-message-signatures-directory`). r5 lists only the `/bot` page on `apps/landing` (A2); the
key directory is a second nginx/landing artifact in the Coder/DevOps zones.

### AUDIT-P6 — LOW — Backups grow with the new store

**Reasoning.** `docs/runbooks/deployment.md` §8: nightly `pg_dump` to the `crm-backups` R2 bucket with retention.
Revisions, text blobs and generations are the first tables designed to grow daily. MP-07 measures table size; it
should also record dump size/duration and R2 cost per wave.

### AUDIT-P7 — LOW — OpenRouter key-limit semantics are a vendor claim

**Reasoning.** Whether a key `limit` is enforced pre-request (hard) or post-request (soft, can overshoot by one
request), and how `limit_reset` behaves, decides whether AUDIT-16's reservation is belt-and-braces or load-bearing.
Already in r5's open list; flagged here because it changes a money control.

---

## r5 claims re-verified as correct (so r6 does not re-litigate them)

C-01 landed columns/enum/DDL and `job-queue-schema.spec.ts`; C-02 `boundedFetchText` has no production caller; C-03
no helper bases exist, `DouRssProvider` is the sole provider; C-04/C-08/C-09 (`getActiveTeamPeers` shape;
`findActiveTeamsForUser` lives in finance); C-10 controller surface and guard chain (`@Roles` on every route,
`@Throttle` 10/min on `collect`); C-12 `JOB_SOURCING_ENTRY_ENABLED = false`; C-15 bare `psql -v ON_ERROR_STOP=1`
re-apply per deploy and the wiring guard's copy+apply rule; C-16 seed = 16 disabled rows keyed by `(type, config)`,
header says "append rows here"; C-19 `DESCRIPTION_MD_MAX = 50000`; C-21 `CLOUDFLARE_*` belong to résumé AI,
`JOB_MATCH_THRESHOLD` exists; C-22 allow-list rejects `.local/.internal/.localhost` and never resolves DNS; C-23 the
"never rethrow" convention; C-27 the language rule file now holds the English policy; C-29 compose networks; D-03 the
`CONTEXT.md` reservation of **Vacancy** and **Job source** ("Opportunity" is free).

## Not verified (open)

Everything r5 already lists as open (vendor documents, Firecrawl service list, Web Bot Auth status, Content-Signal,
pg-boss, OpenRouter parameters, the "techword" fixture, the ~55 count, r4's evidence bundle). Added by this audit:
the live `max_connections` and pool sizing for a second DB-connected process (both `DatabaseService` pools default to
`pg`'s 10); Hetzner secondary-IP/rDNS availability and price for AUDIT-P1; the exact pg-boss schema behaviour for
AUDIT-P3; the Legal position for AUDIT-P4. No live database was read for this audit.

## Decision-readiness delta for the owner brief (additions to r5 §4)

| Item                                   | Level | Note                                                                                             |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| Process-role topology (AUDIT-01/02)    | A1    | Architect records the three-role table; no owner input needed, but it must exist before Task 2.5 |
| Dedicated egress IP (AUDIT-P1)         | A2    | Small recurring cost; replaces part of the "separate VPS" question with a cheaper middle option  |
| Local model on main VPS (AUDIT-P2)     | A2    | Recommend removing it as a candidate to save MP-04 effort                                        |
| Third-party personal data (AUDIT-P4)   | A3    | Legal basis/retention is irreversible once data is collected; Legal agent before activation      |
| Cron zoning scope (AUDIT-03)           | A1    | One small ADR; decide "all crons zoned" vs "none"                                                |
| Worker DB role deploy shape (AUDIT-04) | A1    | DevOps task; depends on the ledger ADR only for the guard extension                              |

**Findings: AUDIT-01, AUDIT-02, AUDIT-03, AUDIT-04, AUDIT-05, AUDIT-06, AUDIT-07, AUDIT-08, AUDIT-09, AUDIT-10,
AUDIT-11, AUDIT-12, AUDIT-13, AUDIT-14, AUDIT-15, AUDIT-16, AUDIT-P1, AUDIT-P2, AUDIT-P3, AUDIT-P4, AUDIT-P5,
AUDIT-P6, AUDIT-P7 (23)**
