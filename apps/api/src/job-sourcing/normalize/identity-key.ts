import type { JobIdentityKind, JobSourceType } from '@crm/shared'
import { checkStoredLink } from './url-policy'

/** Bump when the tuple layout changes: old and new keys must never be comparable by accident. */
export const IDENTITY_KEY_VERSION = 'v1'
const MAX_NAMESPACE_CHARS = 128
const MAX_NATIVE_ID_CHARS = 256

/**
 * The store's cap on `identityKey` (`jobSourceIdentitySchema` in `@crm/shared`). Declared here as a
 * number because the schema states it inline, so the two are bound by a conformance test
 * (`observation.store-conformance.spec.ts`) that parses a key of exactly this length through the
 * schema — not by hoping two literals stay equal.
 */
export const MAX_IDENTITY_KEY_CHARS = 2048

/**
 * The store's vocabulary, not a parallel one. `jobIdentityKindSchema` shipped in phase 1 and is in
 * production; a local `'NATIVE' | 'URL'` spelling made this producer emit values its own consumer
 * rejects, with nothing to notice because no test crossed the boundary.
 */
export type IdentityKind = JobIdentityKind

export interface ObservationIdentity {
  provider: JobSourceType
  /** Verified board/account + regional endpoint variant (NOT a category row). Lowercased, NFC. */
  namespace: string
  nativeId: string | null
  /** Canonical JSON tuple, see `encodeIdentityTuple`. */
  identityKey: string
  identityKind: IdentityKind
}

/**
 * `INVALID_NAMESPACE`: adapter bug. `NO_IDENTITY`: no usable native id AND no safe URL.
 * `IDENTITY_TOO_LONG`: a safe URL whose encoded key exceeds what the store accepts.
 */
export type IdentityFailure = 'INVALID_NAMESPACE' | 'NO_IDENTITY' | 'IDENTITY_TOO_LONG'

export interface IdentityInput {
  provider: JobSourceType
  namespace: string
  /** The source's own stable posting id, if it has one. */
  nativeId: string | null | undefined
  /** Posting URL for the fallback; ignored when a usable native id exists. */
  url: string | null | undefined
  /** Query params that identify a posting on this source (e.g. `['id']`); all others are noise. */
  identityParams?: readonly string[]
}

export type IdentityResult =
  { ok: true; identity: ObservationIdentity } | { ok: false; reason: IdentityFailure }

/**
 * Encodes identity components as a JSON array of strings (a canonical tuple): every component is
 * quoted and escaped, so no component can contain, imitate or erase a boundary. Delimiter
 * concatenation (`a|b|c`) cannot make that promise: `['a|b','c']` and `['a','b|c']` join to the
 * same string. The output is the persisted identity key, so it contains no whitespace and is
 * order-sensitive by design.
 */
export function encodeIdentityTuple(parts: readonly unknown[]): string {
  return JSON.stringify(parts)
}

/** NFC + trim; the namespace is additionally case-folded (hosts/accounts are case-insensitive). */
function normalizeNamespace(raw: string): string | null {
  const ns = raw.normalize('NFC').trim().toLowerCase()
  return ns.length > 0 && ns.length <= MAX_NAMESPACE_CHARS ? ns : null
}

/**
 * The ONE spelling of a provider-issued id: NFC + trim, case kept (ids may be case-sensitive).
 *
 * Exported because identity is not the only place ids are compared. The collection loop's
 * collision check (AC5) compares the ids an adapter reports against the identity they produced,
 * and it compared them RAW while identity compared them normalised — so a precomposed `é` and
 * `e` + U+0301, which identity correctly treats as one id, read as two ids on one key and raised a
 * false ADAPTER_INVARIANT that discarded the whole page (SR-M-3). Both sides now spell an id with
 * this function, so they cannot disagree about what "the same id" means.
 */
export function canonicalNativeId(raw: string): string {
  return raw.normalize('NFC').trim()
}

