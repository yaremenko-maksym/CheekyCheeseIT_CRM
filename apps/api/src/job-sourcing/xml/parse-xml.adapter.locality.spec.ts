/**
 * R-4: exactly ONE file in `apps/api/src` imports the XML parser.
 *
 * This is the property the whole two-layer design exists to provide — "replacement costs a new
 * adapter plus its conformance work, and zero adapter churn across ~25 call sites". It is also the
 * property most likely to erode silently: the second import is never added maliciously, it is
 * added by someone who needs one more thing from the library and does not know the seam is the
 * point. Nothing about the code would look wrong afterwards, and no other test in this directory
 * would notice.
 *
 * So it is asserted mechanically, over the source tree, with the file list named rather than
 * counted — a count would pass the day one legitimate importer is replaced by a different one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_NAME = '@rgrove/parse-xml'

/**
 * A MODULE SPECIFIER, not a mention.
 *
 * The first version of this spec matched the package name anywhere in the file, which made it a
 * test about PROSE: `bounded-xml-port.ts` and `namespaces.ts` both discuss the parser in their
 * header comments and were reported as importers. A test that goes red when someone explains the
 * design in a comment is worse than no test — it trains people to delete the explanation.
 *
 * Specifiers are quoted; prose in this codebase uses backticks. So the quoted form is the import,
 * and that distinction is what this regex encodes. It covers `from '…'`, `import('…')`,
 * `require('…')` and `vi.mock('…')` alike, because all four quote the specifier.
 */
const SPECIFIER = /['"]@rgrove\/parse-xml['"]/
const SRC = join(__dirname, '..', '..')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
    } else if (entry.endsWith('.ts')) {
      yield full
    }
  }
}

describe('R-4: the library is named in one place', () => {
  const importers = [...walk(SRC)]
    .filter((file) => SPECIFIER.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(SRC.length + 1).replace(/\\/g, '/'))
    .sort()

  it('POSITIVE CONTROL: the scan finds the importers it should', () => {
    // Without this, an empty result — a broken walk, a wrong root, a renamed package — would make
    // every assertion below pass for the wrong reason. That is the single most likely way a test
    // of this shape becomes decoration.
    expect(importers.length).toBeGreaterThan(0)
  })

  it('only the adapter and the two specs that must reach the library name it', () => {
    // Named rather than counted: a count of 3 would still pass the day a legitimate importer is
    // swapped for an illegitimate one.
    expect(importers).toEqual([
      // this file — it needs the name to search for it
      'job-sourcing/xml/parse-xml.adapter.locality.spec.ts',
      // the call-site spy — it must mock the real module to read the options actually passed
      'job-sourcing/xml/parse-xml.adapter.options.spec.ts',
      // the one production importer
      'job-sourcing/xml/parse-xml.adapter.ts',
    ])
  })

  it('exactly one NON-spec file imports it', () => {
    // The assertion that actually matters for a swap: specs may reach the library (the options
    // spy must mock it, the capability test must reach past the gates), production code may not.
    const production = importers.filter((file) => !file.endsWith('.spec.ts'))
    expect(production).toEqual(['job-sourcing/xml/parse-xml.adapter.ts'])
  })

  it('the dependency is pinned EXACTLY, and the installed copy is that version', () => {
    // A version in prose pins nothing. The ADR's verdict rests on one fact a minor release could
    // remove — the library never parses an internal subset — so it says "read the changelog before
    // any bump; do not bump on green CI". A caret range would let a minor arrive on a lockfile
    // refresh, silently, which is the opposite of that instruction.
    //
    // Both halves are asserted because they can diverge: the declaration is what a developer
    // reads, the installed copy is what runs.
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies[PACKAGE_NAME]).toBe('5.0.0')

    const installed = JSON.parse(
      readFileSync(join(SRC, '..', 'node_modules', '@rgrove', 'parse-xml', 'package.json'), 'utf8'),
    ) as { version: string; license: string }
    expect(installed.version).toBe('5.0.0')
    // The licence too: ISC is what the review cleared for a closed-source commercial product, and
    // a relicence on a future version is one of the things worth finding out about loudly.
    expect(installed.license).toBe('ISC')
  })

  it('the legacy DOU scanner is untouched by this adoption — C-20', () => {
    // rss.ts stays hand-rolled and DOU-only. Asserted here rather than trusted, because "we did
    // not touch it" is the kind of claim that is true until someone finds it convenient.
    const rss = readFileSync(join(SRC, 'job-sourcing', 'rss.ts'), 'utf8')
    expect(rss).not.toContain(PACKAGE_NAME)
    expect(rss).toContain('WHY HAND-ROLLED')
    // Its own caps stay its own. The XML port imports `MAX_FEED_BYTES` FROM here, which is the
    // intended direction — one number for one job — and the reverse would be a refactor of a
    // file this task may not refactor.
    expect(rss).toContain('export const MAX_FEED_BYTES = 2 * 1024 * 1024')
    expect(rss).toContain('export const MAX_ITEMS = 200')
  })
})
