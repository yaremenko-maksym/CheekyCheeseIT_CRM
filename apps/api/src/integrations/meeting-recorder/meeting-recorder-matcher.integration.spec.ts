import type { MeetingRecorderRecordingInput } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as schema from '../../database/schema'
import type { DrizzleTx } from '../../database/types'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { googleMeetCodeFromUrl, MeetingRecorderMatcher } from './meeting-recorder-matcher'

/**
 * MeetingRecorderMatcher against real rows (SR-865-H-1, CR-865-H-1, CR-865-H-3).
 *
 * Pins, through the real SQL: the ±30 min window around `interviews.scheduled_at`
 * (owner decision D-1), terminal/archived exclusion, NULL schedule = no match,
 * ambiguity = no match, the URL fallback, and that the Postgres-generated
 * `call_meet_code` agrees with `googleMeetCodeFromUrl` on the same inputs.
 *
 * DB-SKIP-GUARD: skipped without DATABASE_URL; a set-but-unreachable URL fails.
 */

const SENIOR_ID = '5e1a0000-0000-4000-a000-000000000001'
const SCHEDULED = '2026-10-07T12:00:00.000Z'
/** When every seeded interview's callUrl/scheduledAt was set — well before the call. */
const KEY_SET_AT = '2026-09-01T09:00:00.000Z'

const IV = {
  match: '5e1a0000-0000-4000-a000-000000000010',
  reusedRoomLastWeek: '5e1a0000-0000-4000-a000-000000000011',
  hired: '5e1a0000-0000-4000-a000-000000000012',
  rejected: '5e1a0000-0000-4000-a000-000000000013',
  archived: '5e1a0000-0000-4000-a000-000000000014',
  offer: '5e1a0000-0000-4000-a000-000000000015',
  unscheduled: '5e1a0000-0000-4000-a000-000000000016',
  ambiguousA: '5e1a0000-0000-4000-a000-000000000017',
  ambiguousB: '5e1a0000-0000-4000-a000-000000000018',
  urlOnly: '5e1a0000-0000-4000-a000-000000000019',
} as const

/** callUrl inputs whose generated code must equal `googleMeetCodeFromUrl`. */
const PARITY_URLS = [
  'https://meet.google.com/AbC-DeFg-HiJ/?authuser=1#fragment',
  'https://meet.google.com/abc-defg-hij///',
  'https://meet.google.com/prefix/AbC-DeFg-HiJ',
  'HTTPS://MEET.GOOGLE.COM/XyZ-room',
  'https://meet.google.com:443/port-room',
  'http://meet.google.com/abc-defg-hij',
  'https://example.com/abc-defg-hij',
  'https://meet.google.com:444/abc-defg-hij',
  'https://user@meet.google.com/abc-defg-hij',
  'https://user:pass@meet.google.com/abc-defg-hij',
  'https://meet.google.com.evil.example/abc-defg-hij',
  'https://meet.google.com/',
  'not a URL',
]
const PARITY_ID_PREFIX = '5e1a0000-0000-4000-a100-0000000000'

function recordingAt(
  startedAt: string,
  source: Partial<MeetingRecorderRecordingInput['source']>,
): MeetingRecorderRecordingInput {
  return {
    id: 'matcher-integration-recording',
    title: 'Matcher integration',
    startedAt,
    source: { kind: 'meeting', provider: 'google-meet', ...source },
  }
}

function shift(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString()
}

const MIN = 60 * 1000

