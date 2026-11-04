import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createStrictSchema } from './strict-schema'

const NULL = { type: 'null' }

const posting = z.object({
  title: z.string().max(200),
  salary: z.number().nullable(),
  tags: z.array(z.object({ n: z.string(), u: z.string().url().optional() })).optional(),
  loc: z.object({ city: z.string() }).optional(),
  kind: z.enum(['a', 'b']).optional(),
  flag: z.boolean().default(false),
})

const nested = z.object({
  opt: z.object({ a: z.string().optional() }).nullable(),
  list: z.array(z.object({ b: z.number().optional() })).nullable(),
  inner: z.object({ c: z.string() }),
  meta: z.unknown(),
})

describe('createStrictSchema — golden strict form (ADR 5.4c-1)', () => {
  it('renders a flat posting schema', () => {
    expect(createStrictSchema(posting).jsonSchema).toStrictEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        salary: { type: ['number', 'null'] },
        tags: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  n: { type: 'string' },
                  u: { anyOf: [{ type: 'string', format: 'uri' }, NULL] },
                },
                required: ['n', 'u'],
                additionalProperties: false,
              },
            },
            NULL,
          ],
        },
        loc: {
          anyOf: [
            {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
              additionalProperties: false,
            },
            NULL,
          ],
        },
        kind: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, NULL] },
        flag: { default: false, type: 'boolean' },
      },
      required: ['title', 'salary', 'tags', 'loc', 'kind', 'flag'],
      additionalProperties: false,
    })
  })

  it('renders nullable objects and arrays, a plain object and an untyped field', () => {
    expect(createStrictSchema(nested).jsonSchema).toStrictEqual({
      type: 'object',
      properties: {
        opt: {
          anyOf: [
            {
              type: 'object',
              properties: { a: { anyOf: [{ type: 'string' }, NULL] } },
              required: ['a'],
              additionalProperties: false,
            },
            NULL,
          ],
        },
        list: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: { b: { anyOf: [{ type: 'number' }, NULL] } },
                required: ['b'],
                additionalProperties: false,
              },
            },
            NULL,
          ],
        },
        inner: {
          type: 'object',
          properties: { c: { type: 'string' } },
          required: ['c'],
          additionalProperties: false,
        },
        meta: {},
      },
      required: ['opt', 'list', 'inner', 'meta'],
      additionalProperties: false,
    })
  })

  it('never carries maxLength anywhere, while Zod still enforces the bound', () => {
    const strict = createStrictSchema(posting)
    expect(JSON.stringify(strict.jsonSchema)).not.toContain('maxLength')
    expect(strict.replySchema.safeParse({ title: 'x'.repeat(201), salary: null }).success).toBe(
      false,
    )
  })
})

