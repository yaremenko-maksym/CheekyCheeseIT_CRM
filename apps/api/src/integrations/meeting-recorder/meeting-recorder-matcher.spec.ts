import type { MeetingRecorderRecordingInput } from '@crm/shared'
import { describe, expect, it } from 'vitest'

import type { DrizzleTx } from '../../database/types'
import {
  canonicalizeGoogleMeetUrl,
  googleMeetCodeFromUrl,
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

  it('does not query when the recording start time is not a date', async () => {
    await expect(
      new MeetingRecorderMatcher().findExactMatch(noQueryTx, {
        ...recording({ kind: 'meeting', provider: 'google-meet', meetingId: 'abc-defg-hij' }),
        startedAt: 'not-a-date',
      }),
    ).resolves.toBeNull()
  })
})
