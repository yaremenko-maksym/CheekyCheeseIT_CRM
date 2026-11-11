import type { JobSourceDto } from '@crm/shared'

/**
 * The four things an operator needs to tell apart on a source (docs/design/vacancy-queue.md §7).
 * They are different causes with different remedies, so they never share a word or a colour:
 * - `disabled`: an admin turned it off (or retired it) — flip the switch to bring it back;
 * - `paused`: the system backed off (cooldown, host ban, admin pause) — wait, or look at why;
 * - `blocked`: not ready to run at all (readiness) — fix the cause, enabling is refused.
 */
export type SourceStateKind = 'running' | 'disabled' | 'paused' | 'blocked'

export interface SourceState {
  kind: SourceStateKind
  /** ISO instant a `paused` source resumes; null when there is no stated time. */
  pausedUntil: string | null
  /** Typed error code behind a `paused` source, when the server states one. */
  code: string | null
}

const inFuture = (iso: string | null | undefined, now: number): iso is string =>
  !!iso && new Date(iso).getTime() > now

/**
 * Pure derivation from the DTO. Readiness wins over everything (a blocked source is blocked even
 * while switched off — that is what the refused enable will say); a pause window that already
 * ended is no longer a pause.
 */
export function deriveSourceState(source: JobSourceDto, now: number): SourceState {
  if (source.readiness === 'BLOCKED') return { kind: 'blocked', pausedUntil: null, code: null }
  if (!source.enabled || source.adminState === 'RETIRED') {
    return { kind: 'disabled', pausedUntil: null, code: null }
  }
  // The host ban is the stricter of the two server pauses, so it names the reason when both hold.
  if (inFuture(source.hostPausedUntil, now)) {
    return {
      kind: 'paused',
      pausedUntil: source.hostPausedUntil,
      code: source.hostPauseReason ?? null,
    }
  }
  if (inFuture(source.cooldownUntil, now)) {
    return { kind: 'paused', pausedUntil: source.cooldownUntil, code: source.lastErrorCode ?? null }
  }
  if (source.adminState === 'PAUSED') return { kind: 'paused', pausedUntil: null, code: null }
  return { kind: 'running', pausedUntil: null, code: null }
}
