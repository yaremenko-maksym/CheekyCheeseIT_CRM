# ADR: Extraction model router — adopting the VideoContentFactory provider chain into `@crm/inference`

## Status

**Proposed** — 2026-11-03. Code starts only after the owner approves this ADR and answers the A3 decisions in
§7. Task: r5 Task 5.4c (plan `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`, Task 5.4 amendment of
2026-11-03 and §"Model split — owner decision, 2026-10-18").

## Context

The owner decided on 2026-10-18 that vacancy extraction runs on **Gemini, Groq, OpenRouter and the local model**: a
router over free hosted models with prompt dosing, so that no provider starts refusing, over a local baseline.
Everything must work on the local model alone; the free hosted models are an accelerator. Generation (Cloudflare
Workers AI) is out of scope for r5.

The owner already runs such a chain in his own project, **VideoContentFactory** (VCF; read-only for this ADR, read at
its state of 2026-11-03). Today `@crm/inference` offers one extraction route, chosen by `INFERENCE_EXTRACTION_PROVIDER`
(`local` | `openrouter`), behind `ExtractionPort` (`extract({ input, schema, instruction }) → { ok, data, usage? } |
{ ok: false, code: InferenceErrorCode }`). The HTML path (Tasks 5.4a/5.4b) composes privacy guards and a shared
budget around that port; the router must slot in **behind the same port** so 5.4b does not change.

Forces:

- **Privacy.** Page text leaves the host. Contact stripping and the `ai-input=no` gate already run before the port
  (5.4a/5.4b); free hosted tiers may log or train on prompts.
- **Free tiers churn.** Models are renamed, retired, rate-limited per minute and capped per day; the error texts
  differ per provider.
- **"Slow, never a silent failure."** A chain that runs dry must fall to local and say so; a local failure must stop
  loudly, not report "nothing extracted".
- **Repo invariants.** Secrets only in worker-read optional env keys (never config, DB, logs, reports, build layers;
  never `CLOUDFLARE_*`); exhaustion classified by documented status/error codes, never by page text; Zod v4
  validation of every model output; deterministic tests without keys or network.

---

## 1. What VideoContentFactory does, and what is portable

VCF is a single-owner content pipeline (Node 22, `--experimental-strip-types`, SQLite through a synchronous driver).
Its model layer is an `LlmExecutor` function type — `(prompt, tools?, hint?) → Promise<string>`, throwing on failure —
composed from the pieces below.

### 1.1 The pieces

| VCF mechanism (symbol) | What it does | Portable? |
| --- | --- | --- |
| **Route** (`Route` type) | A named executor plus capability facts: usable context tokens, image support, and `rotate` (may it be the first route tried) | **Yes** — the shape is the router's unit |
| **Cascade** (`createChainExecutor`) | Tries routes in order; each failure is recorded as `<route>: <why>` and announced ("X failed, asking Y"); all failed → one error joining every reason | **Yes** |
| **Fit filter** (`createFittingChainExecutor`, `fitRoutes`) | Drops routes that cannot take this call (prompt larger than the context window, images on a text-only route) before spending a request; when nothing fits it tries everyone and says so | **Yes**, minus images |
| **Balancing** (`createBalancedChainExecutor`) | A per-instance counter rotates which rotatable route goes first, so successive calls spread over providers; a `rotate: false` route (Gemini, budget reserved) is only a fallback | **Yes** |
| **Hybrid floor** (`createHybridExecutor`) | Hosted chain first for named calls, the local model behind it; the fall is announced through `onFallback` | **Yes** — this is "local baseline" |
| **OpenAI-compatible leaf** (`createOpenAICompatExecutor`) | One provider, an ordered list of models; skips models marked spent or retired; a minimum gap between calls to one provider (`COMPAT_MIN_GAP_MS` = 3 s); 429 whose body matches a per-day pattern (`DAILY_LIMIT`: "per day", `TPD`, `RPD`, "daily") → model spent for the day; 404 naming a model or endpoint (`retiredAnswer`) → model retired; an off-schema answer passes to the next model | **Yes**, the classification and pacing; **no**, the body-text handling (§5) |
| **Gemini leaf** (`createGeminiExecutor`) | Native Gemini API; 7 s minimum gap (`MIN_CALL_GAP_MS`); 429/503 waited out with backoff 9 s / 25 s (`BUSY_BACKOFF_MS`) before moving on; a 429 naming a `PerDay` quota → spent; safety block (`promptFeedback.blockReason`, `finishReason`) → failure | **Pattern yes**; the native client is replaced by Gemini's OpenAI-compatible endpoint if research confirms it (§2.3) |
| **Own daily caps** (`budgetGuarded`, `providerBudget`, `consumeQuota`) | Before each call a per-provider counter for the provider's own day (Pacific for Gemini, UTC for the rest) is spent; over the cap → the route is skipped without a request | **Yes** — maps onto the CRM's existing account meters (§3) |
| **Spent ledger** (`SpentStore`, table `llm_spent`) | `(model, provider-day)` rows: "this model said no more today"; read by every process | **Concept yes; storage no** (§3) |
| **Retired ledger** (`RetiredStore`, table `llm_retired`) | Models that answered "gone"; cleared by the daily model refresh, because a fresh probe is the authority | **Concept yes; storage no** (§3) |
| **Model refresh** (`pickLiveModels`, `classifyModelStatus`) | Daily probe of the free catalogue; drops 404s and small contexts, keeps alive before busy before unknown; never wipes the list on a bad morning | **Partly** — CRM pins its models (§3.3); the "never wipe on a bad probe" rule is adopted |
| **Preflight** (`PREFLIGHT_PROMPT`, `PREFLIGHT_BACKOFF_MS`) | One trivial call to the local model before a run that needs it; 4 attempts, 10 / 30 / 60 s apart; no answer → the run stops at once, names the address, marks nothing as judged, writes a durable "model unreachable" marker | **Yes** |
| **Wall-clock ceiling** (`boundExecutor`) | One logical call is capped, because per-request timeouts sum across a cascade | **Yes** — essential |
| **Dosing** (`DosedCall`, `dosePlanFor`, `callDosed`, `SmallDoseNeeded`) | See 1.2 | **Yes, re-scoped** |

