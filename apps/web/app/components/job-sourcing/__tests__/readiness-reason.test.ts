import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
import { loadCatalog } from '@/test/i18n'
import { readinessPhrases } from '../readiness-reason'

/**
 * Task 7.5 — the server states a blocked source as `CODE: english detail; CODE: detail`. Only the
 * mapped catalog phrase of a KNOWN code is ever shown, so every code's phrase is pinned here, in
 * both languages, against the real compiled catalogs.
 */
const PHRASES = [
  ['NO_ADAPTER', 'джерело ще не підключено', 'the source is not connected yet'],
  [
    'PERMISSION_PROHIBITED',
    'джерело забороняє автоматичний збір',
    'the source prohibits automated collection',
  ],
  [
    'PERMISSION_UNCLEAR',
    'дозвіл джерела не підтверджено',
    "the source's permission is not confirmed",
  ],
  ['KEY_REQUIRED', 'потрібен ключ доступу', 'an access key is required'],
  ['NO_CAPTURE', 'немає перевіреного зразка відповіді', 'no verified sample response'],
  ['NO_API_CAPTURE', 'немає перевіреного зразка відповіді API', 'no verified API sample response'],
  ['STATUS_CONSTANT_BLOCKED', 'джерело заблоковано політикою', 'the source is blocked by policy'],
  ['AUTH_DEADLINE_PASSED', 'сплив термін авторизації', 'authorization expired'],
  ['POLICY_EXPIRED', 'сплив термін дії політики', 'the policy has expired'],
  ['NO_BOARD_EVIDENCE', 'немає підтвердженого першого запуску', 'no confirmed first run'],
] as const

describe('readinessPhrases', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })
  afterEach(async () => {
    await loadCatalog('uk')
  })

  it.each(PHRASES)('%s reads as its uk phrase, never the server detail', (code, uk) => {
    expect(readinessPhrases(`${code}: developer detail`, i18n)).toEqual([uk])
  })

  it.each(PHRASES)('%s reads as its en phrase', async (code, _uk, en) => {
    await loadCatalog('en')
    expect(readinessPhrases(`${code}: developer detail`, i18n)).toEqual([en])
  })

  it('keeps the server order, once per code, across several codes', () => {
    const raw = 'NO_CAPTURE: a; KEY_REQUIRED: b; NO_CAPTURE: c; NO_ADAPTER: d'
    expect(readinessPhrases(raw, i18n)).toEqual([
      'немає перевіреного зразка відповіді',
      'потрібен ключ доступу',
      'джерело ще не підключено',
    ])
  })

  it('skips an unknown code and keeps the known ones around it', () => {
    const raw = 'SOMETHING_NEW: x; KEY_REQUIRED: y; ANOTHER_ONE: z'
    expect(readinessPhrases(raw, i18n)).toEqual(['потрібен ключ доступу'])
  })

  it('returns nothing for an unknown code alone', () => {
    expect(readinessPhrases('SOMETHING_NEW: x', i18n)).toEqual([])
  })

  it('returns nothing for text with no code, and for a null, undefined or empty reason', () => {
    expect(readinessPhrases('credential not verified', i18n)).toEqual([])
    expect(readinessPhrases(null, i18n)).toEqual([])
    expect(readinessPhrases(undefined, i18n)).toEqual([])
    expect(readinessPhrases('', i18n)).toEqual([])
  })

  it('does not take a code that is not at the start or after the joiner', () => {
    expect(readinessPhrases('see KEY_REQUIRED: y', i18n)).toEqual([])
  })
})
