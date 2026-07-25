/**
 * telemetry/config — task-telemetry-web §5 "Выключатель".
 *
 * `VITE_TELEMETRY` is a strict opt-IN switch: the SDK is a no-op unless the
 * var is exactly `'on'`. Default-DENY (not default-allow) on purpose — a
 * missing/misspelled/misconfigured build env must never silently start
 * shipping telemetry. Dev (`pnpm dev`, no env override) and the E2E stack
 * (no `VITE_TELEMETRY` set — see `apps/web/.env.example`) both fall through
 * to disabled automatically; only a build that explicitly sets
 * `VITE_TELEMETRY=on` (prod build-arg — devops follow-up, see PR body) turns
 * the SDK on.
 *
 * HOTFIX (prod-smoke, PR #415 follow-up): MUST be `import.meta.env.VITE_TELEMETRY`
 * (dot access), NOT `import.meta.env['VITE_TELEMETRY']` (bracket access).
 * Vite's build-time `define`-style static replacement of `import.meta.env.VITE_*`
 * ONLY recognizes the literal dot-property AST pattern — see
 * `routes/login.tsx`'s `SHOW_DEV_LOGIN` comment, which already documented this
 * exact pitfall for a DIFFERENT var before this bug shipped. Bracket access
 * survives into the bundle as a real runtime property read on the (stripped,
 * non-existent-at-runtime) `import.meta.env` object → always `undefined` in
 * prod, so `isTelemetryEnabled()` was a build-time constant `false` no matter
 * what `VITE_TELEMETRY` was set to. Confirmed on the live prod bundle: no
 * occurrence of `"on"` or `VITE_TELEMETRY` in `dist/assets` with the old
 * bracket form; the sentinel `console.debug` below now proves the fix
 * (see PR body's grep output on a real `VITE_TELEMETRY=on` build).
 */
let loggedEnabledSentinel = false

export function isTelemetryEnabled(): boolean {
  const enabled = import.meta.env.VITE_TELEMETRY === 'on'
  if (enabled && !loggedEnabledSentinel) {
    // Diagnostic + build-verification sentinel (hotfix AC3/AC4): grep
    // `dist/assets/*.js` for this exact string after a `VITE_TELEMETRY=on`
    // build to prove Vite actually folded the flag to `true` this time.
    // Logged once per module-eval (this getter is called repeatedly per
    // event/error, so gate behind a tiny local flag rather than console-spam
    // on every call).
    loggedEnabledSentinel = true
    console.debug('[telemetry] enabled')
  }
  return enabled
}

/**
 * Same per-build cache-buster already used by `__root.tsx`'s persister
 * (`CACHE_BUSTER`, injected via Vite `define` in `vite.config.ts`) — reused
 * here as the `appVersion` reported alongside client errors (spec §3 meta:
 * "ua, viewport, appVersion"). Dot access — same hotfix as `isTelemetryEnabled`
 * above (bracket access here was equally dead in prod bundles).
 */
export function currentAppVersion(): string | undefined {
  const v: unknown = import.meta.env.VITE_BUILD_VERSION
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
