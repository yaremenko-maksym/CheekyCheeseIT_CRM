import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyJobQueueSeed } from './job-queue'
import type { SeedDb } from './shared'
import { verifySeed } from './verify'

vi.mock('./job-queue', () => ({ verifyJobQueueSeed: vi.fn() }))

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => undefined))
afterEach(() => vi.restoreAllMocks())

describe('verifySeed — Task 7.6a', () => {
  it('verifies the job-queue seed on the same connection', async () => {
    const db = { execute: () => Promise.resolve({ rows: [] }) } as unknown as SeedDb
    await verifySeed({ db })
    expect(vi.mocked(verifyJobQueueSeed).mock.calls).toEqual([[{ db }]])
  })
})
