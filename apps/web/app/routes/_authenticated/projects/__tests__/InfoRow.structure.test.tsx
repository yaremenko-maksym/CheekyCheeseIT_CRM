/**
 * task-648-fix-round-4 (CR-M-4).
 *
 * Round 3 gave `InfoRow` an `stackOnMobile` prop and, to implement it, wrapped
 * the icon and the label in an extra `<span>`. That wrapper is rendered for
 * EVERY row of the «Детали проекта» card — all eight of them — while only one
 * row opts into the new layout. The reviewer's point was not that a regression
 * was found; it was that nothing on the branch could have found one: no test
 * and no screenshot looked at the other seven rows.
 *
 * This is the structural half of the answer (the empirical half is the per-row
 * measurement at 320/375 in `projects-senior-share-override.spec.ts`, describe
 * «Z»). Three different questions, deliberately not one snapshot:
 *
 *  1. the default path's markup is pinned literally, so any future edit to it
 *     shows up as a diff rather than as a visual surprise;
 *  2. opting in changes ONLY what it claims to change — the delta between the
 *     two renders is enumerated, so a class leaking into the default path
 *     turns this red;
 *  3. the wrapper is layout-NEUTRAL by construction: it re-creates its
 *     parent's own flex context (same direction, same alignment, same gap),
 *     which is the CSS arithmetic the round-3 comment states in prose. Read
 *     from the DOM on BOTH sides, so changing the row's gap without changing
 *     the wrapper's is what turns it red — an equality, not a literal.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InfoRow } from '../$projectId'

const classesOf = (el: Element) => [...el.classList].sort()

/*
 * `testing-library/no-node-access` is disabled for THIS FUNCTION ONLY, and
 * every traversal in the file is pulled in here so the exemption stays that
 * narrow. The rule exists to stop tests from coupling to DOM structure instead
 * of querying the way a user does — but the structure IS the subject here
 * (CR-M-4 asks whether an added wrapper element changed the other seven rows),
 * and "which element is the parent of which" has no accessible-query form. The
 * same reasoning `eslint.config.mjs` already applies where a `<script>` node's
 * absence has to be asserted; see `app/test/test-quality-rules.spec.ts`.
 */
/* eslint-disable testing-library/no-node-access */
function renderRow(stackOnMobile?: boolean) {
  const { container } = render(
    <InfoRow
      icon={<svg data-testid="row-icon" />}
      label="Стек"
      // `exactOptionalPropertyTypes` is on, so `stackOnMobile={undefined}` is
      // NOT the same thing as omitting the prop — and omitting it is exactly
      // what the default path this file pins does. Spreading conditionally
      // keeps the two renders honestly different: one passes the prop, the
      // other never mentions it.
      {...(stackOnMobile === undefined ? {} : { stackOnMobile })}
    >
      <span data-testid="row-value">React</span>
    </InfoRow>,
  )
  const row = container.firstElementChild as HTMLElement
  const wrapper = row.firstElementChild as HTMLElement
  const [icon, label] = [...wrapper.children] as HTMLElement[]
  const value = row.lastElementChild as HTMLElement
  // Not defensiveness: `noUncheckedIndexedAccess` types these two as possibly
  // undefined, and the honest way to narrow them is to state the structural
  // precondition every assertion below depends on. If the wrapper ever stops
  // holding exactly the icon and the label, this throws with a sentence
  // instead of letting six tests fail on `undefined` one by one.
  if (!icon || !label) {
    throw new Error('InfoRow must render the icon and the label inside one wrapper')
  }
  return {
    row,
    wrapper,
    icon,
    label,
    value,
    rowChildCount: row.children.length,
    wrapperChildCount: wrapper.children.length,
  }
}
/* eslint-enable testing-library/no-node-access */

