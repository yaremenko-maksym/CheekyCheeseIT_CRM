import { promises as nodeFs } from 'node:fs'
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

const routeStateSchema = z
  .object({
    version: z.literal(1),
    spent: z.array(spentEntry).max(MAX_STATE_ENTRIES),
    retired: z.array(retiredEntry).max(MAX_STATE_ENTRIES),
    providers: z
      .array(
        z
          .object({
            provider,
            auth: z.boolean(),
            creditDay: day.optional(),
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

export type RouteState = z.infer<typeof routeStateSchema>
export type ProviderRecord = RouteState['providers'][number]

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
  | { type: 'STATE_WRITE_FAILED'; store: 'route-state' }

/**
 * Spent, retired and provider-level bits (ADR §3.2). `snapshot` is the in-memory read path;
 * `update` applies a change to memory at once and writes the whole document through, resolving
 * `false` when that write failed (the change stays in memory).
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

/** The slice of `fs.promises` the file adapters use; a fake replaces it in tests. */
export type StateFs = {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string): Promise<Uint8Array>
  open(
    path: string,
    flags: string,
    mode?: number,
  ): Promise<{
    writeFile(data: string): Promise<void>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  rename(from: string, to: string): Promise<void>
}

export type StateFileOptions = {
  path: string
  now: () => number
  fs?: StateFs
  onEvent?: (e: StateEvent) => void
}

type ReadOutcome =
  { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'oversized' | 'unreadable' }

/** Reads a state file as text, the byte ceiling checked before the read. */
export async function readStateText(fs: StateFs, path: string): Promise<ReadOutcome> {
  try {
    if ((await fs.stat(path)).size > MAX_STATE_BYTES) return { kind: 'oversized' }
    return { kind: 'text', text: new TextDecoder().decode(await fs.readFile(path)) }
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' }
  }
}

/** Durable atomic replace: a `0600` temp file in the same directory, fsync, rename, fsync the directory. */
async function writeAtomic(fs: StateFs, path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  const file = await fs.open(tmp, 'w', 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
  await fs.rename(tmp, path)
  try {
    const dir = await fs.open(dirname(path), 'r')
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

/**
 * The worker state file behind the `RouteStatePort` (ADR §3.2, D4). An unreadable, invalid or
 * oversized file is empty state and raises `STATE_RESET`; one serialised writer writes the whole
 * document after every change, so two concurrent changes cannot lose each other.
 */
export async function createFileRouteStatePort(opts: StateFileOptions): Promise<RouteStatePort> {
  const fs = opts.fs ?? (nodeFs as unknown as StateFs)
  const emit = (e: StateEvent): void => opts.onEvent?.(e)
  let state = EMPTY_ROUTE_STATE
  const read = await readStateText(fs, opts.path)
  if (read.kind === 'text') {
    // Data, never code: the JSON is only ever handed to the schema.
    const parsed = routeStateSchema.safeParse(parseJsonOrNull(read.text))
    if (parsed.success) state = prune(parsed.data, opts.now())
    else emit({ type: 'STATE_RESET', store: 'route-state', reason: 'invalid' })
  } else if (read.kind !== 'missing') {
    emit({ type: 'STATE_RESET', store: 'route-state', reason: read.kind })
  }
  let queue: Promise<unknown> = Promise.resolve()
  return {
    snapshot: () => state,
    update: (change) => {
      state = change(state)
      const doc = JSON.stringify(state)
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

// ---- own caps ----

export type FreeLimit = { requestsPerDay: number; tokensPerDay?: number | undefined }

/**
 * Own daily caps per provider (ADR §3.1, §5.1 unit rules, D5). One unit is one HTTP request,
 * reserved and written through before it is sent; tokens are added after an answer.
 */
export interface OwnCapPort {
  /** `false`: the cap is reached or the write-through failed; no request may be sent. */
  reserve(p: HostedProvider): Promise<boolean>
  /** Gives back a unit the provider refused before doing any work (AUTH, CREDIT, RETIRED 404, no response, abort). */
  release(p: HostedProvider): Promise<void>
  addTokens(p: HostedProvider, tokens: number): Promise<void>
}

type OwnCapRecord = NonNullable<ProviderRecord['ownCap']>

/** The record counting today; a record dated after today (clock skew back) keeps counting. */
function current(r: ProviderRecord, today: string): OwnCapRecord {
  return r.ownCap !== undefined && r.ownCap.day >= today
    ? r.ownCap
    : { day: today, requests: 0, tokens: 0 }
}

/**
 * The `OwnCapPort` over a `RouteStatePort` (file-backed in the worker). The cap is
 * `OWN_CAP_SHARE` of the configured free limit, never above it; a provider without a configured
 * limit has a cap of zero.
 */
export function createOwnCapPort(opts: {
  state: RouteStatePort
  limits: Partial<Record<HostedProvider, FreeLimit>>
  now: () => number
}): OwnCapPort {
  const change = (p: HostedProvider, fn: (c: OwnCapRecord) => OwnCapRecord) =>
    opts.state.update((s) =>
      withProvider(s, p, (r) => ({ ...r, ownCap: fn(current(r, providerDay(p, opts.now()))) })),
    )
  return {
    async reserve(p) {
      const limit = opts.limits[p]
      const c = current(providerRecord(opts.state.snapshot(), p), providerDay(p, opts.now()))
      const tokensFull =
        limit?.tokensPerDay !== undefined && c.tokens >= ownCapOf(limit.tokensPerDay)
      if (limit === undefined || c.requests >= ownCapOf(limit.requestsPerDay) || tokensFull)
        return false
      return change(p, (r) => ({ ...r, requests: r.requests + 1 }))
    },
    async release(p) {
      // After a day rollover the reserved unit belongs to a closed day: nothing to give back today.
      await change(p, (r) => ({ ...r, requests: Math.max(0, r.requests - 1) }))
    },
    async addTokens(p, tokens) {
      await change(p, (r) => ({ ...r, tokens: r.tokens + Math.max(0, Math.floor(tokens)) }))
    },
  }
}
