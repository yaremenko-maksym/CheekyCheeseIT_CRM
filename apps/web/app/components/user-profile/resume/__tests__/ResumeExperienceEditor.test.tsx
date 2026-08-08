/**
 * `moveItem` — the reorder rule behind the experience list.
 *
 * It was exported "so the reorder rule is unit-testable" and then never tested,
 * which makes the export a claim rather than a fact. Order is not cosmetic
 * here: task-resume-tailoring reorders exactly these items per vacancy, so the
 * edge cases (ends of the list, out-of-range indices) are the contract that
 * task will build on.
 */
import { describe, expect, it } from 'vitest'
import { moveItem } from '../ResumeExperienceEditor'

const items = ['a', 'b', 'c', 'd'] as const

describe('moveItem', () => {
  it('moves an item up', () => {
    expect(moveItem(items, 2, 1)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves an item down', () => {
    expect(moveItem(items, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves across the whole list, not just by one', () => {
    expect(moveItem(items, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(items, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('never mutates the input', () => {
    const original = [...items]
    moveItem(original, 0, 2)
    expect(original).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns a copy, not the same reference', () => {
    const original = [...items]
    expect(moveItem(original, 1, 2)).not.toBe(original)
  })

  it.each([
    ['same position', 1, 1],
    ['negative source', -1, 1],
    ['negative target', 1, -1],
    ['source past the end', 4, 1],
    ['target past the end', 1, 4],
  ])('leaves the order untouched for %s', (_label, from, to) => {
    expect(moveItem(items, from, to)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles an empty list', () => {
    expect(moveItem([], 0, 0)).toEqual([])
  })

  it('handles a single-item list', () => {
    expect(moveItem(['only'], 0, 0)).toEqual(['only'])
  })
})
