# XML parser dependency review for `RssProvider` (vacancy sourcing Task 2.4)

**Date:** 2026-10-20 · **Why:** `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`
Task 2.4 requires a "maintained XML/REP parser after dependency/license review"; if rejected, the
RSS/Atom adapters stay blocked. ~25 adapters inherit this choice.
**Shelf life:** recheck **2027-04-20**, or immediately on any of the invalidation signals in
"Expiry and what invalidates this".

## Verdict

**Adopt `@rgrove/parse-xml@5.0.0` (ISC).** Not rejected.

The decisive fact is a **capability argument**, and it holds under every configuration: **XXE and
entity expansion are unreachable in parse-xml for two independent reasons, neither of which an
option can switch on.**

1. **The internal subset is never parsed**, so no entity is ever _declared_. The parser consumes a
   `<!DOCTYPE>` declaration and discards it without reading its contents. There is consequently
   nothing to expand and no system identifier to dereference, whatever the options say.
2. **The package has no I/O capability to abuse.** `dist/` references no `fs`, `http`, `https`,
   `net`, `dns`, `tls` or `child_process` — so even a configuration that substitutes text for an
   entity cannot make the library read a file or open a socket.

Measured: all four attack documents fail with `Named entity isn't defined`, and the network canary
recorded **0 hits across all 78 parser×case runs**.

**This is deliberately _not_ phrased as "no option can resolve an entity", because that weaker
claim is false and was falsified during review.** Two of the eight options do bear on entities:
`resolveUndefinedEntity` substitutes text for an entity from a **caller-supplied** function, and
`ignoreUndefinedEntities: true` turns the refusal into silent pass-through. Both are pinned in
"The exact configuration to adopt" below, and the reason the capability argument survives them is
visible in the measurement:

```
bomb  default        => THREW: Named entity isn't defined: &lol3;
bomb  ignoreUndef    => OK, text: "&lol3;"            # literal, nothing expanded
bomb  resolver-evil  => OK, text: "XXXXXXXXXX"        # 10 chars, NOT exponential
xxe   default        => THREW: Named entity isn't defined: &x;
xxe   ignoreUndef    => OK, text: "&x;"               # literal, no file read
xxe   resolver-evil  => OK, text: "RESOLVER-SUPPLIED" # the caller's own string
```

The billion-laughs row is the proof: with a hostile resolver the bomb yields **ten characters, not
an exponential blow-up**, because the nested `<!ENTITY>` declarations were never parsed and so
there is no recursion to drive. And the XXE row returns only what the caller's own function
returned — the library never touched the filesystem. To get XXE out of parse-xml, the caller would
have to write a file-reading resolver, i.e. implement the vulnerability itself. That is a wrapper
invariant, which is where it is closed.

`fast-xml-parser@5.11.2` (MIT) is a **viable second** and is kept as the documented fallback
adapter — it also refused XXE on evidence. It is not first choice for two measured reasons, not
reputation: entity expansion is a _feature that is enabled by default_ (`processEntities: true`)
and bounded only by numeric limits that a future edit can raise, and it **silently accepts a
truncated feed** where the plan requires "malformed feed = drift".

---

## Candidates and why each survived or fell

Licence read from the `LICENSE` file inside the installed package, not from the npm page.
Release data from `npm view <pkg> time --json` on 2026-10-20.

