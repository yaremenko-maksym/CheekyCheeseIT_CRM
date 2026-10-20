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
 * and deleting either layer reddens a DISJOINT set of them.
 *
 * LAYER 1 — the shape regex. MIRRORS, by name and deliberately,
 * `externalHttpsUrlSchema` in `packages/shared/src/schemas/job-sourcing.ts` and
 * `HTTPS_URL_PATTERN` in `apps/api/src/database/schema/job-opportunities.ts`. The
 * authority — up to the first `/`, `?` or `#` — must be non-empty and free of `@`
 * and whitespace; a path, query or fragment may follow and may contain `@`,
 * because `https://host/a@b` is an ordinary posting URL and
 * `canonicalizePostingUrl` legitimately produces `https://host/path?kept=params`.
 *
 * The LEADING `^` is the operand carrying the scheme check, and it carries it
 * ALONE — layer 2 does not cover for it. Measured: `new URL` normalises
 * `https:/host.test/x` (one slash) into a valid https URL and accepts
 * `https://@host.test/a` (empty userinfo) outright, so with the anchor gone
 * `javascript:https://evil.test/a` reaches `window.open` — the smuggling this
 * file's header names. Layer 1 is also the ONLY layer refusing whitespace inside
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
 * out of `new URL`, INSIDE the click handler, which is worse than a `false`. This
 * layer is what makes the paragraph above true rather than aspirational.
 * `protocol` is re-checked on the PARSED value, not just the raw shape;
 * `username` and `password` must BOTH be empty, since either one alone is enough
 * to show a misleading host.
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
    const parsed = new URL(candidate)
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.host !== ''
    )
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
  const target = typeof url === 'string' ? url.trim() : ''
  if (!isSafeExternalUrl(target)) return false
  open(target, '_blank', 'noopener,noreferrer')
  return true
}
