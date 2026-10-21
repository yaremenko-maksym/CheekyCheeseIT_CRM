import type { CollectionBatch, CollectionBatchFields, RequestReport } from './reporting-provider'
import type { SourceConfigFields } from './reporting-provider'
import type { ApiJsonSourceSpec } from './api-json.provider'

/**
 * TYPES ONLY. This file promises above that it carries NO runtime behaviour, and the promise is
 * load-bearing twice over: it is why a `.ts` file with no spec may sit in the source tree at all,
 * and it is why the mutation gate has nothing here to mutate. Both of those were briefly broken
 * while writing the `nativeIdOf` probe below — first with real `z.object(...)` schemas, then with
 * a real spec literal — and the gate reported the second as eighteen mutants with no coverage.
 */
interface ProbeConfig extends SourceConfigFields {
  query: string | null
  window: null
}
interface ProbeItem {
  id: string
}
interface ProbeEnvelope {
  jobs: unknown[]
}

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

/**
 * `nativeIdOf` IS REQUIRED ON THE ADAPTER SPEC (SPEC-M-1), checked here for the same reason the
 * brands are: the only `ApiJsonSourceSpec` literals in this repository today live in `.spec.ts`
 * files, which `apps/api/tsconfig.json` excludes — so an omission would surface as a runtime
 * `TypeError` in one suite rather than as a typecheck failure, and phase 3's 25 adapters are
 * precisely the authors for whom "the compiler will not let you forget" has to be true.
 *
 * `Omit<…, 'nativeIdOf'>` AND `declare const`, not a written-out spec literal — the same idiom as
 * `brandIsRequired` above, and for the same reason this file states at the top. A real literal was
 * tried first and the mutation gate reported eighteen mutants in it with no coverage: an object
 * full of arrow functions and string literals, inside a function nothing calls, is live code no
 * test can reach. The `Omit` says the one thing the probe is about and carries no code at all.
 *
 * HOW IT FAILS: make the field optional again and a spec WITHOUT it becomes assignable, so the
 * directive goes unused and `tsc` reports "Unused '@ts-expect-error' directive". Verified by doing
 * exactly that.
 */
declare const specWithoutNativeIdOf: Omit<
  ApiJsonSourceSpec<ProbeConfig, ProbeEnvelope, ProbeItem>,
  'nativeIdOf'
>

export function nativeIdOfIsRequired(): void {
  // @ts-expect-error an adapter spec without nativeIdOf gets no AC5 duplicate-collapse check
  const spec: ApiJsonSourceSpec<ProbeConfig, ProbeEnvelope, ProbeItem> = specWithoutNativeIdOf
  void spec
}
