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
 * origin. What this second check buys is POSITION, not independence — it runs at
 * the call site, on whatever string the component is actually holding, however it
 * got there. It is deliberately the SAME predicate as the schema's, and an
 * earlier version of this comment claimed the two were "independent checks,
 * neither load-bearing alone", which was the misleading part: they fail
 * identically, so a hole in the shape is a hole in both (R11-H-4 — both accepted
 * embedded credentials). Mirror them, and change them together.
 */

/**
 * `https:`-only, with a host and no embedded credentials. A relative, `http:`,
 * `data:` or `javascript:` URL is refused, and so is `https://user:pw@host/a`:
 * `window.open` on it shows the user a plausible host while opening someone
 * else's page.
 *
 * MIRRORS, by name and deliberately, `externalHttpsUrlSchema` in
 * `packages/shared/src/schemas/job-sourcing.ts` and `HTTPS_URL_PATTERN` in
 * `apps/api/src/database/schema/job-opportunities.ts`. The authority — up to the
 * first `/`, `?` or `#` — must be non-empty and free of `@` and whitespace; a
 * path, query or fragment may follow and may contain `@`, because
 * `https://host/a@b` is an ordinary posting URL and `canonicalizePostingUrl`
 * legitimately produces `https://host/path?kept=params`.
 *
 * The one character the shared schema's class does NOT list is whitespace in the
 * authority: that schema has `.url()` in front of the regex and `.url()` refuses
 * it there already, so the operand would be unkillable by any test. This is a
 * bare regex with nothing in front of it, so it states the exclusion itself —
 * `https:// x` is refused HERE by this class, and the test says so.
 */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/i.test(url.trim())
}

/**
 * Open an external posting in a new tab. Returns `false` when the URL was
 * refused, so the caller can surface an error instead of a dead click.
 *
 * `noopener,noreferrer` — the opened page must not get a handle on our window
 * (reverse tabnabbing) and must not learn the CRM URL it came from.
 */
export function openOriginalPosting(
  url: string | null | undefined,
  open: typeof window.open = typeof window === 'undefined' ? () => null : window.open.bind(window),
): boolean {
  if (!isSafeExternalUrl(url)) return false
  open(url as string, '_blank', 'noopener,noreferrer')
  return true
}
