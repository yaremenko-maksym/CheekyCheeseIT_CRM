import { z } from 'zod'

export type JsonSchema = { [key: string]: unknown }

// shortcut: arrays pass as objects here; callers branch on Array.isArray first where it matters.
function isObject(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null
}

/** `required` of a Zod-rendered node: an array of names, or absent (an empty set). */
function requiredOf(node: JsonSchema): ReadonlySet<unknown> {
  return new Set(node.required as unknown[] | undefined)
}

/** Constructs the strict form cannot express; a schema using one is refused at creation (CR-M-2). */
const REFUSED_KEYWORDS = new Set([
  'allOf',
  'oneOf',
  '$ref',
  '$defs',
  'prefixItems',
  'patternProperties',
])

function refuse(what: string): never {
  throw new Error(`createStrictSchema: ${what} cannot be rendered in the strict form`)
}

/** A branch that describes an object or an array (as opposed to a primitive or null). */
function isShaped(branch: JsonSchema): boolean {
  return isObject(branch.properties) || isObject(branch.items)
}

/**
 * The strict form every route receives (ADR 5.4c-1): every property in `required`,
 * `additionalProperties: false` on every object, an optional property as a union with `null`,
 * no `maxLength` (a decoder-side cut would truncate silently; Zod still enforces the bound).
 */
function toStrict(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'maxLength' || key === '$schema') continue
    if (REFUSED_KEYWORDS.has(key)) refuse(`"${key}"`)
    if (key === 'additionalProperties' && typeof value !== 'boolean') {
      refuse('a schema-valued additionalProperties (record or loose object)')
    }
    if (key === 'anyOf' && (value as JsonSchema[]).filter(isShaped).length > 1) {
      refuse('a union of several object or array shapes')
    }
    out[key] =
      key === 'items'
        ? toStrict(value as JsonSchema)
        : key === 'anyOf'
          ? (value as JsonSchema[]).map(toStrict)
          : value
  }
  if (isObject(node.properties)) {
    const required = requiredOf(node)
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([name, child]) => {
        const strict = toStrict(child as JsonSchema)
        return [name, required.has(name) ? strict : { anyOf: [strict, { type: 'null' }] }]
      }),
    )
    out.required = Object.keys(node.properties)
    out.additionalProperties = false
  }
  return out
}

/** The one shaped `anyOf` branch (creation refuses unions of several shapes) for `value`. */
function branchFor(node: JsonSchema, value: unknown): JsonSchema {
  if (!Array.isArray(node.anyOf)) return node
  const key = Array.isArray(value) ? 'items' : 'properties'
  const branch = (node.anyOf as JsonSchema[]).find((b) => isObject(b[key]))
  return branch ?? node
}

/** A strict `null` on a property the caller's schema leaves optional means "not found": absent. */
function nullsToAbsent(schemaNode: JsonSchema, value: unknown): unknown {
  const node = branchFor(schemaNode, value)
  const { items, properties } = node
  if (Array.isArray(value)) {
    return isObject(items) ? value.map((v) => nullsToAbsent(items, v)) : value
  }
  if (!isObject(value) || !isObject(properties)) return value
  const required = requiredOf(node)
  // No prototype: a model-sent `__proto__` key stays an own key and is never a prototype (SR-L-62).
  const out = Object.create(null) as JsonSchema
  for (const [key, v] of Object.entries(value)) {
    if (v === null && !required.has(key)) continue
    const child = properties[key]
    out[key] = isObject(child) ? nullsToAbsent(child, v) : v
  }
  return out
}

export type StrictSchema<T> = {
  /** Sent as `response_format.json_schema.schema`. */
  jsonSchema: JsonSchema
  /** The caller's schema behind the null-to-absent mapping; parse every reply with it. */
  replySchema: z.ZodType<T>
}

/** Renders the caller's Zod schema in the strict form and pairs it with the matching reply parser. */
export function createStrictSchema<T>(schema: z.ZodType<T>): StrictSchema<T> {
  const source = z.toJSONSchema(schema) as JsonSchema
  return {
    jsonSchema: toStrict(source),
    replySchema: z.preprocess((v) => nullsToAbsent(source, v), schema) as z.ZodType<T>,
  }
}
