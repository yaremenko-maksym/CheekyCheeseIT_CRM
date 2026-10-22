/**
 * `@xmldom/xmldom`'s advisory batch as a fuzz list — R-5's last unfinished sentence (SPEC-M-3).
 *
 * WHY THIS PACKAGE'S ADVISORIES AND NOT A GENERIC ATTACK LIST
 * ----------------------------------------------------------
 * `@xmldom/xmldom` is the worst row of the dependency review's table — **22 non-withdrawn
 * advisories, one CRITICAL and 18 HIGH**, the largest set any XML parser in the comparison carries,
 * and the reason this repository already pins `@xmldom/xmldom: ">=0.8.15 <0.9.0"` in
 * `pnpm.overrides`. It is therefore the closest thing to a real-world record of how XML parsers
 * actually fail, as opposed to how we imagine they fail. R-5 measured ten growth shapes and said
 * plainly what that was worth: "this is a probe, not a proof — it is ten shapes, not a fuzzer.
 * 2.4 should commit these shapes to the corpus and add xmldom's advisory batch as a fuzz list."
 * The shapes landed in `GROWTH_SHAPES`; the fuzz list did not, and this is it.
 *
 * TWO HALVES, BECAUSE A "FUZZ LIST" ALONE WOULD BE EITHER CHECKLIST OR NOISE
 * -------------------------------------------------------------------------
 * 1. **A verdict per advisory class.** Each of the seven classes in the review's table gets a named
 *    block saying what this port does about it, including the two classes where the honest answer
 *    is "not applicable, and here is why" — an advisory a port structurally cannot have is worth
 *    recording as such, because the alternative is a reader later assuming it was missed.
 * 2. **Seeded mutation fuzzing over the corpus.** A hand-written list only ever finds what its
 *    author thought of; the thing a fuzzer adds is inputs nobody designed. The property asserted
 *    is the one that must hold for EVERY byte string in the universe:
 *
 *        parseDocument either returns a document that honours the bounds,
 *        or throws an XmlPortError carrying a known reason.
 *
 *    Never a raw `@rgrove/parse-xml` error, never a `RangeError` from the stack, never a
 *    `TypeError` from a prefix that happens to name an inherited member, never a hang. That
 *    property is what makes the reason codes a contract instead of a hope, and it is what a swap
 *    to another parser would have to preserve.
 *
 * DETERMINISTIC ON PURPOSE. The generator is a seeded xorshift, the seeds are literals, and the
 * run is therefore identical on every machine and in every CI job. A nondeterministic fuzzer in a
 * required check is a flake generator — it fails for one person, passes on re-run, and gets
 * disabled within a month. The cost of determinism is that it explores the same space every time;
 * the way to explore more is to add a seed to the list, deliberately, in a reviewed diff.
 */

import { describe, expect, it } from 'vitest'
import { fixtureText, utf8, WELL_FORMED_FIXTURES } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { DEFAULT_XML_LIMITS, itemCeiling } from './xml-limits'
import type { XmlFailureReason, XmlLimits } from './xml-port'
import { XmlPortError } from './xml-port'

const port = new BoundedXmlPort()

/** Every reason the port is allowed to fail with. A reason outside this set is a contract break. */
const KNOWN_REASONS: readonly XmlFailureReason[] = [
  'TOO_MANY_BYTES',
  'UNSUPPORTED_ENCODING',
  'UNDECODABLE',
  'ENCODING_CONFLICT',
  'DOCTYPE_FORBIDDEN',
  'TOO_DEEP',
  'TOO_MANY_ELEMENTS',
  'TIME_BUDGET',
  'MALFORMED',
  'UNDECLARED_PREFIX',
  'MALFORMED_QNAME',
  'PREFIX_UNDECLARING',
  'RESERVED_NAMESPACE',
  'DUPLICATE_ATTRIBUTE',
  'PRESCAN_DIFFERENTIAL',
]

/**
 * The property. Returns the reason, or `null` for a document that parsed.
 *
 * `PRESCAN_DIFFERENTIAL` is in `KNOWN_REASONS` but is asserted against separately below: it is an
 * INTERNAL invariant failure, not a property of the input, so a fuzzer finding one has found a bug
 * in our scanner rather than a hostile document. Allowing it here and forbidding it there is the
 * difference between "the port did not crash" and "the port is correct".
 */
