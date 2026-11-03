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

## Decision (summary)

1. **Copy-adapt** VCF's routing patterns into `@crm/inference` behind the unchanged `ExtractionPort` (§2, HIGH).
2. A third extraction provider value, `router`: pinned hosted routes (Gemini, Groq, OpenRouter) in front of a
   **required** local floor; rotation, fit filter, own caps, spent/retired skipping, a whole-call deadline that
   reserves the floor's time (§2.1, §5.2, HIGH).
3. Keys only as optional worker env keys; own caps on the existing `job_account_meters`; spent/retired state in process
   memory behind a port (§3, HIGH for the ports, MED for memory sufficing).
4. Privacy guards stay in front of the router; the router stores and logs no text; which sources and which providers may
   receive text is the owner's (D1–D3, A3) — the recommended default is local-only per source (§4).
5. Classification by status and bounded structured error fields, never page text; every fall to local is an event;
   preflight before a model-using cycle (§5, HIGH).

---

## 1. What VideoContentFactory does, and what is portable

VCF is a single-owner content pipeline (Node 22, `--experimental-strip-types`, SQLite through a synchronous driver).
Its model layer is an `LlmExecutor` function type — `(prompt, tools?, hint?) → Promise<string>`, throwing on failure —
composed from the pieces below.

### 1.1 The pieces

| VCF mechanism (symbol)                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                  | Portable?                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Route** (`Route` type)                                                | A named executor plus capability facts: usable context tokens, image support, and `rotate` (may it be the first route tried)                                                                                                                                                                                                                                                                  | **Yes** — the shape is the router's unit                                                                             |
| **Cascade** (`createChainExecutor`)                                     | Tries routes in order; each failure is recorded as `<route>: <why>` and announced ("X failed, asking Y"); all failed → one error joining every reason                                                                                                                                                                                                                                         | **Yes**                                                                                                              |
| **Fit filter** (`createFittingChainExecutor`, `fitRoutes`)              | Drops routes that cannot take this call (prompt larger than the context window, images on a text-only route) before spending a request; when nothing fits it tries everyone and says so                                                                                                                                                                                                       | **Yes**, minus images                                                                                                |
| **Balancing** (`createBalancedChainExecutor`)                           | A per-instance counter rotates which rotatable route goes first, so successive calls spread over providers; a `rotate: false` route (Gemini, budget reserved) is only a fallback                                                                                                                                                                                                              | **Yes**                                                                                                              |
| **Hybrid floor** (`createHybridExecutor`)                               | Hosted chain first for named calls, the local model behind it; the fall is announced through `onFallback`                                                                                                                                                                                                                                                                                     | **Yes** — this is "local baseline"                                                                                   |
| **OpenAI-compatible leaf** (`createOpenAICompatExecutor`)               | One provider, an ordered list of models; skips models marked spent or retired; a minimum gap between calls to one provider (`COMPAT_MIN_GAP_MS` = 3 s); 429 whose body matches a per-day pattern (`DAILY_LIMIT`: "per day", `TPD`, `RPD`, "daily") → model spent for the day; 404 naming a model or endpoint (`retiredAnswer`) → model retired; an off-schema answer passes to the next model | **Yes**, the classification and pacing; **no**, the body-text handling (§5)                                          |
| **Gemini leaf** (`createGeminiExecutor`)                                | Native Gemini API; 7 s minimum gap (`MIN_CALL_GAP_MS`); 429/503 waited out with backoff 9 s / 25 s (`BUSY_BACKOFF_MS`) before moving on; a 429 naming a `PerDay` quota → spent; safety block (`promptFeedback.blockReason`, `finishReason`) → failure                                                                                                                                         | **Pattern yes**; the native client is replaced by Gemini's OpenAI-compatible endpoint if research confirms it (§2.3) |
| **Own daily caps** (`budgetGuarded`, `providerBudget`, `consumeQuota`)  | Before each call a per-provider counter for the provider's own day (Pacific for Gemini, UTC for the rest) is spent; over the cap → the route is skipped without a request                                                                                                                                                                                                                     | **Yes** — maps onto the CRM's existing account meters (§3)                                                           |
| **Spent ledger** (`SpentStore`, table `llm_spent`)                      | `(model, provider-day)` rows: "this model said no more today"; read by every process                                                                                                                                                                                                                                                                                                          | **Concept yes; storage no** (§3)                                                                                     |
| **Retired ledger** (`RetiredStore`, table `llm_retired`)                | Models that answered "gone"; cleared by the daily model refresh, because a fresh probe is the authority                                                                                                                                                                                                                                                                                       | **Concept yes; storage no** (§3)                                                                                     |
| **Model refresh** (`pickLiveModels`, `classifyModelStatus`)             | Daily probe of the free catalogue; drops 404s and small contexts, keeps alive before busy before unknown; never wipes the list on a bad morning                                                                                                                                                                                                                                               | **Partly** — CRM pins its models (§3.3); the "never wipe on a bad probe" rule is adopted                             |
| **Preflight** (`PREFLIGHT_PROMPT`, `PREFLIGHT_BACKOFF_MS`)              | One trivial call to the local model before a run that needs it; 4 attempts, 10 / 30 / 60 s apart; no answer → the run stops at once, names the address, marks nothing as judged, writes a durable "model unreachable" marker                                                                                                                                                                  | **Yes**                                                                                                              |
| **Wall-clock ceiling** (`boundExecutor`)                                | One logical call is capped, because per-request timeouts sum across a cascade                                                                                                                                                                                                                                                                                                                 | **Yes** — essential                                                                                                  |
| **Dosing** (`DosedCall`, `dosePlanFor`, `callDosed`, `SmallDoseNeeded`) | See 1.2                                                                                                                                                                                                                                                                                                                                                                                       | **Yes, re-scoped**                                                                                                   |

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

