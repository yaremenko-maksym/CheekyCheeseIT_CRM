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
 * origin. Two independent checks, neither one load-bearing alone.
 */

/** `https:`-only. A relative, `http:`, `data:` or `javascript:` URL is refused. */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /^https:\/\/\S+$/i.test(url.trim())
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
