# BLOCKER: task-e2e-vacancies — shard coverage guard

## Агент: autotest

## Задача: .claude/tasks/task-e2e-vacancies.md

## Проблема

`scripts/devops/check-e2e-shard-coverage.py` (FM-5 guard, CI `ci.yml` job
`E2E shard coverage guard`) now fails on the new `apps/e2e/tests/vacancies.spec.ts`:

```
FAIL: The following spec files are NOT in any CI shard and NOT in KNOWN_UNSHARDED:
  tests/vacancies.spec.ts
```

`.github/workflows/ci.yml` and `scripts/devops/check-e2e-shard-coverage.py` are
outside AutoTest's zone-of-write (`.claude/rules/common/zone-of-write.md` —
AutoTest may only write `apps/e2e/tests/*.spec.ts` + fixtures + config), so I
cannot apply this myself.

## Why this spec CAN go straight into a real shard (no new infra needed)

Unlike most `KNOWN_UNSHARDED` "debt" entries (which need an externally
started stack `ci.yml` doesn't provision — see the `landing` project entry),
`vacancies.spec.ts` is a REAL-backend spec (no `page.route()` mocks — see
file header) that talks to `http://localhost:3001` / navigates
`http://localhost:3000` by default. **Every existing `ci.yml` `e2e` shard
already provisions exactly that**: `db:push` + `db:seed` + real Postgres +
real MinIO (bucket `crm-documents`, already bootstrapped by the "Start MinIO

- bucket" step) + a built API on :3001 + a built Web (`vite preview`) on
  :3000. `TURNSTILE_SECRET_KEY` needs no new secret either — `env.ts` defaults
  it to Cloudflare's "always passes" dev dummy secret whenever the env var is
  unset, and no `ci.yml` shard sets it — so the default already applies.

Verified locally (own scratch Postgres DB + own API/web ports, since
:3000-3002 in this session belong to a live dev/UT stack I must not touch):
3 consecutive green runs of the file, plus a live-DOM walkthrough of every
step (creation Sheet incl. the CodeMirror description field, publish, public
apply POST with a hand-rolled valid PDF, HR status transitions + delete, close/
re-open/close, the disabled-delete tooltip, RBAC nav + redirect + 403). See PR
body for the full log.

## Proposed fix (exact diff)

Add the new file to the **`misc`** shard (already a mixed bag of one-off CRM
screens — interviews / profile / documents / admin-actions / onboarding —
this fits the same profile: whole-page CRUD + RBAC flows, not a money-path
spec that needs the `drop-finance` shard's relaxed-throttle isolation, though
`vacancies.spec.ts` also benefits from `THROTTLE_RELAXED=true` +
`THROTTLER_LIMIT=2000`, which the `misc` shard's job-level env already sets
for every shard):

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ matrix.shard
           - name: misc
-            files: tests/interviews.spec.ts tests/profile-self-edit.spec.ts tests/requisites-warning.spec.ts tests/admin-actions.spec.ts tests/onboarding-logout.spec.ts tests/documents-pdf-preview.spec.ts tests/persist-query.spec.ts tests/crm
+            files: tests/interviews.spec.ts tests/profile-self-edit.spec.ts tests/requisites-warning.spec.ts tests/admin-actions.spec.ts tests/onboarding-logout.spec.ts tests/documents-pdf-preview.spec.ts tests/persist-query.spec.ts tests/vacancies.spec.ts tests/crm
```

And remove the (currently absent, guard would ghost-warn otherwise — N/A,
never added) `KNOWN_UNSHARDED` entry — i.e. no change needed there since the
file was never added to that list in the first place.

## Fallback (if the orchestrator prefers debt-listing instead)

If adding to `misc` is undesirable for some reason (e.g. shard timeout
budget), the alternative is a `KNOWN_UNSHARDED` entry in
`scripts/devops/check-e2e-shard-coverage.py`:

```diff
--- a/scripts/devops/check-e2e-shard-coverage.py
+++ b/scripts/devops/check-e2e-shard-coverage.py
@@ KNOWN_UNSHARDED
+    "tests/vacancies.spec.ts",              # debt: real-backend full-flow spec (task-e2e-vacancies),
+                                             # not yet wired into a shard — verified locally 3x green
+                                             # against a scratch stack; run manually:
+                                             # `pnpm --filter @crm/e2e exec playwright test vacancies.spec.ts`
```

This is NOT my preference — the spec runs cleanly against `ci.yml`'s existing
`e2e` job infra with zero extra wiring (see rationale above), so gating it in
`misc` is the lower-debt option.

## Вопрос к PM / оркестратору

Применить diff в `misc` shard (предпочтительно) ИЛИ debt-запись — на
усмотрение оркестратора (не моя зона записи).