| Element          | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config           | `extraction.provider` gains a third value, `router` (additive; `local` and `openrouter` keep their exact behaviour). The `router` block lists **routes** in priority order. Each route has a provider id (`gemini`, `groq`, `openrouter`, `local`), its API key (hosted only), a **pinned** ordered model list, its context window, its structured-output capability (`json_schema` / `json_object` / none), its minimum call gap and `rotate`. The local route is required and always last; the schema refuses a router config without it.                                                                                                                                                 |
| Hosts            | Package constants, as today (no base-URL env); the local route keeps its env URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Route leaf       | One OpenAI-compatible leaf for every provider, built on `sendChatCompletion` widened to return an **internal classified failure** (§5) instead of collapsing everything into `PROVIDER_ERROR`. Gemini uses its OpenAI-compatible endpoint if research confirms strict-schema support there (§2.3); otherwise a small native leaf with the same contract.                                                                                                                                                                                                                                                                                                                                    |
| Router           | `createRouterExtractionAdapter(config, deps)` returns an `ExtractionPort`. Per call: fit filter → rotation among rotatable hosted routes → cascade through hosted routes → local floor. A whole-call deadline caps the sum of per-attempt timeouts (VCF's `boundExecutor` lesson).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Deps (seams)     | `fetchImpl`, `now`, `sleep`, a `RouteStatePort` (§3.2), an optional `OwnCapPort` (§3.1) and `onEvent` (§6.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Public result    | Unchanged: `{ ok: true, data, usage? }` or `{ ok: false, code: InferenceErrorCode }`. Internal codes never leave the package, exactly as `MODEL_UNAVAILABLE` does not today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Input ceiling    | An exported pure helper returns the largest input the configured **local** route accepts; the 5.4b chunker sizes chunks to it, so the floor can always answer (§1.2, dosing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Ports per policy | `InferenceClient` keeps `extraction` (the full chain) and gains `extractionFor({ hostedProviders })`, which returns an `ExtractionPort` over the same router restricted to the listed hosted providers, the floor always included; an empty list is local-only. One port instance per distinct provider set, built once and reused, so pacing and ledger state stay shared. The request type stays unchanged — it carries no source identity — so the **caller** derives the provider set from the source's policy (§4.1, §4.2): `hostedModelsAllowed` false ⇒ empty; true ⇒ every configured provider minus those D2 excludes for that source. Additive; existing consumers see no change. |

The existing `InferenceModelResolverService` (OpenRouter, cheapest model under guardrails, chosen at runtime) stays as
it is for `provider: openrouter`. Under `router` the models are **pinned** (§3.3), not chosen by price.

### 2.2 What the router does not do

It does not strip contacts, check `ai-input`, build the prompt envelope, reserve the shared 20-call cycle budget, chunk
by record boundary, or check URL grounding. Those stay in 5.4a/5.4b **in front of** the port. The router sees
already-stripped, already-permitted text and returns schema-validated data; the result guard still runs after it.

### 2.3 Facts this ADR could not check (no network) — settled by task 5.4c-0

Each is a fact, not a decision; the research task settles it before code.

| Claim                                                                                                                                                                                             | Confidence now                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Gemini exposes an OpenAI-compatible chat-completions endpoint that accepts `response_format` with a JSON schema                                                                                   | MED                                                       |
| Groq accepts strict `json_schema` on the free models it lists, and marks per-day 429s in a structured error field                                                                                 | MED                                                       |
| OpenRouter's `provider.data_collection: "deny"` (already sent by the current adapter) and `zdr` leave few or no `:free` endpoints                                                                 | MED — VCF does not send `deny` and runs on `:free` models |
| The free tiers' current per-minute and per-day limits                                                                                                                                             | LOW — they change monthly                                 |
| Each provider's free-tier data terms: prompt retention, training use, human review. The Gemini API terms for unpaid use are believed to allow use for product improvement, including human review | LOW-MED — **legal-relevant**, §4                          |

---

## 3. Data and secret model

### 3.1 Where each kind of state lives

| State                                                                                                      | Lifetime                                             | Where                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider API keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, existing `OPENROUTER_API_KEY`; local `LOCAL_MODEL_*`) | process                                              | **Optional env keys in the API env schema, read only by the extraction worker.** Absent key → that route does not exist (VCF: "a provider without a key simply does not take part"). Never in the router config schema's persisted form, a manifest, the DB, a build layer, a report, a log or an error message. Never named `CLOUDFLARE_*` (C-21). | Task 5.2 rule; existing `buildInferenceConfig` pattern (a provider block exists only when its key is present)                                                            |
| Per-provider minimum gap (`nextFreeAt`)                                                                    | seconds                                              | **Process memory**, inside the leaf                                                                                                                                                                                                                                                                                                                 | Per-minute limits are per key; one process holds the key                                                                                                                 |
| Rotation counter                                                                                           | process                                              | **Process memory**                                                                                                                                                                                                                                                                                                                                  | VCF's design; losing it on restart costs nothing                                                                                                                         |
| **Own caps** — our calls per provider per provider-day                                                     | provider day                                         | **Postgres, the existing `job_account_meters`** (unit `MODEL_CALL`, window `DAY`, one account key per provider such as `groq:extraction`), reached through the 5.4b `ModelBudgetPort`'s DB adapter, held by the caller; the router asks an `OwnCapPort` the caller injects                                                                          | The meter table already has an atomic spend guard, frozen limits by policy version and an account-key CHECK that refuses anything resembling a credential. No new table. |
| **Spent** — "the provider said: no more today" for a model                                                 | until the provider's reset (UTC; Pacific for Gemini) | **Process memory** behind a `RouteStatePort` (recommended); alternatives below                                                                                                                                                                                                                                                                      |                                                                                                                                                                          |
| **Retired** — "the provider said: this model is gone"                                                      | until the next model-list refresh or process restart | **Process memory** behind the same port                                                                                                                                                                                                                                                                                                             |                                                                                                                                                                          |
| Usage / cost per call                                                                                      | permanent (metering)                                 | Reported through `onEvent` and the caller's meter commit — never stored by the package                                                                                                                                                                                                                                                              | §6.2                                                                                                                                                                     |

