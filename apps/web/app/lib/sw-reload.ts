/**
 * Deferred page reload on Service Worker change (controllerchange).
 *
 * After a redeploy VitePWA (autoUpdate + skipWaiting + clientsClaim) activates
 * the new SW in the background, but an open tab keeps running the old bundle from
 * memory. This module holds the pure reload-decision function, exported for unit
 * testing separately from the DOM glue in client.tsx.
 *
 * The reload is deferred while the tab is visible: ~6 deploys a day plus a stale
 * precache shell caused a reload 2-3 s after opening and mid-use on phones.
 * The reload runs once the tab goes to the background (visibilityState === 'hidden').
 */

export interface SWReloadOptions {
  /** true if an active controller already existed when the page loaded. */
  hadControllerAtLoad: boolean
  /** true if a reload has already been initiated (guards against double fire). */
  alreadyReloading: boolean
  /** true if the tab is currently visible; a reload must not interrupt use. */
  pageVisible: boolean
}

/**
 * Decides whether the page may be reloaded now (after `controllerchange`).
 *
 * Rules:
 *   - No controller at page start: this is the first SW install (not an update),
 *     no reload needed.
 *   - A reload is already in progress: do not duplicate it.
 *   - The page is visible: do not reload (defer until the tab is hidden).
 *   - Otherwise: reload.
 *
 * Pure (deterministic) function without side effects; DOM / window live in client.tsx.
 */
export function shouldReloadOnControllerChange({
  hadControllerAtLoad,
  alreadyReloading,
  pageVisible,
}: SWReloadOptions): boolean {
  if (!hadControllerAtLoad) return false
  if (alreadyReloading) return false
  if (pageVisible) return false
  return true
}
