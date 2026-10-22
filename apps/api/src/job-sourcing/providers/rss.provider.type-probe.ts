import type { SourceConfigFields } from './reporting-provider'
import type { FeedInventory, RssSourceSpec } from './rss.provider'

/**
 * TYPES ONLY — and here that is literally true: there is not one runtime statement in this file,
 * not even a never-called function. A function body is still a block the mutation gate generates
 * a mutant for (and reports as uncovered), so each probe is a TYPE alias: `Holds<…>` accepts only
 * `true`, so a probe whose condition is `false` is a compile error, and `@ts-expect-error` claims
 * exactly that error. This file is compiled by `pnpm typecheck`; specs are not.
 *
 * HOW IT FAILS: make `inventory` optional, or widen `FeedInventory`, and the condition becomes
 * `true` — the error disappears, the directive goes unused, and `tsc` reports it.
 *
 * WHAT IS NOT HERE, AND WHY: "`mapEntry` cannot set `nativeId`". The return type omits the field,
 * but TypeScript only refuses an extra property on a fresh object LITERAL; a value built elsewhere
 * and returned passes structurally. So that guarantee is enforced at run time — the base writes
 * `nativeId` after the adapter's fields — and is asserted in `rss.provider.spec.ts` ("the base
 * sets the native id"), which is the only place it can genuinely fail.
 */
interface ProbeConfig extends SourceConfigFields {
  query: string | null
  window: null
}
type Spec = RssSourceSpec<ProbeConfig>
type Holds<T extends true> = T

/** A feed adapter must state whether its feed is complete or a recent window. */
// @ts-expect-error a spec without `inventory` is not an RssSourceSpec
export type InventoryIsRequired = Holds<Omit<Spec, 'inventory'> extends Spec ? true : false>

/** There is no third kind of inventory for a coverage claim to hide in. */
// @ts-expect-error `{ kind: 'ALL_TIME' }` is not a FeedInventory
export type InventoryIsClosed = Holds<{ kind: 'ALL_TIME' } extends FeedInventory ? true : false>
