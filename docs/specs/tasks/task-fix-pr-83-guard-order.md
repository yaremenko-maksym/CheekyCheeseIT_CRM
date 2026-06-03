# task-fix-pr-83-guard-order

## Агент: coder

## Приоритет: critical

## Зависит от: task-onboarding-6a-data-backend (PR #83 — Reviewer выдал Verdict: BLOCK)

## Ветка: feature/onboarding-data-backend (target_branch — фикс в существующую ветку, НЕ создавать новую)

## Контекст — критичный баг

Reviewer review #4415687659: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/83#pullrequestreview-4415687659

**Bug**: `OnboardingGuard` зарегистрирован как `APP_GUARD` (global), `JwtAuthGuard` — только controller-level через `@UseGuards`. Per NestJS Request lifecycle: **global guards выполняются ДО controller guards**. Значит `OnboardingGuard.canActivate` запускается когда `request.user` ещё `undefined`, его pre-check `if (!user) return true` срабатывает **всегда** в production → guard полностью no-op.

**Следствие**: backend защита для всей онбординг-фичи отсутствует. Пользователи без signed MSA / accepted ToS получают доступ ко всему — никакого 403 `ONBOARDING_REQUIRED`. Phase 6B (frontend gate) тоже окажется в иллюзии что backend защищает.

**Почему unit-тесты не поймали**: `onboarding.guard.spec.ts` мокает `ExecutionContext` с уже заполненным `request.user`, обходя реальный lifecycle. AC10 был deferred (live curl) — именно этот тест и поймал бы.

## Конкретные изменения

### 1. Зарегистрировать JwtAuthGuard как APP_GUARD ПЕРЕД OnboardingGuard

`apps/api/src/app.module.ts`:

- Удалить controller-level `@UseGuards(JwtAuthGuard)` со всех контроллеров (или подходить инкрементально — главное: добавить global registration)
- В `providers: [...]` зарегистрировать **в порядке**:

  ```ts
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // первым — populates req.user
    { provide: APP_GUARD, useClass: OnboardingGuard }, // вторым — читает req.user
    // ... остальные providers
  ]
  ```

  Per NestJS docs: при множественной регистрации `APP_GUARD` через `providers[]`, Nest вызывает их в порядке регистрации.

### 2. Public endpoints через @Public() декоратор

Public endpoints не должны проходить JwtAuthGuard (нет JWT cookie перед login).

Создать (или использовать существующий, если есть):

`apps/api/src/auth/public.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common'
export const IS_PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)
```

Обновить `JwtAuthGuard` чтобы реагировать на `isPublic` через `Reflector`:

```ts
import { Reflector } from '@nestjs/core'
import { IS_PUBLIC_KEY } from './public.decorator'

constructor(private readonly reflector: Reflector, ...) {}

async canActivate(context) {
  const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
    context.getHandler(),
    context.getClass(),
  ])
  if (isPublic) return true
  // ... existing JWT verification
}
```

Применить `@Public()` на endpoints (минимум):

- `GET /api/auth/google` (начало OAuth flow — нет JWT ещё)
- `GET /api/auth/google/callback` (return из Google — JWT устанавливается ВНУТРИ handler)
- `GET /api/health` (health check)
- `POST /api/auth/dev-login` (если есть — dev only, без JWT)

**НЕ публичные** (требуют JWT, но bypass OnboardingGuard в нём же):

- `GET /api/auth/me`
- `GET /api/auth/logout`
- `GET /api/onboarding/status`
- `GET /api/tos/current`
- `GET /api/contracts/templates/current/:role`
- `POST /api/contracts/sign`
- `POST /api/tos/accept`

(Bypass для OnboardingGuard уже реализован в его `bypassPaths` — этот контракт сохраняется.)

### 3. Integration test (mandatory)

Создать `apps/api/src/auth/onboarding.guard.integration.spec.ts`:

- Использовать `@nestjs/testing` `Test.createTestingModule(...).compile()` → `app.createNestApplication()` → `await app.init()`.
- Supertest (`import * as request from 'supertest'`) против реального HTTP layer.
- Setup:
  - Fake JWT для seed senior1 (без signed MSA / accepted ToS) → cookie на supertest
  - Fake JWT для admin (ADMIN bypass) → cookie на supertest
- Cases:
  1. `senior1` без MSA/ToS → `GET /api/teams` → expect 403 + body `{error:'ONBOARDING_REQUIRED', missing:['contract', 'tos']}`
  2. `senior1` без MSA/ToS → `GET /api/onboarding/status` → expect 200 + `{requiresContract: true, requiresTos: true, ...}`
  3. `senior1` без MSA/ToS → `POST /api/contracts/sign` → expect 200 (bypass)
  4. `admin` → `GET /api/teams` → expect 200 (ADMIN bypass)
  5. `senior1` после full onboarding (создать signed_contract + tos_acceptance в setup) → `GET /api/teams` → expect 200
  6. Public endpoint `GET /api/health` без cookie → expect 200

Этот тест **обязан падать** на текущей implementation (до fix) и проходить после fix — это proof что fix работает.

### 4. Minor nit fixes (объединены в этот же batch)

- `apps/api/src/auth/onboarding.guard.ts:54` — упростить:

  ```ts
  const path = rawUrl.split('?')[0] || rawUrl
  ```

  (`??` not needed since `.split('?')[0]` всегда string)

- `apps/api/src/contracts/signed-contracts.service.ts:170-180` — заменить fallback `CHK-1-...` на throw:

  ```ts
  if (!seq) {
    throw new InternalServerErrorException('Failed to allocate contract_number from sequence')
  }
  ```

  (silent fallback может создать UNIQUE constraint violation)

