import { Controller, Get } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Public } from '../auth/public.decorator'
import type { Env } from '../config/env'

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService<Env>) {}

  /**
   * backlog 113 — prod could not say which commit it was running: the old
   * `{ status, timestamp }` body carries no build identity, and every
   * finance route 404s an unauthenticated caller identically to a route
   * that does not exist at all, so a probe cannot even distinguish "server
   * up" from "server missing" by shape. `commit`/`buildTime` come from
   * `GIT_COMMIT`/`BUILD_TIME` — set ONLY by the Docker image build (see
   * env.ts's doc on those two keys for the full chain). Deliberately
   * `'unknown'`, never `''` and never a guess, when the image was built
   * without them (local `pnpm dev`, `tsx` runs, or any other non-Docker
   * boot) — absence of build data must stay visibly distinct from a real
   * value, not silently collapse into an empty string a caller could
   * mistake for "no commit" being itself a valid answer.
   *
   * `||`, NOT `??`, and NOT a bare `this.config.get(...)` — verified by
   * actually building+booting the image without either `--build-arg`:
   * `ConfigService.get()` (`@nestjs/config` 4.x) falls back to the RAW
   * `process.env` value whenever the Zod-validated value it holds is
   * `undefined` (see its own `getFromProcessEnv` branch) — it does not know
   * or care that env.ts's preprocess deliberately turned an empty
   * `GIT_COMMIT=''` build-arg into `undefined`; it just sees the key is
   * unset on the validated side and reads process.env directly, which still
   * has the empty string Docker's `ARG GIT_COMMIT=` default baked in. `??`
   * only substitutes on `null`/`undefined`, so `'' ?? 'unknown'` evaluates to
   * `''` — this reached a real container response before the `||` fix. `||`
   * treats the falsy empty string the same as a missing value, which is
   * exactly what "honest unknown" requires here.
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
      commit: this.config.get('GIT_COMMIT', { infer: true }) || 'unknown',
      buildTime: this.config.get('BUILD_TIME', { infer: true }) || 'unknown',
    }
  }
}
