/**
 * Opening the ORIGINAL posting — task-job-sourcing-slice1 §4.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MUST RUN SYNCHRONOUSLY INSIDE THE CLICK HANDLER. NOTHING MAY BE
 * `await`ed BEFORE IT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Browsers only honour `window.open` while the user gesture is still being
 * processed — the same task as the click event. Put ANY `await` in front of it
 * (mark-as-applied, an analytics call, a "fetch the fresh url" round-trip) and
 * the call lands in a later microtask/task, outside the gesture, where the
 * popup blocker silently drops it.
 *
 * "Silently" is the important word: on desktop the timing is usually forgiving
 * enough that it still works, so the bug ships looking fine and then the button
 * does NOTHING on a phone — no error, no toast, no clue. That is exactly the
 * defect fixed in PR #476 today; this helper exists so the next person cannot
 * reintroduce it by accident, and
 * `apps/web/app/components/job-sourcing/__tests__/open-original.test.ts` +
 * the mobile-profile E2E spec both fail if they do.
 *
 * The URL is re-checked here even though the API already validated it: it comes
 * from a third-party feed, and `window.open('javascript:…')` executes in OUR
 * origin. What this second check buys is POSITION — it runs at the call site, on
 * whatever string the component is actually holding, however it got there — and,
 * since SR-M-2, STRENGTH as well.
 *
 * It is NO LONGER the same predicate as the schema's, and the asymmetry is
 * deliberate and one-directional: every URL accepted HERE is also accepted by
 * `externalHttpsUrlSchema`, and NOT the reverse. The reason is availability, not
 * taste — `new URL` exists in this file (it runs in a browser) and does not exist
 * for `packages/shared`, which is DOM/Node-agnostic and must stay on a regex. So
 * this guard runs the real WHATWG parser on top of the shared shape.
 *
 * An earlier version of this comment claimed the two were "independent checks,
 * neither load-bearing alone", which was the misleading part: they used to fail
 * IDENTICALLY, so a hole in the shape was a hole in both (R11-H-4 — both
 * accepted embedded credentials). "Mirror them" is therefore no longer the
 * instruction. The instruction is the DIRECTION: narrowing the schema must
 * narrow this guard too; widening the schema must NOT widen this one silently.
 * What fails when they drift is not this comment but `EXTERNAL_URL_CORPUS`
 * (`packages/shared/src/schemas/job-sourcing-url-corpus.ts`), which states each
 * guard's verdict absolutely, per guard, and which this file's test runs.
 */

