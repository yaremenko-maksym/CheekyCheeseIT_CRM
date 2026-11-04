export * from './contracts/decision'
export * from './contracts/errors'
export * from './contracts/extraction'
export * from './contracts/config'
export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  boundedRequest,
  type FetchLike,
  type BoundedResult,
  type BoundedRequestOptions,
} from './http/bounded-request'
export * from './registry/model-registry'
export * from './registry/openrouter-catalog'
export * from './adapters/openrouter.extraction-adapter'
export * from './adapters/local.extraction-adapter'
export * from './adapters/jev.decision-adapter'
export * from './client'
export { stripUnstorableChars } from './internal/strip-unstorable'
export { extractJsonObject, parseExtraction, runExtraction } from './internal/extraction-pipeline'
// The router (ADR 2026-11-03, 5.4c-2): only what the extraction worker's wiring needs. The router
// core with its signal, the leaf, the hosts and the memory adapter stay internal.
export {
  routerConfigSchema,
  routerCallCeilingMs,
  isAllowedRouterLocalModelUrl,
  type RouterConfig,
  type RouterConfigInput,
} from './router/config'
export { routerInputCeilingChars } from './router/fit'
export {
  createRouterExtractionAdapter,
  type RouterDeps,
  type RouterEvent,
  type AttemptCode,
  type SkipCode,
} from './router/router'
export {
  createFileRouteStatePort,
  createOwnCapPort,
  type RouteStatePort,
  type OwnCapPort,
  type OwnCapUnit,
  type StateEvent,
  type FreeLimit,
} from './router/state'
export { createFileManagedModels, type ManagedModels } from './router/managed-models'
