import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'

/**
 * The compatibility barrier (r5 Task 4.6 S6a) runs its suites for both values of
 * `JOB_QUEUE_BRIDGE_ENABLED`. Specs build `JobSourcingService` by hand, so the flag reaches it as a
 * fake `ConfigService` passed as the 4th constructor argument; only `get` is ever called on it.
 */
export const BRIDGE_FLAG_VALUES = [false, true] as const

export function bridgeConfig(flagOn: boolean): ConfigService<Env, true> {
  return {
    get: (key: string) => (key === 'JOB_QUEUE_BRIDGE_ENABLED' ? flagOn : undefined),
  } as unknown as ConfigService<Env, true>
}
