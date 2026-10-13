# Shared inference layer — design

**Date:** 2026-10-13 · **Status:** owner-approved design (conversational), pending written-spec review · **Author:** Master session (brainstorming)

> **Scope of this spec:** a NEW shared, in-process inference package (`@crm/inference`) that both the vacancy
> auto-sourcing feature and a colleague's feature consume. It provides two provider-independent ports —
> **extraction** (text → structured fields) and **decision** (typed decisions via a System One model) — plus a model
> registry that keeps provider model choices pinned and safe. Wiring this package into the vacancy funnel/queue, the
> relevance question-set, and the HTML discovery path are **separate later phases**, not designed here.

---

## 1. Goal

Give the monorepo one shared way to call inference models, so that neither the vacancy feature nor the colleague's
feature re-implements model clients, output validation, or model-pool safety. Two distinct inference jobs are served
behind two ports:

- **Extraction** — turn untrusted text (e.g. a job posting's HTML/markdown) into schema-validated structured fields.
  Backends: a local OpenAI-compatible model, or OpenRouter.
- **Decision** — answer typed questions (Choice / Score / Noul) against a bounded state and return structured answers
  with calibrated confidence. Backend: TypeSafe AI **Jev** (System One), provider-independent behind the port.
  **Relevance** (how well a vacancy fits a given senior) is the first consumer of the decision port; the relevance
  question-set itself lives in the consuming feature, not in this package.

The package is framework-agnostic (no `@nestjs` dependency). Each consuming app wraps it in a thin NestJS provider.

## 2. Owner decisions recorded (2026-10-13)

- A local model is acceptable for extraction.
- The decision/relevance job uses **Jev** (TypeSafe AI). This **amends** the r4/r5 constraint "model use is extraction
  only" — a model now also performs relevance. Legitimate per r5 ("an owner cost decision later would amend
  'extraction only'"); recorded here and to be recorded in `CONTEXT.md`.
- The inference layer is a **package in this monorepo**, called in-process; it is reused by a colleague's feature in
  the same monorepo.
- The shared contract is **two ports: `extraction` + a general `decision`** (not a narrow relevance-only port), because
  Jev is a general decision engine and the colleague may use the decision port for other typed decisions.
- OpenRouter's model pool changes daily, so model selection must never trust a model id at call time: a **registry**
  refreshes a vetted, pinned allow-list ahead of use (see §5).
- Jev is early-access / waitlist with self-reported benchmarks and no public SLA; the design must stay
  provider-independent and degrade gracefully when Jev is not configured.

## 3. Non-scope (YAGNI; later phases consume this package)

- Vacancy-queue / funnel wiring and the actual relevance call on the funnel.
- The relevance question-set definition (what we ask Jev about a vacancy↔senior pair).
- HTML discovery / Firecrawl / Phase-5 orchestration.
- The concrete model choice (which OpenRouter model; local vs OpenRouter) — decided later by measurement
  (r5 MP-03 / MP-04). This package only needs the pinned list to be fillable.
- Any persistence of inference results; callers own their own storage.

## 4. Architecture

### 4.1 Package `@crm/inference`

A new `packages/inference` mirroring `@crm/shared`: dual `exports` map, `tsc --outDir dist` build, co-located
`*.spec.ts` under vitest, `tsconfig` extending `tsconfig.base.json` (CommonJS / Node resolution), `zod` as the only
runtime dependency, **no `@nestjs` dependency**. Consumed by apps as `"@crm/inference": "workspace:*"`.

Module layout by responsibility:

```
packages/inference/src/
  index.ts                           # public barrel
  contracts/
    decision.ts                      # DecisionPort interface + Zod question/answer/state schemas
    extraction.ts                    # ExtractionPort interface + Zod request/result schemas
    errors.ts                        # typed result unions + InferenceErrorCode
    config.ts                        # InferenceConfig schema (provider selection, hosts, timeouts, pins)
  adapters/
    jev.decision-adapter.ts          # DecisionPort via Jev (POST https://api.typesafe.ai/v1/systemone)
    openrouter.extraction-adapter.ts # ExtractionPort via OpenRouter (OpenAI-compatible chat/completions)
    local.extraction-adapter.ts      # ExtractionPort via a local OpenAI-compatible endpoint
  registry/
    model-registry.ts                # pinned allow-list + reconcile(live) + ordered selection (pure)
    openrouter-catalog.ts            # bounded GET of the OpenRouter /models catalog
  http/
    bounded-request.ts               # fetch + AbortController, byte/time caps, typed transport errors
  client.ts                          # InferenceClient(config) -> { decision, extraction }
```

Adapters take an **injectable `fetch`-like function** (default: global `fetch`) so tests run without network.

### 4.2 Consumer boundary (NestJS wiring, in each app — not in the package)

Each consuming app adds a thin provider following the existing `OUTBOX_GATEWAY` seam
(`apps/api/src/notifications/notification-email.cron.ts` — `Symbol` token + interface + `{ provide, useClass/useFactory }`):

- Define/reuse a DI token (e.g. `INFERENCE_CLIENT = Symbol('INFERENCE_CLIENT')`).
- A factory reads the app's validated env via `ConfigService`, constructs `new InferenceClient(cfg)`, binds it to the
  token, and the module `exports` it. Consumers `@Inject(INFERENCE_CLIENT)`.
- The package never reads env or process globals itself; all secrets/hosts are passed in through `InferenceConfig`.

### 4.3 Data flow

```
caller ── extraction.extract({ input, schema, instruction? })
            └─ adapter: build request → boundedRequest(fixed host) → raw text
               → extractJsonObject → safeJsonParse → schema.safeParse → link-sanitize
               → Ok{data,usage} | (one corrective retry on invalid JSON) | Failure{code}

caller ── decision.decide({ state, questions })
            └─ jev adapter: build systemone request → boundedRequest(api.typesafe.ai)
               → parse envelope → per-question Zod validation (value + confidence)
               → Ok{answers[]} | Failure{code}      // never throws
```

## 5. Contracts

All model output is **UNTRUSTED**: adapters validate it with Zod before returning typed data, and never return raw
provider output to the caller.

### 5.1 DecisionPort (general; Jev-shaped)

```
interface DecisionPort { decide(req: DecisionRequest): Promise<DecisionResult> }

DecisionRequest = { state: BoundedJson, questions: DecisionQuestion[] }
DecisionQuestion =
  | { id: string; kind: 'choice'; options: string[] }   // options length 1..255
  | { id: string; kind: 'score'; min: number; max: number }
  | { id: string; kind: 'noul' }                         // yes/no probability
DecisionAnswer  = { id: string; value: <per kind>; confidence: number }  // confidence 0..1
DecisionResult  = { ok: true; answers: DecisionAnswer[] } | { ok: false; code: InferenceErrorCode }
```

- `state` is bounded (size cap) and carries no secrets; the caller composes it.
- Answer `id`s must map one-to-one to the request's question `id`s; a mismatch is `INVALID_OUTPUT`.
- The relevance consumer (later, in the vacancy feature) builds the questions and interprets `confidence`; the port
  stays domain-agnostic.

### 5.2 ExtractionPort

```
interface ExtractionPort { extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> }

ExtractionRequest<T> = { input: string; schema: ZodType<T>; instruction?: string }  // input bounded
ExtractionResult<T>  = { ok: true; data: T; usage?: { totalTokens?: number } }
                     | { ok: false; code: InferenceErrorCode }
```

- Untrusted-output pipeline mirrors `resume-ai.service.ts`: `extractJsonObject` (balanced-brace scan) →
  `safeJsonParse` → `schema.safeParse` → link sanitization; **exactly two attempts** (initial + one corrective retry
  that feeds the parse error back), never a loop.

### 5.3 Errors

`InferenceErrorCode = NOT_CONFIGURED | PROVIDER_ERROR | INVALID_OUTPUT | RATE_LIMITED | TIMEOUT`.
Adapters **never throw** to the caller (typed result union, per `resume-ai.service.ts`). HTTP 429 (or provider
rate-limit signal) → `RATE_LIMITED`; abort/timeout → `TIMEOUT`; transport/5xx/malformed envelope → `PROVIDER_ERROR`;
missing credentials → `NOT_CONFIGURED`. Tokens and request/response bodies are never logged.

## 6. Model registry (OpenRouter safety)

Addresses the owner's concern that the OpenRouter model pool changes daily.

- A **pinned allow-list** is a code constant (provenance/SSRF): an ordered list of vetted
  `ModelPin = { id, purpose: 'extraction', minContext }` entries per purpose. Nothing admin-stored, nothing from env
  for ids.
- `openrouter-catalog.ts`: a **bounded GET** of `https://openrouter.ai/api/v1/models` returning the set of live ids.
- `model-registry.ts`:
  - `reconcile(pinned, liveIds) -> { usableInOrder: ModelPin[], missing: ModelPin[] }` — a **pure** function.
  - Selection = the first pinned entry present in `liveIds`. If a higher-priority pin is missing, selection falls to
    the next and `missing` is surfaced for an alert.
  - A model id that is live but **not pinned is never selected**.
- **Refresh-ahead mechanism (in `apps/api`, not in the package):** a scheduled job runs daily (ahead of use), fetches
  the catalog, calls `reconcile`, and caches the chosen usable model. If the catalog fetch fails, the last good
  snapshot is kept and an alert is surfaced; inference calls do not hard-fail on a failed refresh. The package exposes
  the pure `reconcile` and the bounded catalog fetch; the app owns the schedule and the snapshot cache.
- Jev (`jev-latest`) and the local model use a single fixed alias and bypass the registry.

## 7. Config, secrets, egress

- New **optional-no-default** env keys in `apps/api/src/config/env.ts` (Zod `z.string().min(1).optional()` pattern):
  `JEV_API_KEY`, `OPENROUTER_API_KEY`, `LOCAL_MODEL_URL`, optional `LOCAL_MODEL_KEY`, and an extraction-provider
  selector `INFERENCE_EXTRACTION_PROVIDER` (`local | openrouter`). Timeouts, byte caps and the pinned model list are
  code constants, not env.
- **`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` are NOT reused** — they belong to résumé generation
  (`resume-ai.service.ts`); the withdrawn Workers-AI route must not be reintroduced through them (r5 C-21).
- Secret flow uses the existing mechanism: add each key to the `deploy.yml` secrets list + the `envs:` SSH allow-list +
  the conditional `.env.production` append (unset secrets are omitted, never written blank).
- **Egress**: fixed provider hosts (`api.typesafe.ai`, `openrouter.ai`, the local host) via `http/bounded-request.ts`
  (raw `fetch` + inline `AbortController` + byte/time caps — the repo precedent for fixed hosts). HTTPS-only, except
  `http` is permitted only for a loopback/local host. Hosts are constants, never admin-supplied. The client runs with a
  clean environment (no `DATABASE_URL` etc.).
- **Graceful degradation**: when `JEV_API_KEY` is absent, the decision port returns `NOT_CONFIGURED` rather than
  throwing (the `isConfigured()` precedent). Same for extraction when neither provider is configured.

## 8. Error handling & testing

- Error handling as §5.3: typed unions, never throw, no secret/body logging, corrective retry only for extraction
  JSON-shape errors.
- Testing (vitest, co-located; the mutation gate sees these pure units):
  - Contract schemas: round-trip parse + rejection of malformed/oversized input and non-matching answer ids.
  - `reconcile`: pinned ordering, `missing` surfacing, never selecting an unpinned live id, empty/duplicate live lists.
  - Extraction sanitization pipeline: untrusted text → typed data or typed failure; the two-attempt corrective retry;
    link sanitization.
  - Adapters: request building and response parsing with an **injected fake `fetch`** (no network in CI); 429 →
    `RATE_LIMITED`, abort → `TIMEOUT`, malformed envelope → `PROVIDER_ERROR`.
- A live smoke against real providers is env-gated and manual, never in CI.

## 9. File structure

**New package:** `packages/inference/**` (package.json, tsconfig.json, vitest.config.mts, eslint config, `src/**` per
§4.1 with co-located specs). `pnpm-workspace.yaml` already globs `packages/*`; `turbo` builds it; consumers add
`"@crm/inference": "workspace:*"`.

**Modified (apps/api):** `apps/api/src/config/env.ts` (new optional keys); a new `apps/api/src/inference/` thin NestJS
module (token + factory + the daily registry-refresh scheduled job + snapshot cache); `apps/api/package.json`
(`workspace:*` dependency).

**Modified (DevOps):** `.github/workflows/deploy.yml` (secrets list + `envs:` allow-list + `.env.production` append for
the new keys); compose files only if a local model runtime is co-located (deferred to the model-choice measurement).

**Docs:** `CONTEXT.md` (glossary: inference layer / extraction port / decision port; record the r5 "extraction only"
amendment).

## 10. Risks

- **Jev maturity** — early-access, self-reported benchmarks, no SLA. Mitigation: provider-independent decision port,
  graceful `NOT_CONFIGURED`, first adapter only; a second decision backend can be added behind the same port.
- **OpenRouter pool churn** — mitigated by the pinned allow-list + refresh-ahead reconcile (§6); a call never adopts an
  unvetted id.
- **Local model capacity on the prod VPS** — unresolved until measured (r5 MP-04 / MP-05); the local adapter is wired
  but the host/model decision is deferred. No compose change until measured.
- **Secret handling** — provider keys are optional-no-default and flow through the existing `deploy.yml` mechanism;
  the client receives a clean environment.

## 11. Shelf life

Revisit when a provider contract materially changes (Jev GA / pricing, OpenRouter `/models` shape or terms, a local
runtime decision) or when the first consumer (vacancy relevance) is wired. The pinned model list is reviewed whenever a
model is added or an alert reports a missing pin.
