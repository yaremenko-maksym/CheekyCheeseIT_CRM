import type { MeetingRecorderRecordingInput } from '@crm/shared'
import { describe, expect, it } from 'vitest'

import type { DrizzleTx } from '../../database/types'
import {
  canonicalizeGoogleMeetUrl,
  googleMeetCodeFromUrl,
  MEETING_RECORDER_MATCH_WINDOW_MS,
  MEETING_RECORDER_UNMATCHABLE_STAGES,
  meetingRecorderMatchKeys,
  MeetingRecorderMatcher,
} from './meeting-recorder-matcher'

/**
 * Pure normalization + the short-circuits that must not query at all. Matching
 * behaviour against real rows (window, stage, ambiguity, SQL/JS code parity) lives
 * in `meeting-recorder-matcher.integration.spec.ts` — a mocked query chain cannot
 * tell whether the SQL selects the right interview (CR-865-H-3).
 */

/** A transaction that fails the test if the matcher reaches the database. */
const noQueryTx = new Proxy(
  {},
  {
    get() {
      throw new Error('the matcher must not query for this recording')
    },
  },
) as DrizzleTx

function recording(source: MeetingRecorderRecordingInput['source']): MeetingRecorderRecordingInput {
  return {
    id: 'recording-1',
    title: 'Contract interview',
    startedAt: '2026-10-07T12:00:00.000Z',
    source,
  }
}

describe('MeetingRecorderMatcher', () => {
  it('canonicalizes only Google Meet HTTPS URLs and extracts a case-insensitive meeting code', () => {
    expect(
      canonicalizeGoogleMeetUrl('https://meet.google.com/AbC-DeFg-HiJ/?authuser=1#fragment'),
    ).toBe('https://meet.google.com/AbC-DeFg-HiJ')
    expect(googleMeetCodeFromUrl('https://meet.google.com/AbC-DeFg-HiJ/?authuser=1')).toBe(
      'abc-defg-hij',
    )
    expect(canonicalizeGoogleMeetUrl('http://meet.google.com/abc-defg-hij')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('https://example.com/abc-defg-hij')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('https://meet.google.com:444/abc-defg-hij')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('https://user@meet.google.com/abc-defg-hij')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('https://user:pass@meet.google.com/abc-defg-hij')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('https://:pass@meet.google.com/abc-defg-hij')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('https://meet.google.com/abc-defg-hij///')).toBe(
      'https://meet.google.com/abc-defg-hij',
    )
    expect(canonicalizeGoogleMeetUrl('https://meet.google.com/')).toBeNull()
    expect(canonicalizeGoogleMeetUrl('not a URL')).toBeNull()
    expect(googleMeetCodeFromUrl('not a URL')).toBeNull()
    expect(googleMeetCodeFromUrl('https://meet.google.com/prefix/AbC-DeFg-HiJ')).toBe(
      'abc-defg-hij',
    )
  })

  it('does not query for a non-Google-Meet recording', async () => {
    await expect(
      new MeetingRecorderMatcher().findExactMatch(
        noQueryTx,
        recording({
          kind: 'meeting',
          provider: 'zoom',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }),
      ),
    ).resolves.toBeNull()
  })

  it('does not query when the recording carries no usable Meet code', async () => {
    const matcher = new MeetingRecorderMatcher()
    await expect(
      matcher.findExactMatch(
        noQueryTx,
        recording({
          kind: 'meeting',
          provider: 'google-meet',
          meetingUrl: 'https://example.com/not-a-meet-room',
        }),
      ),
    ).resolves.toBeNull()
    await expect(
      matcher.findExactMatch(noQueryTx, recording({ kind: 'meeting', provider: 'google-meet' })),
    ).resolves.toBeNull()
  })

  // Owner decision D-1: ±30 minutes. The expected value is hand-computed
  // (30 min × 60 s × 1000 ms = 1 800 000) rather than re-derived from the same
  // expression, so this cannot agree with the code by construction.
  it('pins the auto-match window to 30 minutes expressed in milliseconds', () => {
    expect(MEETING_RECORDER_MATCH_WINDOW_MS).toBe(1_800_000)
  })

  it('pins the stages that never receive an automatic link', () => {
    expect([...MEETING_RECORDER_UNMATCHABLE_STAGES]).toEqual(['HIRED', 'REJECTED', 'ARCHIVED'])
  })

  describe('meetingRecorderMatchKeys', () => {
    it('prefers the meeting id and adds the URL code only when it differs', () => {
      expect(
        meetingRecorderMatchKeys({
          kind: 'meeting',
          provider: 'google-meet',
          meetingId: 'ABC-DEFG-HIJ',
          meetingUrl: 'https://meet.google.com/zzz-zzzz-zzz',
        }),
      ).toEqual([
        { code: 'abc-defg-hij', matchedBy: 'meeting-id' },
        { code: 'zzz-zzzz-zzz', matchedBy: 'meeting-url' },
      ])
    })

    it('de-duplicates when the id and the URL carry the same code', () => {
      expect(
        meetingRecorderMatchKeys({
          kind: 'meeting',
          provider: 'google-meet',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/ABC-DEFG-HIJ?authuser=1',
        }),
      ).toEqual([{ code: 'abc-defg-hij', matchedBy: 'meeting-id' }])
    })

    it('yields the single available code, or none at all', () => {
      expect(
        meetingRecorderMatchKeys({
          kind: 'meeting',
          provider: 'google-meet',
          meetingId: 'Only-Id',
        }),
      ).toEqual([{ code: 'only-id', matchedBy: 'meeting-id' }])
      expect(
        meetingRecorderMatchKeys({
          kind: 'meeting',
          provider: 'google-meet',
          meetingUrl: 'https://meet.google.com/only-url',
        }),
      ).toEqual([{ code: 'only-url', matchedBy: 'meeting-url' }])
      expect(meetingRecorderMatchKeys({ kind: 'meeting', provider: 'google-meet' })).toEqual([])
      expect(
        meetingRecorderMatchKeys({
          kind: 'meeting',
          provider: 'google-meet',
          meetingUrl: 'https://example.com/not-a-meet-room',
        }),
      ).toEqual([])
    })

    it('yields nothing for a non-Google-Meet provider', () => {
      expect(
        meetingRecorderMatchKeys({
          kind: 'meeting',
          provider: 'zoom',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }),
      ).toEqual([])
    })
  })

  it('does not query when the recording start time is not a date', async () => {
    await expect(
      new MeetingRecorderMatcher().findExactMatch(noQueryTx, {
        ...recording({ kind: 'meeting', provider: 'google-meet', meetingId: 'abc-defg-hij' }),
        startedAt: 'not-a-date',
      }),
    ).resolves.toBeNull()
  })
})
