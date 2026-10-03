import type { MessageDescriptor } from '@lingui/core'
import type { PendingTitleKind } from './pending'

/**
 * i18n server-text PR1. The catalog of pending-row titles: the server emits
 * `titleKind` + nominative-only `titleParams` (`pending.ts`), the client
 * renders `PENDING_TITLE_MESSAGES[kind]` through the shared `renderMessage`
 * (`notification-registry.ts` — the one renderer, not a second one) in the
 * VIEWER's locale.
 *
 * Same shape and the same reason as `NOTIFICATION_TITLE_MESSAGES`: one
 * `Record` with `/* i18n *\/`-marked explicit-id literals, because
 * `lingui extract` only sees such a literal as an object PROPERTY value.
 * `satisfies` (not `as const`) so the compiler checks exhaustiveness against
 * `PendingTitleKind` while each literal keeps its own type.
 *
 * Case: params are substituted nominative-only; every sentence is written so
 * no case agreement is needed («Частка за замовчуванням — {seniorName}», a
 * dash and a bare name, not «…для {name в родовому}»).
 */
export const PENDING_TITLE_MESSAGES = {
  CONTRACT: /* i18n */ {
    id: 'pending.title.CONTRACT',
    message: 'Ваш контракт',
  },
  SHARE_PROJECT: /* i18n */ {
    id: 'pending.title.SHARE_PROJECT',
    message: 'Частка за проєктом «{projectName}»',
  },
  SHARE_BASE_MINE: /* i18n */ {
    id: 'pending.title.SHARE_BASE_MINE',
    message: 'Частка за замовчуванням',
  },
  SHARE_BASE_OTHER: /* i18n */ {
    id: 'pending.title.SHARE_BASE_OTHER',
    message: 'Частка за замовчуванням — {seniorName}',
  },
  PROJECT_APPROVAL: /* i18n */ {
    id: 'pending.title.PROJECT_APPROVAL',
    message: '{projectName}',
  },
} satisfies Record<PendingTitleKind, MessageDescriptor>