function outcomeOf(
  bytes: Uint8Array,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): XmlFailureReason | null {
  let thrown: unknown
  try {
    const document = port.parseDocument(bytes, limits)
    // A returned document must honour the bounds it claims to enforce. A fuzzer that only checked
    // "did not throw" would accept a port whose bounds silently stopped applying — which is the
    // defect this whole review round has been about.
    expect(document.depth).toBeLessThanOrEqual(limits.maxDepth)
    expect(document.elementCount).toBeLessThanOrEqual(itemCeiling(limits))
    expect(document.elementCount).toBeGreaterThan(0)
    expect(typeof document.effectiveEncoding).toBe('string')
    return null
  } catch (error) {
    thrown = error
  }
  // The contract: an XmlPortError with a known reason, and nothing else. `instanceof` rather than
  // a duck-check on `.reason`, so a plain object shaped like one does not satisfy it.
  if (!(thrown instanceof XmlPortError)) {
    throw new Error(
      `parseDocument leaked a non-port error: ${String((thrown as Error)?.name)}: ${String((thrown as Error)?.message)}`,
    )
  }
  expect(KNOWN_REASONS).toContain(thrown.reason)
  expect(thrown.message.length).toBeGreaterThan(10)
  return thrown.reason
}

// ---------------------------------------------------------------------------------------------
// Half one: a verdict for each advisory class in the dependency review's table.
// ---------------------------------------------------------------------------------------------

describe('class 1 of 7 — DocType NAME injection (the CRITICAL one)', () => {
  // xmldom's critical advisory is a `<!DOCTYPE>` name carrying content that escapes on
  // serialization. This port's answer is structural and total: `<!DOCTYPE` is refused on the
  // DECODED string before the parser is reached, so there is no doctype to inject into. That
  // makes this the one advisory class the port is immune to by construction rather than by care.
  it.each([
    ['a plain doctype', '<!DOCTYPE r><r/>'],
    ['a doctype name with a quote', '<!DOCTYPE "r"><r/>'],
    ['a doctype name with markup in it', '<!DOCTYPE r><!--><r/>'],
    ['a doctype with an internal subset', '<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>'],
    ['lowercase', '<!doctype r><r/>'],
    ['mixed case', '<!DocType r><r/>'],
    ['leading whitespace and a declaration', '<?xml version="1.0"?>\n  <!DOCTYPE r>\n<r/>'],
    ['a doctype after a comment', '<!--c--><!DOCTYPE r><r/>'],
  ])('%s is refused on the doctype, before any parse', (_case, xml) => {
    expect(outcomeOf(utf8(xml))).toBe('DOCTYPE_FORBIDDEN')
  })

  it('a doctype hidden by UTF-16 is still refused — the check is on the decoded text', () => {
    // The byte-level version of this check is the one that misses: `<!DOCTYPE` in UTF-16LE shares
    // no byte sequence with its ASCII form.
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...[...'<!DOCTYPE r><r/>'].flatMap((c) => [c.charCodeAt(0), 0]),
    ])
    expect(outcomeOf(utf16)).toBe('DOCTYPE_FORBIDDEN')
  })
})

