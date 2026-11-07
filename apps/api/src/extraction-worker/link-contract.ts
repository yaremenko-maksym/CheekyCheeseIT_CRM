import { createHash } from 'node:crypto'
import type { SmallDoseGroup } from '@crm/inference'
import { z } from 'zod'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'
import { smallDoseFor } from '../job-sourcing/structuring/small-dose-table'

/**
 * What both ends of the worker link agree on (ADR §2.4): the secret rule and the table version.
 * The only worker module the collection side may import (a source scan pins that); it holds no
 * env parser, router config or key.
 */

/** The worker refuses to start with a shorter `EXTRACTION_WORKER_SECRET` (ADR §2.4). */
export const MIN_WORKER_SECRET_CHARS = 32
/** Fewer distinct characters than this is a placeholder, whatever its length. */
export const MIN_WORKER_SECRET_DISTINCT_CHARS = 8
/** One rule for both ends of the worker link: the worker and the collection side. */
export const isUsableWorkerSecret = (secret: string): boolean =>
  secret.length >= MIN_WORKER_SECRET_CHARS &&
  new Set(secret).size >= MIN_WORKER_SECRET_DISTINCT_CHARS

/**
 * A digest of the checked-in extraction module both workers import: the prompt, the field-group
 * table and the reply schema. Two images mid-deploy differ here without anyone bumping a constant.
 * `merge` is code and is not hashed; a change to it alone ships with a prompt or table change or
 * not at all.
 */
export function tableVersionOf(m: {
  prompt: string
  groups: readonly SmallDoseGroup[]
  reply: z.ZodType
}): string {
  const groups = m.groups.map((g) => ({
    name: g.name,
    instruction: g.instruction,
    maxAnswerTokens: g.maxAnswerTokens,
    // Stryker disable next-line StringLiteral: equivalent — zod merges a string result into the node, so '' leaves `{}` exactly as 'any' does; dropping the option is caught
    schema: z.toJSONSchema(g.schema, { unrepresentable: 'any' }),
  }))
  // Stryker disable next-line StringLiteral: equivalent — see the line above; 'io' is pinned by its own test
  const reply = z.toJSONSchema(m.reply, { unrepresentable: 'any', io: 'input' })
  const doc = JSON.stringify({ prompt: m.prompt, groups, reply })
  // Stryker disable next-line StringLiteral: false survivor — '' throws "Digest method not supported" at module load, the spec file fails to collect, which the runner does not count as a kill
  const hash = createHash('sha256')
  return hash.update(doc).digest('hex').slice(0, 16)
}

// Stryker disable next-line ObjectLiteral: false survivor — {} throws at module load (m.groups is undefined), the spec file fails to collect, which the runner does not count as a kill
export const EXTRACTION_TABLE_VERSION = tableVersionOf({
  prompt: EXTRACTION_SYSTEM_PROMPT,
  groups: smallDoseFor().groups,
  reply: modelReplySchema,
})
