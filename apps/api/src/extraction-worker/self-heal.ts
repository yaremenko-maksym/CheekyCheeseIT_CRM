import {
  createManagedListWriter,
  routerConfigSchema,
  runDailyModelRefresh,
  runModelChainCheck,
  runStartupModelRefresh,
  type ModelRefreshDeps,
  type ModelRefreshResult,
  type RouterEvent,
} from '@crm/inference'
import type { WorkerLogLine } from './server'

export const DAILY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
export const CHAIN_CHECK_INTERVAL_MS = 7 * DAILY_REFRESH_INTERVAL_MS

type Job = (deps: ModelRefreshDeps) => Promise<ModelRefreshResult>

export type SelfHealOptions = Omit<
  ModelRefreshDeps,
  'config' | 'onEvent' | 'sleep' | 'hadOkCall' | 'fetchImpl' | 'writeManagedList'
> & {
  config: unknown
  /** The managed-list file; the self-heal jobs are its only writer (ADR §3.2). */
  listPath: string
  log: (line: WorkerLogLine) => void
  /** The 5.4c-2b jobs; a test passes fakes. */
  jobs?: { startup: Job; daily: Job; chain: Job }
}

/**
 * The self-heal timers of ADR §3.4, inside the extraction worker (main has no scheduler): the
 * start-up refresh at once, the daily refresh each day, the chain check each week. `record` feeds
 * the router's events in, so a hosted model with an `OK` call since the last daily run is not
 * probed. A config the router refuses schedules nothing: that router sends nothing either.
 */
export function scheduleSelfHeal(opts: SelfHealOptions): {
  record(e: RouterEvent): void
  stop(): void
} {
  const okCalls = new Set<string>()
  const key = (p: string, model: string): string => `${p}\n${model}`
  const record = (e: RouterEvent): void => {
    if (e.type === 'ATTEMPT' && e.code === 'OK' && e.route !== 'local') {
      okCalls.add(key(e.route, e.model))
    }
  }
  const config = routerConfigSchema.safeParse(opts.config)
  if (!config.success) return { record, stop: () => undefined }

  const jobs = opts.jobs ?? {
    startup: runStartupModelRefresh,
    daily: runDailyModelRefresh,
    chain: runModelChainCheck,
  }
  const deps: ModelRefreshDeps = {
    config: config.data,
    state: opts.state,
    ownCap: opts.ownCap,
    managedModels: opts.managedModels,
    writeManagedList: createManagedListWriter({
      path: opts.listPath,
      onEvent: (e) => opts.log({ event: 'STATE', ...e }),
    }),
    // Provider names, model ids, verdicts and codes only (the jobs' own contract).
    onEvent: (e) => opts.log({ event: 'REFRESH', ...e }),
    now: opts.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    hadOkCall: (p, model) => okCalls.has(key(p, model)),
  }
  // No error text: it could carry a config value.
  const run = (job: 'startup' | 'daily' | 'chain', after?: () => void): void => {
    jobs[job](deps).then(after, () =>
      opts.log({ event: 'REFRESH', type: 'MODEL_REFRESH_FAILED', job }),
    )
  }
  run('startup')
  // The ledger covers one day: cleared only after a daily run that saw it finished.
  const daily = setInterval(() => run('daily', () => okCalls.clear()), DAILY_REFRESH_INTERVAL_MS)
  const chain = setInterval(() => run('chain'), CHAIN_CHECK_INTERVAL_MS)
  daily.unref()
  chain.unref()
  return {
    record,
    stop: () => {
      clearInterval(daily)
      clearInterval(chain)
    },
  }
}