describe('createStrictSchema — null means "not found"', () => {
  // Built per test: a throw while rendering must fail a test, not the collection.
  const reply = () => createStrictSchema(posting).replySchema

  it('maps a null on an optional field to absent and keeps a null on a nullable one', () => {
    const r = reply().parse({
      title: 'T',
      salary: null,
      tags: null,
      loc: null,
      kind: null,
      flag: true,
    })
    expect(r).toStrictEqual({ title: 'T', salary: null, flag: true })
  })

  it('maps nulls inside array items and nested objects', () => {
    const r = reply().parse({
      title: 'T',
      salary: 1,
      tags: [{ n: 'a', u: null }],
      loc: { city: 'K' },
      kind: 'a',
      flag: false,
    })
    expect(r).toStrictEqual({
      title: 'T',
      salary: 1,
      tags: [{ n: 'a' }],
      loc: { city: 'K' },
      kind: 'a',
      flag: false,
    })
  })

  it('does not turn a null on a required non-nullable field into absent', () => {
    expect(reply().safeParse({ title: null, salary: 1 }).success).toBe(false)
  })

  it('follows the anyOf branch of nullable objects and arrays', () => {
    const r = createStrictSchema(nested).replySchema.parse({
      opt: { a: null },
      list: [{ b: null }, { b: 2 }],
      inner: { c: 'x', extra: 1 },
      meta: [{ k: null }],
    })
    expect(r).toStrictEqual({
      opt: {},
      list: [{}, { b: 2 }],
      inner: { c: 'x' },
      meta: [{ k: null }],
    })
  })

  it('keeps a whole null on a nullable object or array', () => {
    const r = createStrictSchema(nested).replySchema.parse({
      opt: null,
      list: null,
      inner: { c: 'x' },
      meta: { k: null },
    })
    expect(r).toStrictEqual({ opt: null, list: null, inner: { c: 'x' }, meta: { k: null } })
  })

  it('leaves keys the schema does not describe to the caller schema', () => {
    const r = reply().parse({ title: 'T', salary: 1, unknownKey: 'v', other: null })
    expect(r).toStrictEqual({ title: 'T', salary: 1, flag: false })
  })

  it('never overwrites a filled field: an absent answer leaves the earlier value', () => {
    const filled = { title: 'Filled', salary: 5, kind: 'b' as const }
    const answer = reply().parse({
      title: 'T',
      salary: null,
      kind: null,
      tags: null,
      loc: null,
      flag: false,
    })
    expect('kind' in answer).toBe(false)
    expect({ ...filled, ...answer }.kind).toBe('b')
  })

  it('passes a primitive answer for a string-or-object field through untouched', () => {
    const either = z.object({ v: z.union([z.string(), z.object({ a: z.string().optional() })]) })
    const replySchema = createStrictSchema(either).replySchema
    expect(replySchema.parse({ v: 'plain' })).toStrictEqual({ v: 'plain' })
    expect(replySchema.parse({ v: { a: null } })).toStrictEqual({ v: {} })
  })

  it('maps nulls in an all-optional object', () => {
    const allOptional = z.object({ a: z.string().optional(), b: z.number().optional() })
    expect(createStrictSchema(allOptional).replySchema.parse({ a: null, b: 1 })).toStrictEqual({
      b: 1,
    })
  })
})

describe('createStrictSchema — refuses what it cannot make strict (CR-M-2)', () => {
  const Tree: z.ZodType = z.object({
    n: z.string(),
    get c() {
      return z.array(Tree).optional()
    },
  })

  it.each([
    ['a record', z.object({ r: z.record(z.string(), z.number()) }), /additionalProperties/],
    ['a loose object', z.looseObject({ c: z.string() }), /additionalProperties/],
    ['a tuple', z.object({ t: z.tuple([z.string(), z.number()]) }), /"prefixItems"/],
    ['a recursive schema', Tree, /"\$ref"/],
    [
      'a discriminated union',
      z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]),
      /"oneOf"/,
    ],
    [
      'a union of two object shapes',
      z.object({ u: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) }),
      /several object or array shapes/,
    ],
    [
      'a union of an array and an object',
      z.object({ u: z.union([z.array(z.string()), z.object({ b: z.string() })]) }),
      /several object or array shapes/,
    ],
    ['allOf', z.object({ a: z.string() }).meta({ allOf: [] }), /"allOf"/],
    ['$defs', z.object({ a: z.string() }).meta({ $defs: {} }), /"\$defs"/],
    [
      'patternProperties',
      z.object({ a: z.string() }).meta({ patternProperties: {} }),
      /"patternProperties"/,
    ],
  ])('%s', (_name, schema: z.ZodType, message: RegExp) => {
    expect(() => createStrictSchema(schema)).toThrow(message)
    expect(() => createStrictSchema(schema)).toThrow(
      /^createStrictSchema: .+ cannot be rendered in the strict form$/,
    )
  })

  it('keeps a nullable object, a nullable array and a primitive-or-object union', () => {
    expect(() =>
      createStrictSchema(
        z.object({
          o: z.object({ a: z.string() }).nullable().optional(),
          l: z.array(z.string()).nullable(),
          u: z.union([z.string(), z.object({ a: z.string() })]),
        }),
      ),
    ).not.toThrow()
  })
})

describe('createStrictSchema — a model-sent __proto__ key (SR-L-62)', () => {
  it('never becomes the prototype of the mapped answer', () => {
    const schema = z.object({ a: z.string(), p: z.boolean().optional() })
    const sent: unknown = JSON.parse('{"a":"x","__proto__":{"p":true}}')
    expect(createStrictSchema(schema).replySchema.parse(sent)).toStrictEqual({ a: 'x' })
    expect(({} as Record<string, unknown>).p).toBeUndefined()
  })
})
