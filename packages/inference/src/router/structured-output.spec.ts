import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderSchema, structuredOutputFor } from './structured-output'

describe('renderSchema', () => {
  it('renders a schema JSON Schema can express, with a reply schema that parses its answer', () => {
    const rendered = renderSchema(z.object({ title: z.string().nullable() }))
    expect(rendered).not.toBeNull()
    expect(rendered?.jsonSchema).toMatchObject({ type: 'object' })
    expect(rendered?.replySchema.safeParse({ title: 'x' }).success).toBe(true)
  })

  it('answers null for a schema JSON Schema cannot express, instead of throwing', () => {
    expect(renderSchema(z.object({ at: z.date() }))).toBeNull()
  })
})

describe('structuredOutputFor', () => {
  const rendered = renderSchema(z.object({ title: z.string() }))

  it('asks json_schema with the rendered schema', () => {
    expect(structuredOutputFor(rendered, 'json_schema')).toEqual({
      mode: 'json_schema',
      schema: rendered?.jsonSchema,
    })
  })

  it('falls back to json_object when the schema could not be rendered', () => {
    expect(structuredOutputFor(null, 'json_schema')).toEqual({ mode: 'json_object' })
  })

  it.each(['json_object', 'none'] as const)('passes %s through without a schema', (mode) => {
    expect(structuredOutputFor(rendered, mode)).toEqual({ mode })
    expect(structuredOutputFor(null, mode)).toEqual({ mode })
  })
})