- `apps/api/src/contracts/signed-contracts.service.ts:221-222` + `apps/api/src/tos/tos.service.ts:107-110` — удалить `void and`, `void desc`, `void tosAcceptances` (лишние, эти имена реально используются в relational query API).

### 5. Update progress (Coder zone)

`docs/specs/tasks/task-fix-pr-83-guard-order.progress.md` — sentinel с milestone tracking. Не обязательно если задача < 6 файлов, но в этом случае рекомендую (есть integration test setup, может быть нюанс).

## Acceptance criteria

- [ ] AC1: `apps/api/src/auth/public.decorator.ts` существует, экспортирует `Public` и `IS_PUBLIC_KEY`
- [ ] AC2: `JwtAuthGuard` использует `Reflector` для проверки `IS_PUBLIC_KEY` → bypass на public endpoints
- [ ] AC3: `apps/api/src/app.module.ts` имеет **в порядке**: `{provide: APP_GUARD, useClass: JwtAuthGuard}` ДО `{provide: APP_GUARD, useClass: OnboardingGuard}` в `providers[]` (через `mcp__ast-grep__find_code` подтвердить порядок)
- [ ] AC4: `@Public()` применён на `/api/auth/google`, `/api/auth/google/callback`, `/api/health` (минимум)
- [ ] AC5: `apps/api/src/auth/onboarding.guard.integration.spec.ts` — все 6 cases passed (`pnpm --filter @crm/api test -- onboarding.guard.integration`)
- [ ] AC6: Existing unit-test `onboarding.guard.spec.ts` обновлён ИЛИ оставлен с пометкой `// NOTE: integration test покрывает real lifecycle, см. onboarding.guard.integration.spec.ts` — должен показывать complementary coverage
- [ ] AC7: Все existing unit tests still passed (`pnpm --filter @crm/api test` — 488 → 488+N green)
- [ ] AC8: Minor nits 4.\* fixed (3 файла) — `grep -n` подтверждает удалённое `void and/desc/tosAcceptances`, упрощённый split в guard, throw вместо CHK-1 fallback
- [ ] AC9: CI зелёный после push: typecheck + lint + unit tests + 5 E2E shards + check-no-hook-bypass (GH workflow names в `gh pr view 83 --json statusCheckRollup`)
- [ ] AC10: Live HTTP smoke test (выполняется PM на User Testing — не Coder; но добавить snippet в `.progress.md` как future-PM guide):
  ```bash
  # После User Testing prep:
  curl -i -b "auth=<seed_senior1_jwt>" http://localhost:3001/api/teams
  # Expect: HTTP/1.1 403 ... {"error":"ONBOARDING_REQUIRED","missing":["contract","tos"]}
  ```

## Запрещено трогать

- Логику внутри `signed-contracts.service.ts` interpolate/sign (кроме указанных nits §4)
- Migration `0027_onboarding.sql` (схема финальная)
- `packages/shared/**` schemas (не меняется)
- `apps/web/**` (Phase 6B)
- `apps/e2e/**` (AutoTest zone)

## Verification (Coder перед `git push`)

1. `git diff main HEAD --name-only` — touched файлы только из «Конкретные изменения»
2. `pnpm --filter @crm/api typecheck && pnpm --filter @crm/shared typecheck` — green
3. `mcp__eslint__lint-files` на touched файлах — 0 errors / 0 warnings
4. `pnpm --filter @crm/api test` — все unit tests green + new integration test passing
5. **Локальная reproducability bug ДО fix**: запустить integration test на старом коде (revert app.module.ts wire-up временно) — он должен FAIL. Затем revert revert → должен PASS. Это proof.
6. Commit message:

   ```
   fix(onboarding): guard order — JwtAuthGuard before OnboardingGuard (APP_GUARD), add @Public(), integration test

   Address PR #83 Verdict: BLOCK from Reviewer #4415687659 — global OnboardingGuard
   was running before JwtAuthGuard (controller-level), so req.user was undefined and
   the guard's `if (!user) return true` pre-check made the entire onboarding gate
   no-op in production.

   - JwtAuthGuard зарегистрирован как APP_GUARD ПЕРЕД OnboardingGuard
   - @Public() декоратор для bypass на public endpoints (OAuth, health)
   - Integration test (NestFactory.create + supertest) — настоящий request lifecycle
   - Minor nits: упрощён split, throw вместо silent CHK-1 fallback, удалены void unused

   ac_verified: 1,2,3,4,5,6,7,8
   ```

   (AC9 и AC10 — verified PM'ом на CI и User Testing соответственно, не Coder'ом).

## Skills required

- `superpowers:using-superpowers` (старт)
- `superpowers:test-driven-development` — integration test пиши **первым** (RED — должен fail на старом коде), затем fix → GREEN
- `superpowers:receiving-code-review` — workflow для приёма Reviewer feedback (не blind implement, технически верифицировать)
- `superpowers:security-review` — auth/guard touching → mandatory
- `superpowers:verification-before-completion` — перед push

## Notes для Coder

- Это **fix-task в существующую ветку**, не новая фича. `git checkout feature/onboarding-data-backend && git pull` (commit `67af7bf` уже там).
- НЕ создавать новую ветку. НЕ открывать новый PR. Существующий PR #83 переоткроется в CI после push.
- Не использовать `--no-verify`. RULES §2.1 zero-tolerance.
- Reviewer указал что unit-тесты на onboarding.guard дают false sense of security — integration test замещает эту дыру. НЕ удаляй существующие unit-тесты — они проверяют логику guard'а в изоляции (полезно), просто добавляй integration уровень.
- После fix integration test случае #1 ОБЯЗАН падать с 403, не 200. Если pass'ит и со 200, и с 403 — баг в setup mock'а JWT.
- `mcp__context7__query-docs` использовать для NestJS guard execution order docs если есть сомнения.