### 1.2 What "dosing" means in VCF — and in the CRM

In VCF, **a dose is the shape of a call sized to the model that answers it**, not a rate. A call has a `full` shape
(the structured request, for a large hosted model) and a `small` shape (a decomposition into simple questions the small
local model answers reliably, read by code). On the hybrid, a call goes `full` to the hosted chain; when the chain gives
up, the executor **hands the call back** (`SmallDoseNeeded`) instead of sending the full prompt to the small model —
which is what used to come back empty — and the small dose runs pinned to the local route.

What keeps a free provider from **refusing** is a separate set of mechanisms: the per-provider minimum gap, the own
daily caps below the provider's published limit, the spent ledger (never re-ask a model that said "no more today"),
and rotation across providers.

The owner's phrase "prompt dosing, so a provider does not start refusing" therefore maps onto **both**, and this ADR
adopts both under explicit names:

- **Pacing** — gap, own caps, spent/retired ledgers, rotation. Keeps hosted providers below their refusal threshold.
- **Dosing** — the input (and, if MP-03 shows it is needed, the schema) sized per route: every chunk the caller sends
  fits the **local** route's window, so the floor can always answer; a route that cannot take a chunk is dropped by the
  fit filter, never fed a truncated prompt.

### 1.3 What is not portable

- **Storage.** SQLite with a synchronous driver; the CRM uses PostgreSQL/Drizzle, and the extraction worker holds no DB
  credential (Task 5.2).
- **Why VCF persists the ledgers.** VCF runs every clip in its own short process, so in-memory state would be lost
  between calls. The CRM extractor is one long-lived process; that reason does not carry over (§3.2).
- **Provider error bodies stored and logged.** VCF writes up to 200–300 characters of the provider's error body into
  its ledgers and notes. A provider error body can echo the prompt; in the CRM it is never persisted or logged — only a
  classified code (§5).
- **Body-text classification by broad regex.** VCF decides "spent for the day" by matching the body against
  `DAILY_LIMIT`. The CRM classifies by status code plus a bounded read of documented structured error fields (§5).
- **`response_format: json_object` with a retry without it on a 400.** The CRM plan requires strict `json_schema` where
  the route supports it, local Zod validation always, and no code-fence fallback.
- **The Claude CLI executor, images, the WSL gateway resolution, Ollama's native API, the env-supplied model lists and
  the providers that need a card** (VCF already rejects Cerebras and Together; the CRM does not add them either).

---

## 2. How to adopt it: three options

All three keep `ExtractionPort` unchanged, so 5.4b and every future consumer are untouched.

### Option A — copy-adapt the patterns into `@crm/inference` (recommended)

Re-implement the mechanisms of §1.1 inside `@crm/inference` against its own contracts: `FetchLike` and
`boundedRequest` for transport, `sendChatCompletion` for the OpenAI-compatible call, `runExtraction` for parse + one
correction retry + Zod validation, `InferenceErrorCode` for the public result. VCF's code is the reference, its
constants are the starting values, and each adopted mechanism names its VCF origin in a code comment (provenance, so a
later fix in VCF can be found and carried over by hand).

