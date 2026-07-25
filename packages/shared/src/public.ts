/**
 * Narrow, unauthenticated-consumer subset of `@crm/shared`.
 *
 * Root-cause fix for PR #421's Lighthouse-mobile regression (`/` dropped from
 * a stable 0.93 to ~0.89 after "real vacancy contract everywhere" swapped a
 * local mock for the real `@crm/shared` import): the top-level `.`
 * export (`./index.ts` → `./schemas/index.ts`) is a single barrel of ALL 28
 * CRM domains (`auth`, `finance`, `payment-requisites`, `contracts`,
 * `telemetry`, …). Zod's builder-chain calls (`z.object()`/`z.enum()`) are
 * ordinary function calls with no `/*#__PURE__*\/` annotation, so Rollup's
 * tree-shaker cannot prove they're side-effect-free and keeps EVERY schema
 * reachable through the barrel even when only two are actually imported —
 * confirmed by grepping the landing's built main chunk for domain-unrelated
 * strings (`walletAddress`, `dropShare`, `monthlySalary`, `IBAN`) that had
 * leaked in from `schemas/finance.ts`/`schemas/payment-requisites.ts`.
 *
 * `apps/landing` (perf-budgeted public marketing site, Lighthouse-gated) is
 * the only consumer of this subpath. It imports `@crm/shared/public` instead
 * of `@crm/shared` for RUNTIME values (the Zod schemas themselves) — `import
 * type` usages of `@crm/shared` elsewhere in the landing stay untouched
 * (types are erased at compile time, so which subpath they resolve through
 * has zero bundle-size cost).
 *
 * `apps/web` (the authenticated CRM SPA) intentionally keeps importing the
 * full `.` barrel — it is not Lighthouse-gated and genuinely needs the whole
 * schema surface.
 *
 * Add to this file ONLY the minimal, deliberately-public contract. Do NOT
 * re-export the full `./schemas` barrel here — that would silently undo the
 * whole point of this file.
 */
export { publicVacancyDetailSchema, publicVacancySchema } from './schemas/vacancies'
export type { PublicVacancy, PublicVacancyDetail } from './schemas/vacancies'
