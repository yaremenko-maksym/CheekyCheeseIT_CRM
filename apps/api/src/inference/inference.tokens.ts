export const INFERENCE_CLIENT = Symbol('INFERENCE_CLIENT')

/** Optional overrides for the model resolver (catalog fetcher, clock, cooldown) — tests inject doubles. */
export const INFERENCE_RESOLVER_OPTIONS = Symbol('INFERENCE_RESOLVER_OPTIONS')
