import { randomUUID } from 'node:crypto'
import { constants, promises as nodeFs } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { parseJsonOrNull } from '../internal/chat-completions'
import { isValidProviderModelId } from '../internal/model-id'
import { HOSTED_PROVIDERS, ownCapOf, type HostedProvider } from './config'

/** Entry cap per list and byte ceiling checked before parsing (ADR §3.2, SR-M-6). */
export const MAX_STATE_ENTRIES = 300
export const MAX_STATE_BYTES = 64 * 1024

const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = z.string().regex(DAY)
const provider = z.enum(HOSTED_PROVIDERS)

/** Structured `provider` and `model`, never one joined string; the model passes the refresh's validation. */
const validModel = (e: { provider: HostedProvider; model: string }): boolean =>
  isValidProviderModelId(e.provider, e.model)
const spentEntry = z.object({ provider, model: z.string(), day }).strict().refine(validModel)
const retiredEntry = z
  .object({ provider, model: z.string(), code: z.literal('RETIRED'), at: z.iso.datetime() })
  .strict()
  .refine(validModel)
type SpentEntry = z.infer<typeof spentEntry>
type RetiredEntry = z.infer<typeof retiredEntry>

/** `N`: a new model earns its place above older ones after this many alive probe days (§3.4). */
export const PROMOTION_STREAK = 3
/** A Gemini model busy on this many consecutive probe days counts as dead (§3.4 verdicts). */
export const BUSY_DEAD_DAYS = 3
/** A model held by a busy-dead verdict gets at most one re-probe per this many UTC days. */
export const BUSY_DEAD_REPROBE_DAYS = 7
/**
 * Not `TARGET`: a cap that small would let six always-busy ids starve a good candidate. Dropping the
 * oldest verdict past it only restarts that model's three-day count. Also rests a candidate that
 * answered anything but alive and stayed off the list; dropping one of those returns it to the queue.
 */
export const MAX_BUSY_DEAD_ENTRIES = 50
/** The managed list keeps at most `TARGET` ids per provider (ADR §3.4, VCF: 5). */
export const MANAGED_LIST_TARGET = 5
/** A full list's records plus one, so the candidate being probed can build its streak (CR2-M-2). */
export const MAX_MODEL_RECORDS = MANAGED_LIST_TARGET + 1

/** Gemini only, as only the Gemini refresh probes: a hand-edited Groq record cannot promote anything. */
const probationEntry = z
  .object({
    provider: z.literal('gemini'),
    model: z.string(),
    aliveStreak: z.number().int().min(0).max(PROMOTION_STREAK),
    lastProbeDay: day,
  })
  .strict()
  .refine(validModel)
const busyEntry = z
  .object({
    provider: z.literal('gemini'),
    model: z.string(),
    busyDays: z.number().int().min(0).max(BUSY_DEAD_DAYS),
    lastProbeDay: day,
  })
  .strict()
  .refine(validModel)
const busyDeadEntry = z
  .object({ provider: z.literal('gemini'), model: z.string(), day })
  .strict()
  .refine(validModel)
const staleEntry = z.object({ provider, model: z.string() }).strict().refine(validModel)
export type ProbationEntry = z.infer<typeof probationEntry>
export type BusyEntry = z.infer<typeof busyEntry>
export type BusyDeadEntry = z.infer<typeof busyDeadEntry>
export type StaleEntry = z.infer<typeof staleEntry>

/** The self-heal jobs that report through the state file, with no answer to ride on (§5.3). */
export type ModelJob = 'daily' | 'chain'

/**
 * The document as loaded: `spent` and `retired` entries are checked one by one, so one bad entry
 * drops only itself. The self-heal lists hold promotion evidence, so one bad entry rejects the file.
 */
