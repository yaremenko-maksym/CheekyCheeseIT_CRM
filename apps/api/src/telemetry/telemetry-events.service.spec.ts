import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import type { Env } from '../config/env'
import type { DatabaseService } from '../database/database.service'
import { computeSessionHash } from './session-hash'
import { TelemetryEventsService } from './telemetry-events.service'

const SALT = 'test-telemetry-session-salt-not-a-real-secret-000'

function makeConfig(): ConfigService<Env, true> {
  return { get: () => SALT } as unknown as ConfigService<Env, true>
}

function makeDb(): { db: DatabaseService; getInsertedRows: () => unknown[] } {
  let inserted: unknown[] = []
  const db = {
    db: {
      insert: (_table: unknown) => ({
        values: (rows: unknown[]) => {
          inserted = rows
          return Promise.resolve(undefined)
        },
      }),
    },
  }
  return { db: db as unknown as DatabaseService, getInsertedRows: () => inserted }
}

describe('TelemetryEventsService.recordBatch', () => {
  it('inserts one row per event, with the actor role + a computed session_hash (never the raw userId)', async () => {
    const { db, getInsertedRows } = makeDb()
    const svc = new TelemetryEventsService(db, makeConfig())
    const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'SENIOR' }

    await svc.recordBatch(
      [
        { event: 'route_enter', route: '/team' },
        { event: 'feature_click', route: '/vacancies', target: 'create-vacancy-button' },
      ],
      actor,
    )

    const rows = getInsertedRows() as Array<{
      sessionHash: string
      userRole: string
      event: string
      route: string
      target: string | null
      durationMs: number | null
    }>
    expect(rows).toHaveLength(2)
    const expectedHash = computeSessionHash(actor.id, SALT)
    for (const row of rows) {
      expect(row.sessionHash).toBe(expectedHash)
      expect(row.sessionHash).not.toContain(actor.id)
      expect(row.userRole).toBe('SENIOR')
    }
    expect(rows[0]).toMatchObject({
      event: 'route_enter',
      route: '/team',
      target: null,
      durationMs: null,
    })
    expect(rows[1]).toMatchObject({
      event: 'feature_click',
      route: '/vacancies',
      target: 'create-vacancy-button',
    })
  })

  it('carries durationMs through for route_leave events', async () => {
    const { db, getInsertedRows } = makeDb()
    const svc = new TelemetryEventsService(db, makeConfig())

    await svc.recordBatch([{ event: 'route_leave', route: '/team', durationMs: 4200 }], {
      id: 'u1',
      role: 'JUNIOR',
    })

    expect((getInsertedRows()[0] as { durationMs: number }).durationMs).toBe(4200)
  })

  it('sec HIGH (review round 1): strips a query string from event.route before storing (consistency with errors/filter)', async () => {
    const { db, getInsertedRows } = makeDb()
    const svc = new TelemetryEventsService(db, makeConfig())

    await svc.recordBatch([{ event: 'route_enter', route: '/finance?tab=history&highlight=42' }], {
      id: 'u1',
      role: 'SENIOR',
    })

    const row = getInsertedRows()[0] as { route: string }
    expect(row.route).toBe('/finance')
    expect(row.route).not.toContain('tab=')
  })

  it('is a no-op on an empty batch', async () => {
    const { db, getInsertedRows } = makeDb()
    const svc = new TelemetryEventsService(db, makeConfig())

    await svc.recordBatch([], { id: 'u1', role: 'JUNIOR' })

    expect(getInsertedRows()).toHaveLength(0)
  })

  it('gives the same actor the same session_hash across separate batches on the same day', async () => {
    const { db, getInsertedRows } = makeDb()
    const svc = new TelemetryEventsService(db, makeConfig())
    const actor = { id: 'u1', role: 'HR' }

    await svc.recordBatch([{ event: 'route_enter', route: '/a' }], actor)
    const first = (getInsertedRows()[0] as { sessionHash: string }).sessionHash

    await svc.recordBatch([{ event: 'route_enter', route: '/b' }], actor)
    const second = (getInsertedRows()[0] as { sessionHash: string }).sessionHash

    expect(first).toBe(second)
  })
})