**The `OwnCapPort` and the shared 20-call cycle budget are different things.** 5.4b reserves one slot of the
cross-provider cycle budget per extraction; the own cap is a per-provider daily ceiling consulted per **attempt**,
before a request is spent on a provider. A router call that cascades across three providers uses one cycle slot and
one own-cap unit per HTTP request it sends, retries included (unit rules: §5.1).

### 3.2 Spent / retired state: memory, Postgres or Redis

| Option                                                                        | For                                                                                                                                                                                                                                                                                                                      | Against                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Process memory (recommended)**                                              | Smallest; the extractor is one long-lived process, so VCF's reason for persistence (a process per clip) does not apply; the worker holds no DB credential (Task 5.2), so a DB ledger would need a new API-side channel; collection runs a few times a day, so a restart costs at most one wasted request per spent model | Lost on restart; a second worker replica would not share it                                                            |
| Postgres table (`spent` / `retired` rows, reason as a **code**, never a body) | Survives restarts; shared across replicas; consistent with "per-host/account state shared through PostgreSQL" in r5                                                                                                                                                                                                      | A Drizzle migration (critical path: security review); needs a DB credential or an API-side endpoint in the worker path |
| Redis keys with a TTL at the provider's reset                                 | Expiry is free; Redis already runs                                                                                                                                                                                                                                                                                       | A second store for one feature; the worker would need Redis access; nothing else in r5 keeps per-account state there   |

**Recommendation:** memory now, behind a `RouteStatePort` with an in-memory implementation, so a Postgres adapter can
replace it without touching the router if a second replica appears. **Confidence: HIGH** for the port, **MED** that
memory stays sufficient (it depends on the worker topology Task 5.2 settles). Owner decision D4 (A2).

**The restart caveat.** Memory also forgets `AUTH`, `CREDIT` and `FLAG_REJECTED`. One restart costs one refused
request per affected provider; a **crash loop** repeats that cost on every restart and repeats the loud event, which is
noise but also the signal. Two guards keep it bounded without a store: the own-cap unit is released for these codes
(§5.1), so a crash loop does not drain a provider's daily cap; and the worker's restart policy (Task 5.2) must use a
backoff, so a loop cannot turn into a request storm. If a crash loop is ever observed in practice, persisting only
these three provider-level bits (provider, code, until) is the first step of D4's Postgres option.

### 3.4 Transport and key hygiene

