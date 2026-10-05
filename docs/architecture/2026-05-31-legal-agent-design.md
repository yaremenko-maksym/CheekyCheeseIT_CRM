# Legal agent (Lawyer) — Design

**Status:** Design approved, awaiting implementation plan
**Date:** 2026-05-31
**Author:** AI Architect (under the user's guidance)
**Scope:** Phase 0 — infrastructure + integration. Phase 1 (knowledge base content) — separately.

## Context

The Cheeky Cheese IT CRM multi-agent system has 6 active roles (PM/BA/Coder/AutoTest/Reviewer/DevOps). One area is not covered — **legal/tax/compliance consulting**. Decisions about features (storing passports in S3, USDT smart-contract payouts, FOP regimes for JUNIORs, NDAs with clients, GDPR for EU clients) are made intuitively without a structural legal check.

**We add a 7th agent — the Lawyer.** It consults on 4 areas:

1. Ukraine FOP/taxes
2. IT contracts with clients (outsource/outstaffing, NDA, IP rights)
3. Crypto/USDT regulation (the UA law on virtual assets, AML/KYC)
4. GDPR / data privacy

PM can call the Lawyer on request, on changes in critical PR zones, and when validating a new feature before decomposition. The Lawyer is obliged to speak about risks and to propose the best solutions for the business.

## Decisions made (brainstorming summary)

| Decision             | Choice                                                                 | Rationale                                                                                              |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Scope coverage       | All 4 areas (UA FOP + IT-contracts + USDT + GDPR)                      | All 4 regularly come up in tasks. Splitting into sub-agents — over-engineering for our scale.          |
| Integration patterns | All 4 (on-demand + auto-PR + pre-feature + strategic)                  | Multi-mode covers both preventive (pre-feature) and detective (PR review) and ad-hoc consultations.    |
| Knowledge source     | Static base `docs/legal/` + WebSearch fallback with mandatory citation | Static — consistent answers, WebSearch — currency. Citation = anti-hallucination guard.                |
| Escalation policy    | Confidence-tagged (HIGH/MED/LOW + LOW mandatory verify with a human)   | Does not block consultations, but signals shaky advice. Hard refuse zones are too rigid.               |
| Architecture         | Local subagent dispatched by PM (Approach 1)                           | Reuses the existing `Agent()` pattern. Zero new infra. Strategic mode via PM proxy — overhead ≈ 0.     |

## Architecture

**Type:** a local subagent. Launched via `Agent(description="Legal: ...", prompt="...")` from the PM session. An analog of Reviewer/Coder. **Not a GHA workflow.**

**A single prompt with branch logic** on `mode={consult, pr-review, brief-check, strategic}`. All 4 modes share common logic (read knowledge base → analyze → structured output). The branch logic is minimal (where to read the input, where to write the output). This is easier to maintain than 4 different prompts.

## File structure

```
docs/
  agents/
    legal.md                              # the Lawyer's system prompt (NEW)
    CLAUDE-legal.md                       # operational notes (NEW)
    memory/legal/lessons.md               # accumulated lessons (NEW)
  legal/                                  # knowledge base (NEW root section)
    README.md                             # index of topic folders
    ua-fop/                               # FOP group 3, single tax, currency operations
    crypto-usdt/                          # UA law on virtual assets, USDT, AML, smart contract disclosure
    gdpr/                                 # personal data categories, processor/controller, breach notification
    it-contracts/                         # NDA templates, services agreement, IP rights clauses
    cross-cutting/
      escalation-zones.md                 # explicit list of when → a human lawyer (criminal/court/state bodies/specific tax amounts)
      citation-rules.md                   # how the Lawyer is obliged to cite (format, mandatory fields)
  specs/
    legal-consultations/                  # persistent log of Strategic-mode answers (NEW)
      README.md                           # index + naming rules
    tasks/
      templates/task-legal.md.tpl         # template for task-legal-*.md (NEW)
```

**Phase 0 deliverable:** the structure with placeholder content in `docs/legal/*/`. The user fills it with facts in Phase 1.

**No CLI scripts in Phase 0.** If Strategic mode becomes frequent — `scripts/legal/ask.sh` will be added later.

## Data flow across the 4 modes

### Mode A — On-demand consultation

1. User or PM formulates a question
2. PM creates `docs/specs/tasks/task-legal-<slug>.md` with the question + relevant context (links to `docs/business/`)
3. PM: `Agent(description="Legal: <slug>", prompt="You are the Legal agent. Read docs/agents/legal.md. mode=consult. Task: docs/specs/tasks/task-legal-<slug>.md")`
4. Legal reads the task → reads the relevant `docs/legal/<topic>/*.md` → opt. WebSearch (with mandatory citation) → appends `## Lawyer's answer` into the task-file
5. PM reads the result → informs the User in chat
6. The action decision — with PM/User. If Confidence: LOW and the decision is action-critical — a recommendation to escalate to a human lawyer

### Mode B — Auto PR review (critical zones)

1. After the Coder created/updated a PR → PM in Mode 2, in parallel with dispatching the Reviewer, checks the diff
2. **Trigger heuristic:** the diff matches any of the patterns:
   - `apps/api/src/{finance,auth,documents,users}/**`
   - `packages/shared/src/schemas/{auth,finance,users,documents}.ts`
   - Adding new S3/wallet/passport/personal-data fields to schema.ts
   - Adding third-party integrations (new npm packages with network access)
3. If match → `Agent(Legal, mode=pr-review, pr_number=<N>)` in parallel with the Reviewer
4. Legal reads the diff via `mcp__github__get_pull_request_files` → reads the relevant `docs/legal/` → analyzes → **write-then-post pattern** (like the Reviewer): saves the body to `/tmp/legal-output/pr-<N>-<ts>.md` BEFORE the MCP call (resilience against an MCP hang)
5. Legal posts via `mcp__github__create_pull_request_review` with `event: COMMENT`, the body's first line: `Legal Review: <Confidence>` + a structured body
6. **Info-only.** Does not block merge. The PR gets the label `legal-noted`. Critical findings → PM escalates to the User separately in chat

### Mode C — Pre-feature brief check

1. On receiving `docs/specs/pm-brief.md` from BA, PM in Mode 1 Step 1 applies the heuristic
2. **Trigger heuristic:** the brief mentions any of:
   - finance / payments / transactions / payouts
   - user data storage (passport, wallet, telegram, phone)
   - contracts / NDA / IP / agreements
   - crypto / USDT / smart-contract
   - third-party integration (S3, Etherscan, NBU API, new SaaS)
   - hiring / employment (new user roles or work scenarios)
3. If match → `Agent(Legal, mode=brief-check, brief_file=docs/specs/pm-brief.md)` **before decomposition**
4. Legal returns the structure (like mode A) with emphasis on recommendations for the AC. Example output: "Add an encrypted-at-rest requirement to the storage AC", "GDPR Art.13 — add a consent flow to the registration AC"
5. PM includes the Legal recommendations in the task decomposition (Mode 1 Step 2). Recommendations are logged in `pm-state.json.events[]` as `legal_pre_feature_done`

### Mode D — Strategic advisor

1. User in chat: "ask the lawyer — can we hire a JUNIOR through a FOP group 2?"
2. PM recognizes a legal question → creates `docs/specs/legal-consultations/YYYY-MM-DD-<slug>.md` with the question
3. `Agent(Legal, mode=strategic, consultation_file=docs/specs/legal-consultations/...)`
4. Legal answers into the file (the same output structure)
5. PM shows the TL;DR + Confidence + Recommendation to the User in chat. The User reads the full answer in the file if desired

**Difference from Mode A:** Mode A — the task flow is tied to a specific feature/PR. Mode D — a strategic question outside the feature pipeline. A persistent log in `docs/specs/legal-consultations/` for future reference.

## Output format (mandatory structure)

Every Legal answer — a mandatory structure, the same for all 4 modes:

```markdown
## Lawyer's answer

**Confidence:** HIGH | MED | LOW
**Mode:** consult | pr-review | brief-check | strategic
**Date:** YYYY-MM-DD

### TL;DR

1-2 sentences. A direct answer to the question.

### Analysis

What the laws / regulations say. Specific articles / norms / precedents.
The context of applicability to our situation.

### Risks (at least 1 row — even "no material ones" = Low/Low with a reason)

| Risk | Severity                       | Probability         | Mitigation     |
| ---- | ------------------------------ | ------------------- | -------------- |
| ...  | Critical / High / Medium / Low | High / Medium / Low | concrete step  |

### Recommendation (best for business)

1. <concrete step 1>
2. <concrete step 2>
3. ...

### Sources

- [Article 24 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/...) — the specific norm
- `docs/legal/ua-fop/fop-3-group.md` — the internal base
- WebSearch: `<url> (collection date: YYYY-MM-DD)` — for dynamic lookups

### Disclaimer

- **Confidence: LOW** → MANDATORY verify with a human lawyer BEFORE action. This consultation — a preliminary check, not binding advice.
- (HIGH/MED) AI preliminary check. For critical decisions (court, disputes with state bodies, criminal risks, tax amounts > 100k UAH) — escalate to a human lawyer.
```

**Hard rule in the system prompt:**

> Answering without citing a source is forbidden. If there is no source → Confidence: LOW + an explicit flag "based on general principles, not specific statute".

## Confidence policy

| Level    | When to set                                                                                 | User action                                               |
| -------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **HIGH** | The static base covers it with an explicit article of the law, the answer is unambiguous, no contradictory practice | May act on the recommendation with ordinary caution       |
| **MED**  | A basis exists in `docs/legal/` or WebSearch, but an edge case / interpretation needs clarification | Additional verification is desirable for a high-stakes action |
| **LOW**  | The question is beyond the base, WebSearch gave no clear source, contradictory practice      | **MUST** verify with a human lawyer BEFORE action         |

## PM integration (pinpoint edits in existing files)

| File                                               | Change                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/agents/pm.md` Mode 1                         | Add Step 1.5 — a Legal touchpoints heuristic check on pm-brief.md. If match → a Mode C dispatch BEFORE decomposition                             |
| `docs/agents/pm.md` Mode 2                         | Add a row to the events table: `PR diff matches critical zones → MUST dispatch Legal in pr-review mode (info-only, label legal-noted)`           |
| `docs/agents/pm-snippets.md`                       | A new section "Legal — dispatch snippets": 4 Agent templates (one per mode)                                                                      |
| `docs/agents/CLAUDE-pm.md`                         | Legal in the durations table (~10-15 min per consultation, MED for a PR review with a large diff)                                               |
| `docs/agents/CLAUDE-pm.md` pm-state.json schema v2 | Add event types: `legal_dispatched`, `legal_review_posted`, `legal_pre_feature_done`, `legal_escalated_to_human`                                 |
| `.github/labels.yml`                               | Add label `legal-noted` (color `0075ca` info-blue, description "Legal review posted — info only, does not block merge")                         |
| `docs/agents/coder.md` Zone-of-write               | Add `docs/legal/**` to the Coder's off-limits zone (legal knowledge is updated via User/PM, not the Coder)                                       |
| `docs/agents/reviewer.md`                          | Add a note: "Legal review (if present on a PR) — info-only, do not treat as a gate. The Reviewer focuses on code quality, Legal — on the legal angle" |

## Anti-scope (what we do NOT do)

| We do not do                                          | Reason                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Auto-block merge on legal findings                    | The Lawyer is info-only. The decision to block — with PM/User. An AI lawyer can be wrong, a hard-block creates operational risk |
| GHA workflow                                          | All consultations < 1 min for PM. GHA would add 3-5 min of runner overhead per consultation                        |
| A CLI script `scripts/legal/ask.sh` in Phase 0        | YAGNI. Strategic mode via PM proxy — overhead ≈ 0. We will add it if Strategic mode becomes frequent               |
| Real-time monitoring of draft laws                    | Out of scope. WebSearch on-demand per question is sufficient                                                      |
| Legal unit/E2E tests                                  | Tests on AI prompt output — make no sense. Validation = user feedback + lessons.md                                |
| Replacement of a human lawyer                         | The Lawyer — a preliminary check for typical questions. Critical decisions always → a human                       |
| Multiple sub-agents (Tax lawyer, IT lawyer, GDPR lawyer) | Over-engineering for our scale. A single Legal with topic folders in the knowledge base is sufficient             |

## Memory + Lessons

`docs/agents/memory/legal/lessons.md` — the format as with the other agents:

```
YYYY-MM-DD [P0|P1|P2] [<task-id>] #topic-tag <a concrete lesson>
```

Lessons are written by PM after:

- A merged PR where Legal was attached in Mode B
- A closed consultation in Mode A/D
- A pre-feature check in Mode C where the Legal recommendation actually affected the decomposition

Examples of what to record (placeholder for future sessions):

- `2026-XX-XX [P0] [task-legal-fop-currency] #ua-fop FOP group 3 limit USD/EUR turnover 7M UAH for 2026 — exceeding it requires switching to the general system`
- `2026-XX-XX [P1] [task-legal-passport-s3] #gdpr Storing passports in S3 requires encrypted-at-rest (AWS KMS) + an access log + a retention policy max 3 years after dismissal`
- `2026-XX-XX [P2] [pr-N-finance] #usdt-aml USDT transactions > $1000 per day to one recipient — flag for an AML check, does not block but record in the audit log`

## Phasing

**Phase 0 — Infrastructure (this design → implementation plan):**

1. Create `docs/agents/legal.md` (system prompt) + `CLAUDE-legal.md` (operational notes) + `memory/legal/lessons.md` (empty with a header)
2. Create the `docs/legal/` skeleton:
   - `README.md` — index + update rules
   - One placeholder file in each topic folder (ua-fop, crypto-usdt, gdpr, it-contracts, cross-cutting). The placeholder contains: the folder scope, links to authoritative sources, the instruction "the User fills it with facts in Phase 1"
   - `cross-cutting/escalation-zones.md` — an explicit list (this is critical for the confidence policy)
   - `cross-cutting/citation-rules.md` — the format for citation
3. Create `docs/specs/tasks/templates/task-legal.md.tpl`
4. Create `docs/specs/legal-consultations/README.md` (an empty folder with naming rules)
5. Update `pm.md`, `pm-snippets.md`, `CLAUDE-pm.md`, `coder.md`, `reviewer.md` (pinpoint edits from the table above)
6. Update `.github/labels.yml` — add `legal-noted`

(This file — a design doc + ADR in one. We do not create a separate ADR — all decisions are fixed here, a link from CLAUDE.md / pm.md leads here.)

**Phase 1 — Knowledge seeding + the first real consultation (after Phase 0 is merged):**

- Fill `docs/legal/ua-fop/`, `gdpr/`, `crypto-usdt/`, `it-contracts/` with facts. The User feeds them or copies from existing sources
- The first real consultation (any mode) — calibration of the answer against the expected
- Tune `escalation-zones.md` based on real experience
- Tune the Confidence policy thresholds if the answers are too cautious / too confident

**Phase 2 — Optional extensions (the distant future):**

- `scripts/legal/ask.sh` CLI if Strategic mode is frequent
- A decision log / audit trail for regulatory compliance
- Auto-updating `docs/legal/` via a scheduled WebSearch on changes in the laws (dangerous — it may miss or mislead, needs human review)

## Open questions / known risks

1. **Hallucination risk.** The AI lawyer may invent an article / misinterpret a norm. Mitigation: a hard citation rule, the Confidence policy, LOW = must-human-verify, lessons.md tracking of misses.
2. **WebSearch stale results.** WebSearch may return outdated data (the law changed). Mitigation: Legal is obliged to state the collection date on a WebSearch, and where possible to compare with docs/legal/ (if the internal base says otherwise — Confidence: LOW).
3. **Critical zones heuristic accuracy.** It may miss a PR with a legal touchpoint (false negative) or pull it in for nothing (false positive). Mitigation: log in pm-state.json `events[]`, after several rounds tune the patterns. The initial heuristic — broad strokes (better a false positive than a negative).
4. **Strategic mode discovery.** How does the User learn that they can "ask the lawyer" in chat? Mitigation: document it in CLAUDE.md project memory + demonstrate the first Strategic request in onboarding.
5. **Knowledge base maintenance burden.** docs/legal/ currency — manual work. Mitigation: explicitly beyond Phase 0. Lessons + subsequent consultations show which topics are really needed → we do not do upfront comprehensive seeding.
6. **Legal liability.** If the AI lawyer gives advice and the user follows it — who is responsible? Mitigation: a mandatory Disclaimer in every answer. The project README / docs/legal/README.md explicitly state "AI preliminary check, not a replacement". This is an organisational, not a technical mitigation.

## References

- `docs/agents/pm.md` — PM workflow (Mode 1-4)
- `docs/agents/reviewer.md` — the write-then-post pattern (Mode B borrows it)
- `docs/agents/CLAUDE-pm.md` — pm-state.json schema v2 (we extend the event types)
- `docs/architecture/2026-05-23-dev-flow-rca.md` — context for recovery patterns
- CLAUDE.md (root) — stack, business rules, agents overview