| Package             | Version | SPDX (read in)                                     | Last release | Releases since 2024 | Native bindings   | Deps                    | Install size | Outcome                                        |
| ------------------- | ------- | -------------------------------------------------- | ------------ | ------------------- | ----------------- | ----------------------- | ------------ | ---------------------------------------------- |
| `@rgrove/parse-xml` | 5.0.0   | **ISC** (`node_modules/@rgrove/parse-xml/LICENSE`) | 2026-08-30   | 5                   | no                | **0**                   | 396 KB       | **ADOPTED**                                    |
| `fast-xml-parser`   | 5.11.2  | **MIT** (`node_modules/fast-xml-parser/LICENSE`)   | 2026-09-29   | 72                  | no                | 6 direct / 7 transitive | 1.4 MB       | fallback adapter                               |
| `sax`               | 1.6.1   | **BlueOak-1.0.0** (`LICENSE.md`)                   | 2026-07-24   | 8                   | no                | 0                       | 72 KB        | rejected — error-tolerant by design            |
| `@xmldom/xmldom`    | 0.9.12  | **MIT** (`LICENSE`)                                | 2026-08-23   | 18                  | no                | 0                       | 452 KB       | rejected — slowest, lax                        |
| `saxes`             | 6.0.0   | ISC                                                | 2022-05-17   | **0**               | no                | 1                       | 164 KB       | rejected — maintenance lapse                   |
| `xml2js`            | 0.6.2   | MIT                                                | 2024-05-31   | 0 since 2024-05     | no                | 2                       | 3.4 MB       | rejected — effectively unmaintained            |
| `htmlparser2`       | 12.0.0  | MIT                                                | 2026-03-20   | 5                   | no                | 4                       | 235 KB       | rejected — HTML error recovery, not strict XML |
| `libxmljs2`         | 0.37.0  | MIT                                                | 2025-06-01   | 2                   | **yes (libxml2)** | 3                       | 7.2 MB       | rejected — see below                           |
| `node-xml-stream`   | 1.0.2   | MIT                                                | 2022-05-11   | 0                   | no                | —                       | —            | rejected — abandoned                           |
| `xml-stream`        | 0.4.5   | _none declared_                                    | 2024-11-04   | 0                   | yes (expat)       | —                       | —            | rejected — no licence field, native            |

**No copyleft appeared.** ISC, MIT and BlueOak-1.0.0 are all permissive and compatible with a
closed-source commercial product. `fast-xml-parser`'s 7 transitive packages are each MIT
(`@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `strnum`,
`anynum`, `xml-naming`), verified by reading each `package.json` `license` field. `xml-stream`
declares **no licence at all**, which is a rejection on its own — absent a grant, the default is
"no permission".

**`libxmljs2` rejected on the native-bindings liability, stated rather than argued:** it compiles
libxml2 from source via `node-gyp` unless a prebuild matches. That puts a C toolchain on the
critical path of every CI run and every Docker image build, couples us to libxml2's own CVE
stream (the busiest XXE/entity CVE surface in this whole list), and its 2 releases in ~2 years is
thin cover for that exposure. A pure-JS parser that we can bound ourselves is the cheaper risk.

**Advisories — queried directly against the GitHub Advisory Database**, not only via `npm audit`:

```bash
gh api graphql -f query='{ securityVulnerabilities(ecosystem: NPM,
  package: "@rgrove/parse-xml", first: 20) { nodes { advisory { ghsaId severity
  publishedAt } vulnerableVersionRange firstPatchedVersion { identifier } } } }'
→ {"data":{"securityVulnerabilities":{"nodes":[]}}}
```

**`@rgrove/parse-xml`: zero advisories, ever.** The same query for the fallback is the opposite
picture and is material to the decision rather than decoration:

| Package             | Distinct GHSAs                 | Worst severity                       | Most recent                                 | Affects                           |
| ------------------- | ------------------------------ | ------------------------------------ | ------------------------------------------- | --------------------------------- |
| `@rgrove/parse-xml` | **0**                          | —                                    | —                                           | —                                 |
| `fast-xml-parser`   | **13** (17 version-range rows) | **CRITICAL** (`GHSA-m7jm-9gc2-mpf2`) | `GHSA-8r6m-32jq-jx6q`, HIGH, **2026-07-21** | `>=5.9.3 <5.10.1`, patched 5.10.1 |

Three consequences, stated rather than buried:

1. **It reframes fast-xml-parser's release cadence.** Above I recorded 72 releases since 2024 as a
   health signal; the advisory history shows a good part of that churn is **security response**,
   including nine advisories in 2026 alone. High cadence here means "frequently found vulnerable",
   not simply "actively maintained".
2. **The chosen fallback version is patched** — 5.11.2 is past 5.10.1 — but if the
   `FastXmlParserAdapter` is ever activated, it must be **re-pinned at activation time**, not
   adopted at the version recorded in this document.
3. **It independently supports the verdict.** The parser with no DTD machinery has no advisory
   history; the parser with DTD and entity machinery has thirteen. That is the capability argument
   showing up in the historical record.

`npm audit` over the installed set separately reported **`found 0 vulnerabilities`**
(fast-xml-parser 5.11.2, @rgrove/parse-xml 5.0.0, sax 1.6.1, @xmldom/xmldom 0.9.12 and all
transitives). Note the repo already pins `@xmldom/xmldom: ">=0.8.15 <0.9.0"` in
`pnpm.overrides` — a historical response to that package's advisory history, and context for
preferring a parser with no DTD machinery at all.

---

## The measurement that actually decided it

Measured, not read. Scratch install outside the repository; nothing added to any repo
`package.json`. Node **22.23.1** (the project pin is `node >=22.19 <23`).

Harness: one child process per (parser, case) pair so a heap death is observable as a signal
rather than inferred, a 20 s SIGKILL per pair, and a **local HTTP server as a network canary** —
one XXE document points its external entity at `http://127.0.0.1:<port>/pwned`, so any
dereference is recorded as a connection rather than guessed at. A file-pointing XXE targets a
canary file containing `TOP-SECRET-CANARY-7f3a9b`, and every returned value is scanned for that
string.

