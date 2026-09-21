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
