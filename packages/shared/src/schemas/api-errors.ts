import { z } from 'zod'
import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage2-task5. Первые восемь кодов конверта API-ошибок — фундамент
 * для этапа 4 (289 оставшихся исключений мигрируют туда же по мере надобности,
 * не расширяя этот реестр раньше времени). `GENERIC` зарезервирован под общий
 * fallback (пока никем не брошен — этап 4 решит, где он нужен первым).
 *
 * Семь остальных — первые реальные codepaths, переведённые с сервера на клиент:
 * два `NotFoundException` (`CONTRACT_TEMPLATE_MISSING`)
 * и пять `ForbiddenException` под «войти как» (импersonation), каждый — ровно
 * тот отказ, чей русский литерал уже жил в `packages/shared` до этой задачи
 * (`*_IMPERSONATION_MESSAGE` — они НЕ удаляются, их всё ещё читают клиентские
 * баннеры до этапа 3; конверт заменяет только СЕРВЕРНОЕ HTTP-сообщение).
 */
export const API_ERROR_CODES = [
  'GENERIC',
  'CONTRACT_TEMPLATE_MISSING',
  'CONTRACT_SIGN_IMPERSONATION',
  'TOS_ACCEPT_IMPERSONATION',
  'INVOICE_SIGN_IMPERSONATION',
  'NOTIFICATION_PREFERENCES_IMPERSONATION',
  'SHARE_DECISION_IMPERSONATION',
  'PROJECT_DECISION_IMPERSONATION',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/**
 * SR-M-1 (PR #694, круг 1) — compile-time pin on which `{token}` params each
 * code actually accepts. Before this, `apiError()`'s third argument was a
 * flat `z.record` with no per-code allow-list: safe only because every call
 * site today happens to pass either nothing or the (non-PII) `role`, a fact
 * enforced by nobody. `ParamsFor<C>` below narrows `apiError`'s signature to
 * exactly this set — a future `apiError('TOS_ACCEPT_IMPERSONATION', 403,
 * { email })` (the class of leak #161 / #164 recurred as) is a compile error,
 * not a silent HTTP-body addition. `api-errors.spec.ts` cross-checks this
 * list against the `{token}` sets that actually appear in
 * `API_ERROR_MESSAGES[code].message` and `API_ERROR_FALLBACK_EN[code]` (plus
 * the `en` catalog string), so the three cannot drift apart.
 */
export const API_ERROR_PARAMS = {
  GENERIC: [],
  CONTRACT_TEMPLATE_MISSING: [],
  CONTRACT_SIGN_IMPERSONATION: [],
  TOS_ACCEPT_IMPERSONATION: [],
  INVOICE_SIGN_IMPERSONATION: [],
  NOTIFICATION_PREFERENCES_IMPERSONATION: [],
  SHARE_DECISION_IMPERSONATION: [],
  PROJECT_DECISION_IMPERSONATION: [],
} as const satisfies Record<ApiErrorCode, readonly string[]>

/**
 * Object type with exactly the keys `API_ERROR_PARAMS[C]` declares —
 * `never` (no third argument at all, see `apiError`) when the code takes
 * none. `never` rather than `{}`/`Record<never, ...>` deliberately: TS's
 * excess-property check does not fire against the empty object type (a
 * `{ extra: 1 }` literal type-checks fine against `{}`), which would make
 * the pin toothless for the seven zero-param codes — verified empirically,
 * not from memory, before committing to this shape. Routing through `never`
 * removes the third parameter from the call signature entirely instead, so
 * passing one at all is the error.
 *
 * SR-L-2 (PR #694, круг 2): the guarantee above is an excess-property check,
 * which TS fires only against a FRESH object literal at the call site — a
 * pre-built object assigned through a variable is not re-checked and an
 * extra key on it passes silently (verified with `tsc`). Always pass
 * `params` as a literal, not a variable assembled earlier.
 */
export type ParamsFor<C extends ApiErrorCode> = (typeof API_ERROR_PARAMS)[C] extends readonly []
  ? never
  : { [K in (typeof API_ERROR_PARAMS)[C][number]]: string | number }

/**
 * `params` — только строки/числа (никаких объектов/PII-структур): значения
 * едут в HTTP-теле и в интерполяцию перевода на клиенте, а не для передачи
 * произвольных данных. Рантайм-схема остаётся общей (парсит любой ответ,
 * мигрированный или нет) — per-code allow-list живёт в `ParamsFor` выше, на
 * стороне вызова `apiError()`, а не здесь.
 */
export const apiErrorEnvelopeSchema = z.object({
  statusCode: z.number().int(),
  code: z.enum(API_ERROR_CODES),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  message: z.string(),
})
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>

/**
 * Украинский исходный текст (source locale — `lingui.config.ts`). Явные id
 * (`api-error.<CODE>`) — извлечение стабильно без макроса `t`/`msg`, реестр
 * читают И сервер (для формы дескриптора), И клиент (`i18n._`).
 *
 * Черновик кодера (task-i18n-stage2-task5) — `copy-reviewer` проверяет оба
 * языка (en — в `en/messages.po` после `pnpm i18n:extract`).
 */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor> = {
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

/**
 * Английский fallback, который едет В САМОМ HTTP-теле (`apiError()` на API) —
 * для логов и клиентов без каталога. Клиент с каталогом всегда переводит по
 * `code` через `API_ERROR_MESSAGES` (`getApiErrorMessage`, `axios-utils.ts`)
 * и это значение никогда не покажет — но клиент БЕЗ каталога это как раз
 * пользователь (COPY-M-4, PR #694 round 2), поэтому текст равен `en`-строке
 * каталога дословно, а не сокращённому варианту: `api-errors.spec.ts`
 * закрепляет `API_ERROR_FALLBACK_EN[code] === en/messages.po`'s msgstr для
 * каждого кода, так что расхождению неоткуда взяться.
 */
export const API_ERROR_FALLBACK_EN: Record<ApiErrorCode, string> = {
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
