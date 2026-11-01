/**
 * Where a source's posting description arrives (source fetch strategy ADR, 6a): `IN_LIST` when the
 * list response carries it (the default for every source), `ON_DEMAND` when the list lacks it and
 * the detail is fetched later, once, for a posting that is wanted.
 */
export const DETAIL_MODES = ['IN_LIST', 'ON_DEMAND'] as const
export type DetailMode = (typeof DETAIL_MODES)[number]

/**
 * SFS U10: the types whose `detailMode` is `ON_DEMAND`. One helper for both catalog builders (the
 * manifest one and the production snapshot one) so the rule lives in a single tested place.
 */
export function onDemandTypesOf<T extends { readonly type: S; readonly detailMode: DetailMode }, S>(
  types: readonly T[],
): S[] {
  return types.filter((t) => t.detailMode === 'ON_DEMAND').map((t) => t.type)
}