/** Case-sensitive (ids may be); unusable ids fall through to the URL fallback rather than throw. */
function normalizeNativeId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const id = canonicalNativeId(raw)
  if (id.length === 0 || id.length > MAX_NATIVE_ID_CHARS || /[\u0000-\u001f\u007f]/.test(id)) {
    return null
  }
  return id
}

/**
 * THE canonical order for a query-param multiset, used by every module in this family that has to
 * put params into a hashed or compared payload (identity keys here, content hashes in
 * `content-hash.ts`). One order, declared once.
 *
 * Each pair is encoded to `name=value` FIRST and the encoded strings are then sorted with the
 * default comparator (UTF-16 code units). That is a total order on distinct params, so one multiset
 * of params has exactly one spelling, and repeated params are kept (`id=2&id=1` and `id=1&id=2`
 * become one identity). Encoding first is what makes it unambiguous: `encodeURIComponent` escapes
 * `=` and `&`, so no name or value can imitate a separator.
 *
 * Deliberately NOT a hand-written pairwise comparator. One was here, and it needed two Stryker
 * suppressions for tie branches that no input could observe — a construct whose mutants had to be
 * excused is better deleted than excused.
 */
export function canonicalParams(entries: Iterable<readonly [string, string]>): string[] {
  return [...entries].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort()
}

/** [host, path, canonical params] of a safe URL, keeping only the declared identity params. */
function urlComponents(url: URL, identityParams: readonly string[]) {
  const wanted = new Set(identityParams)
  const kept = [...url.searchParams].filter(([name]) => wanted.has(name))
  return [url.hostname, url.pathname.replace(/\/+$/, ''), canonicalParams(kept)] as const
}

/**
 * Identity of one observation: native id when the source has a usable one, otherwise the safe
 * posting URL (preserving declared identity params), otherwise a quarantine outcome. An absent
 * native id is NEVER encoded as an empty NATIVE component — that would fold every id-less posting
 * of a namespace onto a single key.
 */
export function buildIdentity(input: IdentityInput): IdentityResult {
  const namespace = normalizeNamespace(input.namespace)
  if (namespace === null) return { ok: false, reason: 'INVALID_NAMESPACE' }

  const nativeId = normalizeNativeId(input.nativeId)
  if (nativeId !== null) {
    // Bounded by construction, so there is no length check on this branch: the tuple holds the
    // version, the kind, a `JobSourceType` member, a namespace of at most MAX_NAMESPACE_CHARS and a
    // native id of at most MAX_NATIVE_ID_CHARS. Even with every character JSON-escaped to six bytes
    // that is far below MAX_IDENTITY_KEY_CHARS, and the conformance test pins the worst case.
    return {
      ok: true,
      identity: {
        provider: input.provider,
        namespace,
        nativeId,
        identityKind: 'NATIVE_ID',
        identityKey: encodeIdentityTuple([
          IDENTITY_KEY_VERSION,
          'NATIVE_ID',
          input.provider,
          namespace,
          nativeId,
        ]),
      },
    }
  }

  const link = checkStoredLink(input.url)
  if (!link.ok) return { ok: false, reason: 'NO_IDENTITY' }
  const identityKey = encodeIdentityTuple([
    IDENTITY_KEY_VERSION,
    'URL_FALLBACK',
    input.provider,
    namespace,
    ...urlComponents(link.url, input.identityParams ?? []),
  ])
  // A URL-derived key is NOT bounded by construction: a URL may be MAX_LINK_CHARS long on its own,
  // and the namespace, the tuple's JSON quoting and its escaping are all added on top. Quarantine,
  // rather than truncate to fit: two URLs sharing a long prefix would truncate to the SAME key and
  // two distinct postings would merge into one record. A failure must not report success, and
  // silently merging records is worse than declining to identify this one.
  if (identityKey.length > MAX_IDENTITY_KEY_CHARS) {
    return { ok: false, reason: 'IDENTITY_TOO_LONG' }
  }
  return {
    ok: true,
    identity: {
      provider: input.provider,
      namespace,
      nativeId: null,
      identityKind: 'URL_FALLBACK',
      identityKey,
    },
  }
}
