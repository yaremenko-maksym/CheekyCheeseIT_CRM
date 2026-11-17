import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * The server states a blocked source's reason as `CODE: developer detail; CODE: detail` — English,
 * up to 500 characters (`readinessReason()` in the API manifest). The panel never shows that text:
 * each CODE maps to a short catalog phrase, an unknown code maps to nothing, and the detail is
 * dropped. Module-level `msg`, looked up by key (Stryker rewrites a literal a macro would read).
 */
const REASON = {
  NO_ADAPTER: msg`джерело ще не підключено`,
  PERMISSION_PROHIBITED: msg`джерело забороняє автоматичний збір`,
  PERMISSION_UNCLEAR: msg`дозвіл джерела не підтверджено`,
  KEY_REQUIRED: msg`потрібен ключ доступу`,
  NO_CAPTURE: msg`немає перевіреного зразка відповіді`,
  NO_API_CAPTURE: msg`немає перевіреного зразка відповіді API`,
  STATUS_CONSTANT_BLOCKED: msg`джерело заблоковано політикою`,
  AUTH_DEADLINE_PASSED: msg`сплив термін авторизації`,
  POLICY_EXPIRED: msg`сплив термін дії політики`,
  NO_BOARD_EVIDENCE: msg`немає підтвердженого першого запуску`,
} satisfies Record<string, ReturnType<typeof msg>>

type KnownCode = keyof typeof REASON

const isKnown = (code: string): code is KnownCode => Object.hasOwn(REASON, code)

// A code starts the string or follows the `; ` joiner, and is upper snake case followed by `: `.
const CODE = /(?:^|; )([A-Z][A-Z0-9_]*): /g

/** The catalog phrases for the known blocker codes in `raw`, once each, in order. */
export function readinessPhrases(raw: string | null | undefined, i18n: I18n): string[] {
  if (!raw) return []
  // Group 1 takes part in every match of CODE, so it is always a string.
  const found = Array.from(raw.matchAll(CODE), (m) => m[1] as string).filter(isKnown)
  return [...new Set(found)].map((code) => i18n._(REASON[code]))
}
