/**
 * SR-H-2 (timing half): a cap-filling GermanTechJobs page of slow-shape titles, ingested and
 * classified, costs about what a page of ordinary titles costs.
 *
 * A separate file for the reason `xml/growth.timing.spec.ts` gives: a wall-clock ratio cancels
 * machine speed but not contention. Inside the shared unit suite this ratio read 11.5 (wall) and 7.9
 * (CPU) on the fixed code, against 3.0 / 1.0 alone. It is excluded from the default `vitest run`
 * (`TIMING_SPECS` in `apps/api/vitest.config.mts`) and runs alone in the `Timing specs` CI job:
 *
 *   TIMING_SPECS=1 pnpm --filter @crm/api exec vitest run
 *
 * The non-timing half stays in `germantechjobs.provider.spec.ts` and gates every push: the same page
 * is ingested, and every classified title is at most DISPLAY_TITLE_CHARS long. `role-classifier.spec.ts`
 * pins, by CPU-time scaling, that the classifier is linear in the title length.
 */

import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { classifyRoles } from '../../funnel/role-classifier'
import { GERMANTECHJOBS_MAX_BYTES, germanTechJobsProvider } from './germantechjobs.provider'

const NOW = new Date('2026-11-24T12:00:00Z')

async function ingestAndClassify(bodyText: string): Promise<number> {
  const f = fakeCollectionContext({ now: NOW, responses: [{ status: 200, bodyText }] })
  const batch = await germanTechJobsProvider.collectReport(
    germanTechJobsProvider.parseConfig({ configVersion: 1 }),
    f.ctx,
  )
  for (const o of batch.observations) classifyRoles({ title: o.normalized.title, tags: [] })
  return batch.observations.length
}

/** Fastest of three wall-clock runs, after a warm-up: the minimum filters GC noise. */
async function fastestMs(bodyText: string): Promise<number> {
  await ingestAndClassify(bodyText)
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    await ingestAndClassify(bodyText)
    best = Math.min(best, performance.now() - started)
  }
  return best
}

const page = (name: (i: number) => string) =>
  JSON.stringify(
    Array.from({ length: 1_900 }, (_, i) => ({
      _id: `filler-${i}`,
      jobUrl: `filler-${i}`,
      name: name(i),
      company: 'Probe GmbH',
      activeFrom: '2026-11-14T00:00:00.000+01:00',
    })),
  )

describe('GermanTechJobs: a page of slow-shape titles (timing)', () => {
  it('ingests and classifies 1,900 slow-shape titles (2,000 chars) about as fast as ordinary ones', async () => {
    // Measured 2026-11-25 (Apple silicon, alone): 2,844 ms before the classifier fix, 249 ms after;
    // the ratio to the ordinary page read 19.0 before, 3.0 after. Linear is a small constant;
    // the quadratic patterns put it far above 8.
    const srH2 = `архітектор проєктувальн${' '.repeat(2_000 - 24)}x`
    const engineer = `інженер ${' '.repeat(2_000 - 9)}x`
    const ordinary = `Backend Engineer ${'a'.repeat(2_000 - 17)}`
    const slowBody = page((i) => (i % 2 === 0 ? srH2 : engineer))
    const ordinaryBody = page(() => ordinary)
    expect(Buffer.byteLength(slowBody)).toBeLessThanOrEqual(GERMANTECHJOBS_MAX_BYTES)
    expect(await ingestAndClassify(slowBody)).toBe(950)
    expect(await ingestAndClassify(ordinaryBody)).toBe(1_900)

    expect((await fastestMs(slowBody)) / (await fastestMs(ordinaryBody))).toBeLessThan(8)
  }, 120_000)
})
