/**
 * telemetry/safe-call — code-review round 1 (MED-2).
 *
 * `TelemetryProvider` renders `<TelemetryErrorBoundary>{children}</...>` —
 * the boundary wraps `children` ONLY. The provider's OWN hooks
 * (`useGlobalErrorHandlers`/`useRouteTelemetry`/`useClickDelegation`/
 * `useVisibilityFlush`) run in `TelemetryProvider`'s OWN render/effects,
 * which sit ABOVE (are not descendants of) that boundary — a `componentDidCatch`
 * only catches throws from ITS subtree, never from its own ancestors/siblings.
 * A throw inside any of those effect bodies, or inside a listener they
 * register (router `onResolved`, a delegated `click`, `visibilitychange`),
 * would therefore crash the WHOLE app uncaught — exactly what the SDK must
 * never do (spec §3: telemetry is fail-silent, it never breaks prod UX).
 *
 * `safeCall` is the one place that invariant is enforced. Every hook in this
 * directory that runs code outside the boundary's subtree (i.e. every hook
 * called directly from `TelemetryProvider`, plus the listeners they
 * register) routes its body through this wrapper instead of duplicating a
 * try/catch. Pure enough to unit-test directly (`safe-call.test.ts`) without
 * mounting React at all.
 */
export function safeCall(fn: () => void, context: string): void {
  try {
    fn()
  } catch (err: unknown) {
    // fail-silent (spec §3): one console.debug, never a rethrow — a bug in
    // the telemetry SDK itself must never become a SECOND uncaught error.
    console.debug(`[telemetry] ${context} threw — swallowed (fail-silent)`, err)
  }
}
