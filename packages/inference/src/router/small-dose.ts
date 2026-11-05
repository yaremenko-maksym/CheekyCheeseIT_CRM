import type { z } from 'zod'
import type { SmallDose } from '../contracts/extraction'
import type { StructuredOutput } from '../internal/classified-chat'
import {
  DEFAULT_EXTRACTION_INSTRUCTION,
  MAX_EXTRACTION_INSTRUCTION_CHARS,
} from '../internal/chat-completions'
import { runExtraction } from '../internal/extraction-pipeline'
import { createStrictSchema, type StrictSchema } from '../internal/strict-schema'

/** The strict rendering of a schema, or `null` for one JSON Schema cannot express. */
export function renderSchema<T>(schema: z.ZodType<T>): StrictSchema<T> | null {
  try {
    return createStrictSchema(schema)
  } catch {
    return null
  }
}

/** What a route's `structuredOutput` asks for; an unrendered schema falls back to `json_object`. */
export function structuredOutputFor(
  rendered: StrictSchema<unknown> | null,
  mode: 'json_schema' | 'json_object' | 'none',
): StructuredOutput {
  if (mode !== 'json_schema') return { mode }
  return rendered === null
    ? { mode: 'json_object' }
    : { mode: 'json_schema', schema: rendered.jsonSchema }
}

/** One local request of a group: the combined instruction, its output bound, its strict shape. */
export type DoseAsk = {
  instruction: string | undefined
  maxTokens: number
  structuredOutput: StructuredOutput
}

/**
 * Answers the hand-back on the floor (ADR §5.4): each group is one structured extraction on the same
 * input, its constant appended to the whole instruction. Every group is checked before the first is
 * sent, so a table that cannot fit sends nothing. The first failed group fails the whole answer; a
 * partial merge is never returned.
 */
export async function runSmallDose<T, C extends string>(args: {
  dose: SmallDose<T>
  instruction: string | undefined
  schema: z.ZodType<T>
  mode: 'json_schema' | 'json_object' | 'none'
  fits: (instruction: string, maxAnswerTokens: number) => boolean
  ask: (
    ask: DoseAsk,
    correction?: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; code: C }>
}): Promise<{ ok: true; data: T } | { ok: false; code: C | 'INVALID_OUTPUT' | 'PROMPT_TOO_LARGE' }> {
  const base = args.instruction ?? DEFAULT_EXTRACTION_INSTRUCTION
  const groups = args.dose.groups.map((group) => ({
    group,
    rendered: renderSchema(group.schema),
    instruction: `${base}\n\n${group.instruction}`,
  }))
  for (const { group, instruction } of groups) {
    const withinCut = instruction.length <= MAX_EXTRACTION_INSTRUCTION_CHARS
    if (!withinCut || !args.fits(instruction, group.maxAnswerTokens)) {
      return { ok: false, code: 'PROMPT_TOO_LARGE' }
    }
  }
  const parts: Record<string, unknown> = {}
  for (const { group, rendered, instruction } of groups) {
    const part = await runExtraction({
      schema: rendered?.replySchema ?? group.schema,
      call: (correction?: string) =>
        args.ask(
          {
            instruction,
            maxTokens: group.maxAnswerTokens,
            structuredOutput: structuredOutputFor(rendered, args.mode),
          },
          correction,
        ),
    })
    if (!part.ok) return part
    parts[group.name] = part.data
  }
  const merged = args.dose.merge(parts)
  if (!merged.ok) return { ok: false, code: 'INVALID_OUTPUT' }
  const whole = args.schema.safeParse(merged.data)
  return whole.success ? { ok: true, data: whole.data } : { ok: false, code: 'INVALID_OUTPUT' }
}
