import type { SmallDose, SmallDoseGroup } from '@crm/inference'
import { z } from 'zod'
import { modelReplySchema, type ModelReply } from './extraction-result-guard'
import { MODEL_FILLABLE_FIELDS, type ModelFillableField } from './html-structurer.port'

/** Marks a floor answer: the guard requires `uncertainty`, and the floor is not asked for it (ADR §5.4). */
export const FLOOR_UNCERTAINTY = 0.5
/** `ModelStructurer` stamps the request's version; this only satisfies the reply schema. */
const FLOOR_EXTRACTION_VERSION = 'floor-small-dose-v1'
/** The bound of `postingsOnPage`: past this, the count is no use and the answer stays small. */
const MAX_POSTINGS_ON_PAGE = 20
const MAX_QUOTE_CHARS = 2_000

const MAIN_POSTING_ONLY =
  'Answer about the main job posting of this page only; ignore postings in sidebars, lists or ' +
  'recommendations.'
const QUOTE_RULE =
  'Use null when the page does not state it. Every value comes with a quote copied verbatim from ' +
  'the page.'

const quote = () => z.string().max(MAX_QUOTE_CHARS).nullable()

interface FloorGroup extends SmallDoseGroup {
  /** The fields this group answers; a group none of them is missing from is not asked. */
  readonly fields: readonly ModelFillableField[]
}

/**
 * The floor's question table (ADR §5.4). Sub-schemas are flat, strict-renderable objects, and every
 * instruction is appended to `EXTRACTION_SYSTEM_PROMPT` by the router, never in place of it.
 * `maxAnswerTokens` is a first estimate; MP-03 tunes it.
 */
const IDENTITY_GROUP: SmallDoseGroup = {
  name: 'identity',
  instruction: `${MAIN_POSTING_ONLY} Count the separate job postings on this page.`,
  schema: z.object({ postingsOnPage: z.number().int().min(0).max(MAX_POSTINGS_ON_PAGE) }),
  maxAnswerTokens: 32,
}

const FIELD_GROUPS: readonly FloorGroup[] = [
  {
    name: 'place',
    instruction: `${MAIN_POSTING_ONLY} State its location and whether the work is remote. ${QUOTE_RULE}`,
    schema: z.object({
      location: z.string().max(500).nullable(),
      locationQuote: quote(),
      remote: z.boolean().nullable(),
    }),
    maxAnswerTokens: 256,
    fields: ['location', 'remote'],
  },
  {
    name: 'terms',
    instruction: `${MAIN_POSTING_ONLY} State its employment type. ${QUOTE_RULE}`,
    schema: z.object({
      employmentType: z.string().max(100).nullable(),
      employmentTypeQuote: quote(),
    }),
    maxAnswerTokens: 128,
    fields: ['employmentType'],
  },
  {
    name: 'description',
    instruction: `${MAIN_POSTING_ONLY} State its description. ${QUOTE_RULE}`,
    schema: z.object({
      description: z.string().max(20_000).nullable(),
      descriptionQuote: quote(),
    }),
    maxAnswerTokens: 1_200,
    fields: ['description'],
  },
]

/**
 * The small dose `ModelStructurer` always supplies. `merge` yields exactly one record or an explicit
 * failure, never `{ records: [] }`, which the guard would pass as "no postings".
 */
export function smallDoseFor(
  missing: readonly ModelFillableField[] = MODEL_FILLABLE_FIELDS,
): SmallDose<ModelReply> {
  const asked = FIELD_GROUPS.filter(({ fields }) => fields.some((f) => missing.includes(f)))
  return {
    groups: [IDENTITY_GROUP, ...asked].map(({ name, instruction, schema, maxAnswerTokens }) => ({
      name,
      instruction,
      schema,
      maxAnswerTokens,
    })),
    merge(parts) {
      const identity = IDENTITY_GROUP.schema.safeParse(parts[IDENTITY_GROUP.name])
      if (!identity.success) return { ok: false }
      if ((identity.data as { postingsOnPage: number }).postingsOnPage !== 1) return { ok: false }

      const facts: Record<string, unknown> = {}
      const evidence: { field: ModelFillableField; quote: string }[] = []
      for (const group of asked) {
        const part = group.schema.safeParse(parts[group.name])
        if (!part.success) return { ok: false }
        const answer = part.data as Readonly<Record<string, unknown>>
        for (const field of group.fields) {
          const said = answer[field]
          facts[field] = said
          const quoted = answer[`${field}Quote`]
          // An empty quote proves nothing, and the record schema refuses it.
          if (said !== null && typeof quoted === 'string' && quoted !== '') {
            evidence.push({ field, quote: quoted })
          }
        }
      }
      // `parse` only applies the record's defaults: no answer a group admits exceeds a record limit
      // (the longest-answer spec pins it). A drift throws, and the router answers PROVIDER_ERROR.
      const data = modelReplySchema.parse({
        extractionVersion: FLOOR_EXTRACTION_VERSION,
        records: [{ ...facts, evidence, uncertainty: FLOOR_UNCERTAINTY }],
      })
      return { ok: true, data }
    },
  }
}
