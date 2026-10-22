import type { SourceConfigFields } from './reporting-provider'
import type { FeedInventory, RssSourceSpec } from './rss.provider'

/**
 * TYPES ONLY — `declare const` values and a never-called function, for the reason given at the
 * top of `reporting-provider.type-probe.ts`: this file is compiled by `pnpm typecheck` (specs are
 * not), and a probe written as real literals is live code the mutation gate reports as uncovered.
 *
 * HOW IT FAILS: make `inventory` optional, or widen `FeedInventory`, and the assignment below
 * stops being an error — the directive goes unused and `tsc` reports it.
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

declare const specWithoutInventory: Omit<RssSourceSpec<ProbeConfig>, 'inventory'>
declare const unknownInventory: { kind: 'ALL_TIME' }

export function inventoryIsADeclaration(): void {
  // @ts-expect-error a feed adapter must state whether its feed is complete or a recent window
  const spec: RssSourceSpec<ProbeConfig> = specWithoutInventory
  void spec

  // @ts-expect-error there is no third kind of inventory for a coverage claim to hide in
  const inventory: FeedInventory = unknownInventory
  void inventory
}