```
node runner/matrix.mjs          # 6 configurations × 13 documents = 78 runs
```

**Total canary hits across all 78 runs: `0`. No returned value ever contained the canary string.**

### Security cases

| Document                        | `@rgrove/parse-xml`                            | `fast-xml-parser` (default)                                              | `fast-xml-parser` (hardened)       |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| XXE → `file://` canary          | **threw** `Named entity isn't defined: &xxe;`  | **threw** `External entities are not supported`                          | **threw** same                     |
| XXE → `http://` canary          | **threw** same, **0 net hits**                 | **threw** same, **0 net hits**                                           | **threw** same, 0 net hits         |
| billion laughs (9 levels)       | **threw** `Named entity isn't defined: &lol9;` | returned `&lol9;` **unexpanded**                                         | returned `&lol9;` unexpanded       |
| quadratic blowup (50 KB × 2000) | **threw** `Named entity isn't defined: &a;`    | **threw** `Entity "a" size (50000) exceeds maximum allowed size (10000)` | returned `&a;` literal, unexpanded |

Both candidates refuse XXE **on evidence**. The difference is _why_, and that is the decision:

- **parse-xml** never parses a DTD. From its own shipped source, `Parser.d.ts`:
  _"This is a loose implementation since doctype declarations are currently discarded without
  further parsing."_ Its complete option surface is `ignoreUndefinedEntities`, `includeOffsets`,
  `preserveCdata`, `preserveComments`, `preserveDocumentType`, `preserveXmlDeclaration`,
  `resolveUndefinedEntity`, `sortAttributes`. **Two of these eight do affect entity handling** —
  `resolveUndefinedEntity` substitutes caller-supplied text for an entity, and
  `ignoreUndefinedEntities` downgrades the refusal to pass-through — but **neither makes the
  library parse a DTD or perform I/O**, which is why the capability argument in the verdict holds
  and a flat "no option touches entities" claim would not. `preserveDocumentType: true` only
  retains the declaration as an inert node. A grep for `require`/`import` of `fs`, `http`,
  `https`, `net`, `dns`, `tls` and `child_process` across `dist/` returns **nothing** (exit 1):
  there is no I/O capability in the package to abuse.
- **fast-xml-parser** does parse the internal subset and _does_ expand internal entities by
  default (`processEntities: true` in `src/xmlparser/OptionsBuilder.js`), bounded by
  `maxEntitySize: 10000`, `maxExpansionDepth: 10000`, `maxEntityCount: 1000`,
  `maxExpandedLength: 100000`. External entities throw from `DocTypeReader.readEntityExp`:
  `throw new Error("External entities are not supported")` — but that check sits behind
  `if (!this.suppressValidationErr)`. The protection is a set of flippable numbers plus a guarded
  branch, not an absent capability. Its parser core also imports no `fs`/`http` (only its CLI
  does), so even with the guard bypassed there is no fetch — but the entity-expansion budget
  remains configurable upward.

### Robustness and correctness cases

| Document                                      | `@rgrove/parse-xml`                           | `fast-xml-parser`                                                       |
| --------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| **truncated envelope**                        | **threw** `Missing end tag for element title` | **returned `{"title":""}` silently**                                    |
| nesting depth 1 000                           | returned                                      | **threw** `Maximum nested tags exceeded` (default `maxNestedTags: 100`) |
| nesting depth 10 000                          | threw `Maximum call stack size exceeded`      | threw (bound)                                                           |
| 58.8 MB document                              | returned, **1 655 ms**, RSS 257 MB            | returned, **4 682 ms**, RSS 317 MB                                      |
| cp1251 explicit encoding                      | **mojibake**                                  | **mojibake**                                                            |
| namespaced Atom, `content:encoded`, 2 authors | correct (see below)                           | correct                                                                 |
| CDATA containing markup                       | correct, markup kept inert as text            | correct                                                                 |

