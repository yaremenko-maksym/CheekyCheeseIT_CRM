/**
 * r5 Task 7.2 — the queue must fit 320 px: no fixed-pixel widths anywhere in its source.
 * `w-[min(20rem,…)]` style fluid widths are fine; `w-[420px]` / `min-w-[300px]` are not.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENTS = join(__dirname, '..')
const PAGE = join(__dirname, '../../../routes/_authenticated/job-queue/index.tsx')
const FIXED_PX_WIDTH = /\b(?:min-|max-)?w-\[\d+px\]/

const files = [
  ...readdirSync(COMPONENTS)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(COMPONENTS, f)),
  PAGE,
]

describe('job-queue responsive guard', () => {
  it('reads the queue sources (5 components + the page)', () => {
    expect(files).toHaveLength(6)
  })

  it.each(files)('%s has no fixed-pixel width class', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(FIXED_PX_WIDTH)
  })

  it('the pattern itself catches a fixed width', () => {
    expect('className="w-[420px]"').toMatch(FIXED_PX_WIDTH)
    expect('className="min-w-[300px]"').toMatch(FIXED_PX_WIDTH)
    expect('className="w-[min(20rem,calc(100vw-2rem))]"').not.toMatch(FIXED_PX_WIDTH)
  })
})
