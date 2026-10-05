# Workflow Registry — read-only audit/research fan-outs (on-demand)

Catalog of **read-only audit/research workflows** (Decision 2 from `rules/common/orchestration-routing.md`).
The engine is the `Workflow` tool OR the skill `codebase-audit` (N×haiku explore in waves ≤ 3-4 → opus synthesis → adversarial verify).

**Master does not read this upfront** — it checks against this file when an event looks like a trigger below.

---

## 🔴 Launch discipline (DO NOT burn tokens)

A workflow ≈ **15× the tokens** of a normal chat (Anthropic multi-agent research). Therefore:

1. **Default-deny.** Launch ONLY when (a) there is an explicit trigger-match from the table below, confirmed by the machine-checkable anchor of Decision 2 (≥ 3 independent modules, read-only, material > one context window), OR (b) an explicit owner request ("run workflow X" / ultracode on). Never "just in case".
2. **Middle-path BEFORE fan-out.** An ambiguous-but-bounded task → first the cheap tier (haiku recon / sonnet work, `model-routing.md`); a full fan-out — only on true breadth.
3. **Owner opt-in for a heavy run.** ultracode off → Master proposes the workflow + an approximate cost, launches after "yes". ultracode on → launches on a trigger-match.
4. **Log `routing_decision`** in the task file / Master's notes (`{ track: "audit-fanout", workflow, reason }`) — only the non-standard track (not light-track / single-pipeline).
5. **This is NOT a dev-pipeline.** Workflows do not implement features (that is Master → Coder). Only read-only audit/recon → a ledger that Master triages and routes into light-track / pipeline.

---

## Catalog (10)

| #   | Workflow                                  | When to launch (trigger)                                                                                 | What it does (fan-out)                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **RBAC / security-surface sweep**         | before/after RBAC changes; periodic role audit; "can role X reach Y"                                     | one controller per agent: `@Roles`/`@UseGuards` + the service body; cross-check the 5-role matrix + DROP; adversarial bypass                                                                                                                                          |
| 2   | **Design-fidelity sweep**                 | after a UI implementation; before a UI merge                                                             | pipeline `screen × {320,768,1024,1440}`: localhost ↔ `design.png` diff + severity (requires a live stack)                                                                                                                                                             |
| 3   | **E2E flake-triage**                      | CI goes red on several E2E at once                                                                       | classify by spec (code/race/environment/pre-existing) → who fixes (AutoTest spec vs Coder code)                                                                                                                                                                       |
| 4   | **"How X works across the repo"**         | before a large refactor (pre-refactor understanding)                                                     | N readers by subsystem → a map of call-sites + blast-radius                                                                                                                                                                                                          |
| 5   | **Money-precision / rounding audit**      | before editing split math; a balance diverged by minor units; before a finance deploy                    | a catalog of money arithmetic (scaled-int vs float) + fixtures proving drift                                                                                                                                                                                          |
| 6   | **Money-mutation safety matrix**          | before a new money endpoint/transaction type; "balance doubled / paid twice"; before an external auditor | concurrency guards + an audit trail across all money-write points                                                                                                                                                                                                    |
| 7   | **Web↔API contract sweep**                | before a release; a PR touches a serializer / shared schema; "API returns X, UI shows undefined"         | a JOIN matrix endpoint ↔ schema ↔ parse across controllers; dead schemas / unvalidated output                                                                                                                                                                         |
| 8   | **Language / locale-leak sweep**          | before localization / an i18n milestone; after a batch of features                                       | RU/EN/UK reach-classification (English in an Exception = a bug). **After i18n stage 6 (spec 2026-09-19) → translation-coverage**: uncovered `en` keys, unwrapped strings bypassing the catalog, the Russian-only letters absent from Ukrainian in product code (the guard set — see `russian-language.md`) |
| 9   | **Doc-vs-reality drift sweep**            | after a milestone (route/dep/storage/phase change); monthly hygiene; agent onboarding                    | stale doc facts vs the ground-truth of the code (package.json / route-tree / deploy)                                                                                                                                                                                  |
| 10  | **md-coherence + AI-infra reinforcement** | after a large agent-infra change; monthly hygiene; lessons → rules                                       | docs-vs-docs coherence (duplicates / dead links / contradictions) + the "work over the mistakes" loop (lessons → rules)                                                                                                                                               |

> Backlog status and design details of each — the owner's memory `project_candidate_workflows`.
> The trigger map evolves: a new workflow → a row here (+ if needed — a trigger in `contracts.md`).

---

## Related rules

- `rules/common/orchestration-routing.md` — agent vs workflow vs light-track (Decision 1/2 + default-deny).
- `rules/common/model-routing.md` — model tier + middle-path escalation.
- `.claude/skills/codebase-audit/SKILL.md` — audit-fanout mechanics.