Three results carry consequences:

1. **The truncation gap is the second reason parse-xml wins.** Task 2.4 requires "malformed feed =
   drift". FXP returns a structurally plausible object for a half-downloaded feed, which would be
   reported as success with silently missing vacancies — the worst available failure mode. FXP _can_
   detect it, but only via a **separate pass**: `XMLValidator.validate(truncated)` returns
   `{"err":{"code":"InvalidXml","msg":"Invalid '[\"rss\",\"channel\",\"item\",\"title\"]' found."}}`.
   Measured cost of that pass on the 58 MB document: **877 ms on top of 4 682 ms**, i.e. ~5.5 s
   total versus parse-xml's 1 655 ms, which rejects truncation natively in one pass.
2. **Nobody handles declared encodings.** Every parser produced mojibake on the
   `encoding="windows-1251"` feed, because they all accept a JS _string_ and the damage is done
   during byte→string decoding, before the parser is called. This is not a defect to select
   against; it relocates a requirement into the wrapper. Node 22 resolves it with no new
   dependency: `new TextDecoder('windows-1251').decode(bytes)` returned `Программист` correctly.
3. **No candidate heap-died at `--max-old-space-size=1024`** on 58.8 MB. The failure mode is "slow
   but completes", which is why the byte cap below exists to bound _time_, not to prevent OOM.

### Functional requirements, verified on the Atom fixture

`@rgrove/parse-xml` satisfied every functional item from Task 2.4:

- `content:encoded` → child element literally named `content:encoded`, text
  `<p>Senior <b>Dev</b></p>` with the CDATA unwrapped and its markup kept inert.
- multiple authors → both `author` elements present, count `2`.
- Atom `link` relations → `[['alternate','https://example.com/job/1'], ['self','https://example.com/feed']]`.
- RSS `guid` with `isPermaLink="false"` → `attributes: {"isPermaLink":"false"}`, text `abc123`.
- Atom `id` → preserved verbatim.
- CDATA with markup, explicit XML declaration → handled.

**One honest gap: parse-xml does not resolve namespace URIs.** Element names keep their literal
prefix (`content:encoded`) and `xmlns` declarations are exposed only as ordinary attributes
(`xmlns` → `http://www.w3.org/2005/Atom`, `xmlns:content` →
`http://purl.org/rss/1.0/modules/content/`); nodes carry no `namespaceURI` property. Task 2.4
requires namespace support, so the prefix→URI mapping is wrapper work: walk `xmlns*` attributes
into a scope map and resolve prefixed names against it. This is a real cost, deliberately not
hidden — but it is _wrappable_, and feeds in practice use conventional prefixes. FXP is no better
here: its only namespace feature is `removeNSPrefix`, which discards the information entirely.

### The types question, settled by compiling

This was the one constraint capable of forcing rejection or `apps/api`-only scoping, and
`package.json` alone is misleading: `@rgrove/parse-xml` is `"type": "module"` with **no `require`
condition in its `exports`**, which looks exactly like the dual-package trap that blocks the
Lingui 6 upgrade.

It is not that trap. Compiled with the repo's own TypeScript (`5.9.3`, matching `package.json`)
under `apps/api`'s **actual** settings — `module: CommonJS`, `moduleResolution: Node`, `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`:

```
npx tsc -p tsconfig.probe.json     →  exit 0, no diagnostics   (both candidates)
```

Types resolve because both packages carry a **top-level `types` field**, which is what classic
`node10` resolution reads while ignoring `exports`. Then the emitted CommonJS was actually
executed:

```
node 22.23.1  require('./distprobe/fxp-probe.js')       →  OK  {"a":{"b":"hi"}}
node 22.23.1  require('./distprobe/parsexml-probe.js')  →  OK  "a"
node 20.15.1  require('./distprobe/parsexml-probe.js')  →  FAILS (require of ESM)
```

