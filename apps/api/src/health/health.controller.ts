import { Controller, Get } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Public } from '../auth/public.decorator'
import { GIT_COMMIT_SHAPE, type Env } from '../config/env'

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService<Env>) {}

  /**
   * backlog 113 — prod could not say which COMMIT it was running: the old
   * `{ status, timestamp }` body carries no build identity. `commit`/
   * `buildTime` come from `GIT_COMMIT`/`BUILD_TIME` — set ONLY by the
   * Docker image build (see env.ts's doc on those two keys for the full
   * chain). Deliberately `'unknown'`, never `''` and never a guess, when
   * the image was built without them (local `pnpm dev`, `tsx` runs, or any
   * other non-Docker boot) — absence of build data must stay visibly
   * distinct from a real value, not silently collapse into an empty string
   * a caller could mistake for "no commit" being itself a valid answer.
   *
   * security-review round 2 (task-cascade-apply, SR-M-2) — corrects a claim
   * this comment used to make: it is NOT true that a finance route 404s an
   * unauthenticated caller identically to a route that does not exist.
   * `JwtAuthGuard` throws `UnauthorizedException` (401) for any real route
   * behind it when no session cookie is present; a genuinely nonexistent
   * path — or the right path called with the wrong HTTP method — is what
   * 404s. Verified against a live deployment: an existing protected route
   * answers 401, a made-up one answers 404. So a route's mere presence
   * CAN be probed from outside by status code alone; what that proves is
   * only "SOME deployed version carries this route", never "THIS commit is
   * deployed" — a route can be unchanged across many commits. That second,
   * stronger question is exactly what `commit` below answers.
   *
   * BUILD_TIME uses `||`, NOT `??`, and NOT a bare `this.config.get(...)` —
   * verified by actually building+booting the image without either
   * `--build-arg`: `ConfigService.get()` (`@nestjs/config` 4.x) falls back
   * to the RAW `process.env` value whenever the Zod-validated value it
   * holds is `undefined` (see its own `getFromProcessEnv` branch) — it does
   * not know or care that env.ts's preprocess deliberately turned an empty
   * `BUILD_TIME=''` build-arg into `undefined`; it just sees the key is
   * unset on the validated side and reads process.env directly, which
   * still has the empty string Docker's default baked in. `??` only
   * substitutes on `null`/`undefined`, so `'' ?? 'unknown'` evaluates to
   * `''` — this reached a real container response before the `||` fix.
   * `||` treats the falsy empty string the same as a missing value, which
   * is exactly what "honest unknown" requires here.
   *
   * GIT_COMMIT does NOT use that same `||` trick, on purpose — security
   * review round 2 (task-cascade-apply, SR-H-1) found it is not enough
   * there. The SAME `ConfigService.get()` process.env fallback above hands
   * back whatever raw string a manual `workflow_dispatch image_tag` typed
   * in (e.g. the rollback runbook's non-SHA `main` tag) whenever env.ts's
   * schema decided the validated value is `undefined` — and unlike an
   * unset build-arg's empty string, that raw string is non-empty, so `||`
   * would treat it as truthy and echo it back as if it were a real commit.
   * `resolveGitCommit` closes that: it re-applies `GIT_COMMIT_SHAPE` to
   * whatever `ConfigService` hands back, so a value that does not look like
   * a real SHA reads as `'unknown'` regardless of which of the three
   * sources (validated / internal / raw process.env) it came from.
   *
   * Deliberately narrow: commit + build time only. No branch, no
   * dependency versions, no stack details — this repo is public and the
   * endpoint is unauthenticated (`@Public()`); a commit hash is already
   * derivable by anyone from the public GitHub history, so it adds nothing
   * an attacker didn't have, but branch names / dependency versions would.
   */
  @Get()
  @Public()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      commit: resolveGitCommit(this.config.get('GIT_COMMIT', { infer: true })),
      buildTime: this.config.get('BUILD_TIME', { infer: true }) || 'unknown',
    }
  }
}

/**
 * `'unknown'` for anything that isn't a real-looking commit SHA — see
 * `HealthController.check`'s doc block for why a plain `|| 'unknown'` is
 * not safe for this particular field. Exported so `health.controller.spec.ts`
 * can drive it directly with the exact raw strings `ConfigService.get()` is
 * capable of handing back (a validated value, OR an unvalidated one leaked
 * from `process.env`), without needing a real `ConfigService` instance.
 */
/**
 * A user-defined type guard, not a bare boolean helper, so the ternary below
 * narrows `value` to `string` on its own — no cast needed.
 *
 * task-mutation-gate follow-up (PR #613, backlog 121). This used to be
 * `value !== undefined && GIT_COMMIT_SHAPE.test(value)` inline in
 * `resolveGitCommit`, and the mutation gate could not kill a mutant that
 * dropped the `value !== undefined` half: `RegExp.prototype.test()` coerces
 * a non-string argument via `String()` internally, so `.test(value)` with
 * `value === undefined` already evaluates `GIT_COMMIT_SHAPE.test('undefined')`
 * — and the literal text "undefined" (it contains 'u'/'n'/'i') can never
 * match a hex-only pattern regardless. The explicit `!== undefined` guard
 * was true defense-in-depth for TYPES (this codebase does not pass `unknown`
 * here) but added no OBSERVABLE behaviour a test could pin — so per this
 * project's own mutation-gate policy ("недостающая проверка или лишняя
 * сложность?"), the answer here was simplify, not suppress: `String(value)`
 * below makes the SAME coercion `.test()` already performed implicit
 * anyway, explicit and self-documenting, and removes the redundant
 * conditional entirely rather than hiding it behind a suppression comment.
 */
function looksLikeGitCommit(value: string | undefined): value is string {
  return GIT_COMMIT_SHAPE.test(String(value))
}

export function resolveGitCommit(value: string | undefined): string {
  return looksLikeGitCommit(value) ? value : 'unknown'
}
