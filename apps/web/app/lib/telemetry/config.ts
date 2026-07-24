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
 */
export function isTelemetryEnabled(): boolean {
  return import.meta.env['VITE_TELEMETRY'] === 'on'
}

/**
 * Same per-build cache-buster already used by `__root.tsx`'s persister
 * (`CACHE_BUSTER`, injected via Vite `define` in `vite.config.ts`) — reused
 * here as the `appVersion` reported alongside client errors (spec §3 meta:
 * "ua, viewport, appVersion").
 */
export function currentAppVersion(): string | undefined {
  const v: unknown = import.meta.env['VITE_BUILD_VERSION']
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