So `@rgrove/parse-xml` works in `apps/api` **because of `require(esm)`, available from Node
22.12**. Our pin is `node >=22.19 <23`, satisfied with margin, and the `engines` field already
enforces it (parse-xml itself declares `node >=22.12.0`). **No `moduleResolution` change, no
`apps/api`-only scoping, no `packages/shared` exclusion is required** — it is adoptable in both,
measured rather than inferred. The dependency on `require(esm)` is a real coupling to the Node 22
pin and is recorded as an invalidation signal below; a drop back to Node 20 would break it, which
is already forbidden by `version-pins.md`.

---

## The exact configuration to adopt

```ts
import { parseXml } from '@rgrove/parse-xml'

const doc = parseXml(xmlString, {
  // DRIFT GATE. MUST stay false (its default). Measured with true: a feed carrying an
  // undefined entity parses "successfully" and yields a literal `&x;` — a malformed feed
  // accepted as content, which is the "malformed feed = drift" requirement inverted.
  // Pinned by an assertion, not by this comment (see the test below).
  ignoreUndefinedEntities: false,

  // NEVER SUPPLY. This is the only route by which entity substitution can enter, and a
  // resolver that read files would be caller-authored XXE. Measured with a hostile
  // resolver: returns the caller's own string. Its presence in a diff is a review BLOCK.
  // resolveUndefinedEntity: <never set>

  preserveCdata: false, // CDATA as text; markup inside stays inert
  preserveComments: false,
  preserveDocumentType: false, // do not even retain the DTD node
  preserveXmlDeclaration: true, // we need the declared encoding for reconciliation
})
```

**What disables DTD / external-entity processing, verbatim: nothing — because the library never
parses a DTD and has no I/O capability.** What the configuration above does is close the one
remaining hole, which is **not** XXE but **drift suppression**: `ignoreUndefinedEntities` must stay
`false` and `resolveUndefinedEntity` must never be supplied. Evidence, each from the measurement
above:

| Guarantee            | Mechanism                                                          | Measurement proving it                                                                                        |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| No external entities | no `fs`/`http`/`fetch` anywhere in `dist/`; DTD discarded unparsed | XXE→file and XXE→http both threw `Named entity isn't defined`; canary **0 hits**, canary string never present |
| No entity expansion  | internal subset never parsed, so no entity is ever declared        | billion laughs and quadratic blowup both threw `Named entity isn't defined`                                   |
| No DTD processing    | `consumeDoctypeDeclaration` consumes and discards                  | `preserveDocumentType: false` keeps it out of the tree entirely                                               |
| No network           | no network capability in the package                               | 0 canary hits over 78 runs                                                                                    |
| Malformed = error    | strict XML conformance                                             | truncated envelope threw `Missing end tag for element title`                                                  |

### `ignoreUndefinedEntities` is a drift-suppression switch, and the wrapper must pin it

This is the one option that can convert correct behaviour into the exact failure mode used above
to reject `fast-xml-parser` as first choice, so leaving it unpinned would be inconsistent.

With `ignoreUndefinedEntities: true`, a feed carrying an undefined entity **parses
"successfully"** and yields a literal `&x;` in the content. No throw, no signal. Task 2.4 requires
**malformed feed = drift**; this option turns a drift signal into accepted content, and the
vacancy text silently carries a raw entity reference. Measured: `xxe ignoreUndef => OK, text:
"&x;"`.

It is also the reason the two options are pinned for _different_ reasons, which a single comment
would blur:

| Option                    | Pinned to             | What goes wrong if changed                                                                                         | Risk class                       |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `ignoreUndefinedEntities` | `false` (its default) | a malformed feed is accepted as valid content instead of raising drift                                             | **correctness / drift**, not XXE |
| `resolveUndefinedEntity`  | never supplied        | a caller-written resolver is the only route by which entity substitution — or, if it read files, XXE — could enter | **security**, caller-introduced  |

**Both must be guarded by a test that can fail, not by a comment.** A comment cannot fail. Three
assertions, run against the `XmlPort` seam so they survive a parser swap:

```ts
// 1. drift is raised, not suppressed — fails if ignoreUndefinedEntities is ever flipped true
expect(() => xmlPort.parseDocument(feedWithUndefinedEntity, limits)).toThrow()

// 2. the XXE document is still refused
expect(() => xmlPort.parseDocument(xxeDocument, limits)).toThrow()

// 3. the options object the adapter actually passes carries neither weakening setting
expect(adapterOptions.ignoreUndefinedEntities).toBe(false)
expect(adapterOptions.resolveUndefinedEntity).toBeUndefined()
```