describe.skipIf(!hasDatabaseUrl())('MeetingRecorderMatcher — real DB', () => {
  let pool: Pool
  let tx: DrizzleTx
  const matcher = new MeetingRecorderMatcher()

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM interviews WHERE senior_id = $1', [SENIOR_ID])
    await pool.query('DELETE FROM users WHERE id = $1', [SENIOR_ID])
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    try {
      await pool.query('SELECT 1')
    } catch {
      throw new Error('[meeting-recorder-matcher integration] FAILED — no DB at DATABASE_URL')
    }
    await cleanup()
    await pool.query(
      `INSERT INTO users (id, email, display_name, role, locale)
       VALUES ($1, 'mr-matcher@test.spec', 'MR Matcher Senior', 'SENIOR', 'en')`,
      [SENIOR_ID],
    )
    const rows: Array<[id: string, callUrl: string, stage: string, scheduledAt: string | null]> = [
      [IV.match, 'https://meet.google.com/mtch-room-aaa', 'TECH_INTERVIEW', SCHEDULED],
      // A reused personal room: same code, a week earlier — must not collide.
      [
        IV.reusedRoomLastWeek,
        'https://meet.google.com/mtch-room-aaa',
        'FINAL_INTERVIEW',
        '2026-09-30T12:00:00.000Z',
      ],
      [IV.hired, 'https://meet.google.com/hird-room-aaa', 'HIRED', SCHEDULED],
      [IV.rejected, 'https://meet.google.com/rjct-room-aaa', 'REJECTED', SCHEDULED],
      [IV.archived, 'https://meet.google.com/arch-room-aaa', 'ARCHIVED', SCHEDULED],
      [IV.offer, 'https://meet.google.com/offr-room-aaa', 'OFFER_RECEIVED', SCHEDULED],
      [IV.unscheduled, 'https://meet.google.com/nosc-room-aaa', 'TECH_INTERVIEW', null],
      [IV.ambiguousA, 'https://meet.google.com/ambi-room-aaa', 'TECH_INTERVIEW', SCHEDULED],
      [
        IV.ambiguousB,
        'https://meet.google.com/ambi-room-aaa?authuser=1',
        'CLIENT_INTERVIEW',
        shift(SCHEDULED, 10 * MIN),
      ],
      [IV.urlOnly, 'https://meet.google.com/prefix/URLF-ROOM-AAA/', 'TECH_INTERVIEW', SCHEDULED],
    ]
    for (const [id, callUrl, stage, scheduledAt] of rows) {
      await pool.query(
        `INSERT INTO interviews
           (id, senior_id, company_name, call_url, stage, scheduled_at, match_key_changed_at)
         VALUES ($1, $2, 'Matcher Co', $3, $4, $5, $6)`,
        [id, SENIOR_ID, callUrl, stage, scheduledAt, KEY_SET_AT],
      )
    }
    tx = drizzle(pool, { schema }) as unknown as DrizzleTx
  }, 20_000)

  afterAll(async () => {
    if (!pool) return
    await cleanup()
    await pool.end()
  }, 20_000)

  it('matches the one non-terminal interview scheduled within ±30 min, by meeting id', async () => {
    await expect(
      matcher.findExactMatch(
        tx,
        recordingAt(shift(SCHEDULED, 5 * MIN), { meetingId: 'MTCH-ROOM-AAA' }),
      ),
    ).resolves.toEqual({
      interviewId: IV.match,
      stageAtLink: 'TECH_INTERVIEW',
      matchedBy: 'meeting-id',
    })
  })

  it('treats both ends of the ±30 min window as inside and one second beyond as outside', async () => {
    for (const offset of [-30 * MIN, 30 * MIN]) {
      await expect(
        matcher.findExactMatch(
          tx,
          recordingAt(shift(SCHEDULED, offset), { meetingId: 'mtch-room-aaa' }),
        ),
      ).resolves.toEqual(expect.objectContaining({ interviewId: IV.match }))
    }
    for (const offset of [-30 * MIN - 1000, 30 * MIN + 1000]) {
      await expect(
        matcher.findExactMatch(
          tx,
          recordingAt(shift(SCHEDULED, offset), { meetingId: 'mtch-room-aaa' }),
        ),
      ).resolves.toBeNull()
    }
  })

  it('never matches a terminal or archived interview, but does match OFFER_RECEIVED', async () => {
    for (const code of ['hird-room-aaa', 'rjct-room-aaa', 'arch-room-aaa']) {
      await expect(
        matcher.findExactMatch(tx, recordingAt(SCHEDULED, { meetingId: code })),
      ).resolves.toBeNull()
    }
    await expect(
      matcher.findExactMatch(tx, recordingAt(SCHEDULED, { meetingId: 'offr-room-aaa' })),
    ).resolves.toEqual(expect.objectContaining({ interviewId: IV.offer }))
  })

  it('ignores an interview whose call URL or schedule changed after the recording started', async () => {
    const recording = recordingAt(shift(SCHEDULED, 5 * MIN), { meetingId: 'mtch-room-aaa' })
    try {
      // Equal to startedAt still counts as "not before": the key must predate the call.
      await pool.query('UPDATE interviews SET match_key_changed_at = $2 WHERE id = $1', [
        IV.match,
        recording.startedAt,
      ])
      await expect(matcher.findExactMatch(tx, recording)).resolves.toBeNull()
      await pool.query('UPDATE interviews SET match_key_changed_at = $2 WHERE id = $1', [
        IV.match,
        shift(recording.startedAt, -1000),
      ])
      await expect(matcher.findExactMatch(tx, recording)).resolves.toEqual(
        expect.objectContaining({ interviewId: IV.match }),
      )
    } finally {
      await pool.query('UPDATE interviews SET match_key_changed_at = $2 WHERE id = $1', [
        IV.match,
        KEY_SET_AT,
      ])
    }
  })

  it('never matches an interview without a scheduled time', async () => {
    await expect(
      matcher.findExactMatch(tx, recordingAt(SCHEDULED, { meetingId: 'nosc-room-aaa' })),
    ).resolves.toBeNull()
  })

  it('does not link when two interviews share the code inside the window', async () => {
    await expect(
      matcher.findExactMatch(tx, recordingAt(SCHEDULED, { meetingId: 'ambi-room-aaa' })),
    ).resolves.toBeNull()
  })

  it('falls back to the code in the meeting URL when there is no meeting id', async () => {
    await expect(
      matcher.findExactMatch(
        tx,
        recordingAt(SCHEDULED, { meetingUrl: 'https://meet.google.com/urlf-room-aaa?authuser=0' }),
      ),
    ).resolves.toEqual({
      interviewId: IV.urlOnly,
      stageAtLink: 'TECH_INTERVIEW',
      matchedBy: 'meeting-url',
    })
  })

  it('falls back to the URL code when the meeting id matches nothing', async () => {
    await expect(
      matcher.findExactMatch(
        tx,
        recordingAt(SCHEDULED, {
          meetingId: 'zzzz-zzzz-zzz',
          meetingUrl: 'https://meet.google.com/urlf-room-aaa',
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({ interviewId: IV.urlOnly, matchedBy: 'meeting-url' }),
    )
  })

  it('generates call_meet_code exactly as googleMeetCodeFromUrl normalizes the same URL', async () => {
    const ids = PARITY_URLS.map((_, i) => `${PARITY_ID_PREFIX}${String(i).padStart(2, '0')}`)
    for (const [i, url] of PARITY_URLS.entries()) {
      await pool.query(
        `INSERT INTO interviews (id, senior_id, company_name, call_url) VALUES ($1, $2, 'Parity', $3)`,
        [ids[i], SENIOR_ID, url],
      )
    }
    const res = await pool.query<{ call_url: string; call_meet_code: string | null }>(
      'SELECT call_url, call_meet_code FROM interviews WHERE id = ANY($1)',
      [ids],
    )
    expect(res.rows).toHaveLength(PARITY_URLS.length)
    const byUrl = new Map(res.rows.map((row) => [row.call_url, row.call_meet_code]))
    for (const url of PARITY_URLS) {
      expect({ url, code: byUrl.get(url) }).toEqual({ url, code: googleMeetCodeFromUrl(url) })
    }
  })
})
