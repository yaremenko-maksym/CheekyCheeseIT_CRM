# CRM Telemetry — Design Spec (prod errors + UX analytics)

**Date:** 2026-07-24 · **Status:** APPROVED (owner decisions in chat)
**Goal:** (1) prod errors automatically reach the assistant → fixes without the owner's
involvement; (2) statistics of CRM usage by employees → UX improvements without feedback.

## Owner decisions

| Question             | Decision                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| Architecture         | Our own lightweight system in our Postgres (no SaaS/self-hosted trackers)     |
| Channel to assistant | Auto GitHub issues via a scheduled workflow + a protected digest endpoint     |
| UX depth             | Events+routes+timings+abandoned forms; NO session replay, NO field values     |
| Privacy              | Errors — with userId/role (for repro); UX events — only role + a session hash |

## 1. DB (2 tables, migration + prod DDL via deploy.yml)

**`telemetry_errors`** — grouped by fingerprint:
id · fingerprint (sha256 of normalized message+top-frames+source) UNIQUE · source
(`WEB|API`) · message (truncated 500) · stack (truncated 4000, sanitized) · route/
endpoint · user_id nullable FK · user_role nullable · meta jsonb (ua, viewport, appVersion
— WITHOUT request bodies) · count int · first_seen · last_seen · status (`NEW|NOTIFIED|RESOLVED`)
· github_issue_number nullable.
Error recurrence → count++, last_seen; RESOLVED+recurrence → NEW again (regression, a new issue comment).

**`telemetry_events`** — raw UX events (lightweight rows):
id · session_hash (sha256(userId+daily salt) — patterns visible, identity not) · user_role ·
event (`route_enter|route_leave|feature_click|form_abandon|form_submit`) · route ·
target nullable (data-track feature identifier) · duration_ms nullable (for route_leave —
time on the screen) · created_at. Indexes on (event, created_at), (route, created_at).

## 2. API (`apps/api/src/telemetry/`)

- `POST /api/telemetry/errors` — JwtGuard (employees are logged in), Zod schema, strict
  rate-limit (10/min/user), fingerprint upsert. NOT publicly accessible (the landing is out of scope for v1).
- `POST /api/telemetry/events` — JwtGuard, batch (up to 50 events), rate-limit, fire-and-forget
  (tracking errors never break UX — swallow+log).
- Server errors: a global Nest exception interceptor (5xx + unhandled) → the same
  upsert directly (no HTTP), source=API; exclude the cascade (a telemetry error does not break the
  request and does not track itself — a recursion guard).
- `GET /api/telemetry/digest?since=<iso>` — NO JwtGuard, instead the header
  `X-Telemetry-Token` = env `TELEMETRY_DIGEST_TOKEN` (32+ bytes, constant-time comparison);
  returns: new/regressed errors (full context) + weekly UX aggregates (behind the flag
  `&ux=1`): top routes by time/visits per role, feature clicks, form_abandon rates,
  median timings. Marks the returned errors NOTIFIED (idempotently via since).
- **Retention cron (owner requirement: data is wiped regularly, the DB does not bloat)**,
  daily, fail-loud logging of the count: `telemetry_events` older than **90 days** — delete
  (long-term aggregates live in weekly issues, the raw data is not needed); `telemetry_errors` with
  `last_seen` older than **180 days** — delete REGARDLESS of status (not seen for half a year —
  irrelevant); an additional protective cap: if `telemetry_events` exceeds 1M rows —
  delete the oldest beyond the cap immediately (insurance against a spike). Size metrics — in
  the weekly UX digest (I monitor the trend).

## 3. Web SDK layer (`apps/web/app/lib/telemetry/`)

- Errors: ErrorBoundary (already exists? — integrate) + `window.onerror` +
  `unhandledrejection` → dedupe in memory (1 send/fingerprint/session) → POST.
- Events: subscription to the router (route_enter/leave + duration), a delegated click handler
  on `[data-track]` (set data-track on key features: create vacancy/user/
  transaction, publish, settle, filters, downloads — list in the task file), form_abandon
  (opened a Sheet/Dialog with a form + entered something + closed without submit — WITHOUT content).
- Batching: a buffer of 10 events or 15s → `navigator.sendBeacon` (sends even on tab close);
  a kill switch `VITE_TELEMETRY=off` for dev/E2E (we don't make noise in tests).

## 4. Autonomous-fix channel (`.github/workflows/telemetry-digest.yml`)

- Hourly cron + workflow_dispatch: curl the digest endpoint with the token from GH secrets →
  for each new/regressed error — `gh issue create` (title = the fingerprint heading,
  label `prod-error` + `severity:auto`, body: message/stack/route/role/count/first-last seen,
  a checklist for the fix); dedup: is issue_number written back?? — there is no back channel → dedup
  on the API side (NOTIFIED) + searching open issues by fingerprint in the title.
- Weekly (Monday): a UX digest issue with the label `ux-insights` — aggregates + space for
  my conclusions. The assistant triages the issues in sessions under a standing mandate.

## 5. Security (security-reviewer MANDATORY)

Sanitize stack/message from secrets (there are no secrets in the client already, but a pattern filter for
Bearer/cookie just in case); constant-time digest token; rate-limits; no form values/
financial amounts get into events; telemetry is fail-silent (does not break prod);
telemetry does NOT track the landing (only the CRM, logged-in employees).

## 6. Plan (task order)

1. **T1 coder** `feature/telemetry-api`: shared schemas + tables + ingest/digest + interceptor
   - retention + unit/integration (RBAC digest-token 401/403, recursion guard, rate-limit).
2. **T2 coder** `feature/telemetry-web` (after T1 in main): SDK layer + data-track markup +
   tests; **T3 devops** `infra/telemetry-digest` (in parallel with T2): workflow + secrets
   (TELEMETRY_DIGEST_TOKEN in GH+prod env, fail-loud) + DDL step + runbook.
3. Review: code (all) + security (T1, T3); merge by mandate; prod smoke: an artificial
   error (?debug-throw as ADMIN) → the issue appeared.

Out of scope v1: session replay, landing telemetry, Telegram alerts, a dashboard in the CRM
(the channel — issues; we'll add a dashboard as a separate cycle if desired).
