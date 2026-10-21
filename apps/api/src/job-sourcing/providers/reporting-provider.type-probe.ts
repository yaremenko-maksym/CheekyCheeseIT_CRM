import type { ZodType } from 'zod'
import type { CollectionBatch, CollectionBatchFields, RequestReport } from './reporting-provider'
import type { SourceConfigFields } from './reporting-provider'
import type { ApiJsonSourceSpec } from './api-json.provider'

/**
 * `declare const`, not real schemas. This file promises above that it carries NO runtime
 * behaviour, and that promise is load-bearing twice over: it is why a `.ts` file with no spec can
 * sit in the source tree at all, and it is why the mutation gate has nothing here to mutate. A
 * first version of the `nativeIdOf` probe below built genuine `z.object(...)` schemas, which put
 * live code behind a function nobody calls — every literal in it a mutant no test could reach.
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

declare const probeConfigSchema: ZodType<ProbeConfig>
declare const probeItemSchema: ZodType<ProbeItem>
declare const probeEnvelopeSchema: ZodType<ProbeEnvelope>

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
 * HOW IT FAILS: make the field optional again and the literal below starts compiling, the
 * directive becomes unused, and `tsc` reports "Unused '@ts-expect-error' directive".
 */
export function nativeIdOfIsRequired(): void {
  // @ts-expect-error an adapter spec without nativeIdOf gets no AC5 duplicate-collapse check
  const withoutNativeIdOf: ApiJsonSourceSpec<ProbeConfig, ProbeEnvelope, ProbeItem> = {
    type: 'REMOTEOK_API',
    adapterVersion: 'probe-1',
    configSchema: probeConfigSchema,
    envelopeSchema: probeEnvelopeSchema,
    itemSchema: probeItemSchema,
    pageRequest: () => ({ request: { url: 'https://api.example.com/jobs' } }),
    extractItems: (envelope) => envelope.jobs,
    nextCursor: () => null,
    mapItem: (item) => ({
      namespace: 'board',
      nativeId: item.id,
      url: `https://jobs.example.com/j/${item.id}`,
      title: item.id,
      companyName: item.id,
    }),
    scopeOf: (config) => ({
      namespace: config.namespace,
      query: null,
      configVersion: config.configVersion,
      window: null,
    }),
  }
  void withoutNativeIdOf
}
