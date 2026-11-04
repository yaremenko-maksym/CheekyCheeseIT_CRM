import { promises as nodeFs } from 'node:fs'
import { z } from 'zod'
import { parseJsonOrNull } from '../internal/chat-completions'
import { isValidProviderModelId } from '../internal/model-id'
import type { HostedProvider } from './config'
import { readStateText, type StateEvent, type StateFs } from './state'

/** The managed list keeps at most `TARGET` ids per provider (ADR §3.4, VCF: 5). */
export const MANAGED_LIST_TARGET = 5

const ids = z.array(z.string()).max(MANAGED_LIST_TARGET).optional()

/** Only the ordered ids; no promotion flag the reader would trust (§3.2, SR-M-9). */
const managedListSchema = z
  .object({
    version: z.literal(1),
    providers: z.object({ gemini: ids, groq: ids }).strict(),
  })
  .strict()
  // Every id passes its provider's validation, or the whole file is rejected.
  .refine((doc) =>
    // A parsed JSON key is present only with a value, so every entry here is a list.
    Object.entries(doc.providers).every(([p, list]) =>
      (list as string[]).every((id) => isValidProviderModelId(p as HostedProvider, id)),
    ),
  )

/** `managedModels(provider, fallback)`: the managed entry if valid and non-empty, else the pinned list. */
export type ManagedModels = (
  p: HostedProvider,
  fallback: readonly string[],
) => Promise<readonly string[]>

/** No managed-list file: every provider serves its pinned fallback (the first edition's behaviour). */
export const pinnedModelsOnly: ManagedModels = async (_p, fallback) => fallback

/**
 * Reads the managed-list file written by the daily refresh (5.4c-2b) on every call. A missing,
 * empty, invalid or oversized file degrades to the pinned fallback, never to an empty chain;
 * any invalid entry rejects the whole file.
 */
export function createFileManagedModels(opts: {
  path: string
  fs?: StateFs
  /** Mandatory (ADR §3.2, §5.3): a rejected file is never silent. */
  onEvent: (e: StateEvent) => void
}): ManagedModels {
  const fs: StateFs = opts.fs ?? nodeFs
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
    const list = parsed.data.providers[p]
    return list === undefined || list.length === 0 ? fallback : list
  }
}
