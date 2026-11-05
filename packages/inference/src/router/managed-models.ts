import { promises as nodeFs } from 'node:fs'
import { z } from 'zod'
import { parseJsonOrNull } from '../internal/chat-completions'
import { isValidProviderModelId } from '../internal/model-id'
import type { HostedProvider } from './config'
import {
  isBusyDead,
  MANAGED_LIST_TARGET,
  PROMOTION_STREAK,
  readStateText,
  writeAtomic,
  type ProbationEntry,
  type RouteStatePort,
  type StateEvent,
  type StateFs,
} from './state'

export { MANAGED_LIST_TARGET }

const ids = z.array(z.string()).max(MANAGED_LIST_TARGET).optional()

/** Only the ordered ids; no promotion flag the reader would trust (§3.2, SR-M-9). */
const managedListSchema = z
  .object({
    version: z.literal(1),
    providers: z.object({ gemini: ids, groq: ids }).strict(),
  })
  .strict()
  // Every id passes its provider's validation with no repeats, or the whole file is rejected.
  .refine((doc) =>
    // A parsed JSON key is present only with a value, so every entry here is a list.
    Object.entries(doc.providers).every(([p, list]) => {
      const entries = list as string[]
      return (
        new Set(entries).size === entries.length &&
        entries.every((id) => isValidProviderModelId(p as HostedProvider, id))
      )
    }),
  )

/** `managedModels(provider, fallback)`: the managed entry if valid and non-empty, else the pinned list. */
export type ManagedModels = (
  p: HostedProvider,
  fallback: readonly string[],
) => Promise<readonly string[]>

/** No managed-list file: every provider serves its pinned fallback (the first edition's behaviour). */
export const pinnedModelsOnly: ManagedModels = async (_p, fallback) => fallback

/** The reader's whole promotion rule (§3.4): pinned, or a probation record of a full streak. */
export function isPromoted(
  model: string,
  pinned: readonly string[],
  probation: readonly ProbationEntry[] | undefined,
): boolean {
  return (
    pinned.includes(model) ||
    probation?.some((r) => r.model === model && r.aliveStreak === PROMOTION_STREAK) === true
  )
}

/**
 * Reads the managed-list file written by the daily refresh on every call. A missing, empty,
 * invalid or oversized file degrades to the pinned fallback, never to an empty chain; any invalid
 * entry rejects the whole file. Promotion is recomputed and never read from the file's order:
 * promoted entries serve first, then those on probation, each in file order.
 */
export function createFileManagedModels(opts: {
  path: string
  fs?: StateFs
  state: Pick<RouteStatePort, 'snapshot'>
  /** Mandatory (ADR §3.2, §5.3): a rejected file is never silent. */
  onEvent: (e: StateEvent) => void
}): ManagedModels {
  const fs: StateFs = opts.fs ?? nodeFs
  const ordered = (list: string[], pinned: readonly string[]): readonly string[] => {
    const probation = opts.state.snapshot().probation
    const promoted = (id: string): boolean => isPromoted(id, pinned, probation)
    return [...list.filter(promoted), ...list.filter((id) => !promoted(id))]
  }
  return async (p, fallback) => {
    const read = await readStateText(fs, opts.path)
    if (read.kind === 'missing') return fallback
    if (read.kind !== 'text') {
      opts.onEvent({ type: 'STATE_RESET', store: 'managed-list', reason: read.kind })
      return fallback
    }
    const parsed = managedListSchema.safeParse(parseJsonOrNull(read.text))
    if (!parsed.success) {
      opts.onEvent({ type: 'STATE_RESET', store: 'managed-list', reason: 'invalid' })
      return fallback
    }
    // A held model stays out even when the write that would have removed it failed.
    const held = opts.state.snapshot()
    const list = (parsed.data.providers[p] ?? []).filter((id) => !isBusyDead(held, id))
    return list.length === 0 ? fallback : ordered(list, fallback)
  }
}

/** Replaces one provider's list; `false` means the file was left byte-identical. */
export type ManagedListWriter = (p: HostedProvider, ids: readonly string[]) => Promise<boolean>

/**
 * The one writer of the managed-list file (§3.2): a promise queue re-reads the file, keeps the
 * other provider's valid list and replaces the file atomically. An empty or invalid list is never
 * written (never wipe, §3.4). An invalid file on disk gives the other provider no list to keep.
 */
export function createManagedListWriter(opts: {
  path: string
  fs?: StateFs
  onEvent: (e: StateEvent) => void
}): ManagedListWriter {
  const fs: StateFs = opts.fs ?? nodeFs
  const write = async (p: HostedProvider, ids: readonly string[]): Promise<boolean> => {
    if (ids.length === 0) return false
    const read = await readStateText(fs, opts.path)
    const existing =
      // Stryker disable next-line ConditionalExpression: equivalent for `true`, an absent text parses to null and fails the schema; `false` is covered by the keeps-the-other-provider spec
      read.kind === 'text' ? managedListSchema.safeParse(parseJsonOrNull(read.text)) : null
    const next = managedListSchema.safeParse({
      version: 1,
      providers: { ...(existing?.success === true ? existing.data.providers : {}), [p]: ids },
    })
    if (!next.success) return false
    try {
      await writeAtomic(fs, opts.path, JSON.stringify(next.data))
    } catch {
      opts.onEvent({ type: 'STATE_WRITE_FAILED', store: 'managed-list' })
      return false
    }
    // Outside the try: a throwing observer is not a failed write.
    if (read.kind === 'oversized' || read.kind === 'unreadable') {
      opts.onEvent({ type: 'STATE_RESET', store: 'managed-list', reason: read.kind })
    }
    return true
  }
  let queue: Promise<unknown> = Promise.resolve()
  return (p, ids) => {
    const run = queue.then(() => write(p, ids))
    queue = run
    return run
  }
}
