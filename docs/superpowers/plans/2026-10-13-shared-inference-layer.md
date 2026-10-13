# Shared inference layer (`@crm/inference`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-agnostic in-monorepo package that both the vacancy feature and a colleague's feature call for two inference jobs — extraction (text → schema-validated fields) and general typed decision (Choice/Score/Noul via TypeSafe Jev) — with a model registry that keeps OpenRouter model choices pinned and safe.

**Architecture:** A new `packages/inference` (mirrors `@crm/shared`, no `@nestjs` dep) exposes `InferenceClient(config)` with `extraction` and `decision` ports, three adapters (Jev / OpenRouter / local), a pure model-registry `reconcile`, and a bounded HTTP helper. Each consuming app wraps the client in a thin NestJS provider on a `Symbol` DI token (the `OUTBOX_GATEWAY` precedent) and runs a daily OpenRouter catalog reconcile. All model output is untrusted and Zod-validated inside adapters; adapters never throw.

**Tech Stack:** TypeScript (CommonJS/Node), Zod v4, Vitest; NestJS 11 + `@nestjs/schedule` (consumer side only); raw `fetch` + `AbortController` (no model SDK).

**Spec:** `docs/superpowers/specs/2026-10-13-shared-inference-layer-design.md`

## Global Constraints

Each task implicitly includes this section.

- **Node 22** via `nvm use` / `.nvmrc` (never a host path); pnpm 7.32.4; Zod v4; no version bumps (`.claude/rules/common/version-pins.md`). No new runtime dependency in the package beyond `zod`; a parser/SDK need → stop, ask the Architect.
- **All model output is UNTRUSTED.** Adapters validate every response with Zod before returning typed data; the caller receives typed data or a typed failure, never raw provider output. Strip NUL/control chars on ingested strings.
- **Adapters never throw to the caller.** Every port method returns a typed result union. HTTP 429 / provider rate signal → `RATE_LIMITED`; abort/timeout → `TIMEOUT`; transport/5xx/malformed envelope → `PROVIDER_ERROR`; missing credentials → `NOT_CONFIGURED`; output that fails validation after the corrective retry → `INVALID_OUTPUT`.
- **No secrets or request/response bodies in logs.**
- **Destinations are constants.** Provider hosts and the pinned model list are code constants (SSRF/provenance), never admin-stored or read from env for ids. Env holds only keys/urls/selector (optional-no-default).
- **`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` are never reused** (they belong to `resume-ai.service.ts`; the withdrawn Workers-AI route must not return).
- **Egress:** fixed provider hosts via `http/bounded-request.ts`; HTTPS-only, `http` permitted only for a loopback/local host. Byte and time caps on every call.
- **Repository rules:** zone-of-write (package + `apps/**` = Coder; `.github/workflows/**` + compose = DevOps); git policy (explicit `git add`, no `--no-verify`, `ac_verified:`, `DATABASE_URL= git push`); `security-reviewer` mandatory on the HTTP/egress/adapter/env/secrets tasks (untrusted ingest + external calls + secrets); merge only on the owner's explicit word.
- **Language:** repo + comments + commits + PR in English; no product UI strings in this package (it has no UI).
- **Tests:** `PATH` via `nvm use`; `pnpm --filter @crm/inference exec vitest run <path>`; the mutation gate sees pure units — keep logic in pure functions tested directly; no network in CI (inject a fake `fetch`); a live provider smoke is env-gated and manual.

## Review Focus

Input classes/failure modes the spec implies that deserve an explicit pinning test (each added to the owning task):

- **A live-but-unpinned OpenRouter model id** must never be selected, even when it is the only id returned — Task 5 (`reconcile`).
- **A provider returns HTTP 200 with a body that parses as JSON but fails the caller's Zod schema** → one corrective retry, then `INVALID_OUTPUT`, never a throw or partial data — Task 6 (extraction pipeline).
- **A Jev answer whose `id` does not match any requested question id, or `confidence` outside 0..1** → `INVALID_OUTPUT`, not a silently-accepted answer — Task 8 (Jev adapter).
- **A response that exceeds the byte cap or never completes** → streamed abort → `TIMEOUT`/`transport`, not unbounded memory/time — Task 4 (bounded request).
- **Missing credentials at call time** (no Jev key / no extraction provider configured) → `NOT_CONFIGURED` from the port, feature degrades, no crash on boot — Task 9 (client) and Task 10 (module).

## Dispatch map (Master orchestrates; no PM agent)

| Task                                        | Zone / Agent    | Model  | Gates                                  |
| ------------------------------------------- | --------------- | ------ | -------------------------------------- |
| 0 scaffold                                  | Coder (package) | haiku  | code-reviewer                          |
| 1 decision contracts                        | Coder           | sonnet | code-reviewer                          |
| 2 extraction/errors/config contracts        | Coder           | sonnet | code-reviewer                          |
| 3 bounded-request                           | Coder           | sonnet | code + **security**                    |
| 4 registry reconcile + catalog              | Coder           | sonnet | code-reviewer                          |
| 5 extraction pipeline                       | Coder           | sonnet | code + **security** (untrusted output) |
| 6 OpenRouter adapter                        | Coder           | sonnet | code + **security**                    |
| 7 local adapter                             | Coder           | sonnet | code + **security**                    |
| 8 Jev adapter                               | Coder           | sonnet | code + **security**                    |
| 9 InferenceClient                           | Coder           | sonnet | code-reviewer                          |
| 10 apps/api env + Nest module + refresh job | Coder           | sonnet | code + **security** + spec-reviewer    |
| 11 deploy.yml secrets wiring                | DevOps          | sonnet | code + **security**                    |
| 12 CONTEXT.md glossary + r5 amendment       | Coder (light)   | haiku  | code-reviewer                          |