describe('InfoRow — the default (opt-out) path is pinned', () => {
  it('renders row → (icon, label) wrapper → value, with the label suffixed by a colon', () => {
    const { row, wrapper, icon, label, value, rowChildCount, wrapperChildCount } = renderRow()

    expect(row.tagName).toBe('DIV')
    // The handle the per-row E2E measurement selects on. Pinned here so that
    // removing it fails loudly instead of quietly turning that measurement
    // into a loop over zero rows.
    expect(row.getAttribute('data-testid')).toBe('project-info-row')
    expect(rowChildCount).toBe(2)
    expect(wrapper.tagName).toBe('SPAN')
    expect(wrapperChildCount).toBe(2)
    expect(icon.tagName).toBe('SPAN')
    expect(label.tagName).toBe('SPAN')
    expect(label.textContent).toBe('Стек:')
    expect(value.tagName).toBe('DIV')
    expect(screen.getByTestId('row-icon')).toBeTruthy()
    expect(screen.getByTestId('row-value').textContent).toBe('React')
  })

  it('pins the layout classes of every part', () => {
    const { row, wrapper, icon, label, value } = renderRow()

    expect(classesOf(row)).toEqual(['flex', 'gap-2', 'items-start', 'min-w-0', 'text-sm'].sort())
    expect(classesOf(wrapper)).toEqual(['flex', 'gap-2', 'items-start', 'shrink-0'].sort())
    expect(classesOf(icon)).toEqual(['mt-0.5', 'shrink-0', 'text-muted-foreground'].sort())
    expect(classesOf(label)).toEqual(['min-w-[80px]', 'shrink-0', 'text-muted-foreground'].sort())
    expect(classesOf(value)).toEqual(
      [
        'break-words',
        'flex',
        'flex-1',
        'flex-wrap',
        'gap-x-1.5',
        'gap-y-1',
        'items-center',
        'min-w-0',
      ].sort(),
    )
  })

  it('carries no responsive (sm:) class at all — nothing about it is width-dependent', () => {
    const { row, wrapper, icon, label, value } = renderRow()
    for (const el of [row, wrapper, icon, label, value]) {
      expect([...el.classList].filter((c) => c.startsWith('sm:'))).toEqual([])
    }
  })
})

describe('InfoRow — opting in changes only what it claims to', () => {
  it('produces the same element tree and the same text', () => {
    const plain = renderRow()
    const stacked = renderRow(true)

    expect(stacked.row.tagName).toBe(plain.row.tagName)
    expect(stacked.wrapper.tagName).toBe(plain.wrapper.tagName)
    expect(stacked.value.tagName).toBe(plain.value.tagName)
    expect(stacked.rowChildCount).toBe(plain.rowChildCount)
    expect(stacked.wrapperChildCount).toBe(plain.wrapperChildCount)
    expect(stacked.row.textContent).toBe(plain.row.textContent)
  })

  it('adds exactly the documented classes, and removes exactly the one tailwind-merge overrides', () => {
    const plain = renderRow()
    const stacked = renderRow(true)

    const delta = (before: Element, after: Element) => ({
      added: classesOf(after).filter((c) => !classesOf(before).includes(c)),
      removed: classesOf(before).filter((c) => !classesOf(after).includes(c)),
    })

    // `gap-2` disappears from the row because `cn` runs tailwind-merge and
    // `gap-1` wins the conflict — the tighter mobile gap IS the point of the
    // prop, so the removal is intended. Spelled out rather than left
    // implicit: an unexplained vanishing class is exactly how the next
    // reader concludes the wrapper broke something.
    expect(delta(plain.row, stacked.row)).toEqual({
      added: ['flex-col', 'gap-1', 'sm:flex-row', 'sm:gap-2'],
      removed: ['gap-2'],
    })
    expect(delta(plain.wrapper, stacked.wrapper)).toEqual({ added: ['sm:contents'], removed: [] })
    expect(delta(plain.value, stacked.value)).toEqual({
      added: ['sm:w-auto', 'w-full'],
      removed: [],
    })
    // The two parts the prop says nothing about are untouched.
    expect(delta(plain.icon, stacked.icon)).toEqual({ added: [], removed: [] })
    expect(delta(plain.label, stacked.label)).toEqual({ added: [], removed: [] })
  })
})

describe('InfoRow — the wrapper is layout-neutral by construction', () => {
  it('re-creates its parent row’s flex context for the icon and the label', () => {
    const { row, wrapper } = renderRow()
    const gapOf = (el: Element) => [...el.classList].find((c) => /^gap-\d/.test(c))
    const alignOf = (el: Element) => [...el.classList].find((c) => c.startsWith('items-'))

    // Same direction, same cross-axis alignment, same gap as the row the icon
    // and label used to be direct children of. That equality is the whole
    // reason an extra element cannot move anything — asserted against the row
    // rather than against a literal, so changing the row's gap without
    // changing the wrapper's is what turns this red.
    expect(wrapper.classList.contains('flex')).toBe(true)
    expect(row.classList.contains('flex')).toBe(true)
    expect(gapOf(wrapper)).toBe(gapOf(row))
    expect(alignOf(wrapper)).toBe(alignOf(row))
  })

  it('does not grow: it stays shrink-0, as the icon and the label were on their own', () => {
    const { wrapper, icon, label } = renderRow()
    expect(wrapper.classList.contains('shrink-0')).toBe(true)
    expect(icon.classList.contains('shrink-0')).toBe(true)
    expect(label.classList.contains('shrink-0')).toBe(true)
  })
})
