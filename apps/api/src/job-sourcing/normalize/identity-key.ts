import type { JobSourceType } from '@crm/shared'

export function encodeIdentityTuple(parts: readonly string[]): string {
  return parts.join('|')
}

export function buildIdentity(input: {
  provider: JobSourceType
  namespace: string
  nativeId: string | null
  url: string | null
}):
  | { ok: true; identity: Record<string, unknown> & { identityKey: string } }
  | { ok: false; reason: string } {
  if (input.namespace.trim() === '') return { ok: false, reason: 'INVALID_NAMESPACE' }
  const ns = input.namespace.normalize('NFC').trim().toLowerCase()
  const id = input.nativeId ?? ''
  return {
    ok: true,
    identity: {
      provider: input.provider,
      namespace: ns,
      nativeId: input.nativeId,
      identityKind: 'NATIVE',
      identityKey: encodeIdentityTuple([input.provider, ns, 'NATIVE', id]),
    },
  }
}
