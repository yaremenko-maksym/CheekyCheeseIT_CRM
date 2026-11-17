import type { z } from 'zod'
import type { StructuredOutput } from '../internal/classified-chat'
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
