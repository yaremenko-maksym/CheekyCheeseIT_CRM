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

// The wire contract of `/resume-write` and `/visual-check`: the worker parses with it, and the api's
// resume-verification clients check their input and re-validate the reply with the same schemas.

/** The most pages one visual check takes, and the decoded size cap of each (1.5 MB). */
export const MAX_PAGES = 2
export const MAX_PAGE_BYTES = 1_500_000
/**
 * The base64 length of a page at the cap. The cap divides by 3, so a canonical string of at most
 * this length decodes to at most `MAX_PAGE_BYTES`: the length check is the size check.
 */
export const MAX_PAGE_CHARS = (MAX_PAGE_BYTES / 3) * 4
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Canonical padded base64 whose bytes start with the PNG signature (12 chars hold 9 bytes). */
function isPngPage(b64: string): boolean {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  // Stryker disable next-line MethodExpression: equivalent — decoding the whole page gives the same first 8 bytes; the slice only saves the work
  return Buffer.from(b64.slice(0, 12), 'base64').subarray(0, 8).equals(PNG_SIGNATURE)
}

/** `visual-check` data only: the rendered pages. The checklist is the worker's own. */
export const visualCheckBodySchema = z
  .object({
    pages: z.array(z.string().max(MAX_PAGE_CHARS).refine(isPngPage)).min(1).max(MAX_PAGES),
  })
  .strict()

/** `resume-write` reply data, per task. */
export const summaryReplySchema = z.object({ summary: z.string().min(1).max(2000) }).strict()
export const bulletsReplySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            index: z.number().int().min(0),
            bullets: z.array(z.string().min(1).max(400)).min(1).max(8),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()

/** The layout checks `visual-check` may report. */
export const VISUAL_CHECKS = [
  'overflow',
  'overlap',
  'ragged',
  'orphan',
  'broken-bullet',
  'uneven-spacing',
  'cut-off',
] as const
/** `visual-check` reply data. */
export const findingsReplySchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            check: z.enum(VISUAL_CHECKS),
            page: z.number().int().min(0),
            text: z.string().min(1).max(400),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
