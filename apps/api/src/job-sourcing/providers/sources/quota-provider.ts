import { jobMeterUnitSchema, type JobMeterUnit, type JobSourceType } from '@crm/shared'
import { z } from 'zod'
import type { QuotaCredential, QuotaEnvKey } from '../../quota-credentials'
import { type CollectionContext, MIN_REDACTABLE_SECRET_CHARS } from '../reporting-provider'

/**
 * What the four keyed quota adapters (Jooble, JSearch, TheirStack, Reed) share, and nothing else:
 * the readiness refusal, the secret registration, and the meter parameter. Written once because a
 * guard that four authors each retype is a guard that one of them retypes differently.
 *
 * THE KEY NEVER TRAVELS IN `CollectionContext`. The ctx a worker builds carries `secrets`, and a
 * worker that forgot to add the key would leak it into every report. So each adapter registers its
 * own key (and the other forms it is sent in) on the ctx it hands the loop: redaction does not rest
 * on the worker's memory.
 */

/**
 * A keyed source whose credential is not configured. Thrown BEFORE a reservation and BEFORE any
 * network call, so a source nobody provisioned a key for costs nothing and reports itself. Carries
 * the names only: never a value.
 */
export class SourceNotReadyError extends Error {
  constructor(
    readonly sourceType: JobSourceType,
    readonly envKey: QuotaEnvKey,
  ) {
    super(`${sourceType}: ${envKey} is not configured`)
    this.name = 'SourceNotReadyError'
  }
}

/**
 * The key to send, or `SourceNotReadyError`. `configured: true` with an empty key is refused as
 * well: the credential type promises a value, and an empty string would be sent as a real key.
 */
export function requireApiKey(
  sourceType: JobSourceType,
  envKey: QuotaEnvKey,
  credential: QuotaCredential,
): string {
  if (!credential.configured || credential.apiKey === null || credential.apiKey === '') {
    throw new SourceNotReadyError(sourceType, envKey)
  }
  return credential.apiKey
}

/** The ctx the loop sees: the worker's secrets plus the ones this adapter knows it sends. */
export function withSecrets(ctx: CollectionContext, secrets: readonly string[]): CollectionContext {
  // Refuse, with no value in the message, a secret the redactor cannot represent: registering it
  // would make the report claim a redaction that cannot happen.
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTABLE_SECRET_CHARS) {
      throw new Error(
        `a secret of ${secret.length} character(s) cannot be redacted (minimum ${MIN_REDACTABLE_SECRET_CHARS})`,
      )
    }
  }
  return { ...ctx, secrets: [...ctx.secrets, ...secrets] }
}

/** How a source is billed, as a parameter: the unit and what one request is reserved at. */
export interface MeterOption {
  unit: JobMeterUnit
  amountPerRequest: number
}

const meterOptionSchema = z.object({
  unit: jobMeterUnitSchema,
  amountPerRequest: z.number().int().min(1),
})

/** One paid request counted as one request: the default when no agreement says otherwise. */
export const PER_REQUEST_METER: MeterOption = { unit: 'REQUEST', amountPerRequest: 1 }

/** Validated at construction, so a bad agreement fails when the provider is built, not mid-run. */
export function resolveMeter(option: MeterOption | undefined): MeterOption {
  return meterOptionSchema.parse(option ?? PER_REQUEST_METER)
}
