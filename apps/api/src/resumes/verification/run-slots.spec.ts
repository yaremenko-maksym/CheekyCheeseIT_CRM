/**
 * Unit spec of the per-process cap on concurrent verification runs (backlog 436): at most `size`
 * bodies at once, waiters in FIFO order, a slot freed by a body that rejects, the waiting ids.
 */
import { describe, expect, it } from 'vitest'
import { RunSlots } from './run-slots'

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every queued microtask run, so a woken waiter has entered its body. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

function harness(size: number, ids: string[]) {
  const slots = new RunSlots(size)
  const gates = new Map(ids.map((id) => [id, deferred()]))
  const entered: string[] = []
  let inside = 0
  let peak = 0
  const done = ids.map((id) =>
    slots
      .hold(id, async () => {
        entered.push(id)
        inside += 1
        peak = Math.max(peak, inside)
        try {
          await gates.get(id)?.promise
          return id
        } finally {
          inside -= 1
        }
      })
      .catch((err: unknown) => `rejected:${String(err)}`),
  )
  return { slots, gates, entered, done, peak: () => peak }
}

describe('RunSlots', () => {
  it('runs at most `size` bodies at once; the rest wait in FIFO order', async () => {
    const h = harness(2, ['a', 'b', 'c', 'd', 'e'])
    await settle()
    expect(h.entered).toEqual(['a', 'b'])
    expect(h.slots.waiting()).toEqual(['c', 'd', 'e'])

    h.gates.get('b')?.resolve()
    await settle()
    expect(h.entered).toEqual(['a', 'b', 'c'])
    expect(h.slots.waiting()).toEqual(['d', 'e'])

    for (const gate of h.gates.values()) gate.resolve()
    expect(await Promise.all(h.done)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(h.entered).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(h.peak()).toBe(2)
    expect(h.slots.waiting()).toEqual([])
  })

  it('a body that rejects frees its slot for the next waiter, and the rejection reaches the caller', async () => {
    const h = harness(1, ['a', 'b', 'c'])
    await settle()
    expect(h.entered).toEqual(['a'])
    h.gates.get('a')?.reject('boom')
    await settle()
    expect(h.entered).toEqual(['a', 'b'])
    h.gates.get('b')?.reject('again')
    await settle()
    expect(h.entered).toEqual(['a', 'b', 'c'])
    h.gates.get('c')?.resolve()
    expect(await Promise.all(h.done)).toEqual(['rejected:boom', 'rejected:again', 'c'])
    expect(h.peak()).toBe(1)
  })

  it('a body that throws synchronously frees its slot too', async () => {
    const slots = new RunSlots(1)
    const first = slots.hold('a', () => {
      throw new Error('sync')
    })
    await expect(first).rejects.toThrow('sync')
    expect(await slots.hold('b', async () => 'b')).toBe('b')
  })

  it('after every slot is released, new arrivals start at once up to the cap again', async () => {
    const h = harness(2, ['a', 'b'])
    for (const gate of h.gates.values()) gate.resolve()
    await Promise.all(h.done)
    expect(h.slots.waiting()).toEqual([])
    const late = deferred()
    const order: string[] = []
    const x = h.slots.hold('x', async () => {
      order.push('x')
      await late.promise
    })
    const y = h.slots.hold('y', async () => {
      order.push('y')
      await late.promise
    })
    const z = h.slots.hold('z', async () => {
      order.push('z')
    })
    await settle()
    expect(order).toEqual(['x', 'y'])
    expect(h.slots.waiting()).toEqual(['z'])
    late.resolve()
    await Promise.all([x, y, z])
    expect(order).toEqual(['x', 'y', 'z'])
  })
})