Parallelism (`orchestration-routing.md`): Tasks 1 & 2 independent after 0; Tasks 6/7/8 independent after 3/4/5 (disjoint files) → a wave of ≤3. Everything else single-pipeline. Fan-out ≤3 at once.

---

## File Structure

| File                                                                                         | Responsibility                                                          |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/inference/package.json`, `tsconfig.json`, `vitest.config.mts`, `eslint.config.mjs` | package setup, mirrors `@crm/shared`                                    |
| `packages/inference/src/index.ts`                                                            | public barrel                                                           |
| `packages/inference/src/contracts/decision.ts`                                               | `DecisionPort`, question/answer/state Zod schemas + types               |
| `packages/inference/src/contracts/extraction.ts`                                             | `ExtractionPort`, request/result types                                  |
| `packages/inference/src/contracts/errors.ts`                                                 | `INFERENCE_ERROR_CODES`, `InferenceErrorCode`                           |
| `packages/inference/src/contracts/config.ts`                                                 | `InferenceConfig`, `ModelPin`                                           |
| `packages/inference/src/http/bounded-request.ts`                                             | bounded `fetch` + `AbortController`, typed transport result             |
| `packages/inference/src/registry/model-registry.ts`                                          | pure `reconcile` + `selectModel`                                        |
| `packages/inference/src/registry/openrouter-catalog.ts`                                      | bounded fetch + parse of `/models`                                      |
| `packages/inference/src/internal/extraction-pipeline.ts`                                     | `extractJsonObject` + `parseExtraction` (untrusted → typed, 2 attempts) |
| `packages/inference/src/internal/strip-unstorable.ts`                                        | NUL/control-char hygiene for untrusted strings                          |
| `packages/inference/src/adapters/openrouter.extraction-adapter.ts`                           | `ExtractionPort` via OpenRouter                                         |
| `packages/inference/src/adapters/local.extraction-adapter.ts`                                | `ExtractionPort` via local endpoint                                     |
| `packages/inference/src/adapters/jev.decision-adapter.ts`                                    | `DecisionPort` via Jev                                                  |
| `packages/inference/src/client.ts`                                                           | `InferenceClient` factory                                               |
| `apps/api/src/config/env.ts` (MOD)                                                           | new optional keys                                                       |
| `apps/api/src/inference/inference.module.ts` (NEW)                                           | token + factory + exports                                               |
| `apps/api/src/inference/inference-model-refresh.service.ts` (NEW)                            | daily reconcile + snapshot holder                                       |
| `apps/api/src/inference/pinned-models.ts` (NEW)                                              | the code-constant pinned list                                           |
| `.github/workflows/deploy.yml` (MOD, DevOps)                                                 | secrets list + `envs:` + `.env.production` append                       |
| `CONTEXT.md` (MOD)                                                                           | glossary + r5 amendment                                                 |

---

### Task 0: Package scaffold `@crm/inference`

**Files:**

- Create: `packages/inference/package.json`, `packages/inference/tsconfig.json`, `packages/inference/vitest.config.mts`, `packages/inference/eslint.config.mjs`, `packages/inference/src/index.ts`
- Modify: `apps/api/package.json` (add `"@crm/inference": "workspace:*"` to dependencies)

**Interfaces:**

- Produces: a buildable/typecheckable package `@crm/inference` with an empty barrel; consumed later by all tasks and by `apps/api`.

- [ ] **Step 1: Copy the `@crm/shared` skeleton.** Create `package.json` with `name: "@crm/inference"`, `private: true`, `main: ./dist/index.js`, `types: ./dist/index.d.ts`, an `exports` map for `.` (types/source/default), scripts `build: tsc --outDir dist`, `typecheck: tsc --noEmit`, `lint: eslint src`, `test: vitest run`, dependency `zod` (the version already in `@crm/shared`), devDeps matching `@crm/shared` (typescript, vitest, eslint config). `tsconfig.json` extends `../../tsconfig.base.json` with `module: CommonJS`, `moduleResolution: Node`, `outDir: dist`, `declaration`, `declarationMap`, `include: ["src"]`. `vitest.config.mts` with `globals: true`, `environment: 'node'`, `include: src/**/*.{spec,test}.ts`. `eslint.config.mjs` mirroring `@crm/shared`.
- [ ] **Step 2: Barrel + a smoke test.** `src/index.ts` with `export const INFERENCE_PACKAGE = '@crm/inference'` (placeholder export, removed in Task 1). Create `src/index.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { INFERENCE_PACKAGE } from './index'
describe('@crm/inference', () => {
  it('builds and exports its name', () => expect(INFERENCE_PACKAGE).toBe('@crm/inference'))
})
```

- [ ] **Step 3: Install + verify build/typecheck/test.** Run `nvm use && pnpm install` (registers the workspace package), then `pnpm --filter @crm/inference build`, `pnpm --filter @crm/inference typecheck`, `pnpm --filter @crm/inference exec vitest run`. Expected: all green.
- [ ] **Step 4: Verify apps/api resolves it.** `pnpm --filter @crm/api typecheck`. Expected: green (dependency resolves).
- [ ] **Step 5: Commit**

```bash
git add packages/inference apps/api/package.json pnpm-lock.yaml
git commit -m "chore(inference): scaffold @crm/inference package"
```

---

### Task 1: Decision contracts

**Files:**

- Create: `packages/inference/src/contracts/decision.ts`, `packages/inference/src/contracts/decision.spec.ts`
- Modify: `packages/inference/src/index.ts` (export the new module; remove the placeholder)

**Interfaces:**

- Consumes: `InferenceErrorCode` (forward — defined in Task 2; until then import is added in Task 2 Step 1). To keep Task 1 self-contained, declare a local `type DecisionFailureCode = 'NOT_CONFIGURED' | 'PROVIDER_ERROR' | 'INVALID_OUTPUT' | 'RATE_LIMITED' | 'TIMEOUT'` and replace it with the shared `InferenceErrorCode` in Task 2 Step 4.
- Produces:
  - `decisionQuestionSchema` (discriminated union on `kind`), types `DecisionQuestion`, `DecisionChoiceQuestion`, `DecisionScoreQuestion`, `DecisionNoulQuestion`
  - `decisionAnswerSchema`, type `DecisionAnswer`
  - `decisionRequestSchema`, type `DecisionRequest`
  - type `DecisionResult = { ok: true; answers: DecisionAnswer[] } | { ok: false; code: DecisionFailureCode }`
  - `interface DecisionPort { decide(req: DecisionRequest): Promise<DecisionResult> }`
  - const `MAX_DECISION_QUESTIONS = 50`, `MAX_CHOICE_OPTIONS = 255`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { decisionQuestionSchema, decisionAnswerSchema, decisionRequestSchema } from './decision'

describe('decision contracts', () => {
  it('accepts a choice question with 1..255 options', () => {
    const q = decisionQuestionSchema.parse({ id: 'fit', kind: 'choice', options: ['yes', 'no'] })
    expect(q.kind).toBe('choice')
  })
  it('rejects a choice question with 0 options and with 256 options', () => {
    expect(() => decisionQuestionSchema.parse({ id: 'x', kind: 'choice', options: [] })).toThrow()
    expect(() =>
      decisionQuestionSchema.parse({ id: 'x', kind: 'choice', options: Array(256).fill('o') }),
    ).toThrow()
  })
  it('rejects a score question where min >= max', () => {
    expect(() => decisionQuestionSchema.parse({ id: 's', kind: 'score', min: 5, max: 5 })).toThrow()
  })
  it('accepts a noul question', () =>
    expect(decisionQuestionSchema.parse({ id: 'n', kind: 'noul' }).kind).toBe('noul'))
  it('rejects an answer with confidence outside 0..1', () => {
    expect(() => decisionAnswerSchema.parse({ id: 'n', value: true, confidence: 1.2 })).toThrow()
  })
  it('rejects a request with more than 50 questions', () => {
    const qs = Array.from({ length: 51 }, (_, i) => ({ id: `q${i}`, kind: 'noul' as const }))
    expect(() => decisionRequestSchema.parse({ state: {}, questions: qs })).toThrow()
  })
})
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @crm/inference exec vitest run src/contracts/decision.spec.ts`
- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'

