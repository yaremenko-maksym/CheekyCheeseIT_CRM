import { Injectable } from '@nestjs/common'
import { isNotNull } from 'drizzle-orm'
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

@Injectable()
export class MeetingRecorderMatcher {
  async findExactMatch(
    tx: DrizzleTx,
    recording: MeetingRecorderRecordingInput,
  ): Promise<MeetingRecorderAutomaticMatch | null> {
    const source = recording.source
    if (source.provider !== 'google-meet') return null

    const candidates = await tx
      .select({
        id: interviews.id,
        stage: interviews.stage,
        callUrl: interviews.callUrl,
      })
      .from(interviews)
      .where(isNotNull(interviews.callUrl))

    const incomingCode = source.meetingId ? source.meetingId.toLowerCase() : null

    if (incomingCode) {
      const matches = candidates.filter(
        (candidate) => googleMeetCodeFromUrl(candidate.callUrl!) === incomingCode,
      )
      if (matches.length === 1) {
        const match = matches[0]!
        return {
          interviewId: match.id,
          stageAtLink: match.stage,
          matchedBy: 'meeting-id',
        }
      }
    }

    const incomingUrl = source.meetingUrl ? canonicalizeGoogleMeetUrl(source.meetingUrl) : null
    if (incomingUrl) {
      const matches = candidates.filter(
        (candidate) => canonicalizeGoogleMeetUrl(candidate.callUrl!) === incomingUrl,
      )
      if (matches.length === 1) {
        const match = matches[0]!
        return {
          interviewId: match.id,
          stageAtLink: match.stage,
          matchedBy: 'meeting-url',
        }
      }
    }

    return null
  }
}
