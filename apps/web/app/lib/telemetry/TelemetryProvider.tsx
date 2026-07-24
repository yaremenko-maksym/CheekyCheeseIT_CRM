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
