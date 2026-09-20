import { z } from 'zod'
import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage2-task5. Первые восемь кодов конверта API-ошибок — фундамент
 * для этапа 4 (289 оставшихся исключений мигрируют туда же по мере надобности,
 * не расширяя этот реестр раньше времени). `GENERIC` зарезервирован под общий
 * fallback (пока никем не брошен — этап 4 решит, где он нужен первым).
 *
 * Семь остальных — первые реальные codepaths, переведённые с сервера на клиент:
 * два `NotFoundException` (`CONTRACT_TEMPLATE_MISSING`, параметризован ролью)
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
 * `params` — только строки/числа (никаких объектов/PII-структур): значения
 * едут в HTTP-теле и в интерполяцию перевода на клиенте, а не для передачи
 * произвольных данных.
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
    message: 'Немає активного шаблону контракту для ролі {role}',
  },
  CONTRACT_SIGN_IMPERSONATION: /* i18n */ {
    id: 'api-error.CONTRACT_SIGN_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, підписати його контракт не можна — це має зробити він сам',
  },
  TOS_ACCEPT_IMPERSONATION: /* i18n */ {
    id: 'api-error.TOS_ACCEPT_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, прийняти умови використання за нього не можна — це має зробити він сам',
  },
  INVOICE_SIGN_IMPERSONATION: /* i18n */ {
    id: 'api-error.INVOICE_SIGN_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, підписати його рахунок не можна — це має зробити він сам',
  },
  NOTIFICATION_PREFERENCES_IMPERSONATION: /* i18n */ {
    id: 'api-error.NOTIFICATION_PREFERENCES_IMPERSONATION',
    message:
      'Налаштування сповіщень змінює сам співробітник — під «увійти як» вони лише для перегляду',
  },
  SHARE_DECISION_IMPERSONATION: /* i18n */ {
    id: 'api-error.SHARE_DECISION_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, вирішити щодо його частки не можна — це має зробити він сам',
  },
  PROJECT_DECISION_IMPERSONATION: /* i18n */ {
    id: 'api-error.PROJECT_DECISION_IMPERSONATION',
    message:
      'Поки ви увійшли як інший співробітник, вирішити щодо проєкту за нього не можна — це має зробити він сам',
  },
}

/**
 * Английский fallback, который едет В САМОМ HTTP-теле (`apiError()` на API) —
 * для логов и клиентов без каталога. Никогда не показывается пользователю
 * напрямую: браузер всегда переводит по `code` через `API_ERROR_MESSAGES`
 * (`getApiErrorMessage`, `axios-utils.ts`), это лишь серверный fallback-текст.
 */
export const API_ERROR_FALLBACK_EN: Record<ApiErrorCode, string> = {
  GENERIC: 'The action could not be completed',
  CONTRACT_TEMPLATE_MISSING: 'No active contract template for role {role}',
  CONTRACT_SIGN_IMPERSONATION: 'Contract signing is not allowed while impersonating',
  TOS_ACCEPT_IMPERSONATION: 'Accepting the terms is not allowed while impersonating',
  INVOICE_SIGN_IMPERSONATION: 'Invoice signing is not allowed while impersonating',
  NOTIFICATION_PREFERENCES_IMPERSONATION:
    'Notification preferences are read-only while impersonating',
  SHARE_DECISION_IMPERSONATION: 'Share decisions are not allowed while impersonating',
  PROJECT_DECISION_IMPERSONATION: 'Project decisions are not allowed while impersonating',
}