Assertion 3 matters because 1 and 2 could both be satisfied by accident; it pins the surface
itself. And because a resolver is caller-supplied, the review gate is simple and greppable: **a
`resolveUndefinedEntity` appearing anywhere in the diff is a `BLOCK`.**

**If the fallback adapter is ever activated**, FXP's hardened configuration is:

```ts
new XMLParser({
  processEntities: false, // default is TRUE — this flip is mandatory, not cosmetic
  htmlEntities: false,
  ignoreAttributes: false, // needed for guid isPermaLink / Atom link rel
  maxNestedTags: 40, // default 100; tighten to feed-realistic depth
  // suppressValidationErr must NEVER be set: it bypasses the
  // "External entities are not supported" guard in DocTypeReader.
})
```

plus a **mandatory** `XMLValidator.validate()` pass before `parse()`, because without it a
truncated feed parses silently (measured). Verified: `processEntities: { enabled: false }` leaves
`&lol9;` literal, and `maxNestedTags: 5` throws on a depth-7 document.

---

## Bounds the wrapper must enforce before the parser sees the bytes

All five are enforced by **us**, ahead of the call. The reason is uniform and not stylistic:
`parseXml` is a **synchronous, whole-document** function with no size, depth, count or time
option in its entire option surface. A synchronous parse cannot be interrupted once begun — no
`AbortSignal` or timer can preempt it, because it occupies the event loop — so every bound has to
be a precondition. That is also why these cannot be "left to the library": the library has no
such options to leave them to.

