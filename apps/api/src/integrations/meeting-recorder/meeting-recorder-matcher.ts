import { Injectable } from '@nestjs/common'
import { and, eq, gte, lt, lte, notInArray } from 'drizzle-orm'
import type { MeetingRecorderRecordingInput } from '@crm/shared'

import type { DrizzleTx } from '../../database/types'
import { interviews, type Interview } from '../../database/schema'

export type MeetingRecorderAutomaticMatch = {
  interviewId: string
  stageAtLink: Interview['stage']
  matchedBy: 'meeting-id' | 'meeting-url'
}

export function canonicalizeGoogleMeetUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'meet.google.com' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null
    }

    const pathname = url.pathname.replace(/\/+$/, '')
    if (pathname.length === 0) return null
    return `https://meet.google.com${pathname}`
  } catch {
    return null
  }
}

export function googleMeetCodeFromUrl(value: string): string | null {
  const canonical = canonicalizeGoogleMeetUrl(value)
  if (!canonical) return null
  const url = new URL(canonical)
  const code = url.pathname.split('/').at(-1)
  return code ? code.toLowerCase() : null
}

/**
 * Owner decision D-1 (2026-10-22): a recording auto-matches an interview only when
 * it started within this distance of the interview's `scheduledAt`.
 */
export const MEETING_RECORDER_MATCH_WINDOW_MS = 30 * 60 * 1000

/** Stages that never receive an automatic link: terminal (HIRED, REJECTED) or archived. */
export const MEETING_RECORDER_UNMATCHABLE_STAGES = [
  'HIRED',
  'REJECTED',
  'ARCHIVED',
] as const satisfies readonly Interview['stage'][]

/** The only columns the matcher needs from a candidate interview. */
// Stryker disable next-line ObjectLiteral: emptying the projection is only observable through a real query — the unit stub in the sibling spec answers the lookup without reading it, and the gate cannot run the integration spec that does (.claude/rules/common/mutation-gate-integration-specs.md)
const MATCH_CANDIDATE_COLUMNS = { id: interviews.id, stage: interviews.stage }

/**
 * The Meet codes to look an interview up by, most trusted first, de-duplicated.
 *
 * Pure and exported so the ordering and the de-duplication are unit-testable:
 * inside `findExactMatch` they would only be observable as a redundant SQL
 * round-trip, which no assertion short of counting queries could see.
 */
export function meetingRecorderMatchKeys(
  source: MeetingRecorderRecordingInput['source'],
): Array<{ code: string; matchedBy: MeetingRecorderAutomaticMatch['matchedBy'] }> {
  if (source.provider !== 'google-meet') return []

  const idCode = source.meetingId ? source.meetingId.toLowerCase() : null
  const urlCode = source.meetingUrl ? googleMeetCodeFromUrl(source.meetingUrl) : null

  const keys: Array<{ code: string; matchedBy: MeetingRecorderAutomaticMatch['matchedBy'] }> = []
  if (idCode) keys.push({ code: idCode, matchedBy: 'meeting-id' })
  if (urlCode && urlCode !== idCode) keys.push({ code: urlCode, matchedBy: 'meeting-url' })
  return keys
}

@Injectable()
export class MeetingRecorderMatcher {
  /**
   * The single interview a new recording belongs to, or null.
   *
   * SR-865-H-1: `callUrl` is user-writable (SENIOR/HR), so a code match alone would
   * let anyone pull a foreign transcript into their readable scope. A match also
   * needs the recording to start within ±30 min of the interview's `scheduledAt`
   * (NULL never matches), the interview to be neither terminal nor archived, and its
   * match key (`callUrl` / `scheduledAt`) to have been set BEFORE the recording
   * started — both are user-editable, so a key planted after the call began cannot
   * capture it. Two candidates are no match.
   *
   * Residual, accepted by owner decision D-1 (no ADMIN confirmation): a user who
   * knows a future meeting's code and time can plant both before it starts.
   *
   * CR-865-H-1: one indexed lookup on `interviews.call_meet_code` per key with
   * `LIMIT 2` — never load-all-then-filter.
   */
  async findExactMatch(
    tx: DrizzleTx,
    recording: MeetingRecorderRecordingInput,
  ): Promise<MeetingRecorderAutomaticMatch | null> {
    // No explicit "no keys" guard: an empty key list makes the loop below a no-op
    // and falls through to `null` without touching the database.
    const keys = meetingRecorderMatchKeys(recording.source)
    const startedAt = new Date(recording.startedAt).getTime()
    if (Number.isNaN(startedAt)) return null

    for (const { code, matchedBy } of keys) {
      // The five predicates below are compiled into one SQL statement, so only a
      // real Postgres can tell a mutated one from the original — the unit stub in
      // meeting-recorder-matcher.spec.ts answers the lookup without reading the
      // WHERE clause at all, and the mutation gate cannot execute an integration
      // spec (.claude/rules/common/mutation-gate-integration-specs.md). Each is
      // killed behaviourally in meeting-recorder-matcher.integration.spec.ts:
      // the ±30 min window at both edges and one second beyond, the terminal and
      // archived stages, and the match-key-before-start rule.
      const candidates = await tx
        .select(MATCH_CANDIDATE_COLUMNS)
        .from(interviews)
        .where(
          and(
            eq(interviews.callMeetCode, code),
            // Stryker disable next-line ArithmeticOperator: window direction is SQL-only — asserted at both window edges in the integration spec
            gte(interviews.scheduledAt, new Date(startedAt - MEETING_RECORDER_MATCH_WINDOW_MS)),
            // Stryker disable next-line ArithmeticOperator: window direction is SQL-only — asserted at both window edges in the integration spec
            lte(interviews.scheduledAt, new Date(startedAt + MEETING_RECORDER_MATCH_WINDOW_MS)),
            // Stryker disable next-line ArrayDeclaration: an empty exclusion list is SQL-only — the integration spec proves HIRED/REJECTED/ARCHIVED never match
            notInArray(interviews.stage, [...MEETING_RECORDER_UNMATCHABLE_STAGES]),
            lt(interviews.matchKeyChangedAt, new Date(startedAt)),
          ),
        )
        .limit(2)
      if (candidates.length === 1) {
        const match = candidates[0]!
        return { interviewId: match.id, stageAtLink: match.stage, matchedBy }
      }
    }

    return null
  }
}
