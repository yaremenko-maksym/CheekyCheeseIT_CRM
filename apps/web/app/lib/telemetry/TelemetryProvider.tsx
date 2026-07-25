/**
 * telemetry/TelemetryProvider — mounts the CRM-wide telemetry SDK
 * (task-telemetry-web). Wrapped around the ENTIRE app in `__root.tsx`
 * (above auth — `AuthProvider` is mounted per-route, `/login` and
 * `/_authenticated` each have their own), so error/route/click signals are
 * captured on every CRM route, including pre-auth pages — see `vision:` in
 * this task's final commit.
 *
 * Every sub-hook independently no-ops when `VITE_TELEMETRY` isn't `'on'`
 * (AC2) — the composition here doesn't add its own gate, it would just be
 * redundant. The `ErrorBoundary`, however, is ALWAYS active regardless of
 * the flag: a crashed React tree needs a fallback UI no matter whether
 * telemetry reporting is on (see `ErrorBoundary.tsx` — its own
 * `reportClientError` call is what's gated).
 *
 * MED-2 (code review round 1): the four hooks below run BEFORE (are
 * ancestors of, not descendants of) `TelemetryErrorBoundary` in the tree —
 * the boundary only wraps `children`. So a throw inside any of their effect
 * bodies or the listeners they register would crash the whole app UNCAUGHT
 * by that boundary. Each hook routes its own effect body (and every
 * listener it registers) through `safeCall` (`safe-call.ts`) instead — see
 * that file's header for the full rationale. Restructuring the tree so the
 * boundary sat above these hooks was considered and rejected: the hooks
 * need `useRouter()`/DOM listeners that must run regardless of whether a
 * DESCENDANT's render throws, and `safeCall` is the narrower, sufficient fix.
 */
import type { ReactNode } from 'react'
import { TelemetryErrorBoundary } from './ErrorBoundary'
import { useClickDelegation } from './use-click-delegation'
import { useGlobalErrorHandlers } from './use-global-error-handlers'
import { useRouteTelemetry } from './use-route-telemetry'
import { useVisibilityFlush } from './use-visibility-flush'

export function TelemetryProvider({ children }: { children: ReactNode }) {
  useGlobalErrorHandlers()
  useRouteTelemetry()
  useClickDelegation()
  useVisibilityFlush()
  return <TelemetryErrorBoundary>{children}</TelemetryErrorBoundary>
}
