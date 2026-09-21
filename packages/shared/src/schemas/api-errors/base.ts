import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage2-task5, moved here verbatim by task-i18n-stage4-task1
 * (api-errors barrel split, SPEC-M-1 — see `./index.ts`'s doc comment).
 * First eight codes of the API-error envelope — frozen: no task in Track A
 * touches this file, only the barrel spreads it into the combined registry.
 *
 * `GENERIC` is reserved as a general fallback (not thrown anywhere yet).
 * The other seven are the first real codepaths migrated from server to
 * client: two `NotFoundException` (`CONTRACT_TEMPLATE_MISSING`) and five
 * `ForbiddenException` under impersonation ("signed in as someone else"),
 * each the exact refusal whose Russian literal already lived in
 * `packages/shared` before this code existed (`*_IMPERSONATION_MESSAGE` —
 * those are not deleted, client banners still read them until stage 3; the
 * envelope only replaced the SERVER HTTP message).
 */
export const BASE_ERROR_CODES = [
  'GENERIC',
  'CONTRACT_TEMPLATE_MISSING',
  'CONTRACT_SIGN_IMPERSONATION',
  'TOS_ACCEPT_IMPERSONATION',
  'INVOICE_SIGN_IMPERSONATION',
  'NOTIFICATION_PREFERENCES_IMPERSONATION',
  'SHARE_DECISION_IMPERSONATION',
  'PROJECT_DECISION_IMPERSONATION',
] as const
export type BaseErrorCode = (typeof BASE_ERROR_CODES)[number]

export const BASE_ERROR_PARAMS = {
  GENERIC: [],
  CONTRACT_TEMPLATE_MISSING: [],
  CONTRACT_SIGN_IMPERSONATION: [],
  TOS_ACCEPT_IMPERSONATION: [],
  INVOICE_SIGN_IMPERSONATION: [],
  NOTIFICATION_PREFERENCES_IMPERSONATION: [],
  SHARE_DECISION_IMPERSONATION: [],
  PROJECT_DECISION_IMPERSONATION: [],
} as const satisfies Record<BaseErrorCode, readonly string[]>

export const BASE_ERROR_MESSAGES: Record<BaseErrorCode, MessageDescriptor> = {
  GENERIC: /* i18n */ {
    id: 'api-error.GENERIC',
    message: 'Не вдалося виконати дію. Спробуйте ще раз',
  },
  CONTRACT_TEMPLATE_MISSING: /* i18n */ {
    id: 'api-error.CONTRACT_TEMPLATE_MISSING',
    message:
      'Немає активного шаблону контракту для цієї ролі. Додайте шаблон у розділі «Контракти»',
  },
  CONTRACT_SIGN_IMPERSONATION: /* i18n */ {
    id: 'api-error.CONTRACT_SIGN_IMPERSONATION',
    message: 'Ви увійшли як інший співробітник — підписати його контракт може лише він сам',
  },
  TOS_ACCEPT_IMPERSONATION: /* i18n */ {
    id: 'api-error.TOS_ACCEPT_IMPERSONATION',
    message: 'Ви увійшли як інший співробітник — прийняти умови використання може лише він сам',
  },
  INVOICE_SIGN_IMPERSONATION: /* i18n */ {
    id: 'api-error.INVOICE_SIGN_IMPERSONATION',
    message: 'Ви увійшли як інший співробітник — підписати його рахунок може лише він сам',
  },
  NOTIFICATION_PREFERENCES_IMPERSONATION: /* i18n */ {
    id: 'api-error.NOTIFICATION_PREFERENCES_IMPERSONATION',
    message: 'Ви увійшли як інший співробітник — налаштування сповіщень лише для перегляду',
  },
  SHARE_DECISION_IMPERSONATION: /* i18n */ {
    id: 'api-error.SHARE_DECISION_IMPERSONATION',
    message: 'Ви увійшли як інший співробітник — підтвердити чи відхилити частку може лише він сам',
  },
  PROJECT_DECISION_IMPERSONATION: /* i18n */ {
    id: 'api-error.PROJECT_DECISION_IMPERSONATION',
    message: 'Ви увійшли як інший співробітник — рішення щодо проєкту приймає лише він сам',
  },
}

export const BASE_ERROR_FALLBACK_EN: Record<BaseErrorCode, string> = {
  GENERIC: 'Something went wrong. Please try again',
  CONTRACT_TEMPLATE_MISSING: 'No active contract template for this role. Add one under Contracts',
  CONTRACT_SIGN_IMPERSONATION:
    "You're signed in as another employee — only they can sign their contract",
  TOS_ACCEPT_IMPERSONATION: "You're signed in as another employee — only they can accept the terms",
  INVOICE_SIGN_IMPERSONATION:
    "You're signed in as another employee — only they can sign their invoice",
  NOTIFICATION_PREFERENCES_IMPERSONATION:
    "You're signed in as another employee — notification preferences are view-only",
  SHARE_DECISION_IMPERSONATION:
    "You're signed in as another employee — only they can decide on their share",
  PROJECT_DECISION_IMPERSONATION:
    "You're signed in as another employee — only they can decide on the project",
}
