/**
 * Unit tests for `assertProjectActive` — the fused fetch+check guard behind
 * Д2 ("Транзакция на проект в статусе DRAFT/REJECTED отбивается на
 * сервере"). Pure function, no DB — the fusion property itself (fetch and
 * check as one statement) is proven at the call sites in
 * transactions.service.ts (see project-draft-transaction-guard.unit.spec.ts);
 * this file pins the guard's own decision table.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { assertProjectActive, PROJECT_NOT_ACTIVE_MESSAGE } from './project-status.util'

function project(status: 'DRAFT' | 'ACTIVE' | 'REJECTED') {
  return { id: 'p1', status }
}

// task-i18n-stage4-task1 — `apiError()` no longer throws the NestJS
// built-in exception subclasses, so a `code`-based assertion is required
// (see this file's other two tests below). `expect()` cannot sit directly
// inside a `try`/`catch` around a SYNC throw (vitest/no-conditional-expect
// — that expect would simply never run if the function did not throw,
// masking a regression instead of failing it); capturing the thrown value
// through a helper keeps the `expect()` unconditional while still letting
// the assertion inspect it.
function captureSyncError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (err) {
    return err
  }
}

describe('assertProjectActive', () => {
  it('AC4: throws BadRequestException for a DRAFT project', () => {
    expect(() => assertProjectActive(project('DRAFT'))).toThrow(BadRequestException)
    expect(() => assertProjectActive(project('DRAFT'))).toThrow(PROJECT_NOT_ACTIVE_MESSAGE)
  })

  it('AC4: throws BadRequestException for a REJECTED project', () => {
    expect(() => assertProjectActive(project('REJECTED'))).toThrow(BadRequestException)
    expect(() => assertProjectActive(project('REJECTED'))).toThrow(PROJECT_NOT_ACTIVE_MESSAGE)
  })

  it('returns the project unchanged for an ACTIVE project', () => {
    const p = project('ACTIVE')
    expect(assertProjectActive(p)).toBe(p)
  })

  it('throws PROJECT_NOT_FOUND (not the DRAFT/REJECTED refusal) when the project is undefined', () => {
    expect(captureSyncError(() => assertProjectActive(undefined))).toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    })
  })

  it('throws PROJECT_NOT_FOUND when the project is null', () => {
    expect(captureSyncError(() => assertProjectActive(null))).toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    })
  })
})
