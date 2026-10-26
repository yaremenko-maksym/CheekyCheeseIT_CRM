/**
 * Where a source's posting description arrives (source fetch strategy ADR, 6a): `IN_LIST` when the
 * list response carries it (the default for every source), `ON_DEMAND` when the list lacks it and
 * the detail is fetched later, once, for a posting that is wanted.
 */
export const DETAIL_MODES = ['IN_LIST', 'ON_DEMAND'] as const
export type DetailMode = (typeof DETAIL_MODES)[number]
