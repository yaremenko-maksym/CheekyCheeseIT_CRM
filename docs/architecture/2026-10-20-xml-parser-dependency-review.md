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

The capability argument stands on its own. It is deliberately **not** propped up by the advisory
distribution — see "Why the advisory counts are not corroboration" below, where an earlier
revision of this document made exactly that mistake and it was removed.

### What this document decides, and what it does not

**Decides:** which package to adopt, on what evidence, under what licence, with which two options
pinned, behind which seam, and when the conclusion expires.

**Does not decide — carried into Task 2.4 as acceptance criteria (R-1 … R-5 below):** the
wrapper's test assertions and the specific bound values. Each was falsified or re-measured by
review, and each fix is test code or implementation measured against a real wrapper rather than
prose. A document cannot hold a falsifiable assertion, and specifying a contract that nothing
enforces is worse than leaving it open.

**Explicitly unchanged — constraint C-20:** `apps/api/src/job-sourcing/rss.ts` **stays DOU-only**
and is **not touched** by this adoption. The existing hand-rolled scanner keeps its own documented
caps (`MAX_FEED_BYTES` 2 MiB, `MAX_ITEMS` 200) and its legacy timestamp-query policy via
`canonicalizePostingUrl`. `RssProvider` is a **new** base beside it, not a replacement for it, and
DOU's golden outcomes must stay unchanged. This review proposes **no** edit to that file.

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

The **GHSA** column is the count of **distinct non-withdrawn GitHub Security Advisory ids** in the
NPM ecosystem, queried **2026-10-20** (basis and query in "Advisories" below). It is the column to
read first.

| Package             | GHSA (distinct)                  | DTD machinery | Version | SPDX (read in)                                     | Last release | Releases since 2024 | Native bindings   | Deps                    | Install size | Outcome                                        |
| ------------------- | -------------------------------- | ------------- | ------- | -------------------------------------------------- | ------------ | ------------------- | ----------------- | ----------------------- | ------------ | ---------------------------------------------- |
| `@rgrove/parse-xml` | **0**                            | **none**      | 5.0.0   | **ISC** (`node_modules/@rgrove/parse-xml/LICENSE`) | 2026-08-30   | 5                   | no                | **0**                   | 396 KB       | **ADOPTED**                                    |
| `fast-xml-parser`   | **12** (1 CRITICAL, 6 HIGH)      | yes           | 5.11.2  | **MIT** (`node_modules/fast-xml-parser/LICENSE`)   | 2026-09-29   | 72                  | no                | 6 direct / 7 transitive | 1.4 MB       | fallback adapter — latest HIGH 2026-07-21      |
| `sax`               | 0                                | partial       | 1.6.1   | **BlueOak-1.0.0** (`LICENSE.md`)                   | 2026-07-24   | 8                   | no                | 0                       | 72 KB        | **runner-up** — rejected on integration cost   |
| `@xmldom/xmldom`    | **22** (1 CRITICAL, **18 HIGH**) | yes           | 0.9.12  | **MIT** (`LICENSE`)                                | 2026-08-23   | 18                  | no                | 0                       | 452 KB       | rejected — worst row in the table              |
| `saxes`             | 0                                | partial       | 6.0.0   | **ISC** (`package.json` field only, no file)       | 2022-05-17   | **0**               | no                | 1                       | 164 KB       | rejected — maintenance lapse                   |
| `xml2js`            | 1 (MODERATE, 2023-04-05)         | no            | 0.6.2   | **MIT** (`LICENSE`)                                | 2024-05-31   | 0 since 2024-05     | no                | 2                       | 3.4 MB       | rejected — effectively unmaintained            |
| `htmlparser2`       | 0                                | no            | 12.0.0  | **MIT** (`LICENSE`)                                | 2026-03-20   | 5                   | no                | 4                       | 235 KB       | rejected — HTML error recovery, not strict XML |
| `libxmljs2`         | **2 (both CRITICAL)**            | yes (libxml2) | 0.37.0  | **MIT** (`LICENSE`)                                | 2025-06-01   | 2                   | **yes (libxml2)** | 3                       | 7.2 MB       | rejected — native bindings, 2 CRITICALs        |
| `node-xml-stream`   | 0                                | no            | 1.0.2   | **MIT** (field only, not installed)                | 2022-05-11   | 0                   | no                | —                       | —            | rejected — abandoned since 2022                |
| `xml-stream`        | 0                                | no            | 0.4.5   | **MIT** (`LICENSE`; field absent — see note)       | 2024-11-04   | 0                   | yes (expat)       | —                       | —            | rejected — abandoned + native expat            |

