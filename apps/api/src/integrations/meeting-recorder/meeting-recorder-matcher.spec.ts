import type { MeetingRecorderRecordingInput } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'

import type { DrizzleTx } from '../../database/types'
import { interviews } from '../../database/schema'
import {
  canonicalizeGoogleMeetUrl,
  googleMeetCodeFromUrl,
  MeetingRecorderMatcher,
} from './meeting-recorder-matcher'

type Candidate = {
  id: string
  stage: 'TECH_INTERVIEW' | 'FINAL_INTERVIEW'
  callUrl: string | null
}

function txWithCandidates(candidates: Candidate[]): DrizzleTx {
  return {
    select: () => ({
      from: () => ({
        where: async () => candidates,
      }),
    }),
  } as unknown as DrizzleTx
}

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

  it('matches one interview by meeting id before considering the full meeting URL', async () => {
    const matcher = new MeetingRecorderMatcher()
    const tx = txWithCandidates([
      {
        id: 'interview-match',
        stage: 'TECH_INTERVIEW',
        callUrl: 'https://meet.google.com/ABC-DEFG-HIJ?authuser=1',
      },
      {
        id: 'interview-other',
        stage: 'FINAL_INTERVIEW',
        callUrl: 'https://meet.google.com/other-room',
      },
    ])

    await expect(
      matcher.findExactMatch(
        tx,
        recording({
          kind: 'meeting',
          provider: 'google-meet',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/other-room',
        }),
      ),
    ).resolves.toEqual({
      interviewId: 'interview-match',
      stageAtLink: 'TECH_INTERVIEW',
      matchedBy: 'meeting-id',
    })
  })

  it('selects the exact candidate fields needed for matching', async () => {
    const matcher = new MeetingRecorderMatcher()
    const where = vi.fn().mockResolvedValue([])
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })
    const tx = { select } as unknown as DrizzleTx

    await expect(
      matcher.findExactMatch(
        tx,
        recording({
          kind: 'meeting',
          provider: 'google-meet',
          meetingId: 'abc-defg-hij',
        }),
      ),
    ).resolves.toBeNull()

    expect(select).toHaveBeenCalledWith({
      id: interviews.id,
      stage: interviews.stage,
      callUrl: interviews.callUrl,
    })
  })

  it('falls back to one canonical Meet URL match when no meeting id is present', async () => {
    const matcher = new MeetingRecorderMatcher()
    const tx = txWithCandidates([
      {
        id: 'interview-invalid-url',
        stage: 'TECH_INTERVIEW',
        callUrl: 'https://example.com/not-a-meet-room',
      },
      {
        id: 'interview-match',
        stage: 'FINAL_INTERVIEW',
        callUrl: 'https://meet.google.com/abc-defg-hij/?authuser=2',
      },
      {
        id: 'interview-other',
        stage: 'TECH_INTERVIEW',
        callUrl: 'https://meet.google.com/other-room',
      },
    ])

    await expect(
      matcher.findExactMatch(
        tx,
        recording({
          kind: 'meeting',
          provider: 'google-meet',
          meetingUrl: 'https://meet.google.com/abc-defg-hij#fragment',
        }),
      ),
    ).resolves.toEqual({
      interviewId: 'interview-match',
      stageAtLink: 'FINAL_INTERVIEW',
      matchedBy: 'meeting-url',
    })
  })

  it('does not auto-link an ambiguous or non-Google-Meet recording', async () => {
    const matcher = new MeetingRecorderMatcher()
    const tx = txWithCandidates([
      {
        id: 'interview-a',
        stage: 'TECH_INTERVIEW',
        callUrl: 'https://meet.google.com/abc-defg-hij',
      },
      {
        id: 'interview-b',
        stage: 'FINAL_INTERVIEW',
        callUrl: 'https://meet.google.com/abc-defg-hij?authuser=1',
      },
    ])

    await expect(
      matcher.findExactMatch(
        tx,
        recording({ kind: 'meeting', provider: 'google-meet', meetingId: 'ABC-DEFG-HIJ' }),
      ),
    ).resolves.toBeNull()
    await expect(
      matcher.findExactMatch(
        tx,
        recording({
          kind: 'meeting',
          provider: 'zoom',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }),
      ),
    ).resolves.toBeNull()

    await expect(
      matcher.findExactMatch(
        txWithCandidates([
          {
            id: 'interview-only',
            stage: 'TECH_INTERVIEW',
            callUrl: 'https://meet.google.com/abc-defg-hij',
          },
        ]),
        recording({
          kind: 'meeting',
          provider: 'zoom',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }),
      ),
    ).resolves.toBeNull()
  })

  it('does not use an invalid incoming Meet URL as a null-match wildcard', async () => {
    const matcher = new MeetingRecorderMatcher()

    await expect(
      matcher.findExactMatch(
        txWithCandidates([
          {
            id: 'interview-invalid',
            stage: 'TECH_INTERVIEW',
            callUrl: 'https://example.com/not-a-meet-room',
          },
        ]),
        recording({
          kind: 'meeting',
          provider: 'google-meet',
          meetingUrl: 'https://example.com/not-a-meet-room',
        }),
      ),
    ).resolves.toBeNull()
  })

  it('does not auto-link an ambiguous canonical Meet URL match', async () => {
    const matcher = new MeetingRecorderMatcher()
    const tx = txWithCandidates([
      {
        id: 'interview-a',
        stage: 'TECH_INTERVIEW',
        callUrl: 'https://meet.google.com/abc-defg-hij',
      },
      {
        id: 'interview-b',
        stage: 'FINAL_INTERVIEW',
        callUrl: 'https://meet.google.com/abc-defg-hij?authuser=1',
      },
    ])

    await expect(
      matcher.findExactMatch(
        tx,
        recording({
          kind: 'meeting',
          provider: 'google-meet',
          meetingUrl: 'https://meet.google.com/abc-defg-hij#fragment',
        }),
      ),
    ).resolves.toBeNull()
  })
})
