import type { CollectionBatch, CollectionBatchFields, RequestReport } from './reporting-provider'

/**
 * COMPILE-TIME proof of the construction brands (CR-H-2). Not a spec, deliberately.
 *
 * `apps/api/tsconfig.json` resolves `exclude` to `['node_modules', 'dist', '**-/*.spec.ts',
 * '**-/*.test.ts']`, so ZERO of the package's 384 program files are specs: a `@ts-expect-error`
 * written in a `.spec.ts` is never compiled by `pnpm typecheck` and proves nothing. This file is
 * compiled, which is the whole point of it existing.
 *
 * HOW IT FAILS: `@ts-expect-error` requires an error on the next line. Remove the brand from
 * `CollectionBatch` and the assignment below starts succeeding, the directive becomes unused, and
 * `tsc` reports "Unused '@ts-expect-error' directive" — so the type-level half of the invariant
 * cannot be removed silently. That is a check that can fail, which is the bar every fix in this
 * round had to meet.
 *
 * It carries no runtime behaviour: the declarations are types and a never-called function.
 */

declare const fields: CollectionBatchFields
declare const reportFields: Omit<RequestReport, never> extends infer _T
  ? {
      attempt: number
      page: number
      url: string
      status: number | null
      startedAt: Date
      endedAt: Date
      error: null
      cost: null
    }
  : never

/**
 * An adapter returning a bare object literal is what CR-H-2 found possible. Both assignments below
 * MUST be errors; if either stops being one, this file stops compiling.
 */
export function brandIsRequired(): void {
  // @ts-expect-error a batch that did not go through buildCollectionBatch is not a CollectionBatch
  const fromLiteral: CollectionBatch = fields
  void fromLiteral

  // @ts-expect-error a report that did not go through buildRequestReport is not a RequestReport
  const reportFromLiteral: RequestReport = reportFields
  void reportFromLiteral
}