const routeStateDocument = z
  .object({
    version: z.literal(1),
    spent: z.array(z.unknown()).max(MAX_STATE_ENTRIES),
    retired: z.array(z.unknown()).max(MAX_STATE_ENTRIES),
    probation: z.array(probationEntry).max(MAX_MODEL_RECORDS).optional(),
    busy: z.array(busyEntry).max(MAX_MODEL_RECORDS).optional(),
    busyDead: z.array(busyDeadEntry).max(MAX_BUSY_DEAD_ENTRIES).optional(),
    modelListStale: z.array(staleEntry).max(MAX_STATE_ENTRIES).optional(),
    failedJobs: z
      .array(z.enum(['daily', 'chain']))
      .max(2)
      .optional(),
    providers: z
      .array(
        z
          .object({
            provider,
            auth: z.boolean(),
            creditDay: day.optional(),
            lastStartupRefreshAt: z.iso.datetime().optional(),
            ownCap: z
              .object({
                day,
                requests: z.number().int().nonnegative(),
                tokens: z.number().int().nonnegative(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(HOSTED_PROVIDERS.length),
  })
  .strict()

export type ProviderRecord = z.infer<typeof routeStateDocument>['providers'][number]
export type RouteState = {
  version: 1
  spent: SpentEntry[]
  retired: RetiredEntry[]
  probation?: ProbationEntry[] | undefined
  busy?: BusyEntry[] | undefined
  /** Held out of the list and of probation slots; `day` is the last probe that kept it held. */
  busyDead?: BusyDeadEntry[] | undefined
  /** Named entries the last chain check found dead; empty or absent is a clear flag (§3.4 L3). */
  modelListStale?: StaleEntry[] | undefined
  failedJobs?: ModelJob[] | undefined
  providers: ProviderRecord[]
}

/** Keeps the entries `schema` accepts; the count of the others is reported, never their content. */
function validEntries<T>(list: unknown[], schema: z.ZodType<T>): T[] {
  return list.flatMap((e) => {
    const r = schema.safeParse(e)
    return r.success ? [r.data] : []
  })
}

export const EMPTY_ROUTE_STATE: RouteState = { version: 1, spent: [], retired: [], providers: [] }

/** The calendar day a provider's daily limits reset on: midnight Pacific for Gemini, UTC for Groq (§5.1). */
export function providerDay(p: HostedProvider, nowMs: number): string {
  const timeZone = p === 'gemini' ? 'America/Los_Angeles' : 'UTC'
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(nowMs)
}

export type StateEvent =
  | {
      type: 'STATE_RESET'
      store: 'route-state' | 'managed-list'
      reason: 'invalid' | 'oversized' | 'unreadable'
    }
  /** Entries that failed validation were dropped; the rest of the file was kept (§3.2). */
  | { type: 'STATE_ENTRIES_DROPPED'; store: 'route-state'; count: number }
  | { type: 'STATE_WRITE_FAILED'; store: 'route-state' | 'managed-list'; reason?: 'oversized' }

/**
 * Spent, retired and provider-level bits (ADR §3.2). `snapshot` is the in-memory read path;
 * `update` applies a change to memory at once and writes the whole document through, resolving
 * `false` when that write failed (the change stays in memory). A change whose document would pass
 * the byte ceiling is refused whole: no memory change, no write, `false`.
 */
export interface RouteStatePort {
  snapshot(): RouteState
  update(change: (s: RouteState) => RouteState): Promise<boolean>
}

export function createMemoryRouteStatePort(
  initial: RouteState = EMPTY_ROUTE_STATE,
): RouteStatePort {
  let state = initial
  return {
    snapshot: () => state,
    update: async (change) => {
      state = change(state)
      return true
    },
  }
}

/** The slice of a `fs.promises` file handle the file adapters use. */
export type StateFileHandle = {
  stat(): Promise<{ size: number; isFile(): boolean }>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  writeFile(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** The slice of `fs.promises` the file adapters use; `node:fs` satisfies it, a fake replaces it in tests. */
export type StateFs = {
  open(path: string, flags: number, mode?: number): Promise<StateFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

/** A flag this platform may lack (Windows has neither `O_NOFOLLOW` nor `O_NONBLOCK`): absent is no bit. */
export function platformFlag(flag: number | undefined): number {
  return flag ?? 0
}
/**
 * Read: a planted symlink is refused (SR-L-67) and a planted FIFO cannot block the open (SR-L-73).
 * Write: a fresh temp file only, never an existing one or a link to it (SR-L-72).
 */
export const STATE_READ_FLAGS =
  constants.O_RDONLY | platformFlag(constants.O_NOFOLLOW) | platformFlag(constants.O_NONBLOCK)
export const STATE_WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | platformFlag(constants.O_NOFOLLOW)

export type StateFileOptions = {
  path: string
  now: () => number
  fs?: StateFs
  /** Mandatory (ADR §3.2, §5.3): a reset or a failed write is never silent. */
  onEvent: (e: StateEvent) => void
}

type ReadOutcome =
  { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'oversized' | 'unreadable' }

const errnoOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code

/**
 * Reads a state file as text through one handle: the size is checked on the open file and at
 * most `MAX_STATE_BYTES + 1` bytes are ever read, so a file that grows after the check is still refused.
 */
export async function readStateText(fs: StateFs, path: string): Promise<ReadOutcome> {
  let file: StateFileHandle
  try {
    file = await fs.open(path, STATE_READ_FLAGS)
  } catch (err) {
    return errnoOf(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  try {
    const info = await file.stat()
    if (!info.isFile()) return { kind: 'unreadable' } // a FIFO, a device or a directory (SR-L-73)
    if (info.size > MAX_STATE_BYTES) return { kind: 'oversized' }
    const buf = new Uint8Array(MAX_STATE_BYTES + 1)
    let total = 0
    for (;;) {
      const { bytesRead } = await file.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_STATE_BYTES) return { kind: 'oversized' }
    }
    return { kind: 'text', text: new TextDecoder().decode(buf.subarray(0, total)) }
  } catch {
    return { kind: 'unreadable' }
  } finally {
    await file.close().catch(() => undefined)
  }
}

/**
 * Durable atomic replace: a new `0600` temp file under a random name in the same directory, fsync,
 * rename, fsync the directory. A failed write removes its own temp file.
 */
export async function writeAtomic(fs: StateFs, path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  const file = await fs.open(tmp, STATE_WRITE_FLAGS, 0o600)
  try {
    try {
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
  try {
    const dir = await fs.open(dirname(path), constants.O_RDONLY)
    await dir.sync().finally(() => dir.close())
  } catch {
    // shortcut: a directory cannot be opened for fsync on Windows; the rename is already durable on the
    // worker's Linux volume, which is the only production target.
  }
}

/** Spent entries of past provider days are dropped on load (§3.2 pruning). */
function prune(s: RouteState, nowMs: number): RouteState {
  return { ...s, spent: s.spent.filter((e) => e.day >= providerDay(e.provider, nowMs)) }
}

/** An observer only watches: the disk decides a write, so a throwing one changes no outcome (SR-L-20). */
export const quietObserver =
  (onEvent: (e: StateEvent) => void) =>
  (e: StateEvent): void => {
    try {
      onEvent(e)
    } catch {
      // Nothing to tell: the observer is the channel that failed.
    }
  }

/**
 * The worker state file behind the `RouteStatePort` (ADR §3.2, D4). An unreadable, invalid or
 * oversized file is empty state and raises `STATE_RESET`; one serialised writer writes the whole
 * document after every change, so two concurrent changes cannot lose each other.
 */
export async function createFileRouteStatePort(opts: StateFileOptions): Promise<RouteStatePort> {
  const fs: StateFs = opts.fs ?? nodeFs
  const emit = quietObserver(opts.onEvent)
  let state = EMPTY_ROUTE_STATE
  const read = await readStateText(fs, opts.path)
  if (read.kind === 'text') {
    // Data, never code: the JSON is only ever handed to the schema.
    const parsed = routeStateDocument.safeParse(parseJsonOrNull(read.text))
    if (parsed.success) {
      const doc = parsed.data
      const spent = validEntries(doc.spent, spentEntry)
      const retired = validEntries(doc.retired, retiredEntry)
      const dropped = doc.spent.length - spent.length + doc.retired.length - retired.length
      if (dropped > 0) emit({ type: 'STATE_ENTRIES_DROPPED', store: 'route-state', count: dropped })
      state = prune({ ...doc, spent, retired }, opts.now())
    } else {
      emit({ type: 'STATE_RESET', store: 'route-state', reason: 'invalid' })
    }
  } else if (read.kind !== 'missing') {
    emit({ type: 'STATE_RESET', store: 'route-state', reason: read.kind })
  }
  let queue: Promise<unknown> = Promise.resolve()
  return {
    snapshot: () => state,
    update: (change) => {
      const next = change(state)
      const doc = JSON.stringify(next)
      // The reader would reset a file past the ceiling, and lose every record with it.
      if (Buffer.byteLength(doc) > MAX_STATE_BYTES) {
        emit({ type: 'STATE_WRITE_FAILED', store: 'route-state', reason: 'oversized' })
        return Promise.resolve(false)
      }
      state = next
      const write = queue.then(() => writeAtomic(fs, opts.path, doc))
      queue = write.catch(() => undefined)
      return write.then(
        () => true,
        () => {
          emit({ type: 'STATE_WRITE_FAILED', store: 'route-state' })
          return false
        },
      )
    },
  }
}

// ---- pure readers and changes over RouteState, used by the router ----

export function isSpent(s: RouteState, p: HostedProvider, model: string, today: string): boolean {
  // `>=`: a clock that went back keeps a spent mark rather than re-opening the model.
  return s.spent.some((e) => e.provider === p && e.model === model && e.day >= today)
}

export function isRetired(s: RouteState, p: HostedProvider, model: string): boolean {
  return s.retired.some((e) => e.provider === p && e.model === model)
}

export function isBusyDead(s: RouteState, model: string): boolean {
  return s.busyDead?.some((e) => e.model === model) === true
}

/** A held model's re-probe comes due `BUSY_DEAD_REPROBE_DAYS` UTC days after its stamp. */
export function isBusyDeadReprobeDue(s: RouteState, model: string, today: string): boolean {
  const gap = BUSY_DEAD_REPROBE_DAYS * 86_400_000
  return (
    s.busyDead?.some((e) => e.model === model && Date.parse(today) - Date.parse(e.day) >= gap) ===
    true
  )
}

export function providerRecord(s: RouteState, p: HostedProvider): ProviderRecord {
  return s.providers.find((r) => r.provider === p) ?? { provider: p, auth: false }
}

/** `AUTH` persists until its proof (5.4c-2b); `CREDIT` until the provider day turns. */
export function isProviderBlocked(s: RouteState, p: HostedProvider, today: string): boolean {
  const r = providerRecord(s, p)
  return r.auth || (r.creditDay ?? '') >= today
}

function withProvider(
  s: RouteState,
  p: HostedProvider,
  change: (r: ProviderRecord) => ProviderRecord,
): RouteState {
  return {
    ...s,
    providers: [...s.providers.filter((r) => r.provider !== p), change(providerRecord(s, p))],
  }
}

/** Drops the oldest entries past the cap, so a long-lived file never becomes invalid by growth. */
function capped<T>(list: T[]): T[] {
  return list.slice(-MAX_STATE_ENTRIES)
}

export const markSpent =
  (p: HostedProvider, model: string, today: string) =>
  (s: RouteState): RouteState =>
    isSpent(s, p, model, today)
      ? s
      : { ...s, spent: capped([...s.spent, { provider: p, model, day: today }]) }

export const markRetired =
  (p: HostedProvider, model: string, nowMs: number) =>
  (s: RouteState): RouteState =>
    isRetired(s, p, model)
      ? s
      : {
          ...s,
          retired: capped([
            ...s.retired,
            { provider: p, model, code: 'RETIRED' as const, at: new Date(nowMs).toISOString() },
          ]),
        }

export const markAuth =
  (p: HostedProvider) =>
  (s: RouteState): RouteState =>
    withProvider(s, p, (r) => ({ ...r, auth: true }))

export const markCredit =
  (p: HostedProvider, today: string) =>
  (s: RouteState): RouteState =>
    withProvider(s, p, (r) => ({ ...r, creditDay: today }))

/** The only way back from `AUTH`: a keyed chat probe answered 2xx (§3.2). */
export const clearAuth =
  (p: HostedProvider) =>
  (s: RouteState): RouteState =>
    withProvider(s, p, (r) => ({ ...r, auth: false }))

/** A provider's own successful refresh clears its retired entries, and only its own (SR-M-5). */
export const clearRetired =
  (p: HostedProvider) =>
  (s: RouteState): RouteState => ({ ...s, retired: s.retired.filter((e) => e.provider !== p) })

export const markStartupRefresh =
  (p: HostedProvider, nowMs: number) =>
  (s: RouteState): RouteState =>
    withProvider(s, p, (r) => ({ ...r, lastStartupRefreshAt: new Date(nowMs).toISOString() }))

export const setModelRecords =
  (probation: ProbationEntry[], busy: BusyEntry[], busyDead: BusyDeadEntry[]) =>
  (s: RouteState): RouteState => ({
    ...s,
    probation: probation.slice(-MAX_MODEL_RECORDS),
    busy: busy.slice(-MAX_MODEL_RECORDS),
    busyDead: busyDead.slice(-MAX_BUSY_DEAD_ENTRIES),
  })

/** One provider's named stale entries. */
export const staleModelsOf = (s: RouteState, p: HostedProvider): string[] =>
  s.modelListStale?.filter((e) => e.provider === p).map((e) => e.model) ?? []

/** Replaces one provider's named stale entries; the other provider's stay. */
export const setStaleModels =
  (p: HostedProvider, models: readonly string[]) =>
  (s: RouteState): RouteState => ({
    ...s,
    modelListStale: capped([
      ...(s.modelListStale ?? []).filter((e) => e.provider !== p),
      ...models.map((model) => ({ provider: p, model })),
    ]),
  })

export const setJobFailed =
  (job: ModelJob, failed: boolean) =>
  (s: RouteState): RouteState => ({
    ...s,
    failedJobs: [...(s.failedJobs ?? []).filter((j) => j !== job), ...(failed ? [job] : [])],
  })

// ---- own caps ----

export type FreeLimit = { requestsPerDay: number; tokensPerDay?: number | undefined }

/** A reserved unit, dated by the provider day it was counted on. */
export type OwnCapUnit = { readonly day: string }

/**
 * Own daily caps per provider (ADR §3.1, §5.1 unit rules, D5). One unit is one HTTP request,
 * reserved and written through before it is sent; tokens are added after an answer. The limit
 * comes with every reservation from the router's own config, so the cap has one source.
 */
export interface OwnCapPort {
  /** `null`: the cap is reached or the write-through failed; no request may be sent. */
  reserve(p: HostedProvider, limit: FreeLimit): Promise<OwnCapUnit | null>
  /**
   * Gives back a unit the provider refused before doing any work (AUTH, CREDIT, RETIRED 404, no
   * response, an abort before sending). A unit of a day that has since turned is not given back.
   */
  release(p: HostedProvider, unit: OwnCapUnit): Promise<void>
  addTokens(p: HostedProvider, tokens: number): Promise<void>
}

type OwnCapRecord = NonNullable<ProviderRecord['ownCap']>

/** The record counting today; a record dated after today (clock skew back) keeps counting. */
function current(r: ProviderRecord, today: string): OwnCapRecord {
  return r.ownCap !== undefined && r.ownCap.day >= today
    ? r.ownCap
    : { day: today, requests: 0, tokens: 0 }
}

/** A token count as the file can hold it: a safe non-negative integer (SR-M-66). */
function tokenSum(total: number, add: number): number {
  const clean = Number.isFinite(add) ? Math.max(0, Math.floor(add)) : 0
  return Math.min(Number.MAX_SAFE_INTEGER, total + clean)
}

/**
 * The `OwnCapPort` over a `RouteStatePort` (file-backed in the worker). The cap is
 * `OWN_CAP_SHARE` of the free limit the router passes from its config, never above it.
 */
export function createOwnCapPort(opts: { state: RouteStatePort; now: () => number }): OwnCapPort {
  const today = (p: HostedProvider) => providerDay(p, opts.now())
  const counting = (p: HostedProvider) =>
    current(providerRecord(opts.state.snapshot(), p), today(p))
  const change = (p: HostedProvider, fn: (c: OwnCapRecord) => OwnCapRecord) =>
    opts.state.update((s) =>
      withProvider(s, p, (r) => ({ ...r, ownCap: fn(current(r, today(p))) })),
    )
  return {
    async reserve(p, limit) {
      const c = counting(p)
      const tokensFull = c.tokens >= ownCapOf(limit.tokensPerDay ?? Number.POSITIVE_INFINITY)
      if (c.requests >= ownCapOf(limit.requestsPerDay) || tokensFull) return null
      const written = await change(p, (r) => ({ ...r, requests: r.requests + 1 }))
      return written ? { day: c.day } : null
    },
    async release(p, unit) {
      // The day turned since the reservation: the unit belongs to a closed day (SR-L-68).
      if (counting(p).day !== unit.day) return
      await change(p, (r) => ({ ...r, requests: Math.max(0, r.requests - 1) }))
    },
    async addTokens(p, tokens) {
      await change(p, (r) => ({ ...r, tokens: tokenSum(r.tokens, tokens) }))
    },
  }
}
