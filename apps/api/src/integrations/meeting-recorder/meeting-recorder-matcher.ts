import { Injectable } from '@nestjs/common'
import { and, eq, gte, lte, notInArray } from 'drizzle-orm'
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

@Injectable()
export class MeetingRecorderMatcher {
  /**
   * The single interview a new recording belongs to, or null.
   *
   * SR-865-H-1: `callUrl` is user-writable (SENIOR/HR), so a code match alone would
   * let anyone pull a foreign transcript into their readable scope. A match also
   * needs the recording to start within ±30 min of the interview's `scheduledAt`
   * (NULL never matches) and the interview to be neither terminal nor archived.
   * Two candidates are no match.
   *
   * CR-865-H-1: one indexed lookup on `interviews.call_meet_code` per key with
   * `LIMIT 2` — never load-all-then-filter.
   */
  async findExactMatch(
    tx: DrizzleTx,
    recording: MeetingRecorderRecordingInput,
  ): Promise<MeetingRecorderAutomaticMatch | null> {
    const source = recording.source
    if (source.provider !== 'google-meet') return null

    const startedAt = new Date(recording.startedAt).getTime()
    if (Number.isNaN(startedAt)) return null

    const idCode = source.meetingId ? source.meetingId.toLowerCase() : null
    const urlCode = source.meetingUrl ? googleMeetCodeFromUrl(source.meetingUrl) : null

    const keys: Array<{ code: string; matchedBy: MeetingRecorderAutomaticMatch['matchedBy'] }> = []
    if (idCode) keys.push({ code: idCode, matchedBy: 'meeting-id' })
    if (urlCode && urlCode !== idCode) keys.push({ code: urlCode, matchedBy: 'meeting-url' })

    for (const { code, matchedBy } of keys) {
      const candidates = await tx
        .select({ id: interviews.id, stage: interviews.stage })
        .from(interviews)
        .where(
          and(
            eq(interviews.callMeetCode, code),
            gte(interviews.scheduledAt, new Date(startedAt - MEETING_RECORDER_MATCH_WINDOW_MS)),
            lte(interviews.scheduledAt, new Date(startedAt + MEETING_RECORDER_MATCH_WINDOW_MS)),
            notInArray(interviews.stage, [...MEETING_RECORDER_UNMATCHABLE_STAGES]),
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
