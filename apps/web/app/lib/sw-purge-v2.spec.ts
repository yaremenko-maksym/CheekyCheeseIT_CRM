/**
 * Unit coverage for apps/web/public/sw-purge-v2.js — security
 * MED-5 (task-scan-cache-leak, security-review PR #477 same review):
 * "сама чистка не покрыта ни одним тестом" — the only prior coverage was the
 * `cache` Playwright project, which is NOT run in CI (`KNOWN_UNSHARDED`,
 * requires externally-started servers — see apps/e2e/playwright.config.ts).
 *
 * WHY sandboxed execution instead of `import`: the target file is
 * deliberately a plain, untransformed script (see its own header comment) —
 * `public/` files are copied to the build output as-is and injected into the
 * generated `sw.js` via workbox's `importScripts`. It is NOT an ES module and
 * intentionally has no exports, so there is nothing to `import`. This test
 * reads the raw source and runs it with `new Function(...)` against minimal
 * `self` / `caches` / `indexedDB` fakes — the same three globals a real
 * Service Worker provides — captures the `activate` listener the script
 * registers, and asserts what it does when the browser fires that event.
 *
 * Covers:
 *   - AC3: media-cache (in addition to the pre-existing api-cache) is purged
 *     on activation — the actual accumulated-scan cleanup.
 *   - AC4 / security MED-2: the shared `workbox-expiration` IndexedDB
 *     database (workbox-expiration's CacheTimestampsModel — the list of
 *     every URL a user's browser cached, which survives `caches.delete()`
 *     because it's a separate store) is deleted too, so "what was viewed"
 *     does not outlive the purge.
 *
 * Filename note (security HIGH-1 round 2, security-review PR #479 review
 * `4864575278`): the target script was renamed from
 * `sw-purge-stale-api-cache.js` to `sw-purge-v2.js` — the path is caught by
 * nginx's immutable-1y static-asset rule, and the SW's default
 * `updateViaCache: 'imports'` means an `importScripts()`-imported file (this
 * one) is fetched through that same HTTP cache, not always from the network.
 * A same-named edit is invisible to any device that already cached the old
 * body (verified live on prod — the purge fix in v1 reached zero devices).
 * This spec's `scriptPath` MUST be kept in sync with whatever filename is
 * currently live (see the naming-convention block at the top of the target
 * file itself, and the matching comment in vite.config.ts's
 * `importScripts`).
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/sw-purge-v2.js',
)
const scriptSource = readFileSync(scriptPath, 'utf8')

interface FakeIdbRequest {
  onsuccess?: (() => void) | null
  onerror?: (() => void) | null
  onblocked?: (() => void) | null
}

/**
 * Loads the raw SW script against fresh fakes and returns the captured
 * `activate` listener. Re-executed per test so mock call counts never bleed
 * across tests.
 */
function loadActivateHandler(idbOutcome: 'success' | 'error' | 'blocked' = 'success') {
  const deleteMock = vi.fn(() => Promise.resolve(true))
  const fakeCaches = { delete: deleteMock }

  const deleteDatabaseMock = vi.fn((_name: string) => {
    const req: FakeIdbRequest = {}
    // Real IDB requests are always async — defer to a microtask so the
    // script's synchronous `req.onsuccess = ...` assignment (which runs
    // right after `indexedDB.deleteDatabase()` returns) has already
    // happened by the time we fire it, exactly like a real browser.
    queueMicrotask(() => {
      if (idbOutcome === 'success') req.onsuccess?.()
      else if (idbOutcome === 'error') req.onerror?.()
      else req.onblocked?.()
    })
    return req
  })
  const fakeIndexedDB = { deleteDatabase: deleteDatabaseMock }

  let activateHandler: ((event: { waitUntil: (p: Promise<unknown>) => void }) => void) | null = null
  const fakeSelf = {
    addEventListener: vi.fn((type: string, handler: typeof activateHandler) => {
      if (type === 'activate') activateHandler = handler
    }),
  }

  // Sandboxed execution of a plain, non-module SW script (see file header) —
  // scriptSource is OUR OWN repo file read by path, never user input.
  const run = new Function('self', 'caches', 'indexedDB', scriptSource)
  run(fakeSelf, fakeCaches, fakeIndexedDB)

  expect(activateHandler, 'Expected the script to register an activate listener').not.toBeNull()

  return { activateHandler: activateHandler!, deleteMock, deleteDatabaseMock }
}

async function fireActivate(
  activateHandler: (event: { waitUntil: (p: Promise<unknown>) => void }) => void,
): Promise<void> {
  let captured: Promise<unknown> | null = null
  activateHandler({
    waitUntil: (p) => {
      captured = p
    },
  })
  expect(captured, 'Expected activate handler to call event.waitUntil(...)').not.toBeNull()
  await captured
}

describe('sw-purge-v2.js — activation purge (security AC3/AC4, MED-2)', () => {
  it('AC3: purges BOTH api-cache and media-cache on activation', async () => {
    const { activateHandler, deleteMock } = loadActivateHandler()
    await fireActivate(activateHandler)

    expect(deleteMock).toHaveBeenCalledWith('api-cache')
    expect(deleteMock).toHaveBeenCalledWith('media-cache')
    expect(deleteMock).toHaveBeenCalledTimes(2)
  })

  it('AC4/MED-2: deletes the shared workbox-expiration IndexedDB database', async () => {
    const { activateHandler, deleteDatabaseMock } = loadActivateHandler()
    await fireActivate(activateHandler)

    expect(deleteDatabaseMock).toHaveBeenCalledWith('workbox-expiration')
    expect(deleteDatabaseMock).toHaveBeenCalledTimes(1)
  })

  it('is best-effort: an IDB error must not reject activation', async () => {
    const { activateHandler, deleteMock } = loadActivateHandler('error')
    await expect(fireActivate(activateHandler)).resolves.toBeUndefined()
    // Cache purge still ran regardless of the IDB outcome.
    expect(deleteMock).toHaveBeenCalledWith('media-cache')
  })

  it('is best-effort: a blocked IDB delete must not hang activation', async () => {
    const { activateHandler } = loadActivateHandler('blocked')
    await expect(fireActivate(activateHandler)).resolves.toBeUndefined()
  })
})
