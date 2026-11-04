# ADR: Extraction model router — adopting the VideoContentFactory provider chain into `@crm/inference`

## Status

**Accepted — 2026-11-04.** Proposed 2026-11-03, amended 2026-11-04, and approved by the owner on 2026-11-04. The approval
answers D7 and accepts the recommendations for D4 and D5. Task: r5 Task 5.4c (plan
`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`, Task 5.4 amendment of 2026-11-03 and §"Model split —
owner decision, 2026-10-18").

**Amendment, 2026-11-04 (owner corrections, relayed by Master).** (1) The CRM installs **its own** lightweight local
model; VCF's model and hardware are not adopted, only the strategy that keeps a small model answering (§8). (2) Small
dose is **unconditional**: built as part of the local route; MP-03 tunes it, it does not gate it (§5.4). (3) Owner
decisions D1–D3 are recorded (§4.1–§4.3): hosted routes for every source the model can serve; providers whose free
tier may train on or human-review prompts are accepted; OpenRouter is not in the first router version.

**Provider-facts amendment, 2026-11-04 (A1, by the architect; source:
`docs/architecture/2026-11-04-extraction-provider-facts.md`).** No owner decision changes.

1. Gemini's listing has no free-tier field: Gemini candidates are filtered by a checked-in family pattern (§3.4).
2. A free key on a model it cannot call gets 429 with limit 0 (forum-sourced): a Gemini model answering a probe with a
   non-per-day 429 on three consecutive probe days is dropped as `dead`; one redacted call in the 5.4c-5 smoke confirms it (§3.4).
3. Retired Gemini models are re-routed, not refused: a 2xx whose response `model` names another version or variant retires
   the requested id; UNVERIFIED that the compat endpoint reports it, else pinned ids and the daily refresh are the repair (§5.1).
4. Groq has no structured per-day field: `SPENT_DAY` comes from the documented `x-ratelimit-remaining-requests: 0`; a
   per-day token 429 has no marker and is `BUSY` with one wait and a cool-down, never a loop; own caps stay the guard (§5.1).
5. Only four Groq models take strict `json_schema`, two of them preview: the Groq pattern and fallback list are the two
   production `gpt-oss` models (§3.4).
6. Strict schema rules (every property required, `additionalProperties: false`, optional as a union with `null`) are
   rendered for every route by 5.4c-1.
7. Ollama's window is server-wide, default 4096: 5.4c-8 sets it, and the input ceiling takes the configured window (§2.1, §8.4).
8. Groq's terms forbid training on inputs: §4 item 4 is corrected for Groq; Gemini's text and D2 are unchanged.
9. Groq's zero data retention is an organisation setting, an optional owner action, not a request flag (§4 item 3).
10. Gemini's 403 has four documented causes, all about the key or project: a 403 carrying the provider's documented error
    envelope is `AUTH`, never `REFUSED`; any other 403 is `TRANSPORT` (§5.1).
11. An error body is parsed whole (capped at 2 MiB), not cut at 2 000 characters, which broke real Google errors; over the
    cap means no marker; each rule reads one fixed field (Gemini 429: `error.details[]`; 403: `error.status`, never `details`); `RETIRED` matches
    the requested id as a whole token (§5.1).

## Context

The owner decided on 2026-10-18 that vacancy extraction runs on Gemini, Groq, OpenRouter and the local model: a
router over free hosted models with prompt dosing, so that no provider starts refusing, over a local baseline.
Everything must work on the local model alone; the free hosted models are an accelerator. Generation (Cloudflare
Workers AI) is out of scope for r5. **Owner decision D3 (2026-11-04) narrows that list for the first router version:
Gemini, Groq and the local floor.** OpenRouter can be added later (§3.5).

The owner already runs such a chain in his own project, **VideoContentFactory** (VCF; read-only for this ADR, read at
its state of 2026-11-03). Today `@crm/inference` offers one extraction route, chosen by `INFERENCE_EXTRACTION_PROVIDER`
(`local` | `openrouter`), behind `ExtractionPort` (`extract({ input, schema, instruction }) → { ok, data, usage? } |
{ ok: false, code: InferenceErrorCode }`). The HTML path (Tasks 5.4a/5.4b) composes privacy guards and a shared
budget around that port. The router slots in **behind the same port** and its result type does not change, but 5.4b does:
`ExtractionRequest` gains `smallDose` and `signal`, and `ModelStructurer` passes the real schema, derives its timeout and
hold from the router's ceiling, and threads the abort (§5.4, §5.5).

Forces:

- **Privacy.** Page text leaves the host. Contact stripping and the `ai-input=no` gate already run before the port
  (5.4a/5.4b); free hosted tiers may log or train on prompts, which the owner has accepted (§4.1, §4.2).
- **A small model fails unless it is dosed.** The local floor is a lightweight model on a CPU host shared with the CRM
  (§8.2). Sent a large structured request, such a model comes back empty or wrong on every prompt; asked what it can
  answer, it answers.
- **Free tiers churn.** Models are renamed, retired, rate-limited per minute and capped per day; the error texts
  differ per provider.
- **"Slow, never a silent failure."** A chain that runs dry must fall to local and say so; a local failure must stop
  loudly, not report "nothing extracted".
- **Repo invariants.** Secrets only in worker-read optional env keys (never config, DB, logs, reports, build layers;
  never `CLOUDFLARE_*`); exhaustion classified by documented status/error codes, never by page text; Zod v4
  validation of every model output; deterministic tests without keys or network.

## Decision (summary)

1. **Copy-adapt** VCF's routing patterns into `@crm/inference` behind `ExtractionPort`, whose result is unchanged (§2, HIGH).
2. A third extraction provider value, `router`: hosted routes from a checked-in provider allowlist (Gemini, Groq) in
   front of a **required** local floor; rotation, fit filter, own caps, spent/retired skipping, a whole-call deadline
   that reserves the floor's time (§2.1, §5.2, HIGH).
3. Keys only as optional worker env keys; own caps, spent/retired/provider state in a worker state file behind a port
   (§3.2, HIGH for the port, MED for the file).
4. **Self-healing model lists** (owner decision D6): request-time retirement, a daily refresh of each provider's
   managed list from its listing, with probes on a fixed synthetic prompt where the provider is probed, a pinned fallback list, a weekly
   `MODEL_LIST_STALE` check — adopted from VCF (§3.4, HIGH).
5. Privacy guards stay in front of the router, whose only entry is authenticated and data-only (§2.4); the router stores and logs no text. Owner decisions D1–D3 (2026-11-04):
   every source the model can serve may use the hosted routes, training-permitting free tiers included, and the
   accepted risk is stated once in §4.1. `ai-input=no`, the `unspecified` policy and contact stripping are not weakened
   (§4, decided).
6. Classification by status and bounded structured error fields, never page text; every fall to local is an event;
   preflight before a model-using cycle (§5, HIGH).
7. **The CRM's own local model:** a lightweight text model chosen by criteria and picked by MP-04, in its own pinned
   container, installed on production only by the owner; if none passes, the owner chooses another host or deterministic
   HTML with model extraction disabled (§8, HIGH for the criteria, **no model named**).
8. **The local route is dosed, always:** hand-back and field-group small dose, refusal of a prompt that does not fit,
   preflight and an absolute ceiling with a real abort are mandatory behaviour, not options (§5.4, §5.5, §8.4, HIGH for the pattern, MED for
   the field groups until MP-03 tunes them).

---

## 1. What VideoContentFactory does, and what is portable

VCF is a single-owner content pipeline (Node 22, `--experimental-strip-types`, SQLite through a synchronous driver).
Its model layer is an `LlmExecutor` function type — `(prompt, tools?, hint?) → Promise<string>`, throwing on failure —
composed from the pieces below.

### 1.1 The pieces

| VCF mechanism (symbol)                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                  | Portable?                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Route** (`Route` type)                                                | A named executor plus capability facts: usable context tokens, image support, and `rotate` (may it be the first route tried)                                                                                                                                                                                                                                                                  | **Yes** — the shape is the router's unit                                                                                 |
| **Cascade** (`createChainExecutor`)                                     | Tries routes in order; each failure is recorded as `<route>: <why>` and announced ("X failed, asking Y"); all failed → one error joining every reason                                                                                                                                                                                                                                         | **Yes**                                                                                                                  |
| **Fit filter** (`createFittingChainExecutor`, `fitRoutes`)              | Drops routes that cannot take this call (prompt larger than the context window, images on a text-only route) before spending a request; when nothing fits it tries everyone and says so                                                                                                                                                                                                       | **Yes**, minus images                                                                                                    |
| **Balancing** (`createBalancedChainExecutor`)                           | A per-instance counter rotates which rotatable route goes first, so successive calls spread over providers; a `rotate: false` route (Gemini, budget reserved) is only a fallback                                                                                                                                                                                                              | **Yes**                                                                                                                  |
| **Hybrid floor** (`createHybridExecutor`)                               | Hosted chain first for named calls, the local model behind it; the fall is announced through `onFallback`                                                                                                                                                                                                                                                                                     | **Yes** — this is "local baseline"                                                                                       |
| **OpenAI-compatible leaf** (`createOpenAICompatExecutor`)               | One provider, an ordered list of models; skips models marked spent or retired; a minimum gap between calls to one provider (`COMPAT_MIN_GAP_MS` = 3 s); 429 whose body matches a per-day pattern (`DAILY_LIMIT`: "per day", `TPD`, `RPD`, "daily") → model spent for the day; 404 naming a model or endpoint (`retiredAnswer`) → model retired; an off-schema answer passes to the next model | **Yes**, the classification and pacing; **no**, the body-text handling (§5)                                              |
| **Gemini leaf** (`createGeminiExecutor`)                                | Native Gemini API; 7 s minimum gap (`MIN_CALL_GAP_MS`); 429/503 waited out with backoff 9 s / 25 s (`BUSY_BACKOFF_MS`) before moving on; a 429 naming a `PerDay` quota → spent; safety block (`promptFeedback.blockReason`, `finishReason`) → failure                                                                                                                                         | **Pattern yes**; the native client is replaced by Gemini's OpenAI-compatible endpoint if research confirms it (§2.3)     |
| **Own daily caps** (`budgetGuarded`, `providerBudget`, `consumeQuota`)  | Before each call a per-provider counter for the provider's own day (Pacific for Gemini, UTC for the rest) is spent; over the cap → the route is skipped without a request                                                                                                                                                                                                                     | **Yes** — maps onto the CRM's existing account meters (§3)                                                               |
| **Spent ledger** (`SpentStore`, table `llm_spent`)                      | `(model, provider-day)` rows: "this model said no more today"; read by every process                                                                                                                                                                                                                                                                                                          | **Concept yes; storage no** (§3)                                                                                         |
| **Retired ledger** (`RetiredStore`, table `llm_retired`)                | Models that answered "gone"; cleared by the daily model refresh, because a fresh probe is the authority                                                                                                                                                                                                                                                                                       | **Concept yes; storage no** (§3)                                                                                         |
| **Model refresh** (`pickLiveModels`, `classifyModelStatus`)             | Daily probe of the free catalogue; drops 404s and small contexts, keeps alive before busy before unknown; never wipes the list on a bad morning                                                                                                                                                                                                                                               | **Partly** — **Yes** (owner decision D6) — adopted with a pinned fallback, a provider allowlist and id validation (§3.4) |
| **Preflight** (`PREFLIGHT_PROMPT`, `PREFLIGHT_BACKOFF_MS`)              | One trivial call to the local model before a run that needs it; 4 attempts, 10 / 30 / 60 s apart; no answer → the run stops at once, names the address, marks nothing as judged, writes a durable "model unreachable" marker                                                                                                                                                                  | **Yes**                                                                                                                  |
| **Wall-clock ceiling** (`boundExecutor`)                                | One logical call is capped, because per-request timeouts sum across a cascade                                                                                                                                                                                                                                                                                                                 | **Yes** — essential                                                                                                      |
| **Dosing** (`DosedCall`, `dosePlanFor`, `callDosed`, `SmallDoseNeeded`) | See 1.2                                                                                                                                                                                                                                                                                                                                                                                       | **Yes, re-scoped**                                                                                                       |

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
- **Dosing** — the input **and the schema** sized per route: every input the caller sends fits the **local** route's
  window, a route that cannot take it is dropped by the fit filter and never fed a truncated prompt, and the local route
  is asked in field groups rather than the full schema (§5.4).

### 1.3 What is not portable

- **Storage.** SQLite with a synchronous driver; the CRM uses PostgreSQL/Drizzle, and the extraction worker holds no DB
  credential (Task 5.2).
- **Why VCF persists the ledgers.** VCF runs every clip in its own short process, so in-memory state would be lost
  between calls. The CRM extractor is one long-lived process; that reason does not carry over (§3.2).
- **Provider error bodies stored and logged.** VCF writes up to 200–300 characters of the provider's error body into
  its ledgers and notes. A provider error body can echo the prompt; in the CRM it is never persisted or logged — only a
  classified code (§5).
- **Body-text classification by broad regex.** VCF decides "spent for the day" by matching the body against
  `DAILY_LIMIT`. The CRM classifies by status code plus documented structured error fields of the parsed body (§5).
- **`response_format: json_object` with a retry without it on a 400.** The CRM plan requires strict `json_schema` where
  the route supports it, local Zod validation always, and no code-fence fallback.
- **The Claude CLI executor, images, the WSL gateway resolution, Ollama's native API, the env-supplied model lists and
  the providers that need a card** (VCF already rejects Cerebras and Together; the CRM does not add them either).
- **VCF's local models and its GPU** (§8.1).

---

## 2. How to adopt it: three options

All three keep `ExtractionPort`'s result unchanged and extend its request (`smallDose`, `signal`; §5.4, §5.5).

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

### Option B — a shared package used by both projects

Rejected, **HIGH**: runtime mode, storage, error contract and privacy rules all differ, the repo has no publish channel, and
a CRM release would depend on a personal project's.

### Option C — call VCF's executor across processes

Rejected, **HIGH**: CRM production would depend on a personal project and the owner's machine, and vacancy text would cross
into a process that logs provider bodies, outside every CRM gate.

**Decision (proposed): Option A.**

### 2.1 Shape inside `@crm/inference`

| Element       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config        | `extraction.provider` gains a third value, `router` (additive; `local` and `openrouter` keep their exact behaviour, and `openrouter` is not a router route, D3). The `router` block lists **routes** in priority order. Each route has a provider id (`gemini`, `groq`, `local`), its API key (hosted only), a **pinned fallback** model list (the managed list of §3.4 supersedes it while valid), its context window, its structured-output capability (`json_schema` / `json_object` / none), its minimum call gap and `rotate`. The local route is required and always last; the schema refuses a router config without it. Both hosted routes rotate by default: VCF's `rotate: false` on Gemini reserved its allowance for other work, and in the CRM extraction is the only consumer. |
| Hosts         | Package constants, as today (no base-URL env); the local route keeps its env URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Route leaf    | One OpenAI-compatible leaf for every provider, built on `sendChatCompletion` widened to return an **internal classified failure** (§5) instead of collapsing everything into `PROVIDER_ERROR`. Gemini uses its OpenAI-compatible endpoint, which takes `json_schema` with `strict: true` (5.4c-0; the endpoint is in beta).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Router        | `createRouterExtractionAdapter(config, deps)` returns an `ExtractionPort`. Per call: fit filter → rotation among rotatable hosted routes → cascade through hosted routes (full shape) → hand-back → local floor (small dose, §5.4). A whole-call deadline caps the sum of per-attempt timeouts (VCF's `boundExecutor` lesson).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Deps (seams)  | `fetchImpl`, `now`, `sleep`, a `RouteStatePort` (§3.2), an `OwnCapPort` (§3.1) and `onEvent` (§6.2). As with a missing `onEvent` (§5.3), a config with a hosted route and no `OwnCapPort` is refused: an uncapped hosted route is not a state the router can be built in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Public result | The type stays `{ ok: true, data, usage? }` or `{ ok: false, code: InferenceErrorCode }`, plus an optional `usage` on the failure branch, so a failed floor call is still charged to the cycle's limit (§5.5). Internal codes never leave the package, exactly as `MODEL_UNAVAILABLE` does not today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Process       | **The router runs only in the extraction worker**, which holds the hosted keys, `ROUTER_LOCAL_MODEL_URL` and the state files, reaches the runtime, and holds **no DB credential** (Task 5.2). It is not the plan's collection worker, which has a DB role, runs `HtmlProvider` and `ModelStructurer`, and keeps gate, strip, budget, result guard and persistence. The one way in is the entry of §2.4. The API process never builds the router.                                                                                                                                                                                                                                                                                                                                             |
| Input ceiling | An exported pure helper returns the largest page text the configured **local** route accepts, computed from that route's **configured** window — never a runtime default (Ollama's is 4096 tokens, less than one detail page) — reserving the instruction, the longest group's answer and the correction (§5.1). Its consumer is `buildExtractionPrompt`, which takes it as a limit below `MAX_MODEL_INPUT_CHARS`, cuts the page text itself and reports `truncated`. No chunker exists on main and none is added: each record stays one chunk and one port call. Hosted routes receive the same cut text, so evidence is one text per record.                                                                                                                                               |
| One port      | `InferenceClient` keeps a single `extraction` port over the whole chain. There is no per-source provider set: under D1 and D2 every call that reaches the port may use every configured route. The gate in front of the port decides whether a call happens at all (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The existing `InferenceModelResolverService` (OpenRouter, cheapest model under guardrails, chosen at runtime) stays as
it is for `provider: openrouter`. Under `router` the models come from each provider's self-healing managed list with a
pinned fallback (§3.4), not chosen by price.

### 2.2 What the router does not do

It does not strip contacts, check `ai-input`, build the prompt envelope, reserve the shared 20-call cycle budget, chunk
by record boundary, or check URL grounding. Those stay in 5.4a/5.4b **in front of** the port. The router sees
already-stripped, already-permitted text and returns schema-validated data; the result guard still runs after it.

### 2.3 Provider facts: settled by 5.4c-0, with follow-ups

5.4c-0 settled the open facts from primary sources in `docs/architecture/2026-11-04-extraction-provider-facts.md` (limits
and API behaviour expire 2026-12-04, terms and licences 2027-02-02). What it could not settle is below. Every rule in this
ADR is safe without these answers; an answer replaces a hand-written fixture, and one that lands after 5.4c-1 is applied
then.

| Item                                                                                                             | Settled by                                                               | Owner action |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| Gemini compat error body: Google envelope with `QuotaFailure`, or OpenAI-style                                   | one redacted error in the 5.4c-5 smoke                                   | yes (key)    |
| A free key on a not-free Gemini id (assumed 429, limit 0)                                                        | one redacted call, same smoke                                            | yes          |
| Gemini gone-model answer (404 or re-route), and the response `model` of both `gemini-2.0-flash` and a healthy id | one call to each, same smoke                                             | yes          |
| Gemini compat listing id form; whether compat ignores the same schema keywords as native                         | one listing call; same smoke                                             | yes          |
| Groq per-day token 429 marker; gone-model status and body (`llama-3.1-8b-instant`); `error.type` values          | same smoke, redacted                                                     | yes          |
| Gemini free-tier RPM, TPM and RPD per model (D5's numbers, `PROBE_CAP`)                                          | the owner reads AI Studio's rate-limit page (login)                      | yes          |
| Groq free-plan limits                                                                                            | the owner reads the free organisation's limits page                      | yes          |
| Groq's daily reset time (config assumes midnight UTC, §5.1)                                                      | the owner reads the same limits page                                     | yes          |
| Whether Groq's no-training clause covers free-plan use                                                           | Groq support or Legal                                                    | yes (asks)   |
| `avx512f` on the VPS (vLLM on CPU)                                                                               | `grep -o avx512f /proc/cpuinfo \| head -1`, Master over the D9 ssh alias | no           |
| Ollama's `response_format` type and enforcement, prompt logging, disconnect; llama.cpp disconnect                | MP-04 on the pinned version                                              | no           |
| `gemma-*` id form; licences at the pinned card                                                                   | the listing; MP-04                                                       | no           |

### 2.4 The extraction worker's entry

The split puts a network entry in front of the router, with hosted keys and egress behind it and the gates on the far side.
Designed twice (SR-H-46):

| Shape                                                 | Verdict                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** Dedicated network, secret, data-only request  | **Adopted.** It stops everything short of code execution in the collection worker: an SSRF or a compromised renderer has neither the route nor the secret                                                                                                                         |
| **(b)** The invariants inside the extraction worker   | **Stripping adopted, as one step on top of (a).** The gate is not: the `ai-input` signal comes from robots fetched by the collection side, and this worker has neither the DB nor the egress to read it again. A signal supplied by the caller proves nothing against that caller |
| **(c)** No split: the router in the collection worker | Rejected: a process parsing hostile pages would hold keys and a DB role together, against Task 5.2. A queue in place of an endpoint has the same trust and more infrastructure                                                                                                    |

**Confidence: HIGH.** The entry:

- **Network.** A dedicated internal network holding only the two workers, separate from the runtime network, with no published
  port. The collection worker never joins the runtime network; the browser container never joins this one.
- **Authentication.** Every call carries `EXTRACTION_WORKER_SECRET`, held only by these two workers and compared in constant
  time. A missing or wrong secret is refused and reaches no route; a worker without one does not start. Both workers read
  their own owner-created `0600` env files, never `.env.production`: the API loads that file through `env_file`, and the
  `write-env` deploy job writes it.
- **Data only, strict schema.** `extract` takes the bounded delimited input from `buildExtractionPrompt` and a table version;
  `preflight` takes nothing and runs the fixed call of §5.3. A foreign field is refused, and a version mismatch too (two images
  mid-deploy). No URL, host, provider, model, key, instruction or schema crosses: `EXTRACTION_SYSTEM_PROMPT`,
  `modelReplySchema`, the field-group table and `merge` are one checked-in module both workers import, and the extraction
  worker builds the `ExtractionRequest` from its copy. So this is no general prompt relay in authority, though not in content:
  a secret holder can place a question in `input` and read the answer from a schema field, bounded by the own caps.
- **Second strip.** The extraction worker passes the input through `stripContacts` before any route. On an honest call that
  changes nothing; a non-zero count raises an event, with no text.
- **Reply.** Answer, `usage`, events and health flags (§5.3), recorded on the DB side. The collection side keeps treating the
  reply as untrusted, and the guard stays there. Closing the connection is the abort. The adapter maps any refused or failed
  call to `PROVIDER_ERROR`, which §5.4 keeps owed.

**If the collection worker itself is compromised (code execution), this much holds and this much does not:**

- **Holds:** no route receives text that `stripContacts` would change. The hosted keys stay unreadable, and the caller chooses
  no host, model or instruction. Use is bounded by the own caps, and cost by free tiers with no billing (§3.1).
- **Does not hold:** `ai-input=no`. That code holds those pages' text and can submit it as input, up to the own caps. The same
  goes for what the worker's DB role can read beyond pages: users, team memberships and legacy résumé inputs. Nor
  does stripping stop a contact deliberately obfuscated past its patterns. This entry cannot fix either: that process already
  has the text and the outbound web access it fetches with (plan Task 2.2), so it needs no router to leak. Its protection is
  that worker's own hardening and egress proxy.

---

## 3. Data and secret model

### 3.1 Where each kind of state lives

| State                                                                                                                                                                                                                 | Lifetime                                                                      | Where                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider API keys (`GEMINI_API_KEY`, `GROQ_API_KEY`; `LOCAL_MODEL_KEY`, `LOCAL_MODEL_NAME`, and a new `ROUTER_LOCAL_MODEL_URL` (§3.3); the router never reads `LOCAL_MODEL_URL` or the existing `OPENROUTER_API_KEY`) | process                                                                       | **Optional env keys in the API env schema, read only by the extraction worker.** Absent key → that route does not exist (VCF: "a provider without a key simply does not take part"). Never in the router config schema's persisted form, a manifest, the DB, a build layer, a report, a log or an error message. Never named `CLOUDFLARE_*` (C-21). | Task 5.2 rule; existing `buildInferenceConfig` pattern (a provider block exists only when its key is present)                                                                                                                                                                                                                                    |
| Per-provider minimum gap (`nextFreeAt`)                                                                                                                                                                               | seconds                                                                       | **Process memory**, inside the leaf                                                                                                                                                                                                                                                                                                                 | Per-minute limits are per key; one process holds the key                                                                                                                                                                                                                                                                                         |
| Rotation counter                                                                                                                                                                                                      | process                                                                       | **Process memory**                                                                                                                                                                                                                                                                                                                                  | VCF's design; losing it on restart costs nothing                                                                                                                                                                                                                                                                                                 |
| **Own caps** — our calls per provider per provider-day                                                                                                                                                                | provider day                                                                  | **Worker state file**, through an `OwnCapPort` adapter over the `RouteStatePort`; limits frozen in config under a policy version                                                                                                                                                                                                                    | The worker has no DB credential, so `job_account_meters` is out of its reach; one writer needs no atomic DB guard. A lost file resets the count, and the provider's own limit (`SPENT_DAY`) is then the backstop. That is a hard stop because **both keys are on free tiers with no billing** (5.4c-5): the provider refuses, it does not charge |
| **Spent** — "the provider said: no more today" for a model                                                                                                                                                            | until the provider's reset (UTC; Pacific for Gemini)                          | **Worker state file**, write-through behind a `RouteStatePort` (§3.2)                                                                                                                                                                                                                                                                               | Survives restarts without a DB credential                                                                                                                                                                                                                                                                                                        |
| **Retired** — "the provider said: this model is gone" (`retiredAnswer`)                                                                                                                                               | until the next successful daily refresh (§3.4) — **not** cleared by a restart | **Worker state file**, same port                                                                                                                                                                                                                                                                                                                    | Owner decision D6: retirement must hold across restarts until the fresh probe, the authority, clears it                                                                                                                                                                                                                                          |
| **Provider-level bits** — `AUTH`, `CREDIT`                                                                                                                                                                            | `CREDIT` until the limit's reset; `AUTH` until the proof of §3.2              | **Worker state file**, same port                                                                                                                                                                                                                                                                                                                    | REV-L-10: a restart or a crash loop no longer re-spends a refused request                                                                                                                                                                                                                                                                        |
| **Managed model list** — the self-healed ordered model ids per provider                                                                                                                                               | until the next successful refresh of that provider                            | **Worker managed-list file** (§3.4), read with the pinned list as fallback                                                                                                                                                                                                                                                                          | Owner decision D6                                                                                                                                                                                                                                                                                                                                |
| Usage / cost per call                                                                                                                                                                                                 | permanent (metering)                                                          | Returned with the answer and committed by the caller's budget — never stored by the package                                                                                                                                                                                                                                                         | §6.2                                                                                                                                                                                                                                                                                                                                             |

**The `OwnCapPort` and the shared 20-call cycle budget are different things.** 5.4b reserves one slot of the
cross-provider cycle budget per extraction; the own cap is a per-provider daily ceiling consulted per **attempt**,
before a request is spent on a provider. A router call that cascades across both hosted providers uses one cycle slot
and one own-cap unit per HTTP request it sends, retries included (unit rules: §5.1). A small dose stays inside that one
slot, however many field groups it asks (§5.4).

### 3.2 Route state (spent, retired, provider bits): where it persists

D6 (owner, below) requires retirement to hold across restarts until the daily refresh clears it, so plain process
memory — the first edition's recommendation — no longer suffices.

| Option                                                            | For                                                                                                                                                                                                                                                                       | Against                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Worker state file, write-through (recommended)**                | Survives restarts; needs no DB credential (the worker has none, Task 5.2) and no new service; one small JSON document on the worker's persistent data volume, beside the managed-list file (§3.4); the in-memory map stays the read path, every change is written through | Not shared by a second worker replica; needs a persistent volume (task 5.4c-8 provisions it)          |
| Postgres table (rows with the reason as a **code**, never a body) | Shared across replicas; consistent with "per-host/account state shared through PostgreSQL" in r5                                                                                                                                                                          | A Drizzle migration (critical path); needs a DB credential or an API-side endpoint in the worker path |
| Redis keys with a TTL at the provider's reset                     | Expiry is free; Redis already runs                                                                                                                                                                                                                                        | A second store for one feature; the worker would need Redis access                                    |
| Process memory only                                               | Smallest                                                                                                                                                                                                                                                                  | **Fails D6**: a restart forgets retirements before the refresh has replaced the list                  |

**Recommendation:** the worker state file behind the `RouteStatePort`, so a Postgres adapter can replace it without
touching the router if a second replica appears. Owner decision D4 (A2), narrowed by D6 to "which persistent store".
**Confidence: HIGH** for the port, **MED** for the file (depends on the volume task 5.4c-8 provisions).

**State-file rules** (the same for the managed-list file):

- **Data, not code.** JSON validated by a Zod schema on every read; never imported, evaluated or used as a path. An
  unreadable, invalid or oversized file is treated as empty state (for the managed list: the pinned fallback), and the
  event says so, an own-cap reset included.
- **Written before sending.** A failed write-through of an own-cap unit refuses that request, exactly as a refused unit does
  (§5.2 step 4). Any other failed write stays in memory and raises the event.
- **Schema, strictly bounded** (SR-M-6):
  - every entry has **structured fields** `provider` and `model` — never one joined `provider:model` string, because
    a model id may itself contain `:`; log lines may print the pair, the file never parses it back;
  - `provider` is an enum of the checked-in provider allowlist; `model` must pass the **same** model-id validation as
    the refresh (§3.4), so a hand-edited or corrupted file cannot smuggle in an id the refresh would have refused;
  - `code` is an enum of the internal codes, `status` an integer 100–599, timestamps ISO strings, the provider day a
    `YYYY-MM-DD` string;
  - an **entry cap** per file (spent and retired: a few hundred; the managed list: `TARGET` per provider; probation
    records: `TARGET` per provider) and a byte ceiling checked **before** parsing (tens of KiB); over either ⇒ treated
    as invalid;
  - **probation records** (SR-M-9) live in the **route-state file**, not in the managed-list file: per new model,
    `provider`, `model`, `aliveStreak` (an integer, schema-bounded to `[0, N]`, clamped on write) and `lastProbeDay`
    (the UTC day of the last probe that counted). The managed-list file stores only the ordered ids; it carries **no**
    promotion flag that the reader would trust (§3.4);
  - **busy records** (§3.4 verdicts) live in the same file, per probed Gemini model, listed or new: `provider`, `model`,
    `busyDays` (an integer, schema-bounded to `[0, 3]`, clamped on write) and `lastProbeDay`;
  - **provider records**: the persisted `AUTH` / `CREDIT` bits and `lastStartupRefreshAt` (SR-M-11), and the own-cap count per
    provider day, written through **before** the request is sent.
- **Single writer.** Only the extraction worker writes, and inside it one serialised writer (a promise queue) owns each
  file: every change is applied to the in-memory state and the whole document is written from it, so two concurrent
  changes cannot lose each other. A second worker replica is out of scope for files (D4: Postgres then).
- **Durable atomic replace**: write a temporary file in the same directory with mode `0600`, `fsync` it, rename it over
  the old file, then `fsync` the directory; a crash at any point leaves either the old or the new file, never a torn
  one. The files live on the worker's own volume, never on a shared or world-readable path.
- **Contents**: the fields above. **Never** a provider error body. VCF stores up to 300 characters of the body as the
  reason; the CRM stores the classified code instead, because a provider body can echo the prompt (§4 item 2). This is
  the one deliberate departure from the VCF `RetiredStore` behaviour (`isRetired` / `markRetired` / `list` / `clear`
  are otherwise adopted).
- **Pruning**: spent entries of past provider days are dropped on load.

**The restart caveat, reduced (REV-L-10, SR-M-7, SR-M-11).** `AUTH` and `CREDIT` persist, so a restart or a crash loop
does not re-send a refused request. What clears each bit is narrow, because the wrong proof would re-open a refused
route:

| Bit      | Cleared only by                                                                                                                                                                  | Not cleared by                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AUTH`   | a **keyed chat probe** to that provider that returns 2xx (the fixed probe prompt, the shared request builder) — this applies to Groq too, which the daily refresh does not probe | a successful listing fetch: a listing that answers proves nothing about a chat call |
| `CREDIT` | the limit's reset                                                                                                                                                                | a refresh                                                                           |

**Start-up refresh.** At worker start, every provider carrying a persisted `AUTH` bit gets an on-demand refresh of that
provider alone, under the constraints of the daily one, so a rotated key is picked up at the next start rather than up to
a day later. It differs from the daily job in one way: it **sends exactly one fixed-prompt chat probe** to that provider,
Groq included, because that probe is the only proof that clears the bit. It is **rate-limited by a persisted
per-provider `lastStartupRefreshAt`**: if the last start-up refresh of that provider is less than **1 hour** old, the
start skips it, so a crash loop sends at most one start-up refresh per provider per hour regardless of the restart
policy. The own-cap unit is still released for these codes (§5.1), and start-up probes count against the own caps like
any probe.

### 3.3 Transport and key hygiene

- **Hosted hosts** are HTTPS package constants; no env or config can point a hosted route elsewhere.
- **The local URL** comes from a new env key, `ROUTER_LOCAL_MODEL_URL`, validated when the config is parsed: no
  credentials in the URL; plain `http` **only** to loopback or the runtime's container name, a **package constant**, not
  env; `https` to loopback, that name, or a private address (RFC 1918, fc00::/7). Refused: link-local (169.254.0.0/16, which
  holds cloud metadata, and fe80::/10), IPv4-mapped forms, any other name or address. Anything refused ⇒ **the whole router
  is `NOT_CONFIGURED`** and no hosted route runs (§8.5), never a request to an arbitrary host.
- **Plain HTTP stays narrow.** Today two gates refuse `http://<container>`: `isUrlAllowed` in `boundedRequest` and the
  refine on `LOCAL_MODEL_URL`, which `validateEnv` enforces at boot. `LOCAL_MODEL_URL` and `allowLoopbackHttp` are **not**
  widened. `boundedRequest` gains a separate option naming the one constant host, set only by the local leaf; a test asserts
  hosted and `openrouter` calls still refuse HTTP.
- **TLS verification is never disabled.** HTTPS to a private address (§8.5) that needs a private CA gets that CA configured
  for the local route; neither a relaxed `rejectUnauthorized` nor `NODE_TLS_REJECT_UNAUTHORIZED` is acceptable.
- **Redirects are refused**: every request goes through `boundedRequest`, which already sets `redirect: 'error'`; the
  router adds no transport of its own.
- **Keys travel in headers only** — `Authorization: Bearer` for OpenAI-compatible endpoints, and if a native Gemini
  leaf is ever needed, the API-key header, **never** a `key=` query parameter (URLs end up in logs and errors).
- **Keys never appear in** `onEvent` payloads, thrown or returned values, internal codes or notes; a 5.4c-1/5.4c-2 test
  seeds a marker key and asserts it is absent from every event and result.
- **One request builder for every hosted chat request** (SR-H-2). Production calls, refresh probes and chain-check
  probes all go through the same builder, so a probe can never differ from production in anything but its prompt and its
  small `max_tokens` (§8.4). Gemini and Groq carry no mandatory privacy field in the first version (§4 item 3). A test
  asserts every other non-prompt field identical on production, probe and chain-check bodies.
- **Listing fetches** (SR-M-8) follow the same transport rules: fixed HTTPS URLs that are package
  constants (no id, query or user value interpolated); `boundedRequest` with its size cap and `redirect: 'error'`; the
  key in a header only (for Gemini the API-key header, **never** a `key=` query parameter); the body parsed by a Zod
  schema that caps the number of entries read (entries beyond the cap are ignored and counted) and the length of every
  field before any id validation runs.

### 3.4 Model lists: self-healing, with a pinned fallback (owner decision D6)

**Owner decision, 2026-11-03:** the available-model list **must self-heal** after a model dies, by the VCF mechanism.
This replaces the first edition's "pinned, alert only, never rewrite". It amends the plan's "pinned
model/provider/runtime config" for hosted model ids: what stays pinned is the **provider allowlist**, the hosts, the
local runtime and model digest (§8; the local model is never self-healed) and a **fallback model list** per hosted
provider; the hosted model ids in use become managed data. (Master records the amendment in the plan.)

**With two hosted providers (D3)** the mechanism holds, with one change in what backs it: VCF's chat-probed refresh runs
on OpenRouter, its Groq path is listing-only, and it has no Gemini refresh at all. In the CRM, **Gemini is therefore the
only provider the daily refresh chat-probes**, and that path has not run anywhere yet.

Three layers, adopted from VCF in this order of authority:

**1. Request-time retirement (immediate).** A response classified `RETIRED` (`retiredAnswer`: status 404 and a body
naming a model or an endpoint; or, for Gemini, a 2xx re-routed to another version or variant, §5.1) marks the provider and
model retired through the
`RouteStatePort` (persisted, §3.2). The current call moves to the next model at once; every later call skips the model
until the next successful refresh.

**2. Daily refresh (repair).** A daily timer inside the extraction worker (main has no scheduler to reuse), run
some time before the collection window so a fresh list is in place — rebuilds each provider's list:

| Provider | Source of candidates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Probe                                                                                                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groq     | the models listing, **active** entries with their context (`pickGroqModels`: keep current ids still listed, add at most one largest-context chat model; non-chat ids such as speech, guard or TTS models excluded). **CRM restriction (SR-H-1):** because Groq additions are never chat-probed, an addition must also match the **checked-in Groq family pattern** `^openai/gpt-oss-(20b\|120b)$`: the two production models with strict `json_schema`. The other two strict models are preview, which Groq says may be discontinued at short notice; admitting them is a reviewed pattern change after MP-03. The pinned fallback list is those two ids | no chat probe — availability comes from the listing (VCF: its problem is rate limits, not staleness)                                                                                                                                                                                                                    |
| Gemini   | the models listing, ids after stripping `models/`, filtered by the **checked-in Gemini family pattern** `^gemini-[0-9]+(\.[0-9]+)?-(flash\|flash-lite\|pro)(-preview(-[0-9]{2}-[0-9]{4})?)?$`. The listing has no free-tier field, so a not-free id can match; the three-day rule below drops it                                                                                                                                                                                                                                                                                                                                                         | yes: the current list first, then the largest-context new candidates, at most `PROBE_CAP`, with a pause between probes. VCF's value of 10 was sized for another provider's daily limit; the CRM's comes from Gemini's free limit, which the owner reads (§2.3), small enough that probes do not eat the day's allowance |

- **Verdicts** (`classifyModelStatus`, adopted as-is): 2xx ⇒ `alive`; 404 ⇒ `dead`; 429/503 ⇒ `transient` (kept — busy is not
  rotten); timeout, network error or any other status ⇒ `unknown`, **never** `dead`. CRM additions: `AUTH` on the listing
  fetch or a probe ⇒ that provider's refresh **fails** and its previous list is kept. A Gemini model whose probe answers a
  429 **without** a per-day quota id on **three consecutive probe days** is dropped as `dead`: by forum reports, a free key
  calling a model it cannot use gets 429 `RESOURCE_EXHAUSTED` with a limit of 0, which would otherwise read as busy forever.
  A model already `SPENT_DAY` today, or with an `OK` call since the last refresh, is not probed: a no-probe day, which
  neither increments nor resets the count. The count lives per provider and model in the route-state file (§3.2), for listed
  models and candidates alike, bounded to `[0, 3]`. One redacted call in the 5.4c-5 smoke confirms the shape; if the body
  marks the zero limit in a structured field, 5.4c-1 classifies it at request time instead.
- **Selection — VCF's `pickLiveModels` with a CRM ordering change (SR-H-1).** Drop `dead` and every model under
  `MIN_MANAGED_CONTEXT` (VCF: 16 000 tokens; the CRM sets it to at least the local chunk size, so every managed model fits
  every chunk); keep `TARGET` (VCF: 5). VCF ranks by status then context, which would put a brand-new, unreviewed,
  large-context candidate **first** for all vacancy text. The CRM instead:
  - keeps **existing** entries in their current order (dropping the dead), and **appends** new candidates at the
    **tail**, below every existing entry, ranked among themselves by status then context;
  - **promotes** a new entry above older ones only after it has been `alive` on N consecutive **probe days** (N = 3
    proposed, a package constant). The streak is the probation record in the route-state file (§3.2), bounded to
    `[0, N]`. Rules (SR-M-9):
    - a **probe day** is a UTC day on which that model was actually probed; the streak increments by one on an `alive`
      probe day only if `lastProbeDay` is an earlier day (a second probe on the same day counts once), and resets to 0
      on a `transient` or `unknown` probe day;
    - a **no-probe day** — the model was not reached under `PROBE_CAP`, the provider was skipped (cap refusal, `AUTH`,
      fetch failure) or the job did not run — neither increments nor resets the streak;
    - the reader **recomputes** promotion, never trusts it: an entry is ordered as promoted only if it is in the pinned
      fallback list or its probation record shows `aliveStreak == N`; an entry without a valid record is on probation.
      A promotion emits an event naming provider and model, so it is visible;
    - **the daily refresh never chat-probes Groq**, so a Groq addition never earns a streak: it stays on probation (tail)
      until a human adds it to the pinned fallback list by a reviewed change. Only a Gemini entry can be promoted by the
      refresh; the weekly chain check earns no streak;
    - until promotion an entry serves only when every older model of that provider failed (see Consequences: in
      practice that is routine on free tiers);
  - uses an **effective context** of `min(provider-reported context, the route's configured context window)` for every
    filter and ranking — a provider-reported number is untrusted input and can never widen what the route accepts.
- **Never wipe.** If the listing fetch fails, or nothing survives, that provider's managed list is **left untouched**
  and the provider counts as failed.
- **Retirement reset, per provider (SR-M-5).** VCF clears every retirement only when every provider refreshed; one
  failing provider would then block every other provider's recovery. The CRM clears a provider's retired entries on
  **that provider's own** successful refresh (its `AUTH` bit clears only by the narrower proof of the §3.2 table, never
  by the refresh's success alone) — the fresh probe of that provider is the authority (VCF: "one still really gone costs
  one request tomorrow, then is retired again"); for Groq the fresh listing is, as in VCF. A provider that is not
  configured (no key) is **skipped**, not counted as failed.
- **Independent providers**: one failing never blocks another. The job's result is **failed** if any provider failed
  (VCF: exit 1), which raises a health event; the log lists provider, model ids and verdicts only — never a key, never a
  probe or provider body.

**3. Weekly chain check (secondary signal).** VCF's `checkModelChain` is kept as a separate, cheaper check: one minimal
probe of every hosted model currently in use, Groq's included, with the same verdict rules. Any `dead` entry raises the
durable health flag `MODEL_LIST_STALE`; a run with no dead entry clears it, and so does a successful daily refresh that
has removed every entry the flag named (the repair heals the signal). It alerts; it never edits a list — repair is layer
2's job. Its probes obey **every** constraint below exactly as the refresh probes do (SR-M-3): the fixed synthetic
prompt, the shared request builder, the provider allowlist, the own caps, the transport rules of §3.3; and they carry
the same tests (§6.1).

**The managed list is read** per provider through a `managedModels(provider, fallback)` reader: the managed-list file's
entry for that provider if it is valid and non-empty, else the **pinned fallback list** from the package config. A
missing, empty or invalid file therefore degrades to the first edition's behaviour, never to an empty chain.

**Constraints the refresh must hold** (the privacy and security surface of self-heal):

- **Probes carry only a fixed synthetic prompt** — a package constant in VCF's form ("reply only with JSON
  `{"ok":true}`") — never vacancy text, never a page, never anything read from the DB. A test asserts the probe request
  body equals the constant plus the route's fixed fields.
- **Probes are built by the shared request builder** (§3.3).
- **Providers come only from the checked-in provider allowlist** (`gemini`, `groq`), and only those that are configured
  (key present). A listing cannot introduce a provider.
- **Model ids are untrusted input** from a hosted listing: each is validated **before** it is probed, stored or logged;
  a failing id is dropped and counted. Ids are only ever sent as the JSON `model` field, never placed into a URL or a
  path. The pattern (SR-H-1):
  - common to all providers: letters, digits and `. _ - /` and at most one `:`, bounded length (128), no leading `/`,
    no `..`, no whitespace or control characters, no URL scheme;
  - **Groq**: the checked-in family pattern of the table above;
  - **Gemini**: the checked-in family pattern of the table above.
- **Probes count against the own caps** (`OwnCapPort`, unit rules of §5.1): a provider whose cap cannot reserve a probe
  is skipped for the day and keeps its list.
- **Rollback of self-heal alone**: deleting the managed-list file returns every provider to its pinned fallback;
  disabling the job stops repairs while request-time retirement still works.

**Confidence: HIGH** for the mechanism and the Groq path (VCF runs them daily); **MED** for the Gemini path (a chat-probed
refresh and a pattern standing in for the missing free-tier field are not in VCF).

### 3.5 Deferred with OpenRouter (owner decision D3)

OpenRouter is not a router route in this version. None of the following is built; it is kept here as the specification
to restore, reviewed again at that time:

- **Route:** provider id `openrouter`, reading the existing `OPENROUTER_API_KEY`, which §3.1 otherwise forbids the router.
- **Candidates:** the public catalogue, free entries only: prompt and completion price 0 **and** a plain or `:free` id
  (price 0 alone is not trusted). `PROBE_CAP` 10 under a ~50/day limit; Task 5.2's USD key limit as the backstop.
- **Ids:** exactly `<author>/<model>` or `<author>/<model>:free`. Any other suffix is refused (`:online` forwards the prompt
  to a web search; also `:extended`, `:nitro`, `:floor`, `:thinking`, any future one). `openrouter/auto` and every id whose
  author is `openrouter` are denied. Hostile-id and free-filter tests come back with it.
- **Privacy fields** on production, probe and chain-check requests alike: `provider.data_collection: "deny"`, `zdr` once
  confirmed, `provider.ignore`. A route whose builder cannot produce them is **disabled**, never sent without them. An id
  names the author, not the endpoint, so filtering ids does not keep an upstream out; `provider.ignore` does.
- **`FLAG_REJECTED`:** the provider refuses a privacy parameter or reports no endpoint matches the data policy. Classified
  **before** `RETIRED`, or it retires good models. Next route, never retried without the flag, own-cap unit released. On a
  production request: a persisted provider bit, cleared only by a 2xx probe with every production field to the model it was
  recorded against (or the current first model if that one is retired), start-up refresh included. On a probe: that model
  is ineligible, and the provider bit is never set.
- **Classification:** the `SPENT_DAY` free-models-per-day marker and the `CREDIT` signal for the USD key limit.

**Re-decided by the owner when it is added:** whether to keep `deny` if it empties the free pool, and what `provider.ignore`
lists, since its contents came from the D2 exclusion that no longer exists. The same restoration applies if 5.4c-0 finds a
per-request privacy parameter on Gemini or Groq that the owner wants sent: a flag a provider can refuse needs
`FLAG_REJECTED` back.

The existing `openrouter` value of `extraction.provider`, its adapter and its `data_collection: deny` are unchanged.

---

## 4. Privacy constraints that hold for EVERY route

These hold for the local route too; none of them depends on which route answers.

1. **Before the router, always** (5.4a/5.4b, unchanged, in the collection worker): `ai-input=no` ⇒ the port is never called;
   `unspecified` follows an explicit policy argument; contacts stripped (emails, phones, messengers, profile URLs); page text
   only inside the delimited data block of the user message; input capped. The router's one entry from there is the extraction
   worker's (§2.4): authenticated, data-only, with a second `stripContacts`. The `ai-input` gate cannot be re-checked at that
   entry, and rests on the collection worker's integrity; §2.4 states what that means.
2. **The router logs and stores no text.** Not the input, not the model output, not a provider error body (it can echo
   the prompt). Events and notes carry route, model, internal code, HTTP status, counts and timings only. This is
   stricter than VCF.
3. **No per-request privacy flag exists** (5.4c-0). Gemini's and Groq's privacy rests on their published terms, which the
   owner has accepted (§4.1, §4.2). Groq offers zero data retention as an **organisation setting**, not a request field;
   turning it on is an optional owner action in 5.4c-5 and does not bring back the refusal handling of §3.5.
4. **What the free tiers do with prompts.** Gemini's unpaid tier uses prompts and answers to improve Google's products,
   with human review. Groq's terms forbid training on inputs and outputs, though they do not say whether that covers
   free-plan use; Groq may log them for up to 30 days for troubleshooting or abuse. Even after contact stripping, the text
   is a third party's published page. The owner has accepted that for every source the gates admit (D2); the risk is stated
   once, in §4.1.
5. **Egress** only to the pinned provider hosts (Task 5.2: "egress allowed to the provider host only"), widened per
   added provider.

### 4.1 Which sources may use hosted routes — owner decision D1 (decided 2026-11-04)

**Decided: every source for which the model can do the task may use the hosted routes.** "Can do the task" means the
call reaches the port at all: the record needs a field that deterministic extraction did not produce (Task 5.5, stage C)
and the gates of item 1 above admit it. This replaces the recommended per-source allowlist with default local-only;
there is no per-source flag, no provider set per source, and reading a source's terms is no longer a precondition per
source.

**Never weakened:** `ai-input=no` blocks **all** routes, the local one included; `unspecified` follows the explicit
policy argument; contacts are stripped before any route. These run before the port (item 1), so no router configuration
can bypass them.

**The residual risk, accepted by the owner on 2026-11-04.** The text of third-party pages, after contact stripping, is
sent to free-tier providers that may retain it, train on it and have humans review it. Stripping removes the listed
contact shapes and nothing else, so names and other personal details written in prose can go out with the text. No
source's terms are read before its text is sent, so a source whose terms restrict such reuse is sent all the same unless
its signal says `ai-input=no`. Text once sent cannot be recalled; removing a key stops further sending only.

### 4.2 Providers whose free terms allow training or human review — owner decision D2 (decided 2026-11-04)

**Decided: yes.** Such providers may receive vacancy text after stripping, whether or not research confirms the belief
about the Gemini API's unpaid tier. No field or filter gates this: the per-source training flag of the earlier edition
is removed, and the caller passes no provider list. What remains of the Legal read in 5.4c-0 is one informational note
on each provider's free-tier data terms, with a source and an expiry date. It feeds **no gate**; it keeps the accepted
risk of §4.1 accurate, and a material change in those terms goes back to the owner.

### 4.3 OpenRouter — owner decision D3 (decided 2026-11-04)

**Decided: OpenRouter is not enabled in this version.** The first router version has Gemini, Groq and the local floor,
which narrows the owner's decision of 2026-10-18. The question of keeping `data_collection: "deny"` against an empty
free pool is moot for now and is re-decided if OpenRouter is added (§3.5).

---

## 5. Failure semantics

### 5.1 Classification (internal codes; one table for every hosted leaf)

Classification uses the HTTP status first, then the **whole** error body, parsed as JSON, of which only the provider's
**documented structured error fields** are read, plus its rate-limit headers — never the page text, never a free-text
regex over the body. A prefix cut is not used: a real Google error with three quota violations, pretty-printed, runs
past 2 000 characters and would stop parsing. The body is already capped at 2 MiB by `boundedRequest`; a body over the
cap or not parsable is read as having no marker: a 429 is `BUSY`, never `SPENT_DAY`; a 403 is `TRANSPORT`, never `AUTH`;
a 404 is `TRANSPORT`, never `RETIRED`. Each rule reads one fixed place, never anywhere in the body, because a provider body
can echo request content: a Gemini 429's per-day marker only from `error.details[]` (from the first element's when the
compat endpoint wraps the envelope in a list; Groq's comes from headers); the 403 rule only Gemini's `error.status` or
the shape of Groq's `error` object, never `details`; the 404 rule only `error.message`. The body is
discarded after classification.

| Internal code      | Signal (fixtures from 5.4c-0's error table)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Router action                                                                                                                                                                                                                                                                                                                   | Ledger                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OK`               | 2xx, envelope valid, output passes Zod after at most one correction retry (`runExtraction`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | return                                                                                                                                                                                                                                                                                                                          | own cap committed                                                                                                    |
| `BUSY`             | 429 without a per-day marker, including Groq's per-day token 429, which has none; 503                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | a short bounded backoff on the same model (VCF Gemini: 9 s, 25 s) **only if** the call deadline allows; a `retry-after` (Groq) or `retryDelay` (Gemini) longer than that puts the model in a **cool-down** until it elapses, in process memory; then next model / next route. At most one wait per model per call, never a loop | none                                                                                                                 |
| `SPENT_DAY`        | 429 with a per-day marker. Groq: `x-ratelimit-remaining-requests` exactly `0` (the request headers always mean per day, documented). Gemini: a `QuotaFailure` quota id containing `PerDay` (secondary; if the compat body lacks it, the 429 is `BUSY` and the own caps hold)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | next model / next route                                                                                                                                                                                                                                                                                                         | model spent until the provider's reset                                                                               |
| `CREDIT`           | 402 / insufficient credit. Neither provider documents one (5.4c-0), so there is no fixture yet; the row stays for a provider that does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | next route                                                                                                                                                                                                                                                                                                                      | whole provider spent until the limit's reset; a loud event (limit pause)                                             |
| `RETIRED`          | 404 naming the model or an endpoint (`retiredAnswer`; "naming" means `error.message` holds the requested id as a whole token, bounded by characters outside `[A-Za-z0-9._-]` or the string's ends, and an empty id never matches; a bare 404 is `TRANSPORT`, so a wrong base URL never retires everything). **Gemini re-route:** a 2xx whose response `model`, after stripping `models/`, matches the Gemini family pattern with a **different version or variant capture** than the requested id — Google routes a deprecated id to a successor instead of refusing it. A response id that fails id validation or the pattern (a `-NNN` revision suffix, say) is no signal and retires nothing. UNVERIFIED that compat reports the routed-to id (§2.3); if it does not, pinned ids and the daily refresh are the only repair | after a 404, next model; after a re-route, the answer is used and the event names both ids, the response id only after it passed id validation (§3.4)                                                                                                                                                                           | model retired (persisted) until the next successful refresh (§3.4)                                                   |
| `AUTH`             | 401; a 403 whose body parses as the provider's **documented error envelope** (Gemini `error.status: PERMISSION_DENIED`; Groq an `error` object with `message` and `type`). Gemini's `PERMISSION_DENIED` has four documented causes, all about the key or project; read as `REFUSED`, a leaked key would be retried on every record. Any other 403 (HTML, empty, foreign JSON — an edge layer reacting to the page) is `TRANSPORT`, so page text can never disable a provider                                                                                                                                                                                                                                                                                                                                                  | next route                                                                                                                                                                                                                                                                                                                      | whole provider disabled, **persisted**, until the proof of §3.2; loud event — a key problem is never read as "spent" |
| `REFUSED`          | a safety block or content filter (OpenAI-compatible `finish_reason: content_filter`; Gemini block reason): an input-triggered refusal must not disable a provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | next route; **not** retried on the same provider                                                                                                                                                                                                                                                                                | none (it is about this input, not the model)                                                                         |
| `INVALID_OUTPUT`   | empty content, `finish_reason: length` (the answer hit `max_tokens`), non-JSON, fenced, schema-invalid after the one correction retry, over 2 MiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | next model (VCF `answerFits`: an answer that would fail later is passed over now); at the floor, a failed answer (§5.3). An empty answer is never "nothing found"                                                                                                                                                               | none                                                                                                                 |
| `TIMEOUT`          | per-attempt timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | next route                                                                                                                                                                                                                                                                                                                      | none; own cap unit stays spent (the request may have been billed)                                                    |
| `TRANSPORT`        | network error, other 4xx/5xx, envelope invalid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | next route                                                                                                                                                                                                                                                                                                                      | none                                                                                                                 |
| `PROMPT_TOO_LARGE` | **local route only, before each HTTP request, correction retry included:** the estimated prompt, the group's `maxAnswerTokens` and the correction maximum (its prefix plus `MAX_CORRECTION_CHARS`) exceed the route's window (VCF `promptFits`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | a **per-record** failure with public `INVALID_OUTPUT`, never `PROVIDER_ERROR`, which would stop the cycle as `MODEL_UNAVAILABLE`. **Never sent, so the runtime can never truncate it**                                                                                                                                          | none; the input ceiling should have prevented it, so an occurrence is a defect signal                                |

The literal word "quota" (or any other word) in the **page** never changes a classification: the page is input, not a
provider response. A 5.4b test already pins this at the port boundary; 5.4c repeats it at the leaf. Groq's per-minute
token limit can be smaller than one large prompt, so the Groq route's configured window is set no higher than it: the fit
filter then skips Groq for such a page instead of cooling it down on every call.

**Durations from headers.** `retry-after` is non-negative integer seconds; `retryDelay` and `x-ratelimit-reset-*` are
parsed as durations; a non-finite, negative or unparsable value counts as absent. Every derived pause is clamped to 24 h
and to the provider's reset. The reset is fixed in config, never read from a header: midnight Pacific for Gemini (documented);
midnight UTC for Groq, an **unverified config assumption** until the owner reads it (§2.3).

**Own-cap unit rules** (the `OwnCapPort`, §3.1). One unit is **one HTTP request** to a hosted provider, reserved
immediately before the request is sent. A `BUSY` re-try on the same model and the one correction retry of
`runExtraction` are separate requests and reserve their own units; a unit that cannot be reserved stops that provider
for this call (no request is sent). After the response, by code:

| Code                                                   | The request's unit                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `OK`, `INVALID_OUTPUT`, `REFUSED`, `BUSY`, `SPENT_DAY` | **committed** — the provider counted the request                                                         |
| `TIMEOUT`                                              | **committed** — the request may have been counted                                                        |
| `AUTH`, `CREDIT`, `RETIRED` after a 404                | **released** — refused before any work; these codes disable the model or provider, so they cannot repeat |
| `RETIRED` after a Gemini re-route (a 2xx)              | **committed** — the provider did the work, and its answer is used                                        |
| `TRANSPORT` with no response (connection never made)   | **released**                                                                                             |
| `TRANSPORT` with a response                            | **committed**                                                                                            |

The local floor reserves no own-cap unit; the 5.4b cycle slot covers the whole call, floor included.

### 5.2 Pacing and dosing, as one algorithm

Per `extract` call:

1. **Deadline.** The hosted cascade may use `hostedBudgetMs`, the floor `floorBudgetMs`; their sum is the call's absolute
   ceiling (§5.5). The cascade cannot spend the floor's time (VCF summed per-request timeouts until `boundExecutor`
   existed). A floor that overruns its own budget ends in `TIMEOUT`; it gets no more time.
2. **Candidates.** Hosted routes that have a key, at least one model not spent / retired, are not disabled, and whose
   context window fits the input (fit filter). The input is already sized to the local window by the caller, so the
   floor always fits.
3. **Rotation.** Among rotatable candidates, the next one in the per-process rotation goes first; the rest keep their
   configured order (VCF `createBalancedChainExecutor`). A non-rotatable route (for example a provider whose allowance is
   reserved for something else) is only a fallback.
4. **Per attempt.** Ask the `OwnCapPort` for one unit of this provider's day; refused ⇒ skip the provider without a
   request. Wait out the provider's minimum gap (VCF: 3 s for OpenAI-compatible providers, 7 s for Gemini). Send with
   the provider's structured-output mode, built by the shared request builder (§3.3). Classify (§5.1).
5. **Hand-back and floor.** Every hosted candidate exhausted, filtered or refused ⇒ `SMALL_DOSE_NEEDED`, and the small dose
   runs on the local route, with no own cap and no gap, under `floorBudgetMs` (§5.4). Every request passes the fit check
   first (`PROMPT_TOO_LARGE`, §5.1). Emit `FELL_TO_LOCAL` with the list of `(route, code)` that led there.
6. **Result.** The first `OK` wins. If the floor also fails, the public code is the floor's (`TIMEOUT`,
   `INVALID_OUTPUT` or `PROVIDER_ERROR`). A router with no valid local route never starts: it is `NOT_CONFIGURED` before any
   hosted request, as §3.3 and §8.5 require.

Own-cap values sit **below** each provider's published free limit, so the provider never reaches its refusal state;
`SPENT_DAY` is then the exception that corrects a wrong cap, not the normal stop. Values: D5.

### 5.3 "Slow, never a silent failure"

- A fall to local is an event, never silence — and an event is only as loud as its consumer, so the consumer is
  **mandatory**, not optional. The wiring (5.4c-3) must supply an `onEvent` handler; the router config schema has
  no "no events" mode. That handler: (a) increments a durable per-day counter of floor falls and of each hosted
  provider's codes (the existing metering/health surface, no text); (b) raises a durable health flag "hosted routes
  dead" when a cycle ran with at least one hosted provider configured and **none** answered `OK`, cleared by the first
  hosted `OK`; (c) re-emits the flag once per collection cycle while it stays raised, so it cannot be seen once and
  forgotten. A 5.4c-3 test fails the wiring if the handler is missing or swallows `FELL_TO_LOCAL`.
- **Preflight** (VCF pattern, adopted as-is): before a collection cycle that will use model extraction, one trivial call
  to the local route; 4 attempts at 10 / 30 / 60 s gaps. No answer ⇒ the model stage of that cycle does not start, no
  record is marked as extracted or "nothing found", and a durable health signal "model unreachable" is raised (the
  r5 job-sourcing health surface is the candidate home; 5.4c-4 confirms it). The signal clears **only** when a later call reaches
  the model, never by age (VCF `MODEL_DOWN_FRESH_HOURS`: after a while only the wording changes). The attempts' spacing is what lets a
  model reloading after a restart come back, so MP-04's measured cold load must fit inside it. The deterministic HTTP/JSON-LD stages
  still run — the VCF rule "a check written for one step must not cost the others".
- A floor failure on a record returns the 5.4b outcome `MODEL_UNAVAILABLE` / `EXTRACTOR_FAILED` with the remaining IDs; what
  happens to those records next is §5.4's table.
- `AUTH` and `CREDIT` raise a loud event once per process, not per call.
- **Health from outside an answer.** The refresh and the chain check (§3.4) run with no answer to ride on. Their failed-job
  event and `MODEL_LIST_STALE` are codes in the state file; every `extract` and `preflight` reply carries them, and the
  collection side records them on the DB side. A preflight opens every model-using cycle, so a flag arrives within one cycle.
  **Accepted limit:** with no model-using cycle the flag waits. No text moves meanwhile, and the pinned list and the floor are
  the safe state.

### 5.4 Small dose: mandatory on the local route

**Owner correction, 2026-11-04: built unconditionally, as part of the local route (task 5.4c-6). MP-03 tunes it; it does
not gate it.** The earlier edition built this only if MP-03 showed the need; that left the floor free to fail on every
prompt until someone measured it. A full structured request to a small model is the failure this exists to prevent, and
in VCF it is what used to come back empty.

**Plan, by the routes that can answer** (VCF `dosePlanFor`): at least one hosted candidate ⇒ `full-then-small`; no hosted
candidate (no keys, all spent) ⇒ `small` directly. Hosted routes always receive the full shape; **the local route never
does**, unless the field-group table is deliberately one group (below).

**Hand-back** (VCF `SmallDoseNeeded`, `callDosed`, `pinnedLocal`). VCF throws across the executor; `@crm/inference` never
throws, so the cascade ends with an **internal** `SMALL_DOSE_NEEDED` result naming why the hosted routes gave up, and a
dose runner in the router answers it, every request pinned to the local route. It never leaves the package; the public
result is unchanged.

**Field groups, read by code** (VCF `DosedCall`):

- `ExtractionRequest` gains an optional `smallDose`: an ordered list of at most `MAX_SMALL_DOSE_GROUPS` field groups (§5.5),
  each with a name, a short instruction, a strict flat sub-schema of a few related fields and a `maxAnswerTokens`, plus a
  pure `merge(parts)` that assembles the result in code. `ModelStructurer` (5.4b) always supplies it, and a test asserts
  that; a request with no `smallDose` declares that its own schema is already small enough, which only a deliberately small
  schema may do.
- **The envelope stays whole.** A group's instruction is a checked-in constant **appended to** `req.instruction`, never a
  replacement: `EXTRACTION_SYSTEM_PROMPT` is the prompt-injection defence, and it reaches the port as `instruction`. The
  input is the same delimited user message. The combined text stays under `MAX_EXTRACTION_INSTRUCTION_CHARS`, past which
  `sendChatCompletion` cuts silently, and counts in the fit check.
- Each group is one `runExtraction` on the same input: strict `json_schema`, parse, one correction retry, Zod.
- **The full schema is real.** Today `ModelStructurer` passes `z.unknown()`, so the port validates nothing, and the guard's
  `outputSchema` is not enough: it declares records and URL fields `z.unknown()`. 5.4c-6 composes `modelReplySchema` from the
  guard's definitions: `records` of the record schema, at most **1** (a detail page is one posting; `HtmlProvider` keeps only
  the first anyway, so more is a wrong answer), URLs typed string or null so they render. A record-shape error is
  `INVALID_OUTPUT` and cascades; the guard stays behind it unchanged, per record and per URL.
- Hosted routes never see a group; a group failure never goes back up the cascade.
- **The floor is asked only what is used.** Stage C applies only `MODEL_FILLABLE_FIELDS` (`description`, `location`,
  `employmentType`, `remote`), and only where Stage B left them empty. The table covers those; a group with no missing field
  is not asked (Task 5.5, stage C), and other fields merge as null.
- **Unquoted facts are dropped, on every route (owner decision D10, 2026-11-04).** Sub-schemas carry flat `<field>Quote`
  strings, which `merge` turns into `evidence`. Main's guard drops a bad **quote**, never a fact, so a field with no
  surviving quote is still applied today. 5.4c-6 changes the guard: a string fact with no surviving quote becomes null, and
  the record and its other fields stay. URLs keep their own whole-URL check. A boolean (`remote`) is kept, because the guard
  never gives a boolean evidence; nulling it would drop every `remote`. **Cost:** a true field the model did not quote is
  lost; deterministic values still win. MP-03 reports the dropped share, for tuning the table.
- `uncertainty` is required by the guard and is not asked of a model on the floor: `merge` sets a fixed constant that marks a
  floor answer. Nothing on main reads it yet.

**Groups run per discovered record, and a record yields one posting.** The guard accepts up to 100 records per reply, and
separate groups answering about a page with several postings have nothing to align on: an apply URL from one posting
would pass grounding on another. So:

- Stage C hands the structurer one `DiscoveredRecord` per detail page, and the port contract narrows to that. Text holding
  several postings is split by discovery or not sent to a model.
- Sub-schemas are flat objects, never arrays. `merge` yields **exactly one** record, and `ModelStructurer` stamps its id.
- Every group's constant says to answer about the page's main posting only. The identity group also returns
  `postingsOnPage`, an integer bounded by its sub-schema and kept out of the merged record. For anything but 1, `merge`
  returns an explicit failure, which the runner maps to public `INVALID_OUTPUT`, so `ModelStructurer` records a per-record
  issue. It never returns `{ records: [] }`, which the guard would pass as "no postings".
- **Residual:** a model that miscounts can still mix a sidebar posting's facts into a record. MP-03's labelled set includes
  such pages and measures it.

**A failed group is a failed call** (VCF: "this module never turns a failed call into an answer"). Any group that ends in
`TIMEOUT`, `TRANSPORT` or `INVALID_OUTPUT` fails the whole floor answer with the floor's public code, and the record stays
due. A model answering `null` for a nullable field is an answer; a group that did not answer is never recorded as nulls,
so "the model did not run" can never read as "the page does not say".

**What MP-03 tunes:** the group boundaries and count (up to the cap), each group's wording and `maxAnswerTokens`, and
whether a candidate holds larger groups. One group holding the whole schema is a legal table; that group is still flat, one
record. If MP-03 shows the chosen model answers it reliably, the tuning is a one-line reviewed change and no code path
changes. There is no off switch: the hand-back and the runner remain.

**Cost, stated:** each group re-sends the input, so one record costs the local model as many prompt evaluations as there
are groups. MP-04 measures that wall time; it is the main reason the table is tuned. The 5.4b cycle slot covers the whole
call, groups included; time is limited by §5.5.

**What happens to a record, by outcome.** These extend the real counters `modelAttempts` and `modelPending`
(`settleModelPending`). Today a reached record is cleared after one try until its content changes, whatever the result; a
missed one counts, and its third miss clears it, so three cycles of stops would park healthy pages; and `MODEL_UNAVAILABLE`
reaches everything, so an outage clears them at once. 5.4c-6 changes that to:

| Outcome                                                                                                                                                                                                                                                                       | Counts in `modelAttempts`? | Next                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answered, including a page that gave no fields                                                                                                                                                                                                                                | no, reset                  | cleared, revisit pace (as today)                                                                                                                                                                                                      |
| **Record-caused:** `INVALID_OUTPUT`, `PROMPT_TOO_LARGE`, `postingsOnPage` other than 1, guard reasons, in a pass where **another record succeeded**                                                                                                                           | **yes**                    | owed on `MODEL_BACKOFF_MS`; the third clears it until the content changes, and is reported                                                                                                                                            |
| **Not the record's fault:** a pass ending `EXTRACTOR_FAILED` (nothing succeeded: a bad runtime or digest answers that way on every record), `TIMEOUT`, `CANCELLED`, `PORT_THREW`, unknown code, budget stops (the local-time limit too), `PROVIDER_ERROR`, a failed preflight | **no**                     | stays owed, due at the longest backoff, and never parked. So a source with one record never parks it, at one call per backoff. The in-flight record of a `TIMEOUT` is offered last next cycle, so one slow page cannot block the rest |
| `NOT_CONFIGURED`, `ai-input` skips                                                                                                                                                                                                                                            | no                         | cleared, as today: a configuration state or a decision                                                                                                                                                                                |

### 5.5 Stopping a call: a ceiling, an abort, one request in flight

A floor budget that grows with the group count does not survive the layer above. `ModelStructurer` gives up after
`DEFAULT_STRUCTURER_TIMEOUT_MS` (120 s), frees the route after `DEFAULT_ABANDONED_HOLD_MS` (250 s, from
`MAX_REQUESTS_PER_PORT_CALL`), and the port takes no signal. An abandoned router call would keep sending, hosted requests
with vacancy text included, while the next record started. **So the 5.4b hold changes:**

1. **A cap on groups.** `MAX_SMALL_DOSE_GROUPS`, a package constant (6 proposed); a request above it sends nothing and fails.
2. **An absolute ceiling per call.** `hostedBudgetMs` and `floorBudgetMs` are config with package maxima, and
   `routerCallCeilingMs(config)` exports their sum. Each request's timeout is the lesser of the route's and what remains. The
   schema refuses a `floorBudgetMs` that cannot give every group of a full table one request; correction retries take what
   is left.
3. **An abort that stops sending.** `ExtractionRequest` gains `signal`. The cascade and the dose runner check it before every
   request and it wakes backoff and minimum-gap sleeps; `sendChatCompletion` and `boundedRequest` take it, so a request in
   flight is cancelled. `ModelStructurer` owns one controller per call and aborts it on its timeout or on the cycle's
   `signal`. `boundedRequest` reports a timeout and an abort alike today, so it gains a separate result: an aborted call
   cascades nowhere and raises no "hosted routes dead" flag.
4. **A timeout and hold derived from the ceiling.** The wiring passes the existing `timeoutMs` as the ceiling plus a margin,
   so the router's coded `TIMEOUT` arrives first, and `abandonedHoldMs` as that plus a grace. The hold ends when the call
   settles, and the slot stays consumed. `PORT_HTTP_TIMEOUT_MS` and `MAX_REQUESTS_PER_PORT_CALL` remain only as the
   defaults for `local` and `openrouter`.
5. **One local request in flight.** One `ModelStructurer` per router, and the local leaf serialises its own requests, so a
   preflight or a second caller queues. A runtime that keeps generating after a disconnect would defeat this, which is why
   §8.3 tests it; `max_tokens` bounds it regardless.
6. **A local-time budget per cycle** holds the plan's "local = calls + CPU time". `usage` gains `localMs` on success **and on
   failure**, an abandoned call counts its elapsed time, and `ModelBudgetPort` refuses the next reservation (`BUDGET_EXHAUSTED`,
   `CYCLE_LIMIT`) once the cycle's total reaches a limit frozen from MP-04.

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
  spent model skipped on the next call; retired model skipped at once and after a restart (file adapter reloaded); `AUTH`
  (401, or a 403 with the documented envelope) disables the provider once and emits once, while a 403 with an HTML, empty or
  foreign body is `TRANSPORT` and persists nothing, and a content-filter refusal is `REFUSED`; a Groq 429 with
  `x-ratelimit-remaining-requests: 0` is `SPENT_DAY`, one without a marker waits at most once and cools the model down, and
  a bad or over-long header pause is absent or clamped; a Gemini 2xx naming another version retires the requested id, while
  a revision-suffixed or invalid response id retires nothing; the own-cap unit table of §5.1 per code, retries reserving
  their own units; the floor's budget stays whole even when every hosted attempt hangs (fake timers); no hosted key
  configured ⇒ no hosted request is ever sent and the plan is `small`; a hosted route without an `OwnCapPort` and an invalid
  local URL both refuse the config, with zero hosted requests; floor failure ⇒ the floor's public code; the word "quota" in
  the input changes nothing; no event payload ever contains input or body text (assert on a seeded marker string); a strict
  `null` reaches the guard as absent and leaves a field already filled by Stage B unchanged.
- **Stopping (§5.5):** after an abort the fake fetch's call count stops growing, on hosted and local routes alike and through
  the worker's connection; a request in flight is cancelled and a sleep wakes; an aborted call raises no "hosted routes dead"
  flag; never two local requests in flight, even after an abandoned call; a slot is not freed while its call still runs; a
  group count over the cap sends nothing; the ceiling holds with every request hanging; the structurer's timeout and hold
  exceed the exported ceiling; the cycle's local-time limit refuses the next reservation, and a failed floor call is charged
  against it.
- **Transport (§3.3):** hosted and `openrouter` calls refuse plain HTTP; the local leaf reaches only the constant host over
  it; link-local, IPv4-mapped and foreign names are refused.
- **Local-route tests (5.4c-6, §8.4):**
  - **Small dose:** a request with `smallDose` never sends the full schema to the local route (fake fetch records every
    body); hosted routes receive the full schema and never a group; the hand-back emits `FELL_TO_LOCAL` and
    `SMALL_DOSE_NEEDED` never reaches the public result; groups merge by code into one record that passes the full schema
    and the guard; a group with no missing field is not asked; a one-group table behaves as a full call on the local route.
  - **Envelope:** every group body carries the whole `EXTRACTION_SYSTEM_PROMPT` and the same delimited input; the longest
    combined instruction stays under the cut.
  - **Identity:** a page with two postings, scripted `postingsOnPage: 2`, ends as a per-record `INVALID_OUTPUT` issue from
    `ModelStructurer`, with no record and no "no postings" result; the merged record carries the discovered record's id; a
    hosted reply with two records is `INVALID_OUTPUT` and cascades.
  - **Failed group:** a `TIMEOUT`, `TRANSPORT` or `INVALID_OUTPUT` in any group fails the whole answer with the floor's
    code, never partial data; a model `null` on a nullable field is kept.
  - **`ModelStructurer` always supplies `smallDose` and passes `modelReplySchema`;** a record-shape error cascades, and the
    guard still drops one bad URL per field.
  - **Fit:** a prompt over the window less the reserves is refused with zero requests sent, for every group; a first request
    that barely fits never overflows on its correction retry; a page over the ceiling is cut by `buildExtractionPrompt`,
    reports `truncated` and does not stop the records behind it.
  - **Decoder and output bound:** no body carries `maxLength`, while an overlong value still fails Zod; every local request
    carries the group's `max_tokens` and every probe the small constant; `finish_reason: length` ⇒ `INVALID_OUTPUT`.
  - **Quotes and `uncertainty`:** `merge` turns `<field>Quote` into `evidence` that survives the guard, and sets the constant.
    **D10:** on a hosted reply and a floor reply alike, a string fact with no surviving quote ends null while the record, its
    quoted fields, its URLs and a boolean stay.
  - **Empty answer** ⇒ `INVALID_OUTPUT`. **Timeout:** the config refuses a local timeout of 300 s or more.
  - **Outcome table (§5.4):** a third record-caused failure clears the record until its content changes; three cycles of an
    outage, stops, the local-time limit or `EXTRACTOR_FAILED` park nothing and leave `modelAttempts` unchanged; a record that
    timed out is offered last.
- **Leaf tests** per fixture: classification table, identical non-prompt fields on every hosted request body, structured-output mode
  per capability, no key in any thrown or returned value.
- **Self-heal tests (5.4c-2b)**, all with fixtures and a fake `fetchImpl`, no key, no network:
  - **Pure pick functions** over fixture listings: `classifyModelStatus` per status (404 dead; 429/503 transient;
    timeout and other statuses unknown, never dead); `pickLiveModels` ranking, context floor and `TARGET`; `pickGroqModels`
    (keeps listed current ids, drops inactive, adds at most one large-context chat model, never a non-chat id); the
    Gemini family pattern; three consecutive `transient` probe days drop a Gemini model as `dead`.
  - **Model-id validation** with hostile ids: path traversal, a URL, whitespace and newlines, control and non-ASCII
    characters, over-long ids, a leading `/`, a second `:` — each dropped and counted, never probed, stored or logged
    raw. Groq: an id outside the checked-in family pattern is never added. Gemini: an id outside its pattern is dropped.
  - **Selection order (SR-H-1)**: a new large-context `alive` candidate is appended **below** every existing entry; it
    is promoted only after N consecutive `alive` refreshes, and a `transient` or `unknown` probe day resets its streak; a no-probe day (cap reached, provider skipped, job not run) leaves the streak unchanged; two probes on one day count once; a hand-edited streak above N is rejected by the schema and an entry absent from the pinned list without a record of streak N is ordered as probation; a Groq addition is never promoted by the refresh; a reported
    context larger than the route's window is capped to the window before any filter or ranking.
  - **Never wipe**: a failed listing fetch, `AUTH`, or nothing surviving leaves the managed-list file byte-identical;
    an invalid, empty or missing file makes `managedModels` return the pinned fallback.
  - **Per-provider reset (SR-M-5)**: provider A failing does not stop provider B's retired entries from clearing on B's
    success; an unconfigured provider counts as skipped, not failed; the job reports failure when any configured provider
    failed. `MODEL_LIST_STALE` clears when a refresh removes every entry it named.
  - **Probe hygiene — refresh and weekly chain check alike (SR-M-3)**: the fake fetch records every request body; each
    equals the fixed probe constant plus the shared builder's fixed fields; no request exceeds `PROBE_CAP` per provider;
    the **daily** job sends Groq no chat request; a provider outside the allowlist or without a key receives no request; a
    cap refusal skips the provider with no request.
  - **Listing fetch (SR-M-8)**: the URL is a constant; the key is in a header and absent from the URL; a redirect is
    refused; an over-size body and an over-count entry list are bounded, not parsed whole.
  - **State files (SR-M-6)**: a hand-edited file with a provider outside the allowlist, an invalid model id, an unknown
    code, too many entries or too many bytes is rejected whole; two concurrent changes both survive (single writer);
    the written file has mode `0600`; a write interrupted between temp file and rename (fake fs) leaves the previous
    file readable.
  - **Start-up refresh (SR-M-7, SR-M-11)**: a persisted `AUTH` bit triggers a refresh of that provider at start, which sends
    exactly one chat probe, to Groq too; a successful listing fetch alone leaves the bit set, a 2xx probe clears it; a second
    start within 1 hour of the persisted `lastStartupRefreshAt` sends no request (crash-loop bound, fake clock).
  - **No secret or body in output**: a seeded marker key and a marker provider body are absent from every log line and
    event.
- **Mutation gate** (Stryker, unit scope) on the classification, the router core, the small-dose runner and merge, and the
  self-heal pick, validation and never-wipe logic: 0 survivors, as for 5.4a/5.4b.

### 6.2 MP-03 and MP-04 measurement hooks

`deps.onEvent(event)` receives, per attempt and per call: route, provider, model, internal code, HTTP status, input
characters, total tokens, cost when the provider reports it, attempt latency, whole-call latency, the field group when
the attempt belongs to a small dose, and whether the floor answered. **No text.** The package does not aggregate; the
caller (and the MP-03 harness) does.

The MP-03 harness (a read-only spike, not product code) never calls a leaf or a port directly. It feeds every page
through the same 5.4a/5.4b pipeline production uses — the `ai-input` gate, `stripContacts`, the prompt envelope and the
result guard, i.e. `HtmlStructurer.structure` — with the port built from a router config. Two phases:

- **Local phase:** a config with no hosted route, over the whole labelled set, per candidate of §8.3, small dose on. It
  runs together with MP-04 (task 5.4c-7), which adds the resource measurements on the target host and picks the model.
- **Hosted phase:** after the local pick, a config with one hosted route and the floor, per provider, on labelled pages
  the gates admit, using keys the owner has provisioned for it. The per-attempt events separate the hosted provider's own
  answers from floor answers. D1 and D2 are answered, so this phase waits on keys rather than on a decision.

It then computes outside the package: field accuracy against the labels, grounding and invented-URL rate (through the
5.4a result guard), schema-valid rate, latency p50/p95, cost per page, and the floor-fall rate of the full chain.
MP-03 gates hosted enablement, as the plan says, and tunes the small dose of §5.4; it does not gate the small dose. MP-04
gates the install (task 5.4c-8).

---

## 7. Owner decisions and task breakdown

### 7.1 Decisions (classified per `autonomy-levels.md`)

| ID      | Question                                                                                                       | Level                                              | Answer or recommendation                                                                                                                                                                                                                                                                                                                                      | Reversible?                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **D1**  | Which sources may send text to hosted models                                                                   | **Decided by the owner 2026-11-04**                | Every source for which the model can do the task; `ai-input=no`, the `unspecified` policy and contact stripping unchanged; residual risk accepted (§4.1)                                                                                                                                                                                                      | Removing the keys stops sending; text already sent is not recallable |
| **D2**  | May a provider whose free tier can train on or human-review prompts receive vacancy text                       | **Decided by the owner 2026-11-04**                | Yes, after stripping (§4.2)                                                                                                                                                                                                                                                                                                                                   | Same                                                                 |
| **D3**  | OpenRouter in the router                                                                                       | **Decided by the owner 2026-11-04**                | Not in this version; `deny` re-decided if it is added (§3.5, §4.3)                                                                                                                                                                                                                                                                                            | Yes — add a provider row later                                       |
| **D4**  | Which persistent store holds route state and the managed list (memory alone is ruled out by D6)                | **Decided by the owner 2026-11-04** (ADR approval) | Worker state files (write-through, atomic replace) behind the `RouteStatePort`; Postgres adapter only when a second worker replica appears                                                                                                                                                                                                                    | Yes — swap the adapter                                               |
| **D5**  | Own daily caps per provider                                                                                    | **Decided by the owner 2026-11-04** (ADR approval) | 50 % of each provider's published free limit (5.4c-0 supplies the numbers), frozen as limits in config under a policy version                                                                                                                                                                                                                                 | Yes — a new policy version                                           |
| **D6**  | Model list after a model dies                                                                                  | **Decided by the owner 2026-11-03**                | **Self-heal** by the VCF mechanism: request-time retirement, daily refresh with a pinned fallback, weekly stale check (§3.4) — replaces "alert only"                                                                                                                                                                                                          | Yes — delete the managed-list file / disable the job                 |
| **D7**  | Adoption shape                                                                                                 | **Decided by the owner 2026-11-04** (ADR approval) | Option A, copy-adapt into `@crm/inference`                                                                                                                                                                                                                                                                                                                    | Yes — revert the PRs                                                 |
| **D8**  | If no model passes MP-04 on the VPS: another host, or deterministic HTML with model extraction disabled (§8.5) | **A3, asked only if it happens**                   | Deterministic HTML first, because it spends nothing and loses only what measured coverage can then price; another host once that loss is known                                                                                                                                                                                                                | Yes                                                                  |
| **D9**  | Where the load replay of MP-04 runs                                                                            | **Decided by the owner 2026-11-04**                | On the VPS, run by Master over the ssh alias (owner-authorized 2026-11-04): the candidate under the container limit (4 vCPU and the RAM left beside the CRM), synthetic data only, stopped if CRM p95 degrades. Alternative path: the owner's own machine under the same limit, synthetic or seed data only, which is indicative of the VPS, not proof (§8.2) | The run is; load already put on production is not                    |
| **D10** | Fields a model returns without a surviving quote                                                               | **Decided by the owner 2026-11-04**                | Filtered out on every route: the field becomes null, the record and its other fields stay (§5.4). MP-03 still reports the dropped share                                                                                                                                                                                                                       | Yes — one filter                                                     |

D1–D3, D9 and D10 are answered, so nothing here is blocked on them. D8 blocks only the local model's branch (5.4c-7, 5.4c-8).

### 7.2 Tasks

Model tier per `model-routing.md`. Every code task: Coder in its own worktree, code-reviewer, **security-reviewer**
(keys, external send), mutation gate on the changed scope.

Order: 5.4c-0 → 5.4c-1 → 5.4c-2 → 5.4c-6 → 5.4c-W → 5.4c-3 and 5.4c-4 → 5.4c-8 (install) → 5.4c-5. 5.4c-7 (MP-04,
the gate of 5.4c-8) runs after 5.4c-6, alongside 5.4c-W; 5.4c-2b follows 5.4c-2 and precedes 5.4c-5. The small dose precedes the measurement because MP-04 and
MP-03 must measure what production will run.

| Task                                                                                                                                   | Agent · model                                                                                                                                                | Depends on                                                      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5.4c-0** Provider and local facts                                                                                                    | `external-research` by Master or a sonnet agent; Legal (opus) for the terms note                                                                             | ADR approved                                                    | **Done 2026-11-04:** `docs/architecture/2026-11-04-extraction-provider-facts.md`. Its follow-ups are the table of §2.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5.4c-1** Classified leaf                                                                                                             | coder · sonnet, medium                                                                                                                                       | 5.4c-0                                                          | Widen the OpenAI-compatible call to return the internal codes of §5.1, Groq's header rules and the Gemini re-route check included; structured-output mode per route capability; the schema rendered in the **strict form for every route** (every property in `required`, `additionalProperties: false` on every object, an optional field as a union with `null`, no `maxLength`; a `null` means "not found", maps to absent before `guardExtractionResult`, and never overwrites a filled field or counts as answered); `max_tokens` and `finish_reason`, temperature 0 on the router's local route; `signal` through `sendChatCompletion` and `boundedRequest`; the local leaf's own plain-HTTP option (§3.3); per-provider fixtures from 5.4c-0's error table; no router yet; public behaviour of `local` / `openrouter` unchanged (their specs stay green)                                                                                                                               |
| **5.4c-2** Router core                                                                                                                 | coder · **opus**, high                                                                                                                                       | 5.4c-1                                                          | Config schema (`router`, local route required, `OwnCapPort` required with a hosted route, providers `gemini` / `groq` / `local`), fit filter, rotation, cascade honouring `signal`, budgets and `routerCallCeilingMs` (§5.5), floor with its single-flight leaf, `RouteStatePort` (memory and file, §3.2), the `OwnCapPort` state-file adapter, `onEvent`, the input-ceiling helper, `ROUTER_LOCAL_MODEL_URL` validation (§3.3), `PROMPT_TOO_LARGE` per request and the 300 s refusal (§8.4); request-time retirement and the `managedModels` reader (§3.4); tests of §6.1                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **5.4c-2b** Model self-heal + daily refresh                                                                                            | coder · **opus**, high (security surface: untrusted model ids, probes leaving the host, a persisted file)                                                    | 5.4c-2, 5.4c-0 (listing shapes)                                 | §3.4 layers 2 and 3 for Gemini and Groq with all their constraints, the start-up refresh and clearing proof of §3.2, and the tests of §6.1 (SR-H-1..SR-M-11). Nothing from §3.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **5.4c-W** Extraction worker service (**prerequisite**: none exists on main; the prod compose has `postgres`, `redis`, `api`, `nginx`) | **coder · opus** for the entrypoint and the `ExtractionPort` adapter; **DevOps** · sonnet for the service                                                    | 5.4c-6, plan Task 2.5 (the collection side)                     | The process of §2.1 and the entry of §2.4, with health flags carried as §5.3 says. Tests: an unauthenticated call, a foreign field and a version mismatch are each refused with zero requests at any route; a contact in the input reaches a fake route stripped and raises the event; a flag in the state file reaches the next reply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5.4c-3** Wiring                                                                                                                      | coder · **opus**, high                                                                                                                                       | 5.4c-2, 5.4c-6, 5.4c-W                                          | Optional env keys read only by the extraction worker (the `LOCAL_MODEL_URL` refine unchanged), `INFERENCE_EXTRACTION_PROVIDER=router` there, `buildInferenceConfig` mapping, `ModelStructurer` built with `timeoutMs` and `abandonedHoldMs` from `routerCallCeilingMs`, the **mandatory** `onEvent` consumer of §5.3; a test pins `ModelStructurer` as the only consumer of the extraction port in `apps/api`, so a future direct caller cannot skip the guards; no log line carries a key or text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **5.4c-4** Preflight + health                                                                                                          | coder · sonnet, medium                                                                                                                                       | 5.4c-W                                                          | Preflight before a model-using cycle; "model unreachable" health signal, cleared only by a later call that reaches the model; deterministic stages unaffected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **5.4c-5** Hosted enablement                                                                                                           | DevOps · sonnet + human-only (keys, egress)                                                                                                                  | 5.4c-8, 5.4c-W, MP-03, 5.4c-2b, 5.4c-3                          | Gemini and Groq keys provisioned by the owner into the extraction worker, **each from a free-tier project or account with no billing enabled**: billing brings different cost and data terms from the ones D2 accepted, and removes the hard stop §3.1 relies on; egress allowlist per provider host (listing endpoints included); controlled smoke per route (Task 5.2), which runs the owner's redacted calls of §2.3; Groq's zero data retention if the owner wants it (§4 item 3). The floor is live before any hosted key exists                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **5.4c-6** Small dose and call control                                                                                                 | coder · **opus**, high (cross-package contract: `ExtractionRequest`, `ModelStructurer`, `ModelBudgetPort`, `buildExtractionPrompt`, `guardExtractionResult`) | 5.4c-2, 5.4b                                                    | §5.4 and §5.5, unconditional, the outcome table included, and the D10 guard change with its test (§6.1). **This changes the 5.4b hold and contract** (§5.5). **MP-03 tunes the table and does not gate it**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **5.4c-7** MP-04: local model measurement (gate of 5.4c-8)                                                                             | **DevOps** · sonnet for the container definition, the guards and the harness; **where the replay runs and who runs it: D9**                                  | 5.4c-0, 5.4c-6, MP-05 baseline                                  | **Makes a merged model service unable to start on production without the owner (§8.6):** a separate compose file and project, a CI assertion, the rehearsal of the deploy paths. Container definition per Task 5.2 and §8.3, limited to the production host's budget, thresholds frozen in the task file before the run. For each candidate on the MP-03 labelled set through the production pipeline with the small dose, on synthetic or seed data only (D9): tokens/s, wall time per record, peak RAM, CPU, cold load, CRM p95 with and without, estimate against reported prompt tokens, reasoning output, whether a disconnect stops generation, plus the MP-03 local-phase metrics (§6.2). **Output: the pick with its digest, licence and limits, the frozen floor budget and cycle limit, or "none passes", which goes to D8.** Tunes the §5.4 table with MP-03                                                                                                                       |
| **5.4c-8** Provision and install the local model                                                                                       | DevOps · sonnet prepares; **the owner runs it on the production server (A3: prod)**                                                                          | 5.4c-7 passing, 5.4c-W, 5.4c-3, 5.4c-4, the owner's explicit go | Runbook section for the owner-run start of the opt-in project (§8.6): pinned image and weights by digest with verification, limits, the extraction worker's persistent volume, the two workers' own `0600` env files (§2.4) with a generated `EXTRACTION_WORKER_SECRET`; on the host, the checks of §8.3 (outbound attempt fails, no published port, marker prompt absent from the container log), **neither the API container nor the collection worker is on the runtime network, and neither env holds hosted keys or `ROUTER_LOCAL_MODEL_URL`; the §2.4 network holds only the two workers with no published port, the API env lacks the secret, and an unauthenticated call is refused**, the window set server-wide and checked with the head marker, and a preflight (§8.4); the owner-run VPS smoke of §8.2 (D9); the undo of §8.6. Then `INFERENCE_EXTRACTION_PROVIDER=router` in the worker with no hosted key: local-only and working. **No agent runs a production step unasked** |

MP-03 itself stays the plan's measurement. Its local phase runs with 5.4c-7 and on the same set; its hosted phase runs
once keys exist for the measurement and before 5.4c-5 (§6.2). MP-03 still gates hosted enablement and picks hosted
candidates; it does not gate the small dose.

---

## 8. The CRM's own local model

**Owner correction, 2026-11-04:** "We do not take the model from the factory. The factory's model is an example of using
a local model so that it does not fail on every prompt. We must install our own lightweight model on the server,
sufficient for our tasks. Take that strategy and adapt it to our needs."

### 8.1 What is adopted, and what is not

**Not adopted: VCF's model and hardware.** VCF runs Qwen text and vision models on a 6 GB RTX 3060, chosen by measuring
them against VCF's own prompts on that card. None of VCF's model names, digests, windows or timeouts is a CRM default,
and its success on a GPU says nothing about a CPU host. **Adopted: the strategy**, §8.4.

### 8.2 The host

| Fact                                                                                                                 | Source                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Target VPS: Hetzner CX33, 4 vCPU, 8 GB RAM. The runbook mentions no GPU anywhere, so the design assumes **CPU only** | `docs/runbooks/deployment.md`                          |
| Measured on production 2026-10-18: 4 cores, 7.6 GB RAM (6.6 free), 41 GB disk free                                   | plan, owner's dependency answers; not re-measured here |
| Shared with the whole CRM (nginx, API, Postgres, Redis), and later the extraction worker and one headless browser    | runbook; plan Tasks 5.1, 5.2                           |

The plan's note of 2026-10-18 says a local model "at usable speed" does not fit this host. No MP-04 measurement stands
behind it, and it predates a batch, field-group design. This ADR neither relies on it nor overrules it: **MP-04 decides**,
and the fall-back is §8.5. "Usable" is defined by the workload rather than by tokens per second: the due model calls of
a cycle complete inside the collection window while the CRM keeps its p95. The thresholds are frozen in the MP-04 task
file before the run. **Confidence: LOW** that a passing model exists on this host; that is why the gate exists.

**Where MP-04 runs (owner decision D9, 2026-11-04):** on the VPS, run by Master over the ssh alias (owner-authorized
2026-11-04), the candidate in a container limited to this host's budget (4 vCPU and the RAM left to it beside the CRM, from
MP-05), with synthetic data only, and stopped if CRM p95 degrades. **Alternative path:** the owner's own machine under the same
limit, synthetic or seed data only. That result is **indicative of the VPS, not proof**: CPU generation and memory bandwidth
differ. Either way 5.4c-8 checks on the VPS after install, owner-run: a short smoke with the container limit on, wall time per
record against MP-04's frozen thresholds, and an abort if CRM p95 degrades.

### 8.3 Selection criteria (all must hold, measured on the pinned runtime)

The model is a lightweight **text** model chosen for extraction on this host. No vision, no tools.

1. **RAM ceiling.** Peak memory of the runtime, with the model loaded **at the configured window**, stays inside the
   container limit, and the limit leaves the CRM its p95/p99 (MP-05 baseline) with the worker and browser running. Free
   memory measured today is the outer bound, not the ceiling.
2. **Context window at least the input size.** The effective window holds the instruction, the group schema, the answer
   and correction reserves, and a typical detail page uncut (MP-02 sizes). The input ceiling follows the window (§2.1), so
   a smaller window is legal only while it still holds such a page. Note: the package caps input at
   `MAX_EXTRACTION_INPUT_CHARS` (50 000) while plan Task 5.4 defaults to 60 000 characters; the local ceiling applies
   below both.
3. **JSON-schema enforcement on the pinned runtime**, for this model, through the OpenAI-compatible endpoint. A model
   that answers empty under the schema fails, whatever it answers without one.
4. **A licence that permits commercial use**, read at the pinned digest and recorded.
5. **Sufficient for our tasks:** the small dose of §5.4 passes MP-03's accuracy, grounding and schema-valid thresholds on
   the labelled set, on Ukrainian and English pages alike.
6. **Wall time:** one record, all groups asked, fits the workload definition of §8.2, on the shared CPU, cold load
   included.
7. **A disconnect stops generation** on the pinned runtime (§5.5): a call that was aborted must not keep the CPU busy.

**The pick is made by MP-04, not here.** Candidates to start from, **all unverified** (fit, licence, schema behaviour and
availability on the runtime are for 5.4c-0 and MP-04): small quantised open-weight text models of the Qwen, Gemma, Phi and
Llama families. Being in this list is not a recommendation, and the Qwen family's use in VCF is not evidence for this host.

**Runtime**, from plan Task 5.2 (OpenAI-compatible, enforcing JSON schema: Ollama's OpenAI endpoint, llama.cpp server or
vLLM, confirmed on the pinned version; one that needs a GPU drops out; concurrency 1), made verifiable. 5.4c-8 checks each
item on the host:

- **Network:** a dedicated `internal: true` network shared only with the extraction worker; no API, nginx or collection worker
  on it and **no `ports:`**, because published ports bypass the host firewall and these runtimes commonly serve without auth. An
  outbound attempt from the container fails.
- **Logs:** request and prompt logging off (§4 item 2). A marker prompt is sent and is absent from the container log.
- **Supply chain:** image pinned by `sha256` digest; weights fetched at provisioning by digest, verified after fetch, in a
  non-executable format (GGUF or safetensors, never pickle, no remote code).
- **Container:** non-root, `no-new-privileges`, capabilities dropped, CPU, RAM, thread and pids limits.

### 8.4 The strategy: mandatory behaviour of the local route

What keeps a small model from failing on every prompt. None of it is optional and none has a config switch; a route that
cannot satisfy it is not the local route.

| Behaviour                                                                                                                                                                                                                           | VCF origin                                                      | In the CRM                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Small dose:** the full schema is never sent to a model that cannot answer it                                                                                                                                                      | `DosedCall`, `callDosed`, `SmallDoseNeeded`, `pinnedLocal`      | §5.4, task 5.4c-6                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Refuse, never truncate:** a prompt that does not fit is an error before it is sent. VCF's runtime kept the tail and dropped the instructions at the top, silently: here that would drop the untrusted-data rule and keep the page | `promptFits`, `estimateTokens`, `ANSWER_RESERVE_TOKENS`         | `PROMPT_TOO_LARGE` (§5.1), checked per HTTP request with the correction reserved. Only code cuts text, only the page text, and it reports `truncated`. The estimate is conservative and tuned on our text: VCF's constants are starting values, and Cyrillic tokenises differently, so MP-04 compares the estimate with the runtime's reported prompt tokens                                                                 |
| **The window is set, and checked:** a runtime default smaller than the configured window is the same silent truncation by another route                                                                                             | `num_ctx` on every request                                      | No candidate runtime takes a per-request window on its OpenAI-compatible endpoint (5.4c-0): 5.4c-8 sets it server-wide (`OLLAMA_CONTEXT_LENGTH`, default 4096; llama.cpp `--ctx-size`; vLLM `--max-model-len`), and the route's configured window is that same value. 5.4c-8 verifies it with a prompt near the window whose answer depends on a marker at its **head**, and repeats that after any runtime or digest change |
| **Input sized to the window**                                                                                                                                                                                                       | `promptBudget`                                                  | input ceiling helper, consumed by `buildExtractionPrompt` (§2.1)                                                                                                                                                                                                                                                                                                                                                             |
| **Preflight** before a cycle; no answer stops the model stage only, and a durable signal stays up                                                                                                                                   | `PREFLIGHT_PROMPT`, `PREFLIGHT_BACKOFF_MS`, `MODEL_UNREACHABLE` | §5.3, task 5.4c-4                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Wall-clock ceiling** on one logical call, and a stop that stops                                                                                                                                                                   | `boundExecutor`                                                 | §5.5                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **A slow answer is not a dead one:** Node's fetch gave up waiting for headers at 300 s, so an unstreamed answer past that died as "fetch failed" whatever the timeout said                                                          | `stream: true`                                                  | The per-request timeout is set by MP-04 (the package default is 60 s, plan Task 5.4 says 120 s). The local route's config refuses a timeout of 300 s or more until the leaf streams; if MP-04 needs one, streaming is added then                                                                                                                                                                                             |
| **An empty answer is a failure**                                                                                                                                                                                                    | "returned no content"                                           | `INVALID_OUTPUT` (§5.1), never "nothing found"                                                                                                                                                                                                                                                                                                                                                                               |
| **No decoder sees a length, and the answer is bounded another way:** a grammar closes a string where `maxLength` runs out, and the cut text parses and passes. Without a bound a looping decoder runs to the timeout                | `withoutLengths`                                                | The schema sent to any route is rendered without `maxLength`; lengths hold in local Zod validation. Array bounds stay. Every local request sets `max_tokens` from its group's `maxAnswerTokens`, every probe a small constant; a truncated answer is `INVALID_OUTPUT`                                                                                                                                                        |
| **Structured and deterministic:** the schema enforced by the runtime, temperature 0                                                                                                                                                 | `format`, `temperature: 0`                                      | Task 5.4c-1. Today the shared chat call sends no `response_format` and temperature 0.1, so this is a change for the router's local route only; `provider: local` keeps its behaviour                                                                                                                                                                                                                                         |
| **Code first:** what code can decide is not asked                                                                                                                                                                                   | `pickPayoffLine`, skipped `planBeats`                           | §5.4; a group with no missing field is not asked                                                                                                                                                                                                                                                                                                                                                                             |

**Model-specific or hardware-specific in VCF, and not adopted as a rule:**

- **The thinking-mode workaround** (`SKIP_REASONING`, an empty closed `<think>` prefill, and `think: false`). VCF's own
  notes show the behaviour differs between two models of one family. For the CRM it is an MP-04 observation, not a rule:
  reasoning output costs wall time and may empty a schema answer, so a candidate shows it under criteria 3 and 6. If the
  chosen model needs a flag, it is recorded beside that model's pin and leaves with it.
- **Free-text answers read by word matching** (`frameAnswer`, no `format`): it exists because a vision model answered
  empty under a schema. Criterion 3 requires schema enforcement, so groups answer in schema. Reconsider only if no
  candidate passes that criterion, and that would be a change to this ADR.
- **Vision routing, image token budgets, frame scaling, `wsl-gateway` resolution, Ollama's native `/api/chat`.**
- **`unloadModel` and `keep_alive`** as VCF sets them: they solve VRAM contention with a transcriber on a 6 GB card. The
  CRM's analogue is RAM shared with the CRM, so how long the model stays resident between cycles is a value MP-04 chooses
  and the container limit bounds, not VCF's ten minutes.
- **VCF's values:** `LOCAL_CONTEXT_TOKENS`, its ten-minute timeout, `MAX_READINGS_PER_RUN` (the CRM's shared 20-call budget
  stands).

VCF's notes also say a bigger server with a model that holds a JSON schema would make its frame decomposition
unnecessary. That is why the field-group table is tunable down to one group (§5.4) rather than fixed.

### 8.5 If no model passes on the VPS — owner decision D8 (A3, asked only then)

No automatic fall-back. The router's schema requires the local route, so **hosted routes do not run without a floor**:
"everything must work on the local model alone" is what that requirement enforces. Per the plan, the owner chooses:

- **Another host** for the runtime, reached over HTTPS on a private address (§3.3); same criteria, re-measured there; or
- **Deterministic HTML with model extraction disabled** (plan Task 5.2 allows it): the deterministic stages ship, and
  sources or fields that need a model wait.

Running hosted routes with no floor would be a reversal of the 2026-10-18 rule, and only the owner can make it.

### 8.6 Installation is an owner action

Nothing here authorises an agent to touch production. DevOps prepares and documents (tasks 5.4c-7, 5.4c-8); **the owner
runs every production step, or instructs it explicitly at that moment** (A3: prod). Undo: stop and remove the container and
its **weights** volume, not the worker's state volume; the preflight then fails loudly, the model stage does not start, and
the deterministic stages and the CRM carry on.

**A merged change must not be able to start the runtime on production.** `deploy-stack-on-vps.sh` runs `up -d
--remove-orphans` on `docker-compose.prod.yml` with no service list, so a service added to that file starts on the next
deploy and takes RAM from the CRM. Task 5.4c-7 (DevOps) therefore:

- puts the runtime and the extraction worker in a **separate compose file with its own project name**, which the deploy script
  does not name. A CI assertion fails if the composed deploy configuration (`docker-compose.prod.yml` with the
  `docker-compose.ghcr.yml` overlay) gains a model service or the deploy script names that file;
- gives the runtime network to that project, because a foreign container on a network of the main stack could fail the
  `down --remove-orphans` of the deploy's network-reset path, and a missing external network would fail its `up`. How the §2.4
  network crosses projects, surviving deploys and coupling neither, is that task's to settle and rehearse;
- **tests on the disposable host, by rehearsing both deploy paths with the runtime up**, that it survives and stays
  reachable. Orphan removal is expected to be scoped by project; that was read from the script's flags and is unverified,
  hence the test. A profile in the main file is rejected because it does depend on how `--remove-orphans` treats inactive
  profiles.

The existing `local` adapter admits a loopback base URL only, and the router's local route has its own URL key and transport
option (§3.3), so `provider: local` stays as it is, for loopback use.

---

## Consequences

- **Positive.** The owner's chain arrives behind `ExtractionPort` with an unchanged result type. Local-only is the working
  state from the install; hosted routes are additive. Pacing below the providers' limits makes "refused" the exception.
  Every fall and every failure is an event with a code. The local floor is dosed from its first call, so it does not depend
  on a measurement to stop failing. A cycle's cancellation now truly stops the router's sending, which main could not do;
  `local` and `openrouter` keep their bounded hold, and they stop only at their next request timeout.
- **Negative.** Logic similar to VCF's is maintained twice, by hand. A second process, with an authenticated entry and a secret
  to provision (§2.4). The merged 5.4b port and structurer change: a signal, a real schema, a derived hold. The worker needs a
  persistent volume for two small state files. The hosted model ids in use
  change without a PR (D6): a refresh can add a model nobody reviewed — bounded by the provider allowlist, the Groq family
  pattern, the Gemini family pattern, id validation and `TARGET`. Two providers mean two sets of terms, keys and egress rules
  to keep current. A small dose costs one prompt evaluation per group, so floor extraction is slow by construction, and a
  cycle over its local-time limit leaves records due. The input ceiling cuts long pages for hosted routes too. The local
  model takes memory and CPU from the CRM's own host; the container limits bound that, and MP-04 measures it.
- **Privacy, accepted.** D1 and D2 trade the per-source local-only default for simplicity and capacity. The residual risk
  is stated in §4.1 and accepted by the owner. No configuration keeps one source local; a source is stopped from reaching
  any model by disabling it or building its provider without `model`.
- **Probation is weaker than it looks (SR LOW notes).** "Serves only when every older model failed" is **routine**, not
  rare: free tiers hit their daily limits most days, so once the older models of a provider are spent, its tail
  (unreviewed, on-probation) models answer real vacancy text regularly. Probation limits ordering, not exposure; the
  exposure bounds are the provider allowlist, the patterns and id validation. Conversely, a provider that is busy
  (`transient`) on probe days resets streaks and can **delay promotion indefinitely** — this fails safe (the model stays
  at the tail) and costs only ordering quality.
- **Risks.** Provider error formats change silently: a per-day 429 read as `BUSY` costs a few wasted requests, not a
  failure (the cascade moves on), and the fixtures make the drift visible when updated. No model may pass on this host:
  the gate is MP-04 and the answer is D8, with model extraction waiting rather than failing. Field groups may lose
  cross-field context a full schema would have kept: MP-03 measures it and tunes the table. With two hosted providers, a
  day both are spent is a floor-only day: slower, loud, and correct. D10 drops a true field the model did not quote (§5.4).
  MP-04's local result may not hold on the VPS; the post-install smoke catches that. A compromised collection worker can
  defeat `ai-input=no` (§2.4).

## Rollback

| Level                                   | Command / action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Expected state                                                                                    | Verification                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Runtime, instant — the privacy rollback | Remove `GEMINI_API_KEY` and `GROQ_API_KEY` from the worker env, restart. **Not** `INFERENCE_EXTRACTION_PROVIDER=openrouter`: that sends text to a hosted route. Text already sent is not recalled                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Router with the floor alone; no hosted request, and self-heal has nothing to refresh              | Router events list only the local route; no request to a hosted host in egress logs                         |
| Hosted, one provider                    | Remove that provider's key from the worker env                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | That route does not exist; the chain keeps the rest and the floor                                 | Router events list no attempt for that provider                                                             |
| Self-heal only                          | Disable the daily refresh job; delete the managed-list file to return to the pinned fallback lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Request-time retirement still works; lists stop changing                                          | `managedModels` events name the fallback; no listing request in egress logs                                 |
| Per source                              | Disable the source, or build its `HtmlProvider` without `model`. Setting `onUnspecified` is not this control: it affects only an `unspecified` signal, and a source whose robots say `yes` is allowed whatever the policy                                                                                                                                                                                                                                                                                                                                                                                                                                 | That source's text reaches no route                                                               | Its report's model stage is `SKIPPED`; no model event and no budget reservation for its records             |
| Local model (owner-run, §8.6)           | Stop and remove the runtime container and its weights volume; keep the worker's state volume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Preflight fails loudly, the model stage does not start, deterministic stages and the CRM carry on | "Model unreachable" health signal up; CRM p95 back to baseline                                              |
| Small-dose table                        | Revert the table to its previous reviewed edition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The same hand-back and runner with the previous groups                                            | Per-group events name the previous groups                                                                   |
| Code                                    | Set `INFERENCE_EXTRACTION_PROVIDER=local` first (a reverted env schema no longer accepts `router`), then `git revert` the 5.4c-n PR(s), newest first. `ROUTER_LOCAL_MODEL_URL` may stay: it is a separate key, the reverted schema drops unknown keys (no `.strict()` on it), and `LOCAL_MODEL_URL` was never widened, so the API still boots. `local` reaches loopback only, so with the runtime in its own container extraction reports `NOT_CONFIGURED` or `PROVIDER_ERROR` until wiring is restored. No text leaves, but **coverage is lost**: main's code clears those records on either code, so they get no model pass until their content changes | `@crm/inference` back to `local` / `openrouter`; no schema migration to undo                      | `pnpm --filter @crm/inference test` and the API inference specs green; the API boots with the key still set |
| This ADR                                | Close or revert its PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No decision recorded; 5.4b unaffected                                                             | `docs/architecture/` no longer lists the file                                                               |

## Sources

- Owner decision 2026-10-18 and the Task 5.4 amendment of 2026-11-03: `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`
  (§"Model split — owner decision, 2026-10-18"; the owner's VPS capacity answer; Tasks 5.2, 5.4, 5.5; MP-03, MP-04, MP-05).
- Owner corrections and decisions D1–D3, 2026-11-04, relayed by Master; D6, 2026-11-03, relayed by Master.
- `docs/runbooks/deployment.md` — target VPS and what shares it.
- Task files for 5.4a (guards) and 5.4b (`HtmlStructurer`, `ModelBudgetPort`) — Master's task set of 2026-11-03.
- `@crm/inference`: `ExtractionPort`, `ExtractionRequest`, `MAX_EXTRACTION_INPUT_CHARS`, `MAX_EXTRACTION_INSTRUCTION_CHARS`,
  `MAX_CORRECTION_CHARS`, `InferenceErrorCode`, `inferenceConfigSchema`, `InferenceClient`, `createLocalExtractionAdapter`
  (loopback only), `createOpenRouterExtractionAdapter`, `sendChatCompletion` (already sends `data_collection: deny` for
  `openrouter`; no `response_format` or `max_tokens`; temperature 0.1), `isModelUnavailable`, `selectModel`,
  `boundedRequest` and `isUrlAllowed`, `DEFAULT_TIMEOUT_MS`.
- `apps/api` job sourcing, read at main `10e99b08`: `ModelStructurer`, `EXTRACTOR_FAILED`, `stripContacts`, `assertModelAllowed`, `DEFAULT_STRUCTURER_TIMEOUT_MS`,
  `DEFAULT_ABANDONED_HOLD_MS`, `BY_INFERENCE_CODE`, `assertModelAllowed`, `buildExtractionPrompt`, `MAX_MODEL_INPUT_CHARS`,
  `EXTRACTION_SYSTEM_PROMPT`, `guardExtractionResult`, `DiscoveredRecord`, `HtmlProvider`; `validateEnv` and the
  `LOCAL_MODEL_URL` refine. `docker-compose.prod.yml` and `deploy-stack-on-vps.sh`.
- API: `buildInferenceConfig`, `InferenceModelResolverService`, the env schema's optional inference keys,
  `ModelUsage`, `settleModelPending`, `MODEL_BACKOFF_MS`, `MODEL_FILLABLE_FIELDS`.
- VideoContentFactory (read-only, 2026-11-03): `createChainExecutor`, `createFittingChainExecutor`,
  `createBalancedChainExecutor`, `createHybridExecutor`, `budgetGuarded`, `providerBudget`, `consumeQuota`,
  `createOpenAICompatExecutor` (`DAILY_LIMIT`, `COMPAT_MIN_GAP_MS`), `createGeminiExecutor` (`MIN_CALL_GAP_MS`,
  `BUSY_BACKOFF_MS`), `SpentStore`, `RetiredStore`, `retiredAnswer`, `classifyModelStatus`, `pickLiveModels`, the
  preflight constants, `boundExecutor`, `DosedCall` / `callDosed` / `SmallDoseNeeded`; its knowledge notes on model
  backends and per-call doses; its free-provider guide (card-requiring providers rejected) and provider-balancing plan;
  for self-heal (D6): its daily free-model refresh script (`PROBE_CAP`, `TARGET`, the fixed JSON probe prompt, the
  per-provider independence, the retirement reset after a fully successful run), `pickGroqModels`, `pickLiveModels`,
  `MIN_MANAGED_CONTEXT`, `parseModelFile` / `formatModelFile`, `managedModels` (pinned fallback on a missing or empty
  file), and the weekly chain check with its `MODEL_LIST_STALE` marker.
- VideoContentFactory for §5.4 and §8 (read-only, 2026-11-04, from the owner's Windows checkout at its commit `c18c40ca`
  of 2026-11-01, not the WSL copy): `dosePlanFor`, `pinnedLocal`, `withSmallDoseBehind`, `promptFits`, `estimateTokens`,
  `ANSWER_RESERVE_TOKENS`, `promptBudget`, `createOllamaExecutor`, `SKIP_REASONING`, `withoutLengths`, `unloadModel`,
  `MODEL_DOWN_FRESH_HOURS`, and the knowledge notes `llm-backends` and `model-call-doses`.
- Provider and runtime facts: `docs/architecture/2026-11-04-extraction-provider-facts.md` (5.4c-0, read 2026-11-04); what
  it could not settle is listed in §2.3. Nothing in this ADR was fetched from the network.