### Why the advisory counts are **not** corroboration of the capability argument

An earlier revision of this document claimed the distribution above was "the capability argument
showing up in the historical record" — that the DTD-carrying parsers hold 36 of the 37 advisories,
therefore DTD machinery causes advisories. **That claim does not survive reading the advisories,
and it is withdrawn.** It was checked by class rather than by count:

| Package           | Advisories | Actual classes                                                                                                                                                                                                                  | Entity/XXE class? |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `@xmldom/xmldom`  | 22         | DocType **name** injection; attribute / element / PI / comment / CDATA **serialization** injection (`requireWellFormed`); quadratic attribute deduplication; quadratic-time parsing; quadratic memory; 2 × ReDoS; recursion DoS | **none**          |
| `libxmljs2`       | 2          | type confusion                                                                                                                                                                                                                  | **none**          |
| `fast-xml-parser` | 12         | ~7 entity / DOCTYPE class, remainder prototype pollution and DoS                                                                                                                                                                | partly            |
| `xml2js`          | 1          | prototype pollution                                                                                                                                                                                                             | no                |

So roughly **24 of the 36 do not bear on entity handling at all**. The counts are real and the
column stays — an advisory load is a maintenance fact worth knowing — but they do **not** test the
proposition they were cited for, and a reader who accepts the count as evidence for the capability
argument has been misled.

Two further reasons not to lean on it, both fair: **zero advisories for a low-traffic package is
also what low scrutiny produces**, so the chosen parser's `0` is not purely a safety signal; and
the original framing ("not about popularity") asserted away precisely that objection.

**What the numbers do legitimately support**, stated narrowly: `fast-xml-parser`'s own history
contains repeated **entity and DOCTYPE-class** advisories (~7 of 12), which is direct evidence
that _its_ DTD machinery has been a recurring source of defects — relevant to it being the
fallback rather than the primary. Nothing more is claimed.

**This mistake is the same defect as MASTER-M-1**, two revisions later and in the opposite
direction: there an absolute claim outran the evidence, here a true-sounding statistic was
recruited for a proposition it does not address. Both were available to catch for free. It is
recorded in `BACKLOG-followups.md` entry 259, which is about exactly this, and the recurrence
inside the same document is the most useful thing in that entry.

Two rows deserve their numbers stated rather than characterised:

- **`@xmldom/xmldom` is the worst row in the table** — 22 advisories, **18 of them HIGH**, the most
  recent published **2026-09-08**, about six weeks before this review. I had originally rejected it
  merely as "slowest, lax"; that rejection is now overwhelmingly supported. It also **explains the
  `@xmldom/xmldom: ">=0.8.15 <0.9.0"` entry in the repo's `pnpm.overrides`**: that pin is a scar
  from this advisory stream, reached transitively rather than chosen, and anyone later wondering
  why an unused XML package is pinned in our root `package.json` should read this row.
- **`libxmljs2`'s two advisories are both CRITICAL.** Above I rejected it on the native-bindings
  liability and characterised libxml2 as "the busiest XXE/entity CVE surface in this list". The
  measured fact is sharper and should be preferred to that guess: **the wrapper itself carries two
  criticals**, independent of libxml2's own record, on 2 releases in ~2 years.