- **Hosted hosts** are HTTPS package constants; no env or config can point a hosted route elsewhere.
- **The local URL** comes from env, so it is validated when the config is parsed: `http` or `https` only, no
  credentials in the URL, and a host that is loopback, a private-range address, or a name on an explicit allowlist
  (the local model's container name). Anything else ⇒ the local route is not configured (`NOT_CONFIGURED`), never a
  request to an arbitrary host. Today `boundedRequest` admits plain HTTP only to loopback but HTTPS to any host; the
  stricter local-URL check closes the "local" route as an exfiltration path.
- **Redirects are refused**: every request goes through `boundedRequest`, which already sets `redirect: 'error'`; the
  router adds no transport of its own.
- **Keys travel in headers only** — `Authorization: Bearer` for OpenAI-compatible endpoints, and if a native Gemini
  leaf is ever needed, the API-key header, **never** a `key=` query parameter (URLs end up in logs and errors).
- **Keys never appear in** `onEvent` payloads, thrown or returned values, internal codes or notes; a 5.4c-1/5.4c-2 test
  seeds a marker key and asserts it is absent from every event and result.

### 3.3 Model lists: pinned, never discovered

The plan requires "pinned model/provider/runtime config". VCF instead refreshes its free list daily from the catalogue
and writes it to a file. For the CRM:

- Each route's model list is **pinned in config** (package constants, overridable only by a reviewed code change).
- A model the provider retires is skipped for the process lifetime (§3.2); the router never **adds** a model it found
  in a catalogue.
- Every hosted model retired ⇒ that route is simply absent; the chain still has the floor. A one-line event reports it
  so a human updates the pin (VCF's "repair" becomes a reviewed PR in the CRM).
- VCF's "never wipe the list on a bad probe" carries over as: a route with all models retired is skipped, the config is
  not rewritten.

**Confidence: HIGH** (follows an explicit plan requirement). Owner decision D6 (A2) only for whether a daily catalogue
check may at least **alert** on a dead pin.

---

## 4. Privacy constraints that hold for EVERY route

These hold for the local route too; none of them depends on which route answers.

1. **Before the router, always** (5.4a/5.4b, unchanged): `ai-input=no` ⇒ the port is never called; `unspecified`
   follows an explicit policy argument; contacts stripped (emails, phones, messengers, profile URLs); page text only
   inside the delimited data block of the user message; input capped. The router has no bypass and no second entry.
2. **The router logs and stores no text.** Not the input, not the model output, not a provider error body (it can echo
   the prompt). Events and notes carry route, model, internal code, HTTP status, counts and timings only. This is
   stricter than VCF.
3. **Provider flags where the provider supports them:** OpenRouter `provider.data_collection: "deny"` on every request
   (already sent today) and `zdr` once research confirms the parameter. **Groq and Gemini: no per-request privacy flag
   is assumed** — if 5.4c-0 finds none, their privacy rests entirely on their published terms and on the per-source,
   per-provider decision D2; the ADR does not pretend a flag protects them. A provider that refuses a flag we send, or
   reports that no endpoint satisfies it, yields `FLAG_REJECTED` (§5.1): its route is disabled loudly until restart and
   is never retried without the flag.
4. **Free tiers may log prompts or train on them.** Even after contact stripping, the text is a third party's published
   page. Whether it may go to such a provider is a question of source terms and provider terms, not of code.
5. **Egress** only to the pinned provider hosts (Task 5.2: "egress allowed to the provider host only"), widened per
   added provider.

### 4.1 Which source classes may use hosted routes at all — owner decision D1 (A3)

| Option                                                     | Meaning                                                                                                                                                                                                           | Cost                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **H0 — local only for everyone**                           | Hosted routes off; the router degenerates to the floor                                                                                                                                                            | Slowest; no third-party exposure                                         |
| **H1 — hosted for every source not marked `ai-input=no`**  | Widest acceleration                                                                                                                                                                                               | `unspecified` sources and sources whose terms restrict reuse also go out |
| **H2 — hosted only for allowlisted sources (recommended)** | A per-source policy flag `hostedModelsAllowed`, default **false**; a source is added only after its terms are read (Legal) and its robots `Content-Signal` is not `ai-input=no`; everything else extracts locally | One review per source; the default is the safe one                       |

Recommendation **H2**: the default is "local", matching "everything works on local by default"; acceleration is
granted source by source, and a wrong grant is reversed by one flag.

### 4.2 Providers whose free terms allow training or human review — owner decision D2 (A3)

If research confirms that a provider's free tier may use prompts for training or human review (believed true of the
Gemini API's unpaid tier), the options are: exclude it from extraction; include it only for allowlisted sources whose
terms Legal has cleared for that use; or include it everywhere hosted is allowed. **Recommendation:** include it only
for sources Legal clears for that use, otherwise exclude it — the owner chose Gemini for its capacity. Mechanically the
source policy carries a second field, `trainingProvidersAllowed` (default **false**); the caller removes every provider
that research marks as training- or review-permitting from the `hostedProviders` list it passes to `extractionFor`
unless that field is true (§2.1). The exclusion is therefore per source **and** per provider, enforced before the
router is reached.

### 4.3 OpenRouter `data_collection: deny` vs the free pool — owner decision D3 (A3)

The current adapter already sends `deny`. If research shows `deny` leaves no usable `:free` endpoint, the choice is:
keep `deny` (OpenRouter then only serves paid models under the USD limit of Task 5.2, or none) or drop it for free
models (training allowed on our prompts). **Recommendation:** keep `deny`. The router then falls to Groq / Gemini /
local; losing an accelerator is cheaper than reversing a privacy default.

---

## 5. Failure semantics

### 5.1 Classification (internal codes; one table for every hosted leaf)

Classification uses the HTTP status first, then a **bounded** read (first 2 000 characters, as `isModelUnavailable`
does today) of the provider's **documented structured error fields** — never the page text, never a free-text regex
over a whole body. The body is discarded after classification.

| Internal code    | Signal (to be pinned per provider by 5.4c-0 fixtures)                                                                                                                                                                                                             | Router action                                                                                                                                 | Ledger                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `OK`             | 2xx, envelope valid, output passes Zod after at most one correction retry (`runExtraction`)                                                                                                                                                                       | return                                                                                                                                        | own cap committed                                                                            |
| `BUSY`           | 429 without a per-day marker; 503                                                                                                                                                                                                                                 | wait out a short bounded backoff on the same model (VCF Gemini: 9 s, 25 s) **only if** the call deadline allows; then next model / next route | none                                                                                         |
| `SPENT_DAY`      | 429 with a per-day marker (Groq per-day token/request limits, OpenRouter free-models-per-day, Gemini per-day quota id)                                                                                                                                            | next model / next route                                                                                                                       | model spent until the provider's reset                                                       |
| `CREDIT`         | 402 / insufficient credit or key limit reached (OpenRouter USD limit of Task 5.2)                                                                                                                                                                                 | next route                                                                                                                                    | whole provider spent until the limit's reset; a loud event (limit pause)                     |
| `RETIRED`        | 404 naming the model or an endpoint (`retiredAnswer`; a bare 404 is `TRANSPORT`, so a wrong base URL never retires everything)                                                                                                                                    | next model                                                                                                                                    | model retired for the process                                                                |
| `AUTH`           | 401; a 403 **only** when the provider's documented structured error field marks it as a key or permission error (the field and its values are pinned by 5.4c-0 fixtures)                                                                                          | next route                                                                                                                                    | whole provider disabled for the process; loud event — a key problem is never read as "spent" |
| `FLAG_REJECTED`  | the provider refuses a privacy parameter we send, or reports that no endpoint satisfies it (OpenRouter's "no endpoints matching your data policy" shape — classified **before** `RETIRED`, so it never retires a model); the documented field is pinned by 5.4c-0 | next route; **never** retried without the flag                                                                                                | provider route disabled until restart; loud event once per process                           |
| `REFUSED`        | a safety block or content filter (OpenAI-compatible `finish_reason: content_filter`; Gemini block reason); **any other 403** — an input-triggered moderation refusal must not disable a provider                                                                  | next route; **not** retried on the same provider                                                                                              | none (it is about this input, not the model)                                                 |
| `INVALID_OUTPUT` | non-JSON, fenced, schema-invalid after the one correction retry, over 2 MiB                                                                                                                                                                                       | next model (VCF `answerFits`: an answer that would fail later is passed over now)                                                             | none                                                                                         |
| `TIMEOUT`        | per-attempt timeout                                                                                                                                                                                                                                               | next route                                                                                                                                    | none; own cap unit stays spent (the request may have been billed)                            |
| `TRANSPORT`      | network error, other 4xx/5xx, envelope invalid                                                                                                                                                                                                                    | next route                                                                                                                                    | none                                                                                         |

The literal word "quota" (or any other word) in the **page** never changes a classification: the page is input, not a
provider response. A 5.4b test already pins this at the port boundary; 5.4c repeats it at the leaf.

**Own-cap unit rules** (the `OwnCapPort`, §3.1). One unit is **one HTTP request** to a hosted provider, reserved
immediately before the request is sent. A `BUSY` re-try on the same model and the one correction retry of
`runExtraction` are separate requests and reserve their own units; a unit that cannot be reserved stops that provider
for this call (no request is sent). After the response, by code:

| Code                                                   | The request's unit                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `OK`, `INVALID_OUTPUT`, `REFUSED`, `BUSY`, `SPENT_DAY` | **committed** — the provider counted the request                                                         |
| `TIMEOUT`                                              | **committed as uncertain** (the meter's `uncertain` column) — the request may have been billed           |
| `AUTH`, `CREDIT`, `FLAG_REJECTED`, `RETIRED`           | **released** — refused before any work; these codes disable the model or provider, so they cannot repeat |
| `TRANSPORT` with no response (connection never made)   | **released**                                                                                             |
| `TRANSPORT` with a response                            | **committed**                                                                                            |

The local floor reserves no own-cap unit; the 5.4b cycle slot covers the whole call, floor included.

### 5.2 Pacing and dosing, as one algorithm

Per `extract` call:

1. **Deadline.** Start a whole-call deadline. Reserve **twice** the local route's per-request timeout out of it — the
   floor's first request plus its one correction retry (`runExtraction`) — so the hosted cascade may only use what is
   left and the floor is never starved (VCF summed per-request timeouts until `boundExecutor` existed). The config
   schema refuses a whole-call deadline shorter than that reserve.
2. **Candidates.** Hosted routes that have a key, at least one model not spent / retired, are not disabled, and whose
   context window fits the input (fit filter). The input is already sized to the local window by the caller, so the
   floor always fits.
3. **Rotation.** Among rotatable candidates, the next one in the per-process rotation goes first; the rest keep their
   configured order (VCF `createBalancedChainExecutor`). A non-rotatable route (for example a provider whose allowance is
   reserved for something else) is only a fallback.
4. **Per attempt.** Ask the `OwnCapPort` for one unit of this provider's day; refused ⇒ skip the provider without a
   request. Wait out the provider's minimum gap (VCF: 3 s for OpenAI-compatible providers, 7 s for Gemini). Send with
   the provider's privacy flags and structured-output mode. Classify (§5.1).
5. **Floor.** Every hosted candidate exhausted, filtered or refused ⇒ the local route, with no own cap and no gap, under
   its own reserved time (first request and correction retry). Emit `FELL_TO_LOCAL` with the list of `(route, code)`
   that led there.
6. **Result.** The first `OK` wins. If the floor also fails, the public code is the floor's (`TIMEOUT`,
   `INVALID_OUTPUT` or `PROVIDER_ERROR`); `NOT_CONFIGURED` only when not even the floor is configured.

Own-cap values sit **below** each provider's published free limit, so the provider never reaches its refusal state;
`SPENT_DAY` is then the exception that corrects a wrong cap, not the normal stop. Values: D5.

### 5.3 "Slow, never a silent failure"

- A fall to local is an event, never silence — and an event is only as loud as its consumer, so the consumer is
  **mandatory**, not optional. The API wiring (5.4c-3) must supply an `onEvent` handler; the router config schema has
  no "no events" mode. That handler: (a) increments a durable per-day counter of floor falls and of each hosted
  provider's codes (the existing metering/health surface, no text); (b) raises a durable health flag "hosted routes
  dead" when a cycle ran with at least one hosted provider configured and **none** answered `OK`, cleared by the first
  hosted `OK`; (c) re-emits the flag once per collection cycle while it stays raised, so it cannot be seen once and
  forgotten. A 5.4c-3 test fails the wiring if the handler is missing or swallows `FELL_TO_LOCAL`.
- **Preflight** (VCF pattern, adopted as-is): before a collection cycle that will use model extraction, one trivial call
  to the local route; 4 attempts at 10 / 30 / 60 s gaps. No answer ⇒ the model stage of that cycle does not start, no
  record is marked as extracted or "nothing found", and a durable health signal "model unreachable" is raised (the
  r5 job-sourcing health surface is the candidate home; 5.4c-4 confirms it). The deterministic HTTP/JSON-LD stages
  still run — the VCF rule "a check written for one step must not cost the others".
- A floor failure on a record returns the 5.4b outcome `MODEL_UNAVAILABLE` / `EXTRACTOR_FAILED` with the remaining IDs;
  the record stays due, never closed.
- `AUTH`, `CREDIT` and `FLAG_REJECTED` raise a loud event once per process, not per call.

### 5.4 Small-dose decomposition (conditional)

If MP-03 shows the local model cannot answer the full extraction schema reliably on a chunk that fits its window, the
VCF hand-back pattern applies: the router returns an internal "small dose needed" result instead of sending the full
schema to the local model, and the caller asks the local model a field-group decomposition read by code. **Not built
until MP-03 shows the need** (task 5.4c-6).

---

## 6. Test strategy and MP-03 hooks

### 6.1 Without keys, without network

- **Seam:** the package's existing `fetchImpl` (`FetchLike`), plus injected `now` and `sleep` — the same seams the
  OpenRouter adapter tests use today. No env, no DB.
- **Fixtures per provider**, one file per provider with a case per row of §5.1: status, headers and a minimal body.
  They are **hand-written from each provider's published error format** (5.4c-0 cites the source of each) and contain no
  real prompt, no real page, no key, no account id. Recording live traffic is not part of the test strategy; the
  controlled smoke of Task 5.2 runs once per route by the owner and is never turned into a fixture unscrubbed.
- **Router tests** with scripted leaves: rotation order across successive calls; a non-rotatable route never first;
  fit filter drops a small-context route and keeps the floor; own cap refused ⇒ no request sent (fetch call count 0);
  spent model skipped on the next call; retired model skipped for the process; `AUTH` (401, or a 403 carrying the
  documented key/permission field) disables the provider once and emits once, while a plain 403 is `REFUSED` and
  disables nothing; `FLAG_REJECTED` disables the route and the next request still carries the flag; the own-cap unit
  table of §5.1 per code, retries reserving their own units; the deadline reserve (two local timeouts) guarantees the
  floor and its correction retry run even when every hosted attempt hangs (fake timers); `extractionFor([])` never
  sends a hosted request and a provider absent from the list is never called; an invalid local URL yields
  `NOT_CONFIGURED`;
  floor failure ⇒ the floor's public code; the word "quota" in the input changes nothing; no event payload ever contains
  input or body text (assert on a seeded marker string).
- **Leaf tests** per fixture: classification table, privacy flags present in every request body, structured-output mode
  per capability, no key in any thrown or returned value.
- **Mutation gate** (Stryker, unit scope) on the classification and the router core: 0 survivors, as for 5.4a/5.4b.

### 6.2 MP-03 measurement hooks

`deps.onEvent(event)` receives, per attempt and per call: route, provider, model, internal code, HTTP status, input
characters, total tokens, cost when the provider reports it, attempt latency, whole-call latency, and whether the floor
answered. **No text.** The package does not aggregate; the caller (and the MP-03 harness) does.

The MP-03 harness (a read-only spike, not product code) never calls a leaf or a port directly. It feeds every page
through the same 5.4a/5.4b pipeline production uses — the `ai-input` gate, `stripContacts`, the prompt envelope and the
result guard, i.e. `HtmlStructurer.structure` — with the port chosen by `extractionFor`. Two phases:

- **Local phase (no owner decision needed):** `extractionFor({ hostedProviders: [] })` over the whole labelled set.
- **Hosted phase (gated by D1–D3):** runs only after the owner has answered D1–D3, only on labelled pages from sources
  that D1 would allowlist, and per provider only where D2 would allow it for that source. Each hosted provider is
  measured alone with `extractionFor({ hostedProviders: [<one>] })`; the floor stays in the chain, and the per-attempt
  events separate the hosted provider's own answers from floor answers.

It then computes outside the package: field accuracy against the labels, grounding and invented-URL rate (through the
5.4a result guard), schema-valid rate, latency p50/p95, cost per page, and the floor-fall rate of the full chain.
MP-03 gates enablement, as the plan already says.

---

## 7. Owner decisions and task breakdown

### 7.1 Decisions (classified per `autonomy-levels.md`)

| ID     | Question                                                                                                           | Level                                   | Recommendation                                                                                                                                 | Reversible?                           |
| ------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **D1** | Which sources may send text to hosted models at all                                                                | **A3** (external send)                  | **H2:** per-source allowlist, default local-only; a source joins after Legal reads its terms and robots do not say `ai-input=no`               | The flag is; text already sent is not |
| **D2** | May a provider whose free tier can train on or human-review prompts (believed: Gemini unpaid) receive vacancy text | **A3** (external send, legal)           | Only for sources Legal clears for that use; otherwise exclude it from extraction                                                               | Same                                  |
| **D3** | Keep OpenRouter `data_collection: deny` even if it empties the free pool                                           | **A3** (privacy default, external send) | Keep `deny`                                                                                                                                    | Same                                  |
| **D4** | Spent/retired state: process memory, Postgres table, or Redis                                                      | A2                                      | Memory behind a `RouteStatePort`; Postgres adapter only when a second worker replica appears                                                   | Yes — swap the adapter                |
| **D5** | Own daily caps per provider                                                                                        | A2                                      | 50 % of each provider's published free limit (5.4c-0 supplies the numbers), frozen as `MODEL_CALL` / `DAY` meter limits under a policy version | Yes — a new policy version            |
| **D6** | May a daily catalogue check alert on a dead pinned model                                                           | A2                                      | Yes, alert only; never rewrite the pin                                                                                                         | Yes                                   |
| **D7** | Adoption shape                                                                                                     | A2                                      | Option A, copy-adapt into `@crm/inference` (approving this ADR answers it)                                                                     | Yes — revert the PRs                  |

D1–D3 block **only** sending text to hosted providers: the hosted phase of MP-03 (§6.2) and enabling hosted routes
(5.4c-5). Tasks 5.4c-0 to 5.4c-4 and the local phase of MP-03 proceed without them: the router with the floor alone is
fully useful and is the default. Until D1–D3 are answered no real page goes to a hosted provider for any purpose, the
measurement included.

### 7.2 Tasks

Model tier per `model-routing.md`. Every code task: Coder in its own worktree, code-reviewer, **security-reviewer**
(keys, external send), mutation gate on the changed scope.

| Task                          | Agent · model                                                                         | Depends on           | Scope                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5.4c-0** Provider facts     | `external-research` by Master or a sonnet agent; Legal (opus) for the terms questions | ADR approved         | Settles every row of §2.3 with a primary source and an expiry date; the per-provider error formats that the fixtures copy; Legal's read of each provider's free-tier data terms (feeds D2)                                                                                                                                                                                                                       |
| **5.4c-1** Classified leaf    | coder · sonnet, medium                                                                | 5.4c-0               | Widen the OpenAI-compatible call to return the internal codes of §5.1; privacy flags and structured-output mode per route capability; per-provider fixtures; no router yet; public behaviour of `local` / `openrouter` unchanged (their specs stay green)                                                                                                                                                        |
| **5.4c-2** Router core        | coder · **opus**, high                                                                | 5.4c-1               | Config schema (`router`, local route required), fit filter, rotation, cascade, deadline reserve, floor, `RouteStatePort` (memory), `OwnCapPort` seam, `onEvent`, `extractionFor`, the input-ceiling helper, local-URL validation (§3.4); tests of §6.1                                                                                                                                                           |
| **5.4c-3** API wiring         | coder · **opus**, high                                                                | 5.4c-2, 5.4b         | Optional env keys (`GEMINI_API_KEY`, `GROQ_API_KEY`), `INFERENCE_EXTRACTION_PROVIDER=router`, `buildInferenceConfig` mapping, the `OwnCapPort` adapter over `job_account_meters`, source-policy provider sets for `extractionFor` (§4.1, §4.2), the **mandatory** `onEvent` consumer of §5.3 (durable floor-fall counter, "hosted routes dead" health flag, periodic re-emit); no log line carries a key or text |
| **5.4c-4** Preflight + health | coder · sonnet, medium                                                                | 5.4c-2               | Preflight before a model-using cycle; "model unreachable" health signal; deterministic stages unaffected                                                                                                                                                                                                                                                                                                         |
| **5.4c-5** Hosted enablement  | DevOps · sonnet + human-only (keys, egress)                                           | D1–D3, MP-03, 5.4c-3 | Keys provisioned by the owner; egress allowlist per provider host; source allowlist entries; controlled smoke per route (Task 5.2)                                                                                                                                                                                                                                                                               |
| **5.4c-6** Small dose         | coder · sonnet                                                                        | MP-03 shows the need | §5.4 hand-back and field-group decomposition for the local model                                                                                                                                                                                                                                                                                                                                                 |

MP-03 itself (the labelled-set measurement) stays the plan's M1 spike; 5.4c-2 provides its hooks. Its local phase can
run after 5.4b and 5.4c-2; its hosted phase waits for D1–D3 (§6.2).

---

## Consequences

- **Positive.** The owner's chain arrives behind the unchanged `ExtractionPort`; 5.4b and every caller are untouched.
  Local-only is the working default from the first PR; hosted routes are additive and granted per source. Pacing below
  the providers' limits makes "refused" the exception. Every fall and every failure is an event with a code.
- **Negative.** Logic similar to VCF's is maintained twice, by hand. In-memory ledgers forget on restart (at most one
  wasted request per spent model). Pinned model lists need a human PR when the free catalogue churns — deliberately.
  Three providers mean three sets of terms, keys and egress rules to keep current.
- **Risks.** Provider error formats change silently: a per-day 429 read as `BUSY` costs a few wasted requests, not a
  failure (the cascade moves on), and the fixtures make the drift visible when updated. The privacy flags may shrink the
  free pool to nothing (D3): the floor still answers. The local model may be too weak for the full schema: MP-03
  measures it and 5.4c-6 exists for that case.

## Rollback

| Level                                            | Command / action                                                                                                                                                                                                                                | Expected state                                                                                                    | Verification                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime, instant — the **only** privacy rollback | Set `INFERENCE_EXTRACTION_PROVIDER=local` in the worker env, restart. **Not** `openrouter`: that single-route mode predates the source policy and would send every permitted source's text to OpenRouter, ignoring `hostedModelsAllowed` and D2 | Router not constructed; local-only extraction                                                                     | One extraction event names the `local` route; no request to a hosted host in egress logs |
| Hosted only                                      | Remove a provider's key from the worker env                                                                                                                                                                                                     | That route does not exist; the chain keeps the rest and the floor                                                 | Router events list no attempt for that provider                                          |
| Per source                                       | Clear the source's hosted-model flag                                                                                                                                                                                                            | That source gets `extractionFor({ hostedProviders: [] })` (local only)                                            | Events for that source show the floor only                                               |
| Code                                             | First set `INFERENCE_EXTRACTION_PROVIDER=local` (a reverted env schema no longer accepts `router`), then `git revert` the 5.4c-n PR(s), newest first                                                                                            | `@crm/inference` back to `local` / `openrouter`; no schema migration to undo (memory state, existing meter table) | `pnpm --filter @crm/inference test` and the API inference specs green                    |
| This ADR                                         | Close or revert its PR                                                                                                                                                                                                                          | No decision recorded; 5.4b unaffected                                                                             | `docs/architecture/` no longer lists the file                                            |

## Sources

- Owner decision 2026-10-18 and the Task 5.4 amendment of 2026-11-03: `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`
  (§"Model split — owner decision, 2026-10-18"; Tasks 5.2, 5.4; MP-03, MP-04).
- Task files for 5.4a (guards) and 5.4b (`HtmlStructurer`, `ModelBudgetPort`) — Master's task set of 2026-11-03.
- `@crm/inference`: `ExtractionPort`, `InferenceErrorCode`, `inferenceConfigSchema`, `InferenceClient`,
  `createOpenRouterExtractionAdapter`, `sendChatCompletion` (already sends `data_collection: deny`),
  `isModelUnavailable`, `selectModel`, `boundedRequest`.
- API: `buildInferenceConfig`, `InferenceModelResolverService`, the env schema's optional inference keys,
  `job_account_meters` and its account-meter store (atomic spend guard, `MODEL_CALL` unit, `DAY` window).
- VideoContentFactory (read-only, 2026-11-03): `createChainExecutor`, `createFittingChainExecutor`,
  `createBalancedChainExecutor`, `createHybridExecutor`, `budgetGuarded`, `providerBudget`, `consumeQuota`,
  `createOpenAICompatExecutor` (`DAILY_LIMIT`, `COMPAT_MIN_GAP_MS`), `createGeminiExecutor` (`MIN_CALL_GAP_MS`,
  `BUSY_BACKOFF_MS`), `SpentStore`, `RetiredStore`, `retiredAnswer`, `classifyModelStatus`, `pickLiveModels`, the
  preflight constants, `boundExecutor`, `DosedCall` / `callDosed` / `SmallDoseNeeded`; its knowledge notes on model
  backends and per-call doses; its free-provider guide (card-requiring providers rejected) and provider-balancing plan.
- Unverified external facts are listed in §2.3 with confidence and are settled by 5.4c-0; nothing in this ADR was
  fetched from the network.
