import { z } from 'zod'
import type { MessageDescriptor } from '@lingui/core'
import {
  BASE_ERROR_CODES,
  BASE_ERROR_FALLBACK_EN,
  BASE_ERROR_MESSAGES,
  BASE_ERROR_PARAMS,
} from './base'
import {
  AUTH_USERS_PROJECTS_ERROR_CODES,
  AUTH_USERS_PROJECTS_ERROR_FALLBACK_EN,
  AUTH_USERS_PROJECTS_ERROR_MESSAGES,
  AUTH_USERS_PROJECTS_ERROR_PARAMS,
} from './auth-users-projects'
import {
  FINANCE_INVOICES_ERROR_CODES,
  FINANCE_INVOICES_ERROR_FALLBACK_EN,
  FINANCE_INVOICES_ERROR_MESSAGES,
  FINANCE_INVOICES_ERROR_PARAMS,
} from './finance-invoices'
import {
  DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES,
  DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_FALLBACK_EN,
  DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_MESSAGES,
  DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_PARAMS,
} from './documents-contracts-notifications'

/**
 * task-i18n-stage4-task1 (Track A, "Дисциплина параллельности" — SPEC-M-1).
 * `api-errors.ts` used to be a single file every Track A task would have
 * written to at once (3 PRs fighting over one file). Split into a barrel
 * over four per-module files instead: `base.ts` (frozen — today's 8 codes),
 * `auth-users-projects.ts` (this task), `finance-invoices.ts` /
 * `documents-contracts-notifications.ts` (Task 2/3 — bootstrapped here as
 * empty stubs so this barrel typechecks before either lands real content).
 * Every downstream consumer (`apiErrorEnvelopeSchema`, `apiError()`,
 * `getApiErrorMessage`/`translateApiError` on the client) keeps reading the
 * COMBINED `API_ERROR_*` names below — nothing outside this directory
 * changes. The only external entry point is `export * from './api-errors'`
 * in `packages/shared/src/schemas/index.ts`, unchanged: Node/TS module
 * resolution follows it into `api-errors/index.ts` exactly as it used to
 * follow it into the single file.
 */
export const API_ERROR_CODES = [
  ...BASE_ERROR_CODES,
  ...AUTH_USERS_PROJECTS_ERROR_CODES,
  ...FINANCE_INVOICES_ERROR_CODES,
  ...DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES,
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/**
 * SR-M-1 (PR #694, round 1) — compile-time pin on which `{token}` params
 * each code actually accepts, carried forward unchanged by the barrel
 * split. See `ParamsFor<C>` below for the excess-property-check rationale.
 */
export const API_ERROR_PARAMS = {
  ...BASE_ERROR_PARAMS,
  ...AUTH_USERS_PROJECTS_ERROR_PARAMS,
  ...FINANCE_INVOICES_ERROR_PARAMS,
  ...DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_PARAMS,
} as const satisfies Record<ApiErrorCode, readonly string[]>

/**
 * Object type with exactly the keys `API_ERROR_PARAMS[C]` declares —
 * `never` (no third argument at all, see `apiError`) when the code takes
 * none. `never` rather than `{}`/`Record<never, ...>` deliberately: TS's
 * excess-property check does not fire against the empty object type (a
 * `{ extra: 1 }` literal type-checks fine against `{}`), which would make
 * the pin toothless for zero-param codes — verified empirically, not from
 * memory, before committing to this shape (PR #694, round 1). Routing
 * through `never` removes the third parameter from the call signature
 * entirely instead, so passing one at all is the error.
 *
 * SR-L-2 (PR #694, round 2): the guarantee above is an excess-property
 * check, which TS fires only against a FRESH object literal at the call
 * site — a pre-built object assigned through a variable is not re-checked
 * and an extra key on it passes silently (verified with `tsc`). Always
 * pass `params` as a literal, not a variable assembled earlier.
 */
export type ParamsFor<C extends ApiErrorCode> = (typeof API_ERROR_PARAMS)[C] extends readonly []
  ? never
  : { [K in (typeof API_ERROR_PARAMS)[C][number]]: string | number }

/**
 * `params` — only strings/numbers (no objects/PII structures): values ride
 * in the HTTP body and in client-side interpolation, not as a channel for
 * arbitrary data. The runtime schema stays generic (parses any response,
 * migrated or not) — the per-code allow-list lives in `ParamsFor` above, on
 * the `apiError()` call-site side, not here.
 */
export const apiErrorEnvelopeSchema = z.object({
  statusCode: z.number().int(),
  code: z.enum(API_ERROR_CODES),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  message: z.string(),
})
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>

/**
 * Combined message registry — Ukrainian source text (source locale,
 * `lingui.config.ts`). Explicit ids (`api-error.<CODE>`) mean extraction is
 * stable without the `t`/`msg` macro (unavailable in `apps/api`/
 * `packages/shared`, see the stage 4 plan's spike); the registry is read by
 * BOTH sides (server for the descriptor shape, client via `i18n._`).
 */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor> = {
  ...BASE_ERROR_MESSAGES,
  ...AUTH_USERS_PROJECTS_ERROR_MESSAGES,
  ...FINANCE_INVOICES_ERROR_MESSAGES,
  ...DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_MESSAGES,
}

/**
 * English fallback that rides in the HTTP body itself (`apiError()` on the
 * API) — for logs and clients without a catalog. A client WITH a catalog
 * always translates by `code` through `API_ERROR_MESSAGES`
 * (`getApiErrorMessage`, `axios-utils.ts`) and never shows this value — but
 * a client WITHOUT a catalog is exactly a real user (COPY-M-4, PR #694
 * round 2), so this text equals the catalog's `en` string verbatim, not a
 * shortened variant: `api-errors.spec.ts` pins
 * `API_ERROR_FALLBACK_EN[code] === en/messages.po`'s msgstr for every code.
 */
export const API_ERROR_FALLBACK_EN: Record<ApiErrorCode, string> = {
  ...BASE_ERROR_FALLBACK_EN,
  ...AUTH_USERS_PROJECTS_ERROR_FALLBACK_EN,
  ...FINANCE_INVOICES_ERROR_FALLBACK_EN,
  ...DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_FALLBACK_EN,
}