**No copyleft appeared.** ISC, MIT and BlueOak-1.0.0 are all permissive and compatible with a
closed-source commercial product. `fast-xml-parser`'s 7 transitive packages are each MIT
(`@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `strnum`,
`anynum`, `xml-naming`), verified by reading each `package.json` `license` field.

> **Correction — `xml-stream`'s licence.** An earlier revision rejected it for declaring "no
> licence at all… absent a grant, the default is no permission". **That was wrong.** Unpacking
> `xml-stream@0.4.5` shows a `LICENSE` file carrying a **full MIT grant**; only the `package.json`
> `license` field is absent. The error is worse than a wrong cell: this document states its method
> as "licence read from the `LICENSE` file inside the installed package, not from the npm page",
> and on the one row where the file and the field disagreed, the field was used. **The rejection
> stands on different grounds** — abandoned (no release since 2024, 0 since) and native expat
> bindings, the same liability as `libxmljs2`.
>
> **Two rows could not be read from a file** and say so in the table rather than implying
> otherwise: `saxes` ships no licence file (ISC in the field only), and `node-xml-stream` was never
> installed, so its MIT is field-only and its deps and size are "not measured" rather than "—".

> **Correction — `sax`'s rejection reason.** An earlier revision rejected it as "error-tolerant by
> design". **In strict mode it is not:** `sax.parser(true, { strictEntities: true })` throws
> `Unclosed root tag` on the truncated envelope and `Invalid character entity` on an undefined
> entity — so it satisfies the drift requirement that `fast-xml-parser` fails. It is also
> maintained (2026-07-24), **0 advisories**, 0 dependencies, 72 KB. It is therefore the
> **runner-up, not a dismissal**, and is rejected on _integration cost_: it is a tokenizer, so the
> document tree, namespace scoping and feed semantics would all be ours to build, and its
> error-tolerant default is a footgun to inherit across ~25 adapters (strict mode and a correct
> `onerror` are opt-in, and getting either wrong fails silently). **One consequence to preserve:**
> because `sax` is streaming, it is the one candidate that could enforce a **wall-clock bound
> mid-parse** by checking a deadline inside its handlers. If a time bound ever proves necessary
> and a byte cap proves insufficient, `sax` is where to look, and this review should not be read
> as having closed that door.

**`libxmljs2` rejected on the native-bindings liability, stated rather than argued:** it compiles
libxml2 from source via `node-gyp` unless a prebuild matches. That puts a C toolchain on the
critical path of every CI run and every Docker image build, and couples us to libxml2's CVE stream
on top of the wrapper's own. The measured figure is what carries this, not the characterisation:
**the wrapper itself holds 2 distinct advisories and both are CRITICAL**, on 2 releases in ~2
years — thin maintenance cover for that exposure. A pure-JS parser we can bound ourselves is the
cheaper risk.

**Advisories — queried directly against the GitHub Advisory Database**, not only via `npm audit`:

```bash
gh api graphql -f query='{ securityVulnerabilities(ecosystem: NPM,
  package: "@rgrove/parse-xml", first: 20) { nodes { advisory { ghsaId severity
  publishedAt } vulnerableVersionRange firstPatchedVersion { identifier } } } }'
