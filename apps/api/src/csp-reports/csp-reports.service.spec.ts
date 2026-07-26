import { describe, expect, it } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { CspReportsService, USER_AGENT_MAX_LENGTH } from './csp-reports.service'

/**
 * Unit tests for the orchestration around the upsert (resolve directive /
 * normalize / sanitize + the exact `.values()`/`.onConflictDoUpdate()` shape
 * passed to Drizzle) — mirrors `telemetry-errors.service.spec.ts`. The
 * ACTUAL Postgres upsert semantics (count++, unique-by-aggregation-key
 * grouping) can only be proven against a real Postgres — see
 * `csp-reports.integration.spec.ts`.
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

describe('CspReportsService.recordViolation', () => {
  it('inserts with the resolved directive, normalized blockedUri/documentPath, count=1', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example/x.js?foo=bar',
      documentUri: 'https://app.cheekycheese.tech/team?code=abc',
      disposition: 'report',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toMatchObject({
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example/x.js',
      documentPath: '/team',
      disposition: 'report',
      count: 1,
    })
  })

  it('does NOT insert when neither effective-directive nor violated-directive is usable', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({ blockedUri: 'https://evil.example/x.js' })

    expect(calls).toHaveLength(0)
  })

  it('falls back to violated-directive when effective-directive is missing', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({ violatedDirective: "style-src 'self'" })

    expect(calls[0]!.values).toMatchObject({ effectiveDirective: 'style-src' })
  })

  it('defaults disposition to "report" when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({ effectiveDirective: 'script-src' })

    expect(calls[0]!.values).toMatchObject({ disposition: 'report' })
  })

  it('sanitizes a secret-shaped blockedUri before normalizing/storing', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({
      effectiveDirective: 'connect-src',
      blockedUri: 'https://evil.example/steal?Authorization=Bearer sekrit-token-xyz',
    })

    const values = calls[0]!.values as { blockedUri: string }
    // Query string is stripped by normalization regardless, but the sanitize
    // step runs FIRST (defense-in-depth) — assert the secret never survives.
    expect(values.blockedUri).not.toContain('sekrit-token-xyz')
  })

  it('sanitizes AND truncates the User-Agent header before storing', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({
      effectiveDirective: 'script-src',
      userAgent: `Bearer sekrit-ua-token ${'x'.repeat(USER_AGENT_MAX_LENGTH)}`,
    })

    const values = calls[0]!.values as { userAgent: string }
    expect(values.userAgent).not.toContain('sekrit-ua-token')
    expect(values.userAgent.length).toBeLessThanOrEqual(USER_AGENT_MAX_LENGTH)
  })

  it('stores userAgent as null when omitted', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({ effectiveDirective: 'script-src' })

    expect((calls[0]!.values as { userAgent: unknown }).userAgent).toBeNull()
  })

  it('targets the (effectiveDirective, blockedUri, documentPath) composite key for onConflictDoUpdate', async () => {
    const { db, calls } = makeDb()
    const svc = new CspReportsService(db)

    await svc.recordViolation({ effectiveDirective: 'script-src' })

    const onConflict = calls[0]!.onConflict!
    expect(onConflict.target).toHaveLength(3)
    expect(onConflict.set).toHaveProperty('count')
    expect(onConflict.set).toHaveProperty('lastSeen')
    expect(onConflict.set).toHaveProperty('disposition')
    expect(onConflict.set).toHaveProperty('userAgent')
  })
})