describe('class 2 of 7 — serialization injection (5 advisories): NOT APPLICABLE, and why', () => {
  // Five of xmldom's advisories — attribute, element, PI, comment and CDATA serialization
  // injection — are all failures of WRITING XML out, reached through xmldom's serializer and its
  // `requireWellFormed` option. This port has no serializer: `XmlPort` exposes `parseDocument` and
  // nothing else, and the neutral tree is consumed by adapters that emit vacancy records, not XML.
  //
  // So the verdict is "structurally absent", and the assertion that keeps that verdict honest is
  // about the SEAM rather than about any document: if a serializer is ever added to this port,
  // five advisories' worth of attack surface arrives with it, and this test is where a reader
  // finds that out. The parse-side halves of the same shapes are fuzzed in half two.
  it('the port surface is parse-only, so there is no serializer to inject into', () => {
    const surface = Object.getOwnPropertyNames(BoundedXmlPort.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(surface).toEqual(['parseDocument'])
  })

  it('the parse side of the same five shapes stays inside the contract', () => {
    // A terminator sequence embedded in each construct — the content that, re-serialized naively,
    // would break out of it. Here they are only required to produce a document or a known reason.
    for (const xml of [
      '<r a="]]&gt;"/>',
      '<r><![CDATA[a]]]]><![CDATA[>b]]></r>',
      '<r><!--a--b--></r>',
      '<r><?pi ?&gt; ?></r>',
      '<r a="&lt;/r&gt;"/>',
      '<r a="--&gt;"/>',
    ]) {
      expect(() => outcomeOf(utf8(xml))).not.toThrow()
    }
  })
})

describe('class 3 of 7 — quadratic attribute deduplication', () => {
  // xmldom deduplicated attributes in O(n²). The port's answer is the item ceiling: the attribute
  // count is now charged against the wall-clock budget before the parser sees the document, so a
  // tag cannot carry enough attributes for the cost of deduplicating them to matter.
  it('a repeated attribute NAME is refused rather than deduplicated', () => {
    expect(outcomeOf(utf8(`<r ${'a="1" '.repeat(50)}/>`))).toBe('MALFORMED')
  })

  it('the attribute count itself is bounded, so n is bounded before any n² can be paid', () => {
    // SHRUNK LIMITS, not a 25 000-attribute document. The branch is identical and the input is
    // 300 bytes instead of 300 KB — and that matters beyond tidiness: the first version of this
    // file built multi-megabyte inputs here and in two tests below, which added enough parallel
    // CPU load to make `growth.spec.ts`'s exponent assertions fail 3 runs out of 3. A correctness
    // fuzzer has no business competing with the suite's only timing-sensitive file. The real
    // magnitudes are pinned where they belong, against the real constants, in `xml-limits.spec.ts`.
    const limits = { ...DEFAULT_XML_LIMITS, maxWallClockMs: 0.3 } // itemCeiling = 30
    expect(itemCeiling(limits)).toBe(30)
    const attributes = Array.from({ length: 31 }, (_, k) => `a${k}="v"`).join(' ')
    expect(outcomeOf(utf8(`<r ${attributes}/>`), limits)).toBe('TIME_BUDGET')
    // And at the ceiling it passes, so the bound is a limit rather than a wall.
    const atCeiling = Array.from({ length: 29 }, (_, k) => `a${k}="v"`).join(' ')
    expect(outcomeOf(utf8(`<r ${atCeiling}/>`), limits)).toBeNull()
  })

  it('and an ordinary number of attributes is still accepted', () => {
    // The acceptance side: a bound that refuses every attribute would satisfy both tests above.
    expect(
      outcomeOf(utf8(`<r ${Array.from({ length: 64 }, (_, k) => `a${k}="v"`).join(' ')}/>`)),
    ).toBeNull()
  })
})

describe('class 4 and 5 of 7 — quadratic-time parsing and quadratic memory', () => {
  // R-5 fitted growth exponents for these (worst 1.36, which is allocation and GC rather than
  // backtracking) and `growth.spec.ts` keeps that measurement. What belongs HERE is the other
  // half: that the bounds hold at the point where a quadratic cost would be paid, whatever the
  // exponent turns out to be on a future parser version. A bound is cheaper than an exponent.
  // Shrunk limits again, same branches, kilobyte inputs — see the note in class 3.
  it.each([
    [
      'many siblings past the item ceiling',
      (n: number) => `<r>${'<i/>'.repeat(n)}</r>`,
      'TIME_BUDGET',
    ],
    [
      'nesting past the depth cap',
      (n: number) => `${'<a>'.repeat(n)}x${'</a>'.repeat(n)}`,
      'TOO_DEEP',
    ],
  ])('%s is refused with %s regardless of growth exponent', (_case, build, reason) => {
    const limits = { ...DEFAULT_XML_LIMITS, maxWallClockMs: 1, maxDepth: 20 } // itemCeiling = 100
    expect(outcomeOf(utf8(build(300)), limits)).toBe(reason as XmlFailureReason)
  })

  it('adjacent text runs are bounded by the byte cap, and ONLY by it', () => {
    // The quadratic-memory shape that is NOT item-shaped: one element, a long text run, zero
    // attributes. This is the residue of SPEC-M-2 made concrete — the item ceiling says nothing
    // about this document, so the byte cap is the whole bound, and the pair below is it.
    //
    // The REAL 2 MiB magnitudes live in `xml-limits.spec.ts`; here the cap is shrunk so the point
    // is made in kilobytes. (The first draft used the real cap and wrongly expected a refusal at
    // 2 000 007 bytes, which is INSIDE a 2 097 152 byte cap — the one-sidedness this file warns
    // about, appearing in the file itself. Hence the acceptance assertion first, below.)
    const limits = { ...DEFAULT_XML_LIMITS, maxBytes: 4_096 }
    const body = (n: number) => utf8(`<r>${'x y '.repeat(n)}</r>`)
    expect(body(1_000).byteLength).toBeLessThanOrEqual(limits.maxBytes)
    expect(outcomeOf(body(1_000), limits)).toBeNull()
    expect(outcomeOf(body(1_100), limits)).toBe('TOO_MANY_BYTES')
  })
})

describe('class 6 of 7 — the two ReDoS advisories', () => {
  // The shape behind xmldom's PI-grammar ReDoS is an unterminated construct: a parser that scans
  // to end of input looking for a terminator, repeatedly. parse-xml rejects each in
  // sub-millisecond time (R-5), and the port now refuses an unterminated START TAG before the
  // parser at all. These assert the outcome rather than the timing, because a timing assertion on
  // a shared runner is a flake — the timings live in `growth.spec.ts`, which fits exponents.
  it.each([
    ['unterminated PI', '<r><?pi'],
    ['unterminated comment', '<r><!--'],
    ['unterminated CDATA', '<r><![CDATA['],
    ['unterminated markup declaration', '<r><!ENTITY'],
    ['unterminated start tag', '<r><i'],
    ['unterminated attribute value', '<r><i a="'],
    ['unterminated end tag', '<r><i/></i'],
    ['a PI whose terminator is split', '<r><?pi ?'],
    ['nothing but an opening angle bracket', '<'],
    ['an endless run of opening brackets', '<'.repeat(100_000)],
    ['an endless run of question marks after a PI open', `<?${'?'.repeat(100_000)}`],
    ['an endless run of dashes after a comment open', `<!--${'-'.repeat(100_000)}`],
  ])('%s terminates with a known reason', (_case, xml) => {
    const reason = outcomeOf(utf8(xml))
    expect(reason).not.toBeNull()
  })
})

describe('class 7 of 7 — recursion DoS', () => {
  // xmldom's recursion advisory is the stack. The port's bound is its own (`MAX_XML_DEPTH`),
  // deliberately not V8's, because the cliff moved between machines and SIGSEGVs under
  // `--stack-size`. The test that matters is that a document far past the cliff comes back as OUR
  // refusal rather than a `RangeError` — which is precisely what `outcomeOf` refuses to accept.
  it.each([200, 6_000, 60_000])('nesting %i deep is our refusal, never a RangeError', (depth) => {
    expect(outcomeOf(utf8(`${'<a>'.repeat(depth)}x${'</a>'.repeat(depth)}`))).toBe('TOO_DEEP')
  })

  it('and nesting inside the cap is accepted, so the bound is a limit and not a wall', () => {
    expect(
      outcomeOf(
        utf8(
          `${'<a>'.repeat(DEFAULT_XML_LIMITS.maxDepth)}x${'</a>'.repeat(DEFAULT_XML_LIMITS.maxDepth)}`,
        ),
      ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Half two: seeded mutation fuzzing. The part that finds what nobody listed.
// ---------------------------------------------------------------------------------------------

/** xorshift32. Chosen because it is four lines and reproduces identically everywhere. */
function rng(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

/**
 * Fragments spliced in by the mutator, drawn from the advisory classes above.
 *
 * This is where the two halves meet: the generator is blind, but the alphabet it splices from is
 * the real advisory record, so the inputs are nonsense ASSEMBLED FROM the shapes that have
 * actually broken XML parsers. Pure byte noise would mostly produce `MALFORMED` and prove little.
 */
const FRAGMENTS: readonly string[] = [
  '<!DOCTYPE r>',
  '<![CDATA[',
  ']]>',
  '<!--',
  '-->',
  '<?pi?>',
  '<?',
  '?>',
  '&amp;',
  '&undefined;',
  '&#x41;',
  'xmlns=""',
  'xmlns:p=""',
  'xmlns:xml="http://example.com/x"',
  'xmlns:="x"',
  'xmlns:__proto__="x"',
  'constructor:a="1"',
  'a:b:c="1"',
  'xmlns:a="u" xmlns:b="u" a:x="1" b:x="2"',
  '/>',
  '>',
  '<',
  '"',
  "'",
  '=',
  ':',
  '\u0000',
  '￾',
  '\uD800',
  'é',
  'я',
]

function mutate(source: string, random: () => number): string {
  const edits = 1 + Math.floor(random() * 6)
  let text = source
  for (let edit = 0; edit < edits; edit += 1) {
    const at = Math.floor(random() * (text.length + 1))
    const roll = random()
    if (roll < 0.45) {
      // splice a fragment in
      const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] as string
      text = text.slice(0, at) + fragment + text.slice(at)
    } else if (roll < 0.75) {
      // delete a run — this is what produces truncated and unterminated constructs
      text = text.slice(0, at) + text.slice(at + 1 + Math.floor(random() * 32))
    } else {
      // duplicate a run — this is what produces repetition and growth
      const run = text.slice(at, at + 1 + Math.floor(random() * 16))
      text = text.slice(0, at) + run.repeat(1 + Math.floor(random() * 8)) + text.slice(at)
    }
  }
  return text
}

describe('seeded mutation fuzzing over the corpus', () => {
  // 5 fixtures x 4 seeds x 40 mutants = 800 inputs. Sized to run in a second or two: a fuzz pass
  // nobody waits for is a fuzz pass somebody deletes.
  const SEEDS = [0x5eed_1, 0x5eed_2, 0xf00d, 0x1234_5678]

  it.each(WELL_FORMED_FIXTURES)('mutants of %s all land inside the contract', (fixture) => {
    const source = fixtureText(fixture)
    const reasons = new Map<string, number>()
    let parsed = 0

    for (const seed of SEEDS) {
      const random = rng(seed)
      for (let mutant = 0; mutant < 40; mutant += 1) {
        const text = mutate(source, random)
        // `outcomeOf` IS the assertion — it throws on a leaked non-port error, on an unknown
        // reason, and on a returned document that violates a bound.
        const reason = outcomeOf(utf8(text))
        if (reason === null) parsed += 1
        else reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
        // The internal invariant. A hostile document is allowed to be refused for any of the
        // input-shaped reasons; it is NOT allowed to make our pre-scan disagree with the parser,
        // because that would mean the bound could be turned off by a shaped input. This is the
        // single most valuable line in the file.
        expect(reason).not.toBe('PRESCAN_DIFFERENTIAL')
      }
    }

    // The fuzzer must actually be exercising the parser rather than bouncing off one early check.
    // Without this, a mutator that happened to put `<!DOCTYPE` in every input would report 160
    // green cases and have tested the doctype branch 160 times.
    expect(reasons.size + (parsed > 0 ? 1 : 0)).toBeGreaterThanOrEqual(3)
    expect(parsed + [...reasons.values()].reduce((a, b) => a + b, 0)).toBe(SEEDS.length * 40)
  })

  it('the mutator produces genuinely different inputs for different seeds', () => {
    // A seeded fuzzer whose seed does nothing is 800 runs of one input. Cheap to check, and the
    // kind of thing that rots silently.
    const source = fixtureText('positive-control.xml')
    const first = mutate(source, rng(1))
    const second = mutate(source, rng(2))
    expect(first).not.toBe(second)
    expect(first).not.toBe(source)
  })

  it('every fixture in the corpus is reachable as a fuzz seed', () => {
    // Guards the loop above against a fixture list that silently empties.
    expect(WELL_FORMED_FIXTURES.length).toBeGreaterThanOrEqual(5)
    for (const fixture of WELL_FORMED_FIXTURES) {
      expect(fixtureText(fixture).length).toBeGreaterThan(0)
    }
  })
})

/**
 * SPEC-M-1 — NOT CLOSED, and this is the comment the review asked be left where someone will meet
 * it rather than in a PR body nobody re-reads.
 *
 * Of the fixtures this file fuzzes, only the DOU feed is an AUTHENTIC capture. `boards-synthetic
 * .xml` is named for what it is, and the Djinni / WeWorkRemotely / EU-board shapes it stands in for
 * are hand-written from each board's documented feed format, not fetched from it. So the corpus
 * proves the port handles the shapes we BELIEVE those boards emit, which is a weaker claim than the
 * one a reader may assume from a passing fuzz run.
 *
 * Closing the gap needs outbound GET requests to live job boards. That is an external send, which
 * under `.claude/rules/common/autonomy-levels.md` is A3 — irreversible, requiring the owner's
 * explicit authorisation — and it **has not been given**. So the gap stays open, deliberately, and
 * is recorded here and in the PR body as *authentic feeds pending owner authorisation*. It is not
 * a defect in this file and must not be closed by inventing more synthetic fixtures, which would
 * grow the corpus without growing the evidence.
 */
