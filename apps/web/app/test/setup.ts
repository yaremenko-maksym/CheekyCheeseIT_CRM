import '@testing-library/jest-dom'
import { i18n } from '@lingui/core'

/**
 * fix-round 1 (PR #699). A growing set of test files call
 * `translateZodMessage`/`translateZodError` (`apps/web/app/lib/axios-utils.ts`)
 * indirectly through component code under test — e.g. `PaySalaryDialog`,
 * `CreateTransactionDialog`, `SettleSeniorPayoutDialog`'s receipt validation,
 * `ChangePersonalEmailDialog`/`UserDialog`'s email field — none of which
 * themselves activate a Lingui locale. Before this task, `receiptMandatoryError`
 * returned raw prose that never touched the catalog, so no locale was needed;
 * now that it returns a `zod.<CODE>` key translated through `i18n._`, EVERY
 * such test crashes with "Attempted to call a translation function without
 * setting a locale" unless it happens to set one up itself (most did not).
 *
 * Activating a default 'uk' locale here — same empty-catalog pattern already
 * used ad hoc in `axios-utils.spec.ts` / `i18n-smoke.test.tsx` / `auth.spec.tsx`
 * (an EMPTY loaded catalog makes `i18n._` fall back to the descriptor's own
 * `message` field, i.e. the uk SOURCE text baked into `ZOD_ERROR_MESSAGES`
 * `/`API_ERROR_MESSAGES`, not a translation lookup) — fixes the whole class at
 * once instead of scattering the same two lines into every affected file. A
 * test file that needs a DIFFERENT locale (or the real compiled catalog) can
 * still call `i18n.load`/`i18n.activate` itself; Lingui's activation is not
 * one-shot, a later call simply switches it again.
 */
i18n.load('uk', {})
i18n.activate('uk')

/**
 * happy-dom 21 (GHSA-834v-8h66-3h79 bump). `Animation.cancel()` rejects the
 * animation's `finished` promise with an `AbortError` but does not mark that
 * rejection handled. The Web Animations spec (W3C web-animations-1, 4.4.14
 * "Canceling an animation") does both: step 1.2 rejects the current finished
 * promise with an AbortError, step 1.3 sets its [[PromiseIsHandled]] slot to
 * true. motion-dom calls `cancel()` through `NativeAnimation.stop()` on
 * unmount, so nothing attaches a catch and Vitest reports an unhandled
 * rejection (exit code 1 with every test green). Attaching a no-op catch first
 * supplies step 1.3's effect for the tracker only: `p.catch(noop)` derives a new
 * promise and leaves `p` rejecting for every other consumer. No product code is
 * involved.
 *
 * What is pinned: `animation-cancel-shim.test.ts` asserts both halves: no
 * `unhandledRejection` is emitted by `cancel()` (measured red without this
 * shim, green with it) and the promise that `cancel()` rejected still rejects
 * with an AbortError for a late consumer. It does not detect a shim that
 * swallows by replacing `finished`; the whole-suite exit code and 0-error count
 * remain the end-to-end check.
 *
 * Remove when: a later happy-dom marks the rejection handled itself, or motion-dom
 * stops calling `cancel()` on unmount. Delete this block together with that test.
 */
const animationProto = (
  globalThis as { Animation?: { prototype: { cancel: () => void; finished?: Promise<unknown> } } }
).Animation?.prototype
if (animationProto) {
  const originalCancel = animationProto.cancel
  animationProto.cancel = function cancel(this: { finished?: Promise<unknown> }) {
    this.finished?.catch(() => undefined)
    return originalCancel.call(this)
  }
}
