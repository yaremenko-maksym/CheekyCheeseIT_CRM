import type { JobSourceType } from '@crm/shared'
import { checkStoredLink } from './url-policy'

/** Bump when the tuple layout changes: old and new keys must never be comparable by accident. */
export const IDENTITY_KEY_VERSION = 'v1'
const MAX_NAMESPACE_CHARS = 128
const MAX_NATIVE_ID_CHARS = 256

export type IdentityKind = 'NATIVE' | 'URL'

export interface ObservationIdentity {
  provider: JobSourceType
  /** Verified board/account + regional endpoint variant (NOT a category row). Lowercased, NFC. */
  namespace: string
  nativeId: string | null
  /** Canonical JSON tuple, see `encodeIdentityTuple`. */
  identityKey: string
  identityKind: IdentityKind
}

/** `INVALID_NAMESPACE`: adapter bug. `NO_IDENTITY`: no usable native id AND no safe URL. */
export type IdentityFailure = 'INVALID_NAMESPACE' | 'NO_IDENTITY'

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

/** Case-sensitive (ids may be); unusable ids fall through to the URL fallback rather than throw. */
function normalizeNativeId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.normalize('NFC').trim()
  if (id.length === 0 || id.length > MAX_NATIVE_ID_CHARS || /[\u0000-\u001f\u007f]/.test(id)) {
    return null
  }
  return id
}

/** [host, path, sorted [name, value] pairs] of a safe URL, keeping only the declared params. */
function urlComponents(url: URL, identityParams: readonly string[]) {
  const wanted = new Set(identityParams)
  const pairs: Array<[string, string]> = []
  for (const [name, value] of url.searchParams) {
    if (wanted.has(name)) pairs.push([name, value])
  }
  // Repeated params are kept; sorted so `id=2&id=1` and `id=1&id=2` are one identity.
  // Order: name, then value, both by UTF-16 code unit. A tie means two IDENTICAL pairs, so which of
  // them goes first is unobservable and the comparator need not (and does not) return 0 for it.
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) {
      // Stryker disable next-line EqualityOperator: this line is reached only when the names differ, so `<` and `<=` never disagree here. The `>=` sibling this also hides is killed by hand: reversing the comparator fails "orders pairs by name ascending" in identity-url-fallback.spec.ts
      return a[0] < b[0] ? -1 : 1
    }
    // Stryker disable next-line EqualityOperator: `<=` differs from `<` only on equal values, i.e. identical pairs, whose relative order cannot be seen in the output. Proof: node -e "const o=(x,y)=>x<y?-1:1,m=(x,y)=>x<=y?-1:1,u=['1','10','2'];let bad=0;const r=(s)=>{if(JSON.stringify([...s].sort(o))!==JSON.stringify([...s].sort(m)))bad++;if(s.length<7)for(const v of u)r([...s,v])};r([]);console.log('differing sorts:',bad)" prints 'differing sorts: 0'
    return a[1] < b[1] ? -1 : 1
  })
  return [url.hostname, url.pathname.replace(/\/+$/, ''), pairs] as const
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
    return {
      ok: true,
      identity: {
        provider: input.provider,
        namespace,
        nativeId,
        identityKind: 'NATIVE',
        identityKey: encodeIdentityTuple([
          IDENTITY_KEY_VERSION,
          'NATIVE',
          input.provider,
          namespace,
          nativeId,
        ]),
      },
    }
  }

  const link = checkStoredLink(input.url)
  if (!link.ok) return { ok: false, reason: 'NO_IDENTITY' }
  return {
    ok: true,
    identity: {
      provider: input.provider,
      namespace,
      nativeId: null,
      identityKind: 'URL',
      identityKey: encodeIdentityTuple([
        IDENTITY_KEY_VERSION,
        'URL',
        input.provider,
        namespace,
        ...urlComponents(link.url, input.identityParams ?? []),
      ]),
    },
  }
}
