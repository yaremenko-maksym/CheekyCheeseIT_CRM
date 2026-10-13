import type { z } from 'zod'
import { stripUnstorableChars } from './strip-unstorable'

/** Returns the first balanced top-level `{...}` in `text`, ignoring braces inside JSON strings. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

const MAX_CORRECTION_CHARS = 500
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_]{1,32}$/

/**
 * Corrective hint from issue LOCATIONS only, with a fixed generic message. It never carries offending
 * values, unexpected keys or model text (prompt-injection / echo vector). Path segments can be
 * model-controlled (record keys), so anything that is not a short identifier is masked.
 */
function buildSchemaHint(issues: readonly { path: PropertyKey[] }[]): string {
  const locations = [
    ...new Set(
      issues.map((issue) =>
        issue.path.length === 0
          ? '(root)'
          : issue.path
              .map((seg) =>
                typeof seg === 'number'
                  ? String(seg)
                  : SAFE_PATH_SEGMENT.test(String(seg))
                    ? String(seg)
                    : '*',
              )
              .join('.'),
      ),
    ),
  ]
  const hint = `The JSON did not match the required schema; invalid or missing at: ${locations.join(', ')}.`
  return hint.slice(0, MAX_CORRECTION_CHARS)
}

type ParseOutcome<T> = { ok: true; data: T } | { ok: false; reason: string }

function parseDetailed<T>(rawText: string, schema: z.ZodType<T>): ParseOutcome<T> {
  const objectText = extractJsonObject(rawText)
  if (objectText === null) return { ok: false, reason: 'No JSON object found in the response.' }
  let json: unknown
  try {
    json = JSON.parse(objectText, (_key, value: unknown) =>
      typeof value === 'string' ? stripUnstorableChars(value) : value,
    )
  } catch {
    return { ok: false, reason: 'The response was not valid JSON.' }
  }
  const parsed = schema.safeParse(json)
  if (parsed.success) return { ok: true, data: parsed.data }
  return { ok: false, reason: buildSchemaHint(parsed.error.issues) }
}

/** extract -> JSON.parse (guarded) -> control-char strip on string leaves -> schema.safeParse. */
export function parseExtraction<T>(
  rawText: string,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false } {
  const outcome = parseDetailed(rawText, schema)
  return outcome.ok ? outcome : { ok: false }
}

export async function runExtraction<T, C extends string>(args: {
  schema: z.ZodType<T>
  call: (correction?: string) => Promise<{ ok: true; text: string } | { ok: false; code: C }>
}): Promise<{ ok: true; data: T } | { ok: false; code: C | 'INVALID_OUTPUT' }> {
  const first = await args.call()
  if (!first.ok) return first
  const firstParse = parseDetailed(first.text, args.schema)
  if (firstParse.ok) return firstParse

  const second = await args.call(firstParse.reason)
  if (!second.ok) return second
  const secondParse = parseDetailed(second.text, args.schema)
  if (secondParse.ok) return secondParse
  return { ok: false, code: 'INVALID_OUTPUT' }
}
