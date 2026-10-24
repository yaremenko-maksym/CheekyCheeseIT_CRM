import { describe, expect, it } from 'vitest'

/**
 * Each ATS module must LOAD. The other specs import them at the top of the file, and a module that
 * throws while loading takes its whole spec file down as "no tests" - which a mutation run cannot
 * tell from "nothing failed". Importing inside a test turns "does not load" into a failed test.
 *
 * This is not ceremony: every adapter builds its config schema from `ats-config.ts` the moment it
 * is imported (the region list, the slug bound), so a broken kind definition is a boot failure of
 * the API, and the registration in Task 3.7 depends on these modules loading.
 */

describe('the ATS modules load and export what the registration needs', () => {
  it.each([
    ['./ats-config', ['GREENHOUSE_KIND', 'LEVER_KIND', 'ASHBY_KIND', 'collectBoardGroup']],
    ['./greenhouse.provider', ['greenhouseProvider', 'greenhouseSpec']],
    ['./lever.provider', ['leverProvider', 'leverSpec']],
    ['./ashby.provider', ['ashbyProvider', 'ashbySpec']],
  ])('%s', async (path, names) => {
    const mod = (await import(path)) as Record<string, unknown>
    for (const name of names) expect(mod[name], `${path} exports ${name}`).toBeDefined()
  })

  it('each provider can parse a minimal config the moment it loads', async () => {
    const { greenhouseProvider } = await import('./greenhouse.provider')
    const { leverProvider } = await import('./lever.provider')
    const { ashbyProvider } = await import('./ashby.provider')
    const parsed = [greenhouseProvider, leverProvider, ashbyProvider].map(
      (p) => p.parseConfig({ configVersion: 1, board: 'x' }).namespace,
    )
    expect(parsed).toEqual(['greenhouse:x', 'lever:global:x', 'ashby:x'])
  })
})