→ {"data":{"securityVulnerabilities":{"nodes":[]}}}
```

**`@rgrove/parse-xml`: zero advisories, ever.** The same query for the fallback is the opposite
picture and is material to the decision rather than decoration:

**Counting basis — state it, because three different numbers are derivable from one query.** All
counts in this document are **distinct non-withdrawn GHSA ids, NPM ecosystem, queried
2026-10-20**. That basis is chosen because it counts each advisory once and is reproducible from a
single query. The alternatives are traps: the raw response returns one row per
**vulnerable-version-range**, so an advisory spanning a 4.x and a 5.x range appears twice —
`fast-xml-parser` yields **17 rows for 12 advisories**. An unfiltered distinct count also picks up
withdrawn advisories (`@xmldom/xmldom`: 23 unfiltered, **22** non-withdrawn). To re-derive:

```bash
# NOTE the pageInfo: without it this query silently truncates at the page size.
# @xmldom/xmldom already returns 41 rows, so `first: 50` has little headroom left and a
# future recheck would under-count without announcing it.
gh api graphql -f query='{ securityVulnerabilities(ecosystem: NPM, package: "fast-xml-parser",
  first: 100) { pageInfo { hasNextPage } nodes { advisory { ghsaId severity publishedAt
  withdrawnAt } } } }' \
  --jq '.data.securityVulnerabilities
        | (if .pageInfo.hasNextPage then "TRUNCATED — paginate" else "complete" end) as $c
        | [.nodes[].advisory | select(.withdrawnAt == null)] | map(.ghsaId) | unique | length
        | "\(.) (\($c))"'
