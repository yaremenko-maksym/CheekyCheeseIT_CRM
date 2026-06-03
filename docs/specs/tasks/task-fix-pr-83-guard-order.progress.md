# Coder progress — task-fix-pr-83-guard-order

## State

- current_milestone: 6/6
- last_commit: fix(onboarding) (pending final)
- last_push: pending final push (all changes local, ready)
- files_done:
  - apps/api/src/auth/public.decorator.ts (new — `@Public()` + `IS_PUBLIC_KEY`)
  - apps/api/src/auth/jwt.guard.ts (Reflector + Public bypass)
  - apps/api/src/auth/jwt.guard.spec.ts (constructor now takes Reflector + new @Public test)
  - apps/api/src/auth/onboarding.guard.integration.spec.ts (new — 8 cases, real Fastify lifecycle)
  - apps/api/src/auth/onboarding.guard.ts (nit §4: simplified split fallback)
  - apps/api/src/app.module.ts (APP_GUARD: JwtAuthGuard BEFORE OnboardingGuard)
  - apps/api/src/auth/auth.controller.ts (@Public on OAuth + logout + dev-login; removed redundant `@UseGuards`)
  - apps/api/src/health/health.controller.ts (@Public on /health)
  - apps/api/src/invoices/invoices-verify.controller.ts (@Public on /invoices/verify/:id)
  - apps/api/src/notifications/notifications.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/interviews/interviews.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/onboarding/onboarding.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/invoices/invoices.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/documents/documents.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/finance/payment-channel.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/finance/pending-settlement.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/finance/balance.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/finance/transactions.controller.ts (removed `@UseGuards(JwtAuthGuard)` ×4)
  - apps/api/src/contracts/signed-contracts.controller.ts (removed `@UseGuards(JwtAuthGuard)`)
  - apps/api/src/contracts/contract-templates.controller.ts (kept RolesGuard only)
  - apps/api/src/tos/tos.controller.ts (kept RolesGuard only)
  - apps/api/src/teams/teams.controller.ts (kept RolesGuard only)
  - apps/api/src/projects/projects.controller.ts (kept RolesGuard only)
  - apps/api/src/users/users.controller.ts (kept RolesGuard only)
  - apps/api/src/contracts/signed-contracts.service.ts (nit §4: throw vs CHK-1 fallback; removed `void and`)
  - apps/api/src/tos/tos.service.ts (nit §4: removed `void desc` and `void tosAcceptances`)

## RED → GREEN proof (per task §3 — mandatory)

### RED (on commit 67af7bf, pre-fix)

After extracting only `apps/api/src/auth/onboarding.guard.integration.spec.ts` + `apps/api/src/auth/public.decorator.ts` (the rest still pre-fix), `pnpm --filter @crm/api test -- onboarding.guard.integration`:

```
× case 6: public GET /api/health (no cookie) → 200 — @Public() bypasses JwtAuthGuard
  → expected 401 to be 200
 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
```

Case 6 fails because `JwtAuthGuard` on pre-fix code does not check `IS_PUBLIC_KEY` via Reflector → returns 401 for `/api/health` even though it carries `@Public()`. The lifecycle-fix cases 1-5 pass because the test module wires the FIX state via APP_GUARD factory providers (so the test pins the post-fix wiring, not the buggy app.module). An additional `describe` block ("OnboardingGuard ALONE as APP_GUARD") documents the original bug surface.

### GREEN (post-fix)

`pnpm --filter @crm/api test -- onboarding.guard.integration`:

```
 ✓ src/auth/onboarding.guard.integration.spec.ts (8 tests) 61ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### Full suite (post-fix)

```
 Test Files  34 passed (34)
      Tests  497 passed (497)
```

(488 base + 8 new integration cases + 1 new @Public unit test)

## AC verification

- AC1 ✓ — `apps/api/src/auth/public.decorator.ts` exports `Public` + `IS_PUBLIC_KEY`
- AC2 ✓ — `JwtAuthGuard.canActivate` checks `IS_PUBLIC_KEY` via `Reflector.getAllAndOverride` at the top of the method
- AC3 ✓ — `apps/api/src/app.module.ts` `providers[]`: `JwtAuthGuard` registered BEFORE `OnboardingGuard` via APP_GUARD (verified via ast-grep)
- AC4 ✓ — `@Public()` applied to `/api/auth/google`, `/api/auth/google/callback`, `/api/auth/google/one-tap`, `/api/auth/logout`, `/api/auth/dev-login`, `/api/health`, `/api/invoices/verify/:transactionId`
- AC5 ✓ — `onboarding.guard.integration.spec.ts` — 8 cases (7 fix-state + 1 bug-reproduction), all green
- AC6 ✓ — Existing unit test `onboarding.guard.spec.ts` left intact (complementary coverage); existing `jwt.guard.spec.ts` updated for new Reflector signature + new @Public test
- AC7 ✓ — 497 / 497 unit tests green (488 baseline + 9 new)
- AC8 ✓ — Minor §4 nits fixed: simplified `split` in guard.ts:56, throw in signed-contracts.service.ts:180 for sequence failure, removed `void and / void desc / void tosAcceptances`
- AC9 — verified by PM on CI (`gh pr view 83 --json statusCheckRollup`)
- AC10 — verified by PM at User Testing

## Live HTTP smoke (PM User Testing snippet)

```bash
# Login as seed senior1 without signed MSA / accepted ToS:
SENIOR_JWT=$(curl -sX POST -H 'Content-Type: application/json' \
  -d '{"email":"senior1@cc.com"}' \
  http://localhost:3001/api/auth/dev-login | jq -r '.ok // empty')

# Then call a protected endpoint with that cookie:
curl -i -b "jwt=<SENIOR_JWT>" http://localhost:3001/api/teams
# Expect: HTTP/1.1 403  {"error":"ONBOARDING_REQUIRED","missing":["contract","tos"]}

# Health endpoint (public):
curl -i http://localhost:3001/api/health
# Expect: HTTP/1.1 200  {"status":"ok",...}
```

## Skills invoked

- `superpowers:using-superpowers` (start)
- `superpowers:test-driven-development` (RED → GREEN — integration test FIRST, see RED proof above)
- `superpowers:receiving-code-review` (analyzed Reviewer review #4415687659 technically, verified with context7 NestJS docs before implementing)
- `superpowers:verification-before-completion` (final RED→GREEN proof + full suite)
- Manual security review (auth-touching change — see file docstrings for threat model notes)