/**
 * `https:`-only, with a parseable non-empty host and no embedded credentials. A
 * relative, `http:`, `data:` or `javascript:` URL is refused, and so is
 * `https://user:pw@host/a`: `window.open` on it shows the user a plausible host
 * while opening someone else's page.
 *
 * TWO LAYERS, AND EACH REFUSES SOMETHING THE OTHER ACCEPTS. Neither is
 * decoration: `open-original.test.ts` carries a named test per rejection class,
 * and deleting either layer reddens a DISJOINT set of them. Measured in both
 * directions on this file's test, by deleting each layer in turn and counting:
 * without the `new URL` block 4 tests go red (the WHATWG-only shapes); without
 * the regex 11 go red, including the smuggled-scheme ones. That pair of numbers
 * is the evidence that the two layers are not copies of each other — which was
 * CR-M-2's complaint — and it is cheap to re-measure, so re-measure rather than
 * trust it after editing either layer.
 *
 * LAYER 1 — the shape regex. MIRRORS, by name and deliberately,
 * `externalHttpsUrlSchema` in `packages/shared/src/schemas/job-sourcing.ts` and
 * `HTTPS_URL_PATTERN` in `apps/api/src/database/schema/job-opportunities.ts`. The
 * authority — up to the first `/`, `?` or `#` — must be non-empty and free of `@`
 * and whitespace; a path, query or fragment may follow and may contain `@`,
 * because `https://host/a@b` is an ordinary posting URL and
 * `canonicalizePostingUrl` legitimately produces `https://host/path?kept=params`.
 *
 * The LEADING `^` carries the scheme check, and as the code stands it carries it
 * ALONE — measured, by deleting layer 2 and layer 1 in turn (see the numbers
 * above): `new URL('javascript:https://evil.test/a')` PARSES, with
 * `protocol === 'javascript:'`, and nothing in layer 2 looks at `protocol` any
 * more (those operands were deleted as unkillable — see the comment in the
 * `try`), so with the anchor gone that string reaches `window.open`. It also
 * normalises `https:/host.test/x` (one slash) into a valid https URL and accepts
 * `https://@host.test/a` (empty userinfo) outright.
 *
 * TWO THINGS KEEP THE ANCHOR HERE BEYOND THAT, and they survive any later change
 * to layer 2: it is the CHEAPEST refusal, rejecting before anything is parsed;
 * and the shared schema and the column CHECK are pinned on this same anchored
 * shape, so dropping it here would break the three-way mirror even if some other
 * check happened to cover the same inputs. The one thing not to conclude is that
 * the anchor is decorative — delete it and the smuggling tests go red.
 *
 * (An earlier revision of this comment claimed the same thing with a reason that
 * had stopped being true, and the asymmetry is worth keeping in mind: if anyone
 * reintroduces a `protocol` check on the parsed value, layer 2 starts covering
 * for the anchor, and the anchor's own mutants stop being killable. The two
 * cannot both be pinned.)
 *
 * Layer 1 is also the ONLY layer refusing whitespace inside
 * the URL: `new URL` silently strips tab/CR/LF and percent-encodes NBSP, so
 * `https://ho<TAB>st.test/a` survives it. (On the shared side `.url()` runs first
 * and, measured, would not have helped with the smuggling either: it accepts
 * that string too.)
 *
 * LAYER 2 — `new URL`, which the shared schema cannot have. A bare regex is a
 * shape check with no parser behind it, so on its own it accepts strings the
 * WHATWG parser rejects outright: `https://:443/a` (empty host with a port),
 * `https://h.test:99999/a` (port out of range), `https://a%40b.test/` (an `@`
 * smuggled into the host percent-encoded) and a C0 control inside the host. Those
 * did not merely slip through before — `window.open` would throw a SyntaxError
 * out of `new URL`, INSIDE the click handler, which is worse than a `false`.
 *
 * Layer 2 asserts NOTHING on the parsed object — not `protocol`, not `username` /
 * `password`, not `host`. Those four checks were here and were deleted: behind
 * layer 1 no input can make any of them false, so they were four mutants nobody
 * could kill, and they masked layer 1's own operands while they existed. The
 * measurement and the per-operand reasoning are in the `try` block below.
 *
 * Trimming happens HERE, so the string this predicate tests is the trimmed one.
 * `openOriginalPosting` must open that same trimmed string — see the note there.
 * The gap between those two sentences is where SR-M-2 lived.
 */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const candidate = url.trim()
  if (!/^https:\/\/[^\s/?#@]+([/?#]\S*)?$/i.test(candidate)) return false
  try {
    // ONLY THE THROW IS LOAD-BEARING IN LAYER 2, and that is deliberate.
    //
    // This used to be `new URL(candidate)` followed by a conjunction asserting
    // `protocol === 'https:'`, `username === ''`, `password === ''` and
    // `host !== ''`. All four were REDUNDANT BEHIND THE REGEX, and the mutation
    // gate said so: 16 survivors, because no input can distinguish them.
    // Measured over 29 adversarial inputs (14 of which reach this line — IDN,
    // IPv6, `%2F@`, `\@`, a trailing dot, an empty port, `https://@host/`):
    // not one makes any of the four false. The structural reason, per operand:
    //   * `protocol` — the regex pins a literal `https://` at position 0, so a
    //     parse of that string cannot yield another scheme;
    //   * `username` / `password` — userinfo exists only before an `@` in the
    //     authority, and the regex's authority class excludes `@`;
    //   * `host` — https is a special scheme, so an empty host is a PARSE
    //     FAILURE, which means it leaves by the `catch` below and never reaches
    //     a return value to check.
    // They are deleted rather than suppressed: a suppression would have had to
    // cover this whole expression, hiding the operands that DO carry the
    // security property along with the four that carry nothing.
    //
    // What remains here is the one thing the regex cannot see — whether the
    // string PARSES as a URL at all. That is not redundancy: `https://:443/a`,
    // port `:99999`, `%40` in a host and a C0 control in a host all satisfy the
    // regex's authority class and all throw (SR-M-2, measured), and each has a
    // named test. Symmetrically, the regex is the only layer refusing a
    // smuggled scheme and internal whitespace, which `new URL` accepts or
    // strips. Neither layer masks the other any more, which is why both are
    // now mutation-killable.
    //
    // ORDER: regex first, and the verdict does not depend on it — the two are a
    // conjunction of independent predicates with no shared operand, so either
    // order accepts and refuses exactly the same strings. The regex goes first
    // because it is the MIRROR, the shape shared with `externalHttpsUrlSchema`
    // and the column CHECK, so a reader meets the mirrored check first and
    // `new URL` reads as the supplement it is. Do NOT reintroduce assertions on
    // the parsed object to "harden" this: that is precisely what un-pins both
    // layers.
    new URL(candidate)
    return true
  } catch {
    // `new URL` throws on an unparseable URL, and this is the one place that
    // throw is harmless. Letting it escape would blow up the click handler.
    return false
  }
}

/**
 * Open an external posting in a new tab. Returns `false` when the URL was
 * refused, so the caller can surface an error instead of a dead click.
 *
 * `noopener,noreferrer` — the opened page must not get a handle on our window
 * (reverse tabnabbing) and must not learn the CRM URL it came from.
 *
 * THE STRING VALIDATED AND THE STRING OPENED ARE ONE VARIABLE — `target`, the
 * TRIMMED one. That is a choice, not an accident, and it is the fix for SR-M-2,
 * where `isSafeExternalUrl` tested `url.trim()` while `window.open` was handed the
 * raw `url`. A leading U+00A0, U+FEFF or U+2028 passed the check and reached
 * `window.open`, whose own preprocessing strips ONLY C0 controls and space: it saw
 * a string with no scheme at that position and resolved it against the CRM origin,
 * or threw.
 *
 * TRIMMED is the right side of that choice, and the argument is specific rather
 * than stylistic: `String.prototype.trim` removes only Unicode whitespace, and no
 * whitespace character can carry a scheme or an authority, so trimming cannot turn
 * a refused URL into a DIFFERENT accepted one — it can only normalise a feed's
 * stray padding. Opening the RAW string would instead mean the last barrier before
 * `window.open` audits a string nobody opens, which is not a barrier.
 *
 * Reintroducing the skew now takes editing two expressions into disagreement
 * rather than forgetting a `.trim()`, and the test "opens the string it validated,
 * not the raw one" asserts on `open.mock.calls` — so a `true` return cannot hide
 * it, which asserting the return value alone could not detect.
 */
export function openOriginalPosting(
  url: string | null | undefined,
  open: typeof window.open = typeof window === 'undefined' ? () => null : window.open.bind(window),
): boolean {
  // Early return rather than a `: ''` fallback on the next line. The fallback was
  // unobservable — a non-string input is refused whichever placeholder it becomes,
  // so the literal was a mutant no test could kill. Removing it deletes the
  // operand instead of explaining it, and leaves `target` with exactly one
  // possible origin: the trimmed argument.
  if (typeof url !== 'string') return false
  const target = url.trim()
  if (!isSafeExternalUrl(target)) return false
  open(target, '_blank', 'noopener,noreferrer')
  return true
}
