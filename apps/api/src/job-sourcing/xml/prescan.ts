/**
 * Structural pre-scan: element count and nesting depth, before the parser runs — Task 2.4a, R-2.
 *
 * WHY A PRE-SCAN AT ALL, GIVEN DEPTH AND COUNT ARE EXACT AFTER PARSING
 * -------------------------------------------------------------------
 * Because "after parsing" is after the cost has been paid. The element count is what parse time
 * and resident memory track (measurements in `xml-limits.ts`), and the point of a bound is to
 * refuse the work, not to describe it afterwards. Checking the count post-parse would be the same
 * defect as the ADR's wall-clock deadline "checked around the call": a report, not a bound.
 *
 * THE RISK THIS FILE IS, AND HOW IT IS CLOSED
 * -------------------------------------------
 * R-2 names it precisely: a cheap scan over attacker-controlled input that disagrees with the real
 * parser is a **parser-differential** surface. A regex counting `<` would be exactly that — `<`
 * and `>` live quite legally inside attribute values, comments, CDATA sections and processing
 * instructions, and a document can be shaped so the scan sees few elements where the parser builds
 * many, which turns the bound off.
 *
 * So this is not a cheap scan. It is a small tokenizer that recognises the same five markup
 * constructs the parser does, and the disagreement risk is closed by measurement rather than by
 * care: `prescan.differential.spec.ts` parses every document in the corpus and asserts the
 * scanner's `(maxDepth, elementCount)` equals the tree's, and `bounded-xml-port.ts` raises
 * `PRESCAN_DIFFERENTIAL` at runtime if they ever differ. A divergence is therefore a red test or a
 * loud error, never a silently disabled bound.
 *
 * It deliberately does NOT validate. A malformed document is the parser's verdict to give
 * (`MALFORMED` = drift); this scan only has to avoid UNDER-counting one.
 */

export interface PrescanBudget {
  readonly maxDepth: number
  readonly maxElements: number
}

export interface StructureMeasurement {
  /** Deepest element nesting seen, root element = 1. */
  readonly maxDepth: number
  readonly elementCount: number
}

export type PrescanOutcome =
  | ({ readonly ok: true } & StructureMeasurement)
  /**
   * A budget was exceeded. The measurement is the point at which the scan ABORTED, not the
   * document's true size: the scan stops at the first breach, so a hostile document cannot make
   * us walk all of it to find out we did not want it.
   */
  | ({ readonly ok: false; readonly exceeded: 'depth' | 'elements' } & StructureMeasurement)

/**
 * XML name start characters, restricted to what matters here: telling an element open tag from a
 * stray `<` in text. The full production includes large Unicode ranges; a name this scan
 * misclassifies as "not a name" is a `<` the parser will also refuse, so the error can only make
 * the scan refuse-to-count, and the differential spec would catch that on any real document.
 */
function isNameStart(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z_:À-�]/.test(ch)
}

/** Index just past `marker`, or `-1`. */
function skipPast(text: string, from: number, marker: string): number {
  const at = text.indexOf(marker, from)
  return at === -1 ? -1 : at + marker.length
}

/**
 * End of a markup declaration (`<!DOCTYPE …>`, `<!ELEMENT …>`), honouring quotes and the
 * bracketed internal subset.
 *
 * The port rejects `<!DOCTYPE` outright before this scan ever sees it, so in the port's pipeline
 * this branch is unreachable for a doctype. It is still correct here because the adapter can be
 * driven directly — which is exactly what R-1's internal-entity test does — and because a scanner
 * whose correctness depends on an earlier gate is a scanner that breaks when the gate moves.
 */
function endOfMarkupDeclaration(text: string, from: number): number {
  let i = from
  let quote: string | null = null
  let inSubset = false
  while (i < text.length) {
    const ch = text[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '[') {
      inSubset = true
    } else if (ch === ']') {
      inSubset = false
    } else if (ch === '>' && !inSubset) {
      return i + 1
    }
    i += 1
  }
  return -1
}

/**
 * End of a start tag, and whether it closed itself.
 *
 * Quote tracking is the whole job: `<a href="a > b"/>` ends at the LAST `>`, and a scan that took
 * the first one would mis-nest everything after it.
 */
function endOfStartTag(text: string, from: number): { end: number; selfClosing: boolean } | null {
  let i = from
  let quote: string | null = null
  while (i < text.length) {
    const ch = text[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      const selfClosing = text[i - 1] === '/'
      // Stryker disable next-line ArithmeticOperator: `end` is consumed ONLY as the resume index for `text.indexOf('<', end)`, and `i` is a `>` — so starting the search at the `>` or just past it reaches the same next `<`. Proven by applying `i - 1` and running the suite: 331/331 still pass. The mutator cannot mask anything else on this line, which is why the `text[i - 1]` probe was lifted out above (it IS observable, and the self-closing cases kill it).
      return { end: i + 1, selfClosing }
    }
    i += 1
  }
  // `null`, not `{ end: -1, selfClosing: false }`. The old shape carried a `selfClosing` the
  // caller could never read — it tested `end === -1` and broke first — so the field was dead
  // weight that read as a considered value, and two mutants on it were unobservable by
  // construction. Deleting the construct beats explaining why it cannot be seen.
  return null
}

/**
 * Measure structure, stopping at the first breach of `budget`.
 *
 * Runs on the DECODED string, like the `<!DOCTYPE` check and for the same reason: a byte-level
 * scan of a UTF-16 document finds no markup at all and would report an empty structure.
 */
export function prescanStructure(text: string, budget: PrescanBudget): PrescanOutcome {
  let depth = 0
  let maxDepth = 0
  let elementCount = 0
  let i = 0

  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt === -1) break
    i = lt + 1
    const marker = text[i]

    if (marker === '?') {
      // Processing instruction, including the XML declaration. Its content is not markup.
      const next = skipPast(text, i + 1, '?>')
      if (next === -1) break
      i = next
      continue
    }

    if (marker === '!') {
      if (text.startsWith('--', i + 1)) {
        const next = skipPast(text, i + 3, '-->')
        if (next === -1) break
        i = next
        continue
      }
      if (text.startsWith('[CDATA[', i + 1)) {
        // CDATA content is literal text. `<item>` inside it is NOT an element, and counting it
        // would be the differential this scan exists to avoid.
        const next = skipPast(text, i + 8, ']]>')
        if (next === -1) break
        i = next
        continue
      }
      const next = endOfMarkupDeclaration(text, i + 1)
      if (next === -1) break
      i = next
      continue
    }

    if (marker === '/') {
      // `Math.max(0, …)`: an unbalanced close tag must not drive the counter negative and so
      // under-report the depth of what follows. The parser rejects such a document anyway.
      depth = Math.max(0, depth - 1)
      const next = skipPast(text, i + 1, '>')
      if (next === -1) break
      i = next
      continue
    }

    if (!isNameStart(marker)) {
      // A bare `<` in text. Not an element; keep scanning from just past it.
      continue
    }

    elementCount += 1
    depth += 1
    if (depth > maxDepth) maxDepth = depth

    if (depth > budget.maxDepth) {
      return { ok: false, exceeded: 'depth', maxDepth, elementCount }
    }
    if (elementCount > budget.maxElements) {
      return { ok: false, exceeded: 'elements', maxDepth, elementCount }
    }

    const tag = endOfStartTag(text, i + 1)
    if (tag === null) break
    if (tag.selfClosing) depth -= 1
    i = tag.end
  }

  return { ok: true, maxDepth, elementCount }
}
