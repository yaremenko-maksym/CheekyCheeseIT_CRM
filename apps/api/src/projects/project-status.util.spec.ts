/**
 * Unit tests for `assertProjectActive` — the fused fetch+check guard behind
 * Д2 ("Транзакция на проект в статусе DRAFT/REJECTED отбивается на
 * сервере"). Pure function, no DB — the fusion property itself (fetch and
 * check as one statement) is proven at the call sites in
 * transactions.service.ts (see project-draft-transaction-guard.unit.spec.ts);
 * this file pins the guard's own decision table.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { assertProjectActive, PROJECT_NOT_ACTIVE_MESSAGE } from './project-status.util'

function project(status: 'DRAFT' | 'ACTIVE' | 'REJECTED') {
  return { id: 'p1', status }
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

  it('throws NotFoundException (not BadRequestException) when the project is undefined', () => {
    expect(() => assertProjectActive(undefined)).toThrow(NotFoundException)
  })

  it('throws NotFoundException when the project is null', () => {
    expect(() => assertProjectActive(null)).toThrow(NotFoundException)
  })
})
