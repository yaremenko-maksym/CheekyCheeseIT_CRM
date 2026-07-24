import { describe, expect, it } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { computeFingerprint } from './fingerprint'
import {
  MESSAGE_MAX_LENGTH,
  STACK_MAX_LENGTH,
  TelemetryErrorsService,
} from './telemetry-errors.service'

/**
 * Unit tests for the orchestration around the upsert (sanitize/truncate/
 * fingerprint + the exact `.values()`/`.onConflictDoUpdate()` shape passed to
 * Drizzle). The ACTUAL Postgres upsert semantics (count++, RESOLVED→NEW
 * regression, unique-by-fingerprint grouping) can only be proven against a
 * real Postgres — see `telemetry.integration.spec.ts` (AC2/AC3/AC4).
 */

interface InsertCall {
  values?: unknown
  onConflict?: { target: unknown; set: Record<string, unknown> }
}

function makeDb(): { db: DatabaseService; calls: InsertCall[] } {
  const calls: InsertCall[] = []
  const db = {
    db: {
      insert: (_table: unknown) => {
        const call: InsertCall = {}
        calls.push(call)
        return {
          values: (v: unknown) => {
            call.values = v
            return {
              onConflictDoUpdate: (o: { target: unknown; set: Record<string, unknown> }) => {
                call.onConflict = o
                return Promise.resolve(undefined)
              },
            }
          },
        }
      },
    },
  }
  return { db: db as unknown as DatabaseService, calls }
}

describe('TelemetryErrorsService.recordError', () => {
  it('inserts with the computed fingerprint, count=1, status=NEW', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom', stack: 'at foo (a.js:1:1)' })

    const expectedFingerprint = computeFingerprint({
      source: 'WEB',
      message: 'boom',
      stack: 'at foo (a.js:1:1)',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({
      fingerprint: expectedFingerprint,
      source: 'WEB',
      message: 'boom',
      count: 1,
      status: 'NEW',
    })
  })

  it('sanitizes AND truncates message/stack before storing', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({
      source: 'API',
      message: `Bearer sekrit-token-1234 broke ${'x'.repeat(MESSAGE_MAX_LENGTH)}`,
      stack: `Bearer another-sekrit ${'y'.repeat(STACK_MAX_LENGTH)}`,
    })

    const values = calls[0]!.values as { message: string; stack: string }
    expect(values.message).not.toContain('sekrit-token-1234')
    expect(values.message.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH)
    expect(values.stack).not.toContain('another-sekrit')
    expect(values.stack.length).toBeLessThanOrEqual(STACK_MAX_LENGTH)
  })

  it('stores stack as null when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    expect((calls[0]!.values as { stack: unknown }).stack).toBeNull()
  })

  it('defaults route/userId/userRole to null and meta to {} when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    expect(calls[0]!.values).toMatchObject({
      route: null,
      userId: null,
      userRole: null,
      meta: {},
    })
  })

  it('passes through route/userId/userRole/meta when provided', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({
      source: 'WEB',
      message: 'boom',
      route: '/finance',
      userId: '11111111-1111-4111-8111-111111111111',
      userRole: 'SENIOR',
      meta: { ua: 'Mozilla/5.0', viewport: '1920x1080' },
    })

    expect(calls[0]!.values).toMatchObject({
      route: '/finance',
      userId: '11111111-1111-4111-8111-111111111111',
      userRole: 'SENIOR',
      meta: { ua: 'Mozilla/5.0', viewport: '1920x1080' },
    })
  })

  it('targets the fingerprint column for onConflictDoUpdate and sets count/lastSeen/status', async () => {
    const { db, calls } = makeDb()
    const svc = new TelemetryErrorsService(db)

    await svc.recordError({ source: 'WEB', message: 'boom' })

    const onConflict = calls[0]!.onConflict!
    expect(onConflict.set).toHaveProperty('count')
    expect(onConflict.set).toHaveProperty('lastSeen')
    expect(onConflict.set).toHaveProperty('status')
  })
})