- **For:** one runtime and one set of conventions (Zod v4, "never throws", bounded transport, no provider host from
  env); the CRM's privacy rules apply from the first line; testable through the package's existing fake-fetch seam; no
  cross-repo coupling.
- **Against:** two copies of similar logic evolve separately; VCF fixes do not flow automatically.
- **Size:** the router core is small (cascade, fit, rotation, floor: VCF does it in under 100 lines); the bulk is
  failure classification and its fixtures.
- **Confidence: HIGH** — the patterns run daily in VCF and the target seam already exists.

### Option B — extract a shared package used by both projects

- **Against, decisively:** the projects differ in runtime mode (VCF runs TypeScript by type-stripping, which forbids
  some syntax), storage (synchronous SQLite vs Postgres), error contract (VCF throws, `@crm/inference` never throws)
  and privacy rules. A shared package needs a publish channel the repo does not have (pnpm 7 workspace, no private
  registry), makes a CRM release depend on a personal project's release, and the truly shared surface is little more
  than the cascade loop.
- **Confidence: HIGH** that it costs more than it saves.

### Option C — call VCF's executor across processes (sidecar)

- **Against, decisively:** CRM production would depend on a personal project's uptime and on the owner's machine;
  vacancy text would cross into a process that logs provider bodies; hosted keys would live in a second repository; no
  CRM gate reviews that path.
- **Confidence: HIGH** that it is the wrong shape.

**Decision (proposed): Option A.**

### 2.1 Shape inside `@crm/inference`

| Element | Behaviour |
| --- | --- |
| Config | `extraction.provider` gains a third value, `router` (additive; `local` and `openrouter` keep their exact behaviour). The `router` block lists **routes** in priority order. Each route has a provider id (`gemini`, `groq`, `openrouter`, `local`), its API key (hosted only), a **pinned** ordered model list, its context window, its structured-output capability (`json_schema` / `json_object` / none), its minimum call gap and `rotate`. The local route is required and always last; the schema refuses a router config without it. |
| Hosts | Package constants, as today (no base-URL env); the local route keeps its env URL. |
| Route leaf | One OpenAI-compatible leaf for every provider, built on `sendChatCompletion` widened to return an **internal classified failure** (§5) instead of collapsing everything into `PROVIDER_ERROR`. Gemini uses its OpenAI-compatible endpoint if research confirms strict-schema support there (§2.3); otherwise a small native leaf with the same contract. |
| Router | `createRouterExtractionAdapter(config, deps)` returns an `ExtractionPort`. Per call: fit filter → rotation among rotatable hosted routes → cascade through hosted routes → local floor. A whole-call deadline caps the sum of per-attempt timeouts (VCF's `boundExecutor` lesson). |
| Deps (seams) | `fetchImpl`, `now`, `sleep`, a `RouteStatePort` (§3.2), an optional `OwnCapPort` (§3.1) and `onEvent` (§6.2). |
| Public result | Unchanged: `{ ok: true, data, usage? }` or `{ ok: false, code: InferenceErrorCode }`. Internal codes never leave the package, exactly as `MODEL_UNAVAILABLE` does not today. |
| Input ceiling | An exported pure helper returns the largest input the configured **local** route accepts; the 5.4b chunker sizes chunks to it, so the floor can always answer (§1.2, dosing). |

The existing `InferenceModelResolverService` (OpenRouter, cheapest model under guardrails, chosen at runtime) stays as
it is for `provider: openrouter`. Under `router` the models are **pinned** (§3.3), not chosen by price.

### 2.2 What the router does not do

It does not strip contacts, check `ai-input`, build the prompt envelope, reserve the shared 20-call cycle budget, chunk
by record boundary, or check URL grounding. Those stay in 5.4a/5.4b **in front of** the port. The router sees
already-stripped, already-permitted text and returns schema-validated data; the result guard still runs after it.

### 2.3 Facts this ADR could not check (no network) — settled by task 5.4c-0

Each is a fact, not a decision; the research task settles it before code.

| Claim | Confidence now |
| --- | --- |
| Gemini exposes an OpenAI-compatible chat-completions endpoint that accepts `response_format` with a JSON schema | MED |
| Groq accepts strict `json_schema` on the free models it lists, and marks per-day 429s in a structured error field | MED |
| OpenRouter's `provider.data_collection: "deny"` (already sent by the current adapter) and `zdr` leave few or no `:free` endpoints | MED — VCF does not send `deny` and runs on `:free` models |
| The free tiers' current per-minute and per-day limits | LOW — they change monthly |
| Each provider's free-tier data terms: prompt retention, training use, human review. The Gemini API terms for unpaid use are believed to allow use for product improvement, including human review | LOW-MED — **legal-relevant**, §4 |
