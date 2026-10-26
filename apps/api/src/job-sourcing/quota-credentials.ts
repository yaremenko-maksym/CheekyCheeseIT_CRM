import type { JobSourceType } from '@crm/shared'
import type { Env } from '../config/env'

/**
 * Credentials of the five vacancy-sourcing quota providers (r5 Task 3.5).
 *
 * The ONE place these env keys are read. A worker asks for exactly the provider it is about to
 * run, receives the key AND the list to append to `CollectionContext.secrets`, so the key is
 * redacted from every report the attempt produces. Nothing here reads `CLOUDFLARE_*` (C-21): a
 * provider without its own key is unconfigured, never configured by borrowing another one.
 */

export const QUOTA_PROVIDER_ENV_KEY = {
  jooble: 'JOOBLE_API_KEY',
  /** JSearch is sold through RapidAPI; the key is the RapidAPI account key. */
  jsearch: 'RAPIDAPI_KEY',
  theirstack: 'THEIRSTACK_API_KEY',
  reed: 'REED_API_KEY',
  /** The Muse's public API needs no key. */
  themuse: null,
} as const satisfies Record<string, keyof Env | null>

export type QuotaProvider = keyof typeof QUOTA_PROVIDER_ENV_KEY
export type QuotaEnvKey = NonNullable<(typeof QUOTA_PROVIDER_ENV_KEY)[QuotaProvider]>

export interface QuotaCredential {
  /** False when the provider needs a key and none is set: the source must not run. */
  configured: boolean
  apiKey: string | null
  /** Exactly what to add to `CollectionContext.secrets`. Empty when there is no key. */
  secrets: readonly string[]
}

/** The quota provider whose credential a source type sends, or none (r5 Task 2.5 T7). */
export const QUOTA_PROVIDER_OF_TYPE: Partial<Record<JobSourceType, QuotaProvider>> = Object.freeze({
  JOOBLE_API: 'jooble',
  JSEARCH_API: 'jsearch',
  THEIRSTACK_API: 'theirstack',
  REED_API: 'reed',
  MUSE_API: 'themuse',
})

/**
 * T7: what a run of `type` must never show in a report or a persisted message -- the type's own
 * credential, when it has one. The worker hands this to the context's `secrets`; each keyed adapter
 * also registers its key itself, so redaction never rests on one of the two alone.
 */
export function secretsForType(
  type: JobSourceType,
  read: (key: QuotaEnvKey) => string | undefined,
): readonly string[] {
  const provider = QUOTA_PROVIDER_OF_TYPE[type]
  return provider === undefined ? [] : readQuotaCredential(provider, read).secrets
}

/**
 * @param read reads one validated env value, e.g. `(k) => config.get(k, { infer: true })`.
 *   Blank values are already `undefined` after `validateEnv`; an empty string is still treated
 *   as absent here, so an empty credential can never be configured or registered.
 */
export function readQuotaCredential(
  provider: QuotaProvider,
  read: (key: QuotaEnvKey) => string | undefined,
): QuotaCredential {
  const envKey = QUOTA_PROVIDER_ENV_KEY[provider]
  if (envKey === null) return { configured: true, apiKey: null, secrets: [] }
  const apiKey = read(envKey)
  if (apiKey === undefined || apiKey === '') return { configured: false, apiKey: null, secrets: [] }
  return { configured: true, apiKey, secrets: [apiKey] }
}