export const MAX_DECISION_QUESTIONS = 50
export const MAX_CHOICE_OPTIONS = 255

const idSchema = z.string().min(1).max(100)

export const decisionQuestionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: idSchema,
    kind: z.literal('choice'),
    options: z.array(z.string().min(1).max(500)).min(1).max(MAX_CHOICE_OPTIONS),
  }),
  z
    .object({ id: idSchema, kind: z.literal('score'), min: z.number(), max: z.number() })
    .refine((q) => q.min < q.max, 'min must be < max'),
  z.object({ id: idSchema, kind: z.literal('noul') }),
])
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>

export const decisionAnswerSchema = z.object({
  id: idSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number().min(0).max(1),
})
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>

export const decisionRequestSchema = z.object({
  state: z.unknown(),
  questions: z.array(decisionQuestionSchema).min(1).max(MAX_DECISION_QUESTIONS),
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

export type DecisionFailureCode =
  | 'NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'INVALID_OUTPUT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
export type DecisionResult =
  | { ok: true; answers: DecisionAnswer[] }
  | { ok: false; code: DecisionFailureCode }

export interface DecisionPort {
  decide(req: DecisionRequest): Promise<DecisionResult>
}
```

- [ ] **Step 4: Run — PASS**, add `export * from './contracts/decision'` to `src/index.ts` and remove `INFERENCE_PACKAGE` + its smoke test. Re-run `vitest run` (whole package) green.
- [ ] **Step 5: Commit**

```bash
git add packages/inference/src/contracts/decision.ts packages/inference/src/contracts/decision.spec.ts packages/inference/src/index.ts packages/inference/src/index.spec.ts
git commit -m "feat(inference): decision port contracts (choice/score/noul)"
```

---

### Task 2: Extraction, errors, config contracts

**Files:**

- Create: `packages/inference/src/contracts/errors.ts`, `packages/inference/src/contracts/extraction.ts`, `packages/inference/src/contracts/config.ts`, `packages/inference/src/contracts/config.spec.ts`
- Modify: `packages/inference/src/contracts/decision.ts` (replace the local `DecisionFailureCode` with the shared code), `packages/inference/src/index.ts` (exports)

**Interfaces:**

- Produces:
  - `errors.ts`: `export const INFERENCE_ERROR_CODES = ['NOT_CONFIGURED','PROVIDER_ERROR','INVALID_OUTPUT','RATE_LIMITED','TIMEOUT'] as const`; `export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number]`
  - `extraction.ts`: `type ExtractionRequest<T> = { input: string; schema: z.ZodType<T>; instruction?: string }`; `type ExtractionResult<T> = { ok: true; data: T; usage?: { totalTokens?: number } } | { ok: false; code: InferenceErrorCode }`; `interface ExtractionPort { extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> }`; const `MAX_EXTRACTION_INPUT_CHARS = 50000`
  - `config.ts`: `type ModelPin = { id: string; purpose: 'extraction'; minContext?: number }`; `modelPinSchema`; `inferenceConfigSchema` + `type InferenceConfig` with shape:
    ```
    {
      decision?: { jev?: { apiKey: string; baseUrl?: string; timeoutMs?: number } }
      extraction?: {
        provider: 'local' | 'openrouter'
        openrouter?: { apiKey: string; pinnedModels: ModelPin[]; baseUrl?: string; timeoutMs?: number }
        local?: { baseUrl: string; apiKey?: string; model: string; timeoutMs?: number }
      }
    }
    ```

- [ ] **Step 1: Failing test** (`config.spec.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { inferenceConfigSchema, modelPinSchema } from './config'

describe('inference config', () => {
  it('accepts an openrouter extraction config with pins', () => {
    const cfg = inferenceConfigSchema.parse({
      extraction: {
        provider: 'openrouter',
        openrouter: { apiKey: 'k', pinnedModels: [{ id: 'a/b', purpose: 'extraction' }] },
      },
    })
    expect(cfg.extraction?.provider).toBe('openrouter')
  })
  it('rejects a pin without a non-empty id', () =>
    expect(() => modelPinSchema.parse({ id: '', purpose: 'extraction' })).toThrow())
  it('accepts an empty config (nothing configured)', () =>
    expect(inferenceConfigSchema.parse({})).toEqual({}))
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `errors.ts`, `extraction.ts`, `config.ts` per the Interfaces block. `extraction.ts` imports `InferenceErrorCode` from `./errors` and `z` from `zod`. `config.ts`:

```ts
import { z } from 'zod'
export const modelPinSchema = z.object({
  id: z.string().min(1),
  purpose: z.literal('extraction'),
  minContext: z.number().int().positive().optional(),
})
export type ModelPin = z.infer<typeof modelPinSchema>
export const inferenceConfigSchema = z.object({
  decision: z
    .object({
      jev: z
        .object({
          apiKey: z.string().min(1),
          baseUrl: z.string().url().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  extraction: z
    .object({
      provider: z.enum(['local', 'openrouter']),
      openrouter: z
        .object({
          apiKey: z.string().min(1),
          pinnedModels: z.array(modelPinSchema).min(1),
          baseUrl: z.string().url().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      local: z
        .object({
          baseUrl: z.string().url(),
          apiKey: z.string().min(1).optional(),
          model: z.string().min(1),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
})
export type InferenceConfig = z.infer<typeof inferenceConfigSchema>
```

- [ ] **Step 4: Replace the forward-declared code in `decision.ts`.** Import `InferenceErrorCode` from `./errors`; change `DecisionResult`'s failure code and `DecisionPort` to use `InferenceErrorCode`; delete the local `DecisionFailureCode`. Update `decision.spec.ts` if it referenced the local type (it does not). Add barrel exports for the three new modules in `src/index.ts`.
- [ ] **Step 5: Run — PASS** (whole package), `typecheck` green.
- [ ] **Step 6: Commit**

```bash
git add packages/inference/src/contracts packages/inference/src/index.ts
git commit -m "feat(inference): extraction/errors/config contracts"
```

---

### Task 3: Bounded HTTP request

**Files:**

- Create: `packages/inference/src/http/bounded-request.ts`, `packages/inference/src/http/bounded-request.spec.ts`
- Modify: `packages/inference/src/index.ts`

**Interfaces:**

- Produces:
  - `type FetchLike = (url: string, init?: { method?: string; headers?: Record<string,string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null; text: () => Promise<string> }>` (structurally satisfied by global `fetch`)
  - `type BoundedResult = { kind: 'ok'; status: number; text: string } | { kind: 'rate_limited'; status: number } | { kind: 'timeout' } | { kind: 'transport'; status?: number }`
  - `async function boundedRequest(opts: { url: string; method?: string; headers?: Record<string,string>; body?: string; timeoutMs: number; maxBytes: number; allowLoopbackHttp?: boolean; fetchImpl?: FetchLike }): Promise<BoundedResult>`
  - consts `DEFAULT_TIMEOUT_MS = 60000`, `DEFAULT_MAX_BYTES = 2 * 1024 * 1024`
- URL policy: reject non-`https:` unless `allowLoopbackHttp` and host ∈ {`localhost`,`127.0.0.1`,`[::1]`} → `{ kind: 'transport' }`. 429 → `rate_limited`. Abort/timeout → `timeout`. Non-2xx (non-429) → `transport` with status. Over `maxBytes` while reading → abort → `transport`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { boundedRequest, type FetchLike } from './bounded-request'

const okFetch: FetchLike = async () => ({ status: 200, body: null, text: async () => 'hello' })

describe('boundedRequest', () => {
  it('returns ok text on 200', async () => {
    const r = await boundedRequest({
      url: 'https://api.test/x',
      timeoutMs: 1000,
      maxBytes: 1000,
      fetchImpl: okFetch,
    })
    expect(r).toEqual({ kind: 'ok', status: 200, text: 'hello' })
  })
  it('maps 429 to rate_limited', async () => {
    const f: FetchLike = async () => ({ status: 429, body: null, text: async () => '' })
    expect(
      (
        await boundedRequest({
          url: 'https://api.test/x',
          timeoutMs: 1000,
          maxBytes: 1000,
          fetchImpl: f,
        })
      ).kind,
    ).toBe('rate_limited')
  })
  it('maps an aborted/slow call to timeout', async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
      )
    expect(
      (
        await boundedRequest({
          url: 'https://api.test/x',
          timeoutMs: 5,
          maxBytes: 1000,
          fetchImpl: f,
        })
      ).kind,
    ).toBe('timeout')
  })
  it('rejects non-https (and http unless loopback) as transport', async () => {
    expect(
      (
        await boundedRequest({
          url: 'http://api.test/x',
          timeoutMs: 1000,
          maxBytes: 1000,
          fetchImpl: okFetch,
        })
      ).kind,
    ).toBe('transport')
    expect(
      (
        await boundedRequest({
          url: 'http://localhost:11434/x',
          timeoutMs: 1000,
          maxBytes: 1000,
          allowLoopbackHttp: true,
          fetchImpl: okFetch,
        })
      ).kind,
    ).toBe('ok')
  })
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `boundedRequest`: validate URL scheme/host; `AbortController` + `setTimeout(timeoutMs)`; call `fetchImpl`; on `AbortError` → `timeout`; on throw → `transport`; map status (429 → rate_limited, non-2xx → transport); read text (when a `body` stream is present, accumulate with a byte counter and abort over `maxBytes`; otherwise use `text()`); clear the timeout in `finally`. **Review-focus test (byte cap):** add a case feeding a `body` stream that emits more than `maxBytes` and assert `kind: 'transport'`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit**

```bash
git add packages/inference/src/http packages/inference/src/index.ts
git commit -m "feat(inference): bounded HTTP request with typed transport result"
```

---

### Task 4: Model registry — `reconcile` + OpenRouter catalog

**Files:**

- Create: `packages/inference/src/registry/model-registry.ts`, `packages/inference/src/registry/model-registry.spec.ts`, `packages/inference/src/registry/openrouter-catalog.ts`, `packages/inference/src/registry/openrouter-catalog.spec.ts`
- Modify: `packages/inference/src/index.ts`

**Interfaces:**

- Consumes: `ModelPin` (Task 2), `boundedRequest`/`FetchLike`/`BoundedResult` (Task 3), `InferenceErrorCode` (Task 2).
- Produces:
  - `function reconcile(pinned: ModelPin[], liveIds: Iterable<string>): { usableInOrder: ModelPin[]; missing: ModelPin[] }`
  - `function selectModel(pinned: ModelPin[], liveIds: Iterable<string>): ModelPin | null` (= `reconcile(...).usableInOrder[0] ?? null`)
  - `async function fetchOpenRouterModelIds(opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: FetchLike }): Promise<{ ok: true; ids: string[] } | { ok: false; code: InferenceErrorCode }>` (bounded GET `https://openrouter.ai/api/v1/models`, parse `{ data: [{ id }] }` with Zod, map `BoundedResult` to codes)

- [ ] **Step 1: Failing test** (`model-registry.spec.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { reconcile, selectModel } from './model-registry'
const pins = [
  { id: 'a/top', purpose: 'extraction' as const },
  { id: 'b/mid', purpose: 'extraction' as const },
]
describe('reconcile', () => {
  it('selects the highest pin that is live', () => {
    const r = reconcile(pins, ['b/mid', 'a/top'])
    expect(r.usableInOrder.map((p) => p.id)).toEqual(['a/top', 'b/mid'])
    expect(selectModel(pins, ['b/mid', 'a/top'])?.id).toBe('a/top')
  })
  it('falls to the next pin and reports the missing one', () => {
    const r = reconcile(pins, ['b/mid'])
    expect(r.missing.map((p) => p.id)).toEqual(['a/top'])
    expect(selectModel(pins, ['b/mid'])?.id).toBe('b/mid')
  })
  it('NEVER selects a live-but-unpinned id', () => {
    expect(selectModel(pins, ['c/new-unpinned'])).toBeNull()
  })
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `reconcile` (filter pins by membership in the live set, preserving pin order; `missing` = pins not in the set) and `selectModel`. This is the **Review-focus test** for the unpinned-id rule.
- [ ] **Step 4: Failing test + implement `openrouter-catalog.ts`.** Test with a fake `FetchLike` returning `{ data: [{ id: 'x/y' }] }`; assert `{ ok: true, ids: ['x/y'] }`; a 429 fake → `{ ok: false, code: 'RATE_LIMITED' }`; malformed body → `{ ok: false, code: 'PROVIDER_ERROR' }`. Implement using `boundedRequest` + a Zod schema `z.object({ data: z.array(z.object({ id: z.string() })) })`.
- [ ] **Step 5: Run — PASS** (both specs), barrel exports.
- [ ] **Step 6: Commit**

```bash
git add packages/inference/src/registry packages/inference/src/index.ts
git commit -m "feat(inference): model registry reconcile + OpenRouter catalog fetch"
```

---

### Task 5: Extraction pipeline (untrusted → typed, two attempts)

**Files:**

- Create: `packages/inference/src/internal/strip-unstorable.ts`, `packages/inference/src/internal/extraction-pipeline.ts`, and their `.spec.ts`
- Modify: `packages/inference/src/index.ts` (export `extractJsonObject` and the pipeline for adapter use; keep internal names out of the public barrel if preferred — export from a `./internal` subpath used only by adapters)

**Interfaces:**

- Consumes: `z` (Zod).
- Produces:
  - `strip-unstorable.ts`: `function stripUnstorableChars(s: string): string` (removes NUL and C0/C1 control chars except `\n`/`\t`)
  - `extraction-pipeline.ts`:
    - `function extractJsonObject(text: string): string | null` (balanced-brace scan returning the first top-level `{...}`)
    - `function parseExtraction<T>(rawText: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false }` (extract → `JSON.parse` in try/catch → `stripUnstorableChars` on string leaves via schema → `schema.safeParse`)
    - `async function runExtraction<T>(args: { schema: z.ZodType<T>; call: (correction?: string) => Promise<{ ok: true; text: string } | { ok: false; code: 'PROVIDER_ERROR'|'RATE_LIMITED'|'TIMEOUT'|'NOT_CONFIGURED' }> }): Promise<{ ok: true; data: T } | { ok: false; code: 'INVALID_OUTPUT'|'PROVIDER_ERROR'|'RATE_LIMITED'|'TIMEOUT'|'NOT_CONFIGURED' }>` — calls `call()`, parses; on parse failure calls `call(<the zod error message>)` **once** and re-parses; else `INVALID_OUTPUT`. Transport failures short-circuit to their code.

- [ ] **Step 1: Failing test** (`extraction-pipeline.spec.ts`)

```ts
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { extractJsonObject, runExtraction } from './extraction-pipeline'

const schema = z.object({ title: z.string() })
describe('extraction pipeline', () => {
  it('extracts a top-level object from noisy text', () =>
    expect(extractJsonObject('prefix {"title":"x"} suffix')).toBe('{"title":"x"}'))
  it('returns typed data on first valid response', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, text: '{"title":"x"}' })
    const r = await runExtraction({ schema, call })
    expect(r).toEqual({ ok: true, data: { title: 'x' } })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('retries once on invalid JSON then succeeds', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'not json' })
      .mockResolvedValueOnce({ ok: true, text: '{"title":"y"}' })
    const r = await runExtraction({ schema, call })
    expect(r).toEqual({ ok: true, data: { title: 'y' } })
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('returns INVALID_OUTPUT after the corrective retry still fails', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, text: '{"wrong":1}' })
    const r = await runExtraction({ schema, call })
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('short-circuits a transport failure without retrying', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, code: 'RATE_LIMITED' })
    expect(await runExtraction({ schema, call })).toEqual({ ok: false, code: 'RATE_LIMITED' })
    expect(call).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `stripUnstorableChars`, `extractJsonObject` (brace-depth scan), `parseExtraction`, `runExtraction`. This Task owns the **Review-focus test** "200 + schema-invalid JSON → one retry → INVALID_OUTPUT" (the third and fourth `it` above). Separate `strip-unstorable.spec.ts` pins NUL/control removal.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit**

```bash
git add packages/inference/src/internal packages/inference/src/index.ts
git commit -m "feat(inference): untrusted-output extraction pipeline with one corrective retry"
```

---

### Task 6: OpenRouter extraction adapter

**Files:**

- Create: `packages/inference/src/adapters/openrouter.extraction-adapter.ts`, `.spec.ts`
- Modify: `packages/inference/src/index.ts`

**Interfaces:**

- Consumes: `ExtractionPort`/`ExtractionRequest`/`ExtractionResult`/`MAX_EXTRACTION_INPUT_CHARS` (Task 2), `boundedRequest`/`FetchLike` (Task 3), `runExtraction` (Task 5), `InferenceErrorCode` (Task 2).
- Produces: `function createOpenRouterExtractionAdapter(cfg: { apiKey: string; resolveModelId: () => string | null; baseUrl?: string; timeoutMs?: number; fetchImpl?: FetchLike }): ExtractionPort`
  - `resolveModelId` returns the currently-selected pinned model id (the app's refresh service backs it); `null` → `NOT_CONFIGURED`.

- [ ] **Step 1: Failing test** — a fake `FetchLike` returning an OpenAI-compatible `{ choices: [{ message: { content: '{"title":"x"}' } }], usage: { total_tokens: 5 } }`; assert `{ ok: true, data: { title: 'x' }, usage: { totalTokens: 5 } }`. A `resolveModelId: () => null` → `{ ok: false, code: 'NOT_CONFIGURED' }`. An input over `MAX_EXTRACTION_INPUT_CHARS` → caller truncates (assert the request body's content length is capped). A 429 fake → `RATE_LIMITED`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — `extract` builds a `POST {baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions` with `Authorization: Bearer`, `model: resolveModelId()`, messages (system instruction + user input truncated to `MAX_EXTRACTION_INPUT_CHARS`), `temperature: 0.1`; wraps the call in `runExtraction` where `call(correction?)` sends the correction as an extra user message; parses `choices[0].message.content` as the raw text; maps `BoundedResult` → codes.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(inference): OpenRouter extraction adapter`

---

### Task 7: Local extraction adapter

**Files:**

- Create: `packages/inference/src/adapters/local.extraction-adapter.ts`, `.spec.ts`
- Modify: `packages/inference/src/index.ts`

**Interfaces:**

- Consumes: same as Task 6.
- Produces: `function createLocalExtractionAdapter(cfg: { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number; fetchImpl?: FetchLike }): ExtractionPort`

- [ ] **Step 1: Failing test** — identical response-shape assertions as Task 6 but against `cfg.baseUrl` with `allowLoopbackHttp: true` (assert a `http://localhost:…` base works); `apiKey` optional (no `Authorization` header when absent).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — same OpenAI-compatible `chat/completions` shape as Task 6 against `cfg.baseUrl`, passing `allowLoopbackHttp: true` to `boundedRequest`, `model: cfg.model` (no registry), optional `Authorization`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(inference): local extraction adapter`

---

### Task 8: Jev decision adapter

**Files:**

- Create: `packages/inference/src/adapters/jev.decision-adapter.ts`, `.spec.ts`
- Modify: `packages/inference/src/index.ts`

**Interfaces:**

- Consumes: `DecisionPort`/`DecisionRequest`/`DecisionResult`/`decisionAnswerSchema` (Task 1), `boundedRequest`/`FetchLike` (Task 3).
- Produces: `function createJevDecisionAdapter(cfg: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: FetchLike }): DecisionPort` (POST `{baseUrl ?? 'https://api.typesafe.ai'}/v1/systemone`, `model: 'jev-latest'`).

- [ ] **Step 1: Failing test** — a fake `FetchLike` returning a systemone envelope with per-question answers; assert `{ ok: true, answers: [...] }` with each answer validated. **Review-focus tests:** an answer whose `id` is not among the requested questions → `{ ok: false, code: 'INVALID_OUTPUT' }`; an answer with `confidence: 1.5` → `INVALID_OUTPUT`. A missing `apiKey` path is covered at the client (Task 9), but add a guard test: constructing with an empty key and calling → `NOT_CONFIGURED` (adapter treats empty key as not configured).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — build the request from `req.state` + `req.questions` (map Choice/Score/Noul to the systemone question shape), bound the serialized `state` size (cap; over → `PROVIDER_ERROR` before calling), call, parse the envelope, validate each returned answer with `decisionAnswerSchema`, and assert the answer-id set is a subset of the requested ids (else `INVALID_OUTPUT`). Map `BoundedResult` → codes. Empty `apiKey` → `NOT_CONFIGURED`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(inference): Jev decision adapter`

---

### Task 9: `InferenceClient` factory

**Files:**

- Create: `packages/inference/src/client.ts`, `packages/inference/src/client.spec.ts`
- Modify: `packages/inference/src/index.ts`

**Interfaces:**

- Consumes: `InferenceConfig` (Task 2), the three adapter factories (Tasks 6–8), `selectModel` (Task 4), the ports (Tasks 1–2).
- Produces:
  - `class InferenceClient { constructor(cfg: InferenceConfig, deps?: { fetchImpl?: FetchLike; resolveOpenRouterModelId?: () => string | null }); readonly decision: DecisionPort; readonly extraction: ExtractionPort }`
  - When `cfg.decision?.jev` is absent → `decision.decide` returns `{ ok: false, code: 'NOT_CONFIGURED' }`. When `cfg.extraction` is absent, or the selected provider's block is absent → `extraction.extract` returns `NOT_CONFIGURED`. For OpenRouter, if `deps.resolveOpenRouterModelId` is not supplied, default it to `() => selectModel(cfg.extraction.openrouter.pinnedModels, [])` (→ `null` until the app wires the live-reconciled resolver).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { InferenceClient } from './client'

describe('InferenceClient', () => {
  it('returns NOT_CONFIGURED for decision when Jev is absent', async () => {
    const c = new InferenceClient({})
    expect(await c.decision.decide({ state: {}, questions: [{ id: 'n', kind: 'noul' }] })).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    })
  })
  it('returns NOT_CONFIGURED for extraction when nothing is configured', async () => {
    const c = new InferenceClient({})
    const { z } = await import('zod')
    expect(await c.extraction.extract({ input: 'x', schema: z.object({}) })).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    })
  })
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — construct the configured adapters or a `NOT_CONFIGURED`-returning stub per port. This Task owns the client-side **Review-focus test** for graceful degradation.
- [ ] **Step 4: Run — PASS**, then the whole package: `pnpm --filter @crm/inference exec vitest run`, `typecheck`, `lint`, `build` — all green.
- [ ] **Step 5: Commit** `feat(inference): InferenceClient factory with graceful degradation`

---

### Task 10: apps/api env, Nest module, daily model refresh

**Files:**

- Modify: `apps/api/src/config/env.ts`
- Create: `apps/api/src/inference/pinned-models.ts`, `apps/api/src/inference/inference.module.ts`, `apps/api/src/inference/inference-model-refresh.service.ts`, `apps/api/src/inference/inference-model-refresh.service.spec.ts`, `apps/api/src/inference/inference.tokens.ts`
- Modify: `apps/api/src/app.module.ts` (import `InferenceModule`)

**Interfaces:**

- Consumes: `@crm/inference` (`InferenceClient`, `reconcile`/`selectModel`, `fetchOpenRouterModelIds`, `ModelPin`).
- Produces:
  - `inference.tokens.ts`: `export const INFERENCE_CLIENT = Symbol('INFERENCE_CLIENT')`
  - `pinned-models.ts`: `export const PINNED_EXTRACTION_MODELS: ModelPin[] = []` (empty until the MP-03 measurement fills it; a comment references the measurement runbook)
  - `inference-model-refresh.service.ts`: `class InferenceModelRefreshService { getSelectedOpenRouterModelId(): string | null; refresh(): Promise<void> }` — `@Cron` daily `Europe/Kyiv`; `refresh()` calls `fetchOpenRouterModelIds`, `reconcile(PINNED_EXTRACTION_MODELS, ids)`, stores `selectModel(...)?.id ?? null` in a private field; on catalog failure keeps the last good value and `logger.warn`s; `missing.length > 0` → `logger.warn` (alert). Never rethrows (cron convention, `job-sourcing.cron.ts`).
  - `inference.module.ts`: provides `InferenceModelRefreshService`; provides `{ provide: INFERENCE_CLIENT, useFactory: (cfg: ConfigService<Env,true>, refresh: InferenceModelRefreshService) => new InferenceClient(buildConfig(cfg), { resolveOpenRouterModelId: () => refresh.getSelectedOpenRouterModelId() }), inject: [ConfigService, InferenceModelRefreshService] }`; `exports: [INFERENCE_CLIENT]`.
  - `env.ts`: new optional keys `JEV_API_KEY`, `OPENROUTER_API_KEY`, `LOCAL_MODEL_URL`, `LOCAL_MODEL_KEY`, `LOCAL_MODEL_NAME`, `INFERENCE_EXTRACTION_PROVIDER` (`z.enum(['local','openrouter']).optional()`) — all `.optional()` no-default (the resume-ai pattern). `buildConfig` maps env → `InferenceConfig` (only including a provider block when its keys are present).

- [ ] **Step 1: Failing test (env).** In the existing env test (or a new `inference.module.spec.ts`), assert `validateEnv({...valid base...})` accepts absent inference keys and that `buildConfig` of an env with `OPENROUTER_API_KEY` + `INFERENCE_EXTRACTION_PROVIDER=openrouter` yields `{ extraction: { provider: 'openrouter', openrouter: { apiKey, pinnedModels: PINNED_EXTRACTION_MODELS } } }`.
- [ ] **Step 2: Failing test (refresh, pure-ish).** Unit test `InferenceModelRefreshService.refresh()` with an injected `fetchOpenRouterModelIds` double: given live ids ⊇ one pin → `getSelectedOpenRouterModelId()` returns it; given a catalog failure after a good refresh → keeps the previous id; given `missing` → still succeeds. (The selection logic itself is already pinned in Task 4; here assert the service's caching/last-good behavior.)
- [ ] **Step 3: Run — FAIL** both.
- [ ] **Step 4: Implement** `pinned-models.ts`, `inference.tokens.ts`, `buildConfig`, `env.ts` keys, the refresh service, and the module; wire `InferenceModule` into `app.module.ts`.
- [ ] **Step 5: Run — PASS**; `pnpm --filter @crm/api typecheck`, `lint`; `pnpm --filter @crm/api exec vitest run src/inference`.
- [ ] **Step 6: Commit**

```bash
git add apps/api/src/inference apps/api/src/config/env.ts apps/api/src/app.module.ts
git commit -m "feat(api): InferenceModule — DI client + daily OpenRouter model refresh"
```

---

### Task 11: Deploy secrets wiring (DevOps)

**Files:**

- Modify: `.github/workflows/deploy.yml`

**Interfaces:**

- Consumes: the env key names from Task 10.
- Produces: the new keys reach `/opt/crm/.env.production` on the VPS when set, and are omitted when unset.

- [ ] **Step 1:** Mirror the `CLOUDFLARE_AI_TOKEN` precedent for each new key (`JEV_API_KEY`, `OPENROUTER_API_KEY`, `LOCAL_MODEL_URL`, `LOCAL_MODEL_KEY`, `LOCAL_MODEL_NAME`, `INFERENCE_EXTRACTION_PROVIDER`): add to the `env:` secrets block (from `${{ secrets.* }}`), the SSH `envs:` allow-list, and the conditional `printf … >> .env.production` append (`if [ -n "$KEY" ]`). No key is written blank.
- [ ] **Step 2:** `.env.example` — add the keys with empty/placeholder values + a one-line comment each.
- [ ] **Step 3: Commit** (workflow PR → manual merge, per project convention for `deploy.yml`)

```bash
git add .github/workflows/deploy.yml .env.example
git commit -m "infra(deploy): wire inference provider secrets to .env.production"
```

---

### Task 12: Glossary + r5 amendment

**Files:**

- Modify: `CONTEXT.md`

- [ ] **Step 1:** Add glossary entries: **inference layer** (`@crm/inference`), **extraction port**, **decision port** (Jev). Add a short note that the model now performs **relevance** via Jev, amending the r4/r5 "extraction only" constraint by owner decision 2026-10-13, and pointing to `docs/superpowers/specs/2026-10-13-shared-inference-layer-design.md`.
- [ ] **Step 2: Commit** `docs(context): inference layer glossary + r5 extraction-only amendment`

---

## Self-review

- **Spec coverage:** §4 package/layout → Tasks 0–9; §4.2 consumer wiring → Task 10; §5 contracts → Tasks 1,2,8 (decision), 2,5,6,7 (extraction); §6 registry/refresh → Tasks 4 (pure) + 10 (schedule/cache); §7 config/secrets/egress → Tasks 2,3,10,11; §8 errors/testing → every task (TDD) + §Review Focus; §2 r5 amendment → Task 12. No uncovered section.
- **Placeholders:** none; `PINNED_EXTRACTION_MODELS = []` is an intentional, documented empty-until-measured constant, not a placeholder (the measurement that fills it is out of scope here).
- **Type consistency:** `InferenceErrorCode` (Task 2) is the single failure-code source; Task 1's forward-declared `DecisionFailureCode` is explicitly replaced in Task 2 Step 4. `FetchLike`/`BoundedResult` (Task 3) reused by Tasks 4,6,7,8. `resolveModelId`/`resolveOpenRouterModelId` naming: adapter param is `resolveModelId` (Task 6), client dep is `resolveOpenRouterModelId` (Task 9) which is passed into the adapter's `resolveModelId` — consistent by wiring, named per scope.
- **Review Focus:** all five lines have an owning task with an explicit test (Tasks 5, 8, 4, 3, 9/10).

```

```