```

**Row counts are not advisory counts, and the gap grows.** At the time of writing:
`fast-xml-parser` 17 rows → 12 advisories; `@xmldom/xmldom` 41 rows → 22. Any recheck must assert
`hasNextPage == false` or paginate, otherwise the number degrades silently — the failure mode this
whole document is about.

> **Correction.** An earlier revision of this file said "13" for `fast-xml-parser`. That was a
> miscount of the 17 version-range rows by eye, not a different counting basis. The correct figure
> is **12**.

| Package             | Distinct GHSAs (non-withdrawn) | Worst severity                       | Most recent                                 | Affects                              |
| ------------------- | ------------------------------ | ------------------------------------ | ------------------------------------------- | ------------------------------------ |
| `@rgrove/parse-xml` | **0**                          | —                                    | —                                           | —                                    |
| `fast-xml-parser`   | **12** (17 version-range rows) | **CRITICAL** (`GHSA-m7jm-9gc2-mpf2`) | `GHSA-8r6m-32jq-jx6q`, HIGH, **2026-07-21** | `>=5.9.3 <5.10.1`, patched in 5.10.1 |
| `@xmldom/xmldom`    | **22** (23 unfiltered)         | **CRITICAL** + 18 HIGH               | **2026-09-08**                              | the scar behind our `pnpm.overrides` |
| `libxmljs2`         | **2**                          | **both CRITICAL**                    | 2024-05-02                                  | the native wrapper, not libxml2      |

Three consequences, stated rather than buried:

1. **It reframes fast-xml-parser's release cadence.** Above I recorded 72 releases since 2024 as a
   health signal; the advisory history shows a good part of that churn is **security response** —
   **8 advisories published in 2026** by `publishedAt` (an earlier revision said "nine"). High
   cadence here means "frequently found vulnerable" as much as "actively maintained".
2. **The chosen fallback version is patched** — 5.11.2 is past 5.10.1 — but if the
   `FastXmlParserAdapter` is ever activated, it must be **re-pinned at activation time**, not
   adopted at the version recorded in this document.
3. **~7 of fast-xml-parser's 12 advisories are entity or DOCTYPE class.** That is evidence about
   _that_ package's DTD machinery specifically, and it is the only inference the counts support.
   It is **not** evidence that DTD machinery causes advisories in general — see "Why the advisory
   counts are not corroboration" above.

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

> **Precision about what "refused" means — do not flatten this.** The documents above all place a
> **general entity reference in content** (`<title>&xxe;</title>`), and that form throws.
> **Parameter-entity and external-DTD-only documents are _accepted_** by parse-xml: they parse
> successfully, the DTD is retained inert (or discarded), and the canary records **0 hits**.
> Inert acceptance is **not** a vulnerability — nothing is dereferenced, nothing is expanded, no
> I/O occurs — but a reader must not conclude that the parser _rejects all DTD constructs_. It
> rejects **undefined entity references**; it **ignores** the rest. Confirmed independently by the
> security review. This is exactly why R-1's capability test must use an **internal-entity**
> document rather than a classic XXE one.

Both candidates refuse the general-entity XXE form **on evidence**. The difference is _why_, and
that is the decision:

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

### The two options that must be pinned — and why the pinning is specified in Task 2.4, not here

`ignoreUndefinedEntities` can convert correct behaviour into the exact failure mode used above to
reject `fast-xml-parser` as first choice, and `resolveUndefinedEntity` is the only route by which
entity substitution can enter. Both must be pinned by the wrapper:

| Option                    | Pinned to             | What goes wrong if changed                                                                     | Risk class                      |
| ------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| `ignoreUndefinedEntities` | `false` (its default) | a malformed feed is accepted as valid content instead of raising drift                         | **correctness / drift**         |
| `resolveUndefinedEntity`  | never supplied        | a caller-written resolver is the route by which substitution — or caller-authored XXE — enters | **security**, caller-introduced |

**An earlier revision of this document specified three test assertions here. They have been
removed, because they were not falsifiable — and that is a finding, not a tidy-up.** Mutation
testing against seven wrapper variants showed:

- a wrapper whose `parseDocument` **always throws** passes all three;
- the XXE assertion is **masked by this document's own `<!DOCTYPE` pre-reject** — the pre-reject
  fires before the parser runs, so an _expanding_ parser behind it passes too, and the assertion
  cannot detect the capability regression it exists for;
- the third assertion inspected a **local variable** rather than the options actually handed to
  `parseXml`, so a resolver injected at the call site, or a narrow HTML-entity resolver added later
  to "fix" `&nbsp;` in feeds, leaves it green.

So the checks intended to close MASTER-M-1 — a finding about a claim whose true and false states
looked identical — were themselves checks whose passing and absence looked identical. **A document
cannot carry a falsifiable assertion.** The replacement must be test code against a real
`XmlPort`, which cannot exist until Task 2.4 builds one, so the contract is specified there and
listed below.

---

## Open requirements carried into Task 2.4 (not settled here)

> **Assumption (A1, recorded per `autonomy-levels.md`).** This review was narrowed by the
> orchestrator to **the decision plus its corrections**. The wrapper contract — assertions and
> bound values — moves into Task 2.4 as acceptance criteria. Rationale: every item below was
> falsified or re-measured by a reviewer, and each fix is _test code or implementation measured
> against a real wrapper_, not prose. Keeping them here would produce a document asserting a
> contract that nothing enforces. **Nothing below is settled; it is a requirement list.**

### R-1 (from SR-H-1) — falsifiable assertions against a real `XmlPort`

Required, each of which can fail:

- **a positive control** — the same feed with `&amp;` parses to the expected value, so a
  blanket-throwing wrapper cannot pass;
- **assert the error type and message**, not merely that something threw;
- **test the parser layer with the `<!DOCTYPE` pre-reject bypassed**, using an **internal**-entity
  document (`<!ENTITY a "AAA">`, where `&a;` must not yield `AAA`), so expanding and non-expanding
  parsers give different results;
- **pin the real call site** — mock `@rgrove/parse-xml` and assert on the options object actually
  passed (`ignoreUndefinedEntities` false or absent, `resolveUndefinedEntity` undefined, and no
  unexpected keys), rather than on a local variable.

### R-2 (from SR-M-2) — the bounds, re-derived against the real wrapper

The causal claims in the removed bounds table were **false as measured**, and the corrected
measurements are the input to this work, not a settled answer:

| Shape at 8 MiB             | Measured                   |
| -------------------------- | -------------------------- |
| `<i/>` elements            | **3 199 ms, 1 221 MB RSS** |
| `<i a="1"/>`               | 1 494 ms, 670 MB           |
| processing instructions    | 919 ms                     |
| `&amp;` runs               | 545 ms                     |
| element-dense at **2 MiB** | 669 ms, 429 MB             |

What this overturns: the claim that 8 MiB "keeps a worst case in the low hundreds of ms" is wrong
by an order of magnitude, and **bytes are not "the only lever"** — the _element count_ is the real
bound on both time and memory, and **memory, not time, is the container OOM risk**. The parse is
synchronous in the API process, so each hit stalls the event loop that also serves the CRM.

Required decisions in 2.4:

- **The byte cap: aligned at 2 MiB. The earlier 8 MiB is withdrawn, not left open.** It was 4× the
  existing `MAX_FEED_BYTES` with no stated reason, and three independent measurements now agree it
  was wrong rather than merely unexplained:

  | Evidence                                  | At 8 MiB                   | At 2 MiB       |
  | ----------------------------------------- | -------------------------- | -------------- |
  | element-dense `<i/>`, measured in review  | **3 199 ms, 1 221 MB RSS** | 669 ms, 429 MB |
  | my growth probe, extrapolated (exp ≈1.36) | ~6 s                       | ~1 s           |
  | existing `rss.ts` cap for the same job    | —                          | **2 MiB**      |

  1 221 MB RSS in a synchronous parse inside the API process is an **OOM risk in a container**, not
  a latency nit, and it stalls the event loop that also serves the CRM. Real feeds are ~200 KiB, so
  2 MiB is already 10× headroom. **Recommendation: `2 MiB`, the same constant as `rss.ts`** — one
  number for one job, so the two code paths cannot drift. Raising it later requires the
  memory measurement above to be re-run, not an assertion.

- **A real wall-clock bound, or an explicit decision not to have one.** "A deadline checked around
  the call" bounds nothing — it is evaluated after the parse has already returned. A genuine bound
  needs `worker_threads` with `terminate()` on a timer, or a byte cap small enough to make time
  moot. (Or `sax`, the streaming runner-up, which can check a deadline inside its handlers.)
- **Specify and test the pre-scan**, or drop it. Count and depth were to be enforced by an
  unspecified "cheap pre-scan" of attacker-controlled input; any disagreement between that scan
  and the real parser (`<` / `>` inside attributes, comments, CDATA, PIs) is a
  **parser-differential** surface. Note that depth and count can be checked **exactly after**
  parsing — parse-xml throws cleanly at its stack limit — so **only bytes and memory genuinely
  need to be preconditions**.

**The depth reasoning survives and is strengthened; the specific figures do not.** Two machines
disagree: this review measured the cliff at **5 126** default / **28 422** under
`--stack-size=4000`; the reviewer measured **5 419** / **24 999**, **4 686** when called 1 000
frames deep (as it would be inside Nest), and found `--stack-size=20000` **segfaults (SIGSEGV)
rather than throwing**. That two machines cannot agree is precisely the argument for setting the
bound ourselves rather than inheriting the stack's.

### R-3 (from SR-M-3) — DOCTYPE check and decoding, ordering made explicit

- The `<!DOCTYPE` pre-reject must run **on the decoded string, not on the bytes**: a byte-level
  match is **bypassed by any UTF-16 feed** (`<\0!\0D…` does not match; it matches after
  `TextDecoder('utf-16le')`). Measured by the reviewer.
- `new TextDecoder(label)` is **non-fatal by default**: invalid UTF-8 (`61 FF 62`) decodes silently
  to `a<22>b`, which contradicts "malformed = drift". Specify `{ fatal: true }`.

### R-4 (from SR-M-4 / SPEC-M-1) — the fallback is a candidate-of-record, not a drop-in

**Stated plainly, because the earlier claim was false.** `fast-xml-parser` parsing
`<title>A &nbsp; B</title>` returns the literal `A &nbsp; B` **with no throw under every
configuration this document lists**, and `XMLValidator.validate()` returns **`true`**. Confirmed
in this review's own re-run, independently by two reviewers.

Consequences, replacing "no adapter changes, no test changes" and "a configuration change plus the
validator pass":

- The fallback **fails the drift requirement** as configured, and the corpus is **not** a shared
  conformance suite as written — the two parsers already diverge on billion laughs (parse-xml
  throws; FXP returns `&lol9;` unexpanded).
- Adopting it would additionally require **a custom undefined-entity scan** plus a re-pin to the
  then-current patched version (12 advisories, ~7 of them entity/DOCTYPE class).
- So it is a **candidate-of-record with measured behaviour**, not a drop-in.

**The consequence for the seam, which is the part not to miss.** `codebase-design`'s own test is
"one adapter — the seam is hypothetical; two — it is real". An earlier revision claimed this
review had produced the second adapter and therefore a real seam. **It had not.** Only
`@rgrove/parse-xml` can satisfy the drift contract as specified; `fast-xml-parser` cannot, under
any configuration listed. On that test the seam is currently **hypothetical — one working adapter
plus a candidate** — and the "replaceable without touching 25 adapters" property is **designed
for but not yet demonstrated**.

This is a real open question for 2.4, not a caveat to file away. Three ways to close it, in
descending preference:

1. **Make `fast-xml-parser` genuinely conformant** — add the undefined-entity scan (R-4) and run it
   against the shared corpus. Then there are two adapters and the seam is demonstrated.
2. **Use `sax` as the second adapter instead.** It already throws on both truncation and undefined
   entities (measured above), so it may satisfy the contract with less bridging than FXP — at the
   cost of building the tree. This is a further reason the runner-up matters.
3. **Accept a one-adapter seam deliberately**, on the ground that an in-memory fake implementing
   `XmlPort` for tests is itself a second implementation — a weaker but legitimate reading of the
   two-adapter rule.

Whichever is chosen, it should be chosen **knowingly**, because the seam is the entire justification
for the two-layer design, and a seam that has never been crossed is a hypothesis about the future
rather than a property of the code.

### R-5 — ReDoS and quadratic growth: measured here, to be re-confirmed against the wrapper

This class **dominates the real advisory record** (xmldom's 2026 batch: quadratic parse, quadratic
memory, attribute dedup, PI-grammar ReDoS) and the original corpus never ran it. Measured now, on
parse-xml 5.0.0, warmed, best-of-3, across an 8× size range:

| Shape                                    | Growth exponent     | Worst absolute   |
| ---------------------------------------- | ------------------- | ---------------- |
| many distinct attributes                 | **0.98**            | 73 ms at 848 KB  |
| repeated identical attribute names       | 1.14                | 0.2 ms at 468 KB |
| many sibling elements                    | 1.26                | 128 ms at 625 KB |
| long adjacent text runs                  | 1.01                | 2 ms at 312 KB   |
| late mismatched close tag                | **1.36**            | 194 ms at 625 KB |
| unterminated PI / comment / CDATA / attr | rejects immediately | sub-millisecond  |

**No catastrophic backtracking and no quadratic blowup**: every exponent is ≈1, the worst 1.36,
which is node-allocation and GC cost rather than backtracking. parse-xml **rejects every
unterminated construct in sub-millisecond time** — the shape behind xmldom's PI ReDoS advisory.

Two honest limits: a 1.36 exponent is **mildly superlinear**, which is exactly why the byte cap is
load-bearing (see R-2); and **this is a probe, not a proof** — it is ten shapes, not a fuzzer.
2.4 should commit these shapes to the corpus and add xmldom's advisory batch as a fuzz list.

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
- **Adapters — currently one, so the seam is _hypothetical_ by the two-adapter test.** An earlier
  revision claimed two working implementations "on day one". That is **withdrawn**:
  `FastXmlParserAdapter` cannot satisfy the drift contract under any configuration measured
  (R-4), so `ParseXmlAdapter` stands alone and the corpus is **not** yet a shared conformance
  suite. Closing this is required work in 2.4, with three options set out in R-4. **This is the
  one weakness in the recommended shape, and it is the shape's whole justification** — recorded
  here rather than smoothed over.
- **Test surface:** callers and tests cross the same seam. The corpus should run against
  `XmlPort`, so tests do not reach behind the interface — but note R-1: tests that encode
  parser-specific error _messages_ will not survive a swap, only those asserting behaviour with a
  positive control.

### The replacement story

An advisory lands against the chosen parser. Then: implement `XmlPort` over the replacement, run
the committed corpus against it, swap the binding in the module provider. **No adapter changes** —
no adapter ever sees the parser's name or its node type, and that is the property the seam exists
to provide.

**Corrected, because the earlier version of this paragraph was false.** It claimed "no test
changes" and a worst case of "a configuration change plus the FXP validator pass". Neither holds:

- `fast-xml-parser` **accepts an undefined entity under every configuration listed here**, with
  `XMLValidator.validate()` returning `true`, so it fails the drift requirement and needs
  **additional undefined-entity detection code** (R-4).
- The corpus is therefore **not yet a shared conformance suite** — the two parsers diverge on
  billion laughs and on undefined entities. Making it shared is work in 2.4, not a fact today.
- Any port-level tests that encode parser-specific error **messages** will need adjusting; only
  tests asserting _behaviour_ (throws / returns, with a positive control) survive a swap
  unchanged. That is a constraint on how R-1's assertions are written.

So the honest claim is narrower and still worth the seam: **replacement costs a new adapter plus
its conformance work, and zero adapter churn across ~25 call sites.** The alternative shapes (A and
B) cost that _plus_ touching every adapter. Commit this review's corpus — including the R-5 shapes
— as the starting point for that suite.

---

## Expiry and what invalidates this

**Expiry: 2027-04-20** (6 months). Recheck sooner on any of:

1. **Any advisory against `@rgrove/parse-xml`.** Response: activate the measured
   `FastXmlParserAdapter` via Seam 1. This conclusion's whole value is that this is cheap.
   **Re-pin fast-xml-parser to the then-current patched version at activation**, and re-run the
   GHSA query first — it carried 12 advisories and several in 2026 alone, so the version named in
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
  `fast-xml-parser` → 12 distinct GHSAs. No residual gap for npm-ecosystem advisories; a CVE with
  no GHSA record would still be missed, which is a limitation of the database, not of this query.
- **`sax`'s `BlueOak-1.0.0`** is permissive and OSI-approved, but it is an uncommon licence and has
  not been reviewed by counsel for this project. It now matters more than when first written,
  because `sax` is the runner-up rather than a dismissal — read it before adopting `sax`.
- **Real-world feed fixtures were not used.** The corpus is synthetic and adversarial by design.
  Task 2.4 separately requires authentic DOU/Djinni/WWR/EU fixtures; this review does not
  substitute for that, and a real feed could surface namespace shapes the wrapper must handle.
- **The depth and element bounds were derived from DOU alone** ("feeds are depth ~5"), yet the seam
  must also serve **Personio** and ~25 other boards whose real shapes are unmeasured. The numbers
  are starting points for R-2, not validated limits.
- **Only two of ten candidates were run on the corpus.** `sax`, `@xmldom/xmldom`, `saxes`,
  `xml2js` and `htmlparser2` were rejected on licence, maintenance or design grounds without
  adversarial runs — defensible for the rejected, but it means the comparison table's security
  column is measured for the finalists and argued for the rest. `sax` was additionally probed on
  truncation and undefined entities after review, which is what reclassified it.
- **Streaming was only partly evaluated.** Both finalists are whole-document parsers; `sax` is
  streaming and was measured on the R-5 shapes, but not on a genuinely unbounded feed. Streaming
  is the escape hatch if a true mid-parse wall-clock bound is ever required (R-2).
- **R-5 is a probe, not a proof.** Ten shapes across an 8× range is not fuzzing, and the real
  advisory record for this class is dominated by shapes nobody enumerated in advance.

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
