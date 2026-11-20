# Job-sourcing scheduled work: request jitter (load-spreading)

Status: approved by the owner 2026-11-20 (P2).

## Intent

Job-sourcing collection, sweep, and detail runs start at fixed cron minutes and send requests at fixed gaps, so every day the same external hosts see bursts at the exact same second. Spreading that load avoids synchronous traffic spikes without altering the honest User-Agent, proxies, headers, fingerprints, or endpoints.

A jittered delay is always **added** to the existing minimum; it never shortens any gap, any `Crawl-delay`, any `HostRate` / `HostRequestBudget`, or any window deadline.

## Non-goals / Anti-goals

- **No User-Agent changes or spoofing:** The honest CRM User-Agent and contact information remain untouched.
- **No proxies, anti-bot bypass, or browser fingerprinting:** No Cloudflare challenge circumvention or cookie forgery.
- **No changes to cron schedules, budgets, or caps:** Crons still fire on their configured schedules; overall host budgets and rate caps are strictly respected.
- **No Conditional GET (ETag / Last-Modified):** Out of scope for this change.
- **No unseeded/inline Math.random in logic:** Pure random generator seams (`random: () => number`) are injected to guarantee deterministic, reproducible specs.

## Approaches Considered

1. **Fixed stagger per source ID (hash-based offset):**
   - _Pros:_ Deterministic offsets per source.
   - _Cons:_ Over time, sources still fire at predictable, correlated offsets; does not spread load across days or burst patterns.
2. **Poisson / exponential distribution jitter:**
   - _Pros:_ Mathematically models random arrivals.
   - _Cons:_ Long tails require arbitrary truncation; more complex than needed for simple load de-correlation.
3. **Uniform random bounded jitter taken from window budget (chosen):**
   - _Pros:_ Simple, robust, bounded. Start offset `U[0, min(10% window, 10 min)]` delays execution while reducing the window budget by the exact offset amount (`windowMs - offset`), ensuring the overall cycle completion deadline is unchanged. Host gap jitter `minGap * (1 + U[0, 0.5])` spreads requests evenly between 1x and 1.5x minimum gap without starving deadlines.

## Chosen Design

### 1. Pure Jitter Helpers (`apps/api/src/job-sourcing/scheduling/jitter.ts`)

- Constants:
  - `START_OFFSET_SHARE = 0.1` (10% of window)
  - `START_OFFSET_MAX_MS = 600_000` (10 minutes)
  - `GAP_JITTER_SHARE = 0.5` (+0% to +50%)
- Functions:
  - `startOffsetMs(windowMs: number, random: () => number = Math.random): number`: Returns integer milliseconds `Math.floor(random() * min(windowMs * 0.1, 600_000))`. Returns 0 if `windowMs <= 0`.
  - `jitteredGapMs(minGapMs: number, random: () => number = Math.random): number`: Returns integer milliseconds `Math.floor(minGapMs * (1 + random() * 0.5))`. Returns 0 if `minGapMs <= 0`. Never below `minGapMs`.

### 2. Start-Offset Jitter in Cron Handlers (`apps/api/src/job-sourcing/job-sourcing.cron.ts`)

- Target handlers: `handleDailyCollection`, `handleHtmlCollection`, `handleSweep`, and `handleDetailPass`.
- Excluded: `handleTick` (10-minute Kyiv slot tick) and `RoleAiCronService`.
- Mechanism:
  - Computes `offset = startOffsetMs(totalWindowMs, tuning.random)`.
  - Waits `tuning.sleep(offset)` inside the named step `${name}: wait start offset`.
  - Deducts `offset` from window budget passed to `runCollectionWindow`: `windowMs = Math.max(0, totalWindowMs - offset)`.
  - The step catches and logs any sleep interruption/error without rethrowing, preserving scheduler resilience.
  - Test seam: `tuning.random` and `tuning.sleep` default to `Math.random` and `setTimeout`.

### 3. Per-Host Gap Jitter

- **API Transport (`apps/api/src/job-sourcing/http/bounded-fetch.ts`):**
  - `throttle(host, minGapMs, random, signal)` applies `jitteredGapMs(minGapMs, random)`.
  - Respects `signal` aborts even when last request timestamp is zero or sleep is active.
- **HTML Provider (`apps/api/src/job-sourcing/providers/html/html-ports.ts`):**
  - `InMemoryHostGate` accepts injected `random: () => number = Math.random`.
  - In `acquire(origin, minGapMs, signal)`, calculates `gapMs = jitteredGapMs(minGapMs, this.random)` and schedules next allowed time `at + gapMs`.
  - Abort signals reject waiting promises immediately.

## Verification & Safety

- Unit tests in `jitter.spec.ts`, `bounded-fetch.spec.ts`, `html-ports.spec.ts`, `html-provider.spec.ts`, and `job-sourcing.cron.spec.ts`.
- Mutation tests via Stryker verify that constants, boundaries, and jitter arithmetic are killed if mutated.
- Zero live DB connections or production interference.
