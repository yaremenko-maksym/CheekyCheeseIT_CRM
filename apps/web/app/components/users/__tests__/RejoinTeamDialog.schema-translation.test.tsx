/**
 * fix-round 1 (SR-M-1, PR #699). `RejoinTeamDialog`'s `onSubmit` runs
 * `rejoinTeamSchema.safeParse(payload)` as a defense-in-depth re-check AFTER
 * two local UI guards that catch the SAME two conditions the schema's own
 * `superRefine` encodes (`teamMode==='JOIN_DROP_TEAM' && !dropTeamId`,
 * `teamMode==='CREATE_NEW' && hrIds.length<1`) — so under NORMAL component
 * usage this branch is unreachable (the local guards fire first and
 * `return` before `safeParse` ever runs). That is exactly what makes it a
 * LATENT defense-in-depth path rather than dead code: it is what protects
 * an admin from a raw `zod.<CODE>` toast the day the two checks drift apart
 * (a future edit to either the local guards or the schema's `superRefine`
 * that is not kept in lockstep).
 *
 * Rendering the full dialog cannot exercise this branch on its own — the
 * local guards would always intercept first, which is the point. This test
 * instead calls the exact TWO functions the component's `onSubmit` chains
 * together on this path — `rejoinTeamSchema.safeParse` then
 * `translateZodMessage` on its first issue's message — directly, proving
 * that IF this branch is ever reached, the toast shows translated uk text,
 * not the raw `zod.<CODE>` key security-reviewer found missing before this
 * fix.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { rejoinTeamSchema } from '@crm/shared'
import { translateZodMessage } from '@/lib/axios-utils'

beforeAll(() => {
  // Empty catalog on purpose — `ZOD_ERROR_MESSAGES[code].message` (the uk
  // source text) is what `i18n._` falls back to when the id isn't loaded,
  // same pattern `axios-utils.spec.ts` itself relies on. Only an ACTIVATED
  // locale is required.
  i18n.load('uk', {})
  i18n.activate('uk')
})

describe('RejoinTeamDialog onSubmit — SR-M-1 defense-in-depth translation', () => {
  it('JOIN_DROP_TEAM with no dropTeamId: the schema issue translates to uk text, not the raw code', () => {
    const result = rejoinTeamSchema.safeParse({ teamMode: 'JOIN_DROP_TEAM' })
    expect(result.success).toBe(false)
    const first = !result.success ? result.error.issues[0] : undefined
    expect(first?.message).toBe('zod.DROP_TEAM_ID_REQUIRED')

    const translated = translateZodMessage(first?.message)
    expect(translated).not.toMatch(/^zod\./)
    expect(translated).toBe('Виберіть команду дропа')
  })

  it('CREATE_NEW with no hrIds: the schema issue translates to uk text, not the raw code', () => {
    const result = rejoinTeamSchema.safeParse({ teamMode: 'CREATE_NEW', hrIds: [] })
    expect(result.success).toBe(false)
    const first = !result.success ? result.error.issues[0] : undefined
    expect(first?.message).toBe('zod.HR_REQUIRED_MIN')

    const translated = translateZodMessage(first?.message)
    expect(translated).not.toMatch(/^zod\./)
    expect(translated).toBe('Виберіть щонайменше одного HR')
  })

  it('regression proof: an UNwrapped message would have leaked the raw code (what SR-M-1 found)', () => {
    const result = rejoinTeamSchema.safeParse({ teamMode: 'JOIN_DROP_TEAM' })
    const first = !result.success ? result.error.issues[0] : undefined
    // This is what the component showed BEFORE the fix — kept here as the
    // red-proof: if `translateZodMessage` were dropped from the component
    // again, `first?.message` alone is exactly this leak.
    expect(first?.message).toBe('zod.DROP_TEAM_ID_REQUIRED')
  })
})