| Bound                 | Value                                                          | Why it cannot be left to the library                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Input size**        | reject > **8 MiB** before decoding                             | No size option exists. Measured: 58.8 MB parses in 1 655 ms holding 257 MB RSS. Since the parse is synchronous, the byte cap **is** the wall-clock bound — it is the only lever that bounds time at all. 8 MiB keeps a worst case in the low hundreds of ms; real feeds are ~200 KiB (`rss.ts` documents DOU's as such).                                                             |
| **Nesting depth**     | reject > **40** by a cheap pre-scan                            | The library's only limit is the **V8 call stack**, and that is not a contract: measured cliff **5 126** at default stack but **28 422** under `--stack-size=4000`. A bound that moves with an unrelated runtime flag cannot be relied on. Feeds are depth ~5.                                                                                                                        |
| **Element count**     | reject > **5 000** by the same pre-scan                        | No count option. Bounds tree-building memory independently of byte size (many tiny elements are cheap in bytes, costly in nodes).                                                                                                                                                                                                                                                    |
| **Wall clock**        | deadline checked **around** the call, byte cap enforced before | Cannot be enforced _during_ a synchronous parse at all. The deadline covers fetch + decode + parse as a unit and is a liveness check for the run, not a parser interrupt.                                                                                                                                                                                                            |
| **Declared encoding** | transcode bytes → string **before** parsing                    | The parser accepts a string, so encoding is already decided by the time it is called. Measured: every candidate produced mojibake on `encoding="windows-1251"`. Read the declaration from the first bytes, then `new TextDecoder(label).decode(bytes)` (Node 22 built-in, verified: returns `Программист`). Default UTF-8; refuse labels `TextDecoder` rejects rather than guessing. |

Defence in depth, cheap and worth it: **reject any document containing a `<!DOCTYPE`** before
parsing. Feeds have no legitimate need for one, and it makes the guarantee independent of the
parser's internals — so a future swap to a parser that _does_ read DTDs cannot silently reopen
the hole.

---

## The seam: `design it twice`

Twenty-five adapters inherit this, and Task 2.4 requires the parser be replaceable without
touching them. The seam's shape matters more than the package choice, because the package choice
is what the seam exists to make reversible.

A constraint rules out the obvious shape: the parser must **also** serve a **Personio XML
helper**, which is an XML-shaped API response, not a feed. So a feed-only port cannot be the only
seam, or Personio has no supported way in.

### Shape A — the provider calls the library directly (rejected)

`RssProvider` imports `parseXml` and holds the hardened options in a shared constant.

Fewest moving parts, and genuinely tempting. Rejected on the **deletion test**: delete the
abstraction and the complexity does not vanish, it _surfaces at the callers_ — the hardening
options, the five bounds, the encoding transcode and the `<!DOCTYPE>` rejection would be
duplicated in `RssProvider` **and** in the Personio helper, and the parser's node type
(`XmlElement`) would leak into both. Replacement then means touching every place that destructures
that tree. A swap forced by an advisory is exactly the event this seam exists for, so a shape that
makes the swap expensive fails the requirement outright.

### Shape B — one feed port, `parseFeed(bytes, limits) -> FeedDocument` (rejected)

Maximum depth for the RSS adapters: 25 callers learn one function and get bounds, transcoding,
namespace resolution and feed semantics behind it.

Rejected because it has nowhere to put Personio. Personio needs bounded, hardened, transcoded XML
**without** feed semantics; forcing it through `parseFeed` means either pretending an API response
is a feed, or a second parallel entry point that re-imports the library and re-derives the bounds
— which is Shape A smuggled back in through the side door.

### Shape C — two stacked seams (recommended)

```ts
// Seam 1 — bounded, hardened, XML-generic. The ONLY place the library is imported.
interface XmlPort {
  parseDocument(bytes: Uint8Array, limits: XmlLimits): XmlDocument // our own neutral tree
}

// Seam 2 — feed semantics, built on Seam 1. What the 25 RSS adapters consume.
interface FeedPort {
  parseFeed(bytes: Uint8Array, limits: XmlLimits): FeedDocument // items, guid, authors, links
}
```

`XmlLimits` carries the five bounds. `XmlDocument` is **our** minimal tree shape — not
`@rgrove/parse-xml`'s `XmlElement` — with namespace URIs already resolved, which is where the
namespace gap identified above gets paid off once instead of 25 times.

- **Depth / leverage:** an RSS adapter learns one function and gets bounds, transcoding, namespace
  resolution, XXE refusal and feed semantics. Personio enters at Seam 1 and gets everything except
  feed semantics, which is exactly right.
- **Locality:** the library name appears in **one file**. The hardening options, the bounds and
  the `<!DOCTYPE>` rejection live in that one file.
- **Deletion test, Seam 1:** delete it and bounds + hardening + transcoding duplicate across
  `RssProvider` and Personio — complexity surfaces at callers, so it earns its living.
  **Seam 2:** delete it and all 25 adapters re-implement `guid isPermaLink="false"`, Atom link
  relations, `content:encoded` and multiple authors — surfaces at 25 callers, earns its living.
- **Two adapters, so the seam is real, not hypothetical:** this review produced the second one.
  `ParseXmlAdapter` (prod) and `FastXmlParserAdapter` (the measured fallback) both satisfy
  `XmlPort`, and the adversarial corpus is the **shared conformance suite** both must pass. A seam
  with one adapter would be speculative indirection; this one has two working implementations on
  day one.
- **Test surface:** callers and tests cross the same seam. The corpus runs against `XmlPort`, so
  the tests do not reach behind the interface and survive a parser swap unchanged.

### The replacement story

An advisory lands against the chosen parser. Then: implement `XmlPort` over the replacement, run
the committed adversarial corpus against it, swap the binding in the module provider. **No adapter
changes, no test changes** — because no adapter ever saw the parser's name or its node type, and
every test asserts against `XmlPort`. The fallback path is already measured, so the realistic
worst case is a configuration change plus the FXP validator pass, not a redesign. Commit the
corpus from this review as that conformance suite; it is the artifact that makes replacement cheap
and the reason this recommendation meets the bar.

---

## Expiry and what invalidates this

**Expiry: 2027-04-20** (6 months). Recheck sooner on any of:

1. **Any advisory against `@rgrove/parse-xml`.** Response: activate the measured
   `FastXmlParserAdapter` via Seam 1. This conclusion's whole value is that this is cheap.
   **Re-pin fast-xml-parser to the then-current patched version at activation**, and re-run the
   GHSA query first — it carried 13 advisories and nine in 2026 alone, so the version named in
   this document will likely be stale by then.
   Re-run both queries at recheck time:
   `gh api graphql -f query='{ securityVulnerabilities(ecosystem: NPM, package: "<pkg>", first: 20) { nodes { advisory { ghsaId severity publishedAt } vulnerableVersionRange } } }'`
2. **Maintenance lapse** — no release for ~18 months, or an unanswered security issue. Its cadence
   is low by design (5 releases since 2024, a strict-conformance parser that does not need churn),
   so judge by **issue responsiveness**, not release count. Note the precedent in this very
   review: `saxes` was dropped for exactly this, at 0 releases since 2024.
3. **A parse-xml major that adds DTD or entity support.** This would dismantle the single fact the
   verdict rests on. Read the changelog before any major bump, do not bump on green CI.
4. **Any change to the Node pin below 22.12**, which would break `require(esm)` and the ESM-only
   package with it (measured: fails on Node 20). Currently forbidden by `version-pins.md`.
5. **`moduleResolution` moving to `node16`/`bundler`** in `apps/api` or `packages/shared` — the
   compile result above was measured under `Node` resolution and would need re-measuring, as
   `exports` (which has no `require` condition) would then be consulted.

Not an invalidation signal: the namespace-resolution gap and the five wrapper bounds. Both are
known, priced in above, and are wrapper work by design.

## What could not be established

- ~~No public advisory database query beyond `npm audit`.~~ **Closed 2026-10-20**: the GitHub
  Advisory Database was queried directly via the GraphQL `securityVulnerabilities` field (command
  and output in "Candidates and why each survived or fell"). `@rgrove/parse-xml` → `[]`;
  `fast-xml-parser` → 13 distinct GHSAs. No residual gap for npm-ecosystem advisories; a CVE with
  no GHSA record would still be missed, which is a limitation of the database, not of this query.
- **`sax`'s `BlueOak-1.0.0`** is permissive and OSI-approved, but it is an uncommon licence and
  has not been reviewed by counsel for this project. Irrelevant to the verdict (sax is rejected on
  technical grounds), but worth knowing before adopting it elsewhere.
- **Real-world feed fixtures were not used.** The corpus is synthetic and adversarial by design.
  Task 2.4 separately requires authentic DOU/Djinni/WWR/EU fixtures; this review does not
  substitute for that, and a real feed could surface namespace shapes the wrapper must handle.
- **Streaming was not evaluated.** Both finalists are whole-document parsers. If a source ever
  needs genuinely unbounded feeds, that is a new decision, not a tweak — and the 8 MiB cap is the
  line at which it would be triggered.

## Sources

Every claim above traces to one of:

- **Installed package source** (primary): `node_modules/@rgrove/parse-xml/dist/lib/Parser.{d.ts,js}`
  (doctype discarded; full `ParserOptions`), `node_modules/fast-xml-parser/src/xmlparser/OptionsBuilder.js`
  (defaults incl. `processEntities: true`, `maxNestedTags: 100`), `.../DocTypeReader.js`
  ("External entities are not supported"), and each package's `LICENSE` file for the SPDX
  identifier.
- **npm registry** (primary): `npm view <pkg> version license time.modified dist.unpackedSize`
  and `npm view <pkg> time --json`, accessed 2026-10-20.
- **Commands run** in this review, reproducible from the corpus: `node runner/gen.mjs`,
  `node runner/matrix.mjs` (78 runs), `node runner/probe.mjs`, `node runner/bounds.mjs`,
  `node runner/falsify.mjs` (the option-surface falsification: `ignoreUndefinedEntities` and
  `resolveUndefinedEntity` against the bomb and XXE documents),
  `npx tsc -p tsconfig.probe.json`, `npm audit`, the GHSA GraphQL queries quoted above, and the
  `require()` executions on Node 22.23.1 and 20.15.1.
- **Review provenance:** the verdict's decisive sentence was rewritten after finding MASTER-M-1 on
  PR #1064 falsified the weaker claim "no option can resolve a DTD entity". The verdict did not
  change; the argument carrying it was replaced with the capability argument, which survives an
  option flip, and the two entity-bearing options were pinned with failing assertions. Recorded
  because the earlier phrasing read as licence not to pin the option surface.
- **Project constraints**: `.claude/rules/common/version-pins.md` (Node pin, the Lingui 6
  dual-package-types precedent), `apps/api/tsconfig.json` + `tsconfig.base.json` (the exact
  compiler settings measured against), `apps/api/src/job-sourcing/rss.ts` (the existing
  hand-rolled DOU scanner and its documented 2 MiB / 200-item caps).
