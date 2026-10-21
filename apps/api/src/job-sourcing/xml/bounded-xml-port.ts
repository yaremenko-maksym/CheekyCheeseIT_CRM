/**
 * `XmlPort` as implemented: the five bounds, the decode, the `<!DOCTYPE` refusal, in that order.
 *
 * The ORDER is the contract, not an implementation detail, and two of the steps are placed where
 * they are because the obvious placement was measured to be wrong (R-3):
 *
 *   1. `maxBytes` on the RAW BYTES. The only bound that can run before decoding, and decoding is
 *      itself work proportional to the input.
 *   2. decode, fatally. `new TextDecoder(label)` is non-fatal by DEFAULT — `61 FF 62` becomes
 *      `a�b` in silence — and a feed invalid in its own declared encoding is drift, not
 *      content. See `decode.ts`.
 *   3. `<!DOCTYPE` refusal on the DECODED STRING. A byte-level check here is **bypassed by any
 *      UTF-16 feed**: its bytes are `3C 00 21 00 44 00 …` and contain no ASCII `<!DOCTYPE` to
 *      match. The check would look sound and stop nothing.
 *   4. structural pre-scan — depth, element count, and the wall-clock budget spent as elements.
 *   5. parse.
 *   6. reconcile the pre-scan against the real tree, and raise `PRESCAN_DIFFERENTIAL` on a
 *      disagreement. The pre-scan bounds attacker-controlled input, so a scanner that under-counts
 *      is a bound that is not enforced; this makes that failure loud instead of invisible.
 *
 * WHAT THE DOCTYPE REFUSAL DOES AND DOES NOT BUY — do not flatten this.
 * ---------------------------------------------------------------------
 * It is defence in depth, NOT the thing that stops XXE. What stops XXE is that `@rgrove/parse-xml`
 * never parses an internal subset (so no entity is ever declared) and ships no I/O capability at
 * all (measured: `dist/` references no `fs`/`http`/`https`/`net`/`dns`/`tls`/`child_process`).
 * The refusal exists so a future parser swap cannot quietly reintroduce DTD processing through
 * this port — and because a feed carrying a DTD is a feed doing something no job board needs to do.
 *
 * The honest limit of the refusal, stated because the ADR insists on it: parse-xml *accepts*
 * parameter-entity and external-DTD-only documents — they parse, nothing is dereferenced, the
 * network canary recorded zero hits across all 78 runs. Inert acceptance is not a vulnerability,
 * but it means "XXE is refused" is a claim about WHICH document was tested. The capability test
 * that does not depend on this gate is R-1's internal-entity case, which runs against the adapter
 * directly, with this refusal bypassed.
 */

import { decodeXml } from './decode'
import { parseXmlString } from './parse-xml.adapter'
import { prescanStructure } from './prescan'
import { DEFAULT_XML_LIMITS, elementCeiling } from './xml-limits'
import type { XmlDocument, XmlLimits, XmlPort } from './xml-port'
import { XmlPortError } from './xml-port'
import { measureTree } from './xml-tree'

/**
 * Case-insensitively, because `<!doctype` is as effective as `<!DOCTYPE` and XML's own grammar is
 * case-sensitive here only by accident of nobody trying.
 */
const DOCTYPE_PATTERN = /<!doctype/i

export class BoundedXmlPort implements XmlPort {
  parseDocument(bytes: Uint8Array, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlDocument {
    if (bytes.byteLength > limits.maxBytes) {
      throw new XmlPortError(
        'TOO_MANY_BYTES',
        `XML body is ${bytes.byteLength} bytes, over the ${limits.maxBytes} byte cap`,
      )
    }

    const decoded = decodeXml(bytes)

    if (DOCTYPE_PATTERN.test(decoded.text)) {
      throw new XmlPortError(
        'DOCTYPE_FORBIDDEN',
        'XML carries a <!DOCTYPE> declaration, which this port refuses',
      )
    }

    const { ceiling, boundBy } = elementCeiling(limits)
    const prescan = prescanStructure(decoded.text, {
      maxDepth: limits.maxDepth,
      maxElements: ceiling,
    })

    if (!prescan.ok) {
      if (prescan.exceeded === 'depth') {
        throw new XmlPortError(
          'TOO_DEEP',
          `XML nests deeper than ${limits.maxDepth} elements (reached ${prescan.maxDepth})`,
        )
      }
      // Which bound bit decides the reason, so a caller can tell "too big to store" from "too big
      // to parse in the time we allow" — the fixes are different, and so is who raises the limit.
      throw boundBy === 'time'
        ? new XmlPortError(
            'TIME_BUDGET',
            `XML has more than ${ceiling} elements, the most a ${limits.maxWallClockMs} ms parse budget affords`,
          )
        : new XmlPortError('TOO_MANY_ELEMENTS', `XML has more than ${limits.maxElements} elements`)
    }

    const parsed = parseXmlString(decoded.text)
    const actual = measureTree(parsed.root)

    if (actual.maxDepth !== prescan.maxDepth || actual.elementCount !== prescan.elementCount) {
      throw new XmlPortError(
        'PRESCAN_DIFFERENTIAL',
        `pre-scan measured depth ${prescan.maxDepth}/${prescan.elementCount} elements but the parsed tree has ${actual.maxDepth}/${actual.elementCount}`,
      )
    }

    return {
      root: parsed.root,
      // The PARSER's reading of the declaration, not the decoder's.
      //
      // This was `parsed.declaredEncoding ?? decoded.declaredEncoding`, and the mutation gate was
      // right to flag it: both sides read the same declaration from the same decoded string, so
      // the fallback was unreachable and no input could distinguish `??` from `&&`. Dead logic
      // reads as a considered fallback, which is worse than its absence. The parser's structured
      // reading is the one to keep — `decode.ts` still reads the declaration itself, but for the
      // BOM-conflict check, which is internal to it.
      declaredEncoding: parsed.declaredEncoding,
      effectiveEncoding: decoded.effectiveEncoding,
      depth: actual.maxDepth,
      elementCount: actual.elementCount,
    }
  }
}

/** The port, ready to use. A class so a test can hold its own instance without module state. */
export const xmlPort: XmlPort = new BoundedXmlPort()
