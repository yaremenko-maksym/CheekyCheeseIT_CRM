# Working Context — CheekyCheeseIT CRM

**Last updated:** 2026-06-03
**Maintained by:** PM + Architect (sync after each phase)

> Project equivalent of ECC `WORKING-CONTEXT.md`. Tracks active sprint, blockers, queues, and migration state.

---

## Active migration phase

**ECC Migration Phase 1 — Skeleton Bootstrap** (in progress)

- **Status:** PR opened (`architect/phase-1-ecc-skeleton`), awaiting user approval
- **PR branch:** `architect/phase-1-ecc-skeleton`
- **Base SHA:** ECC `928076cc...` (v2.0.0-rc.1) pinned in `ecc-pin.txt`
- **Install method:** Manual cherry-pick (ECC `install-apply.js` targets `.claude/` only, conflicts with existing `.claude/hooks/`; chose root layout per ADR Q6 = Option A)
- **Selective security additions:** `defi-amm-security`, `evm-token-decimals`, `security-review`, `security-scan`, `security-bounty-hunter`, `security-reviewer` agent (verified present in pin)
- **Coexistence verified:** Existing `docs/agents/`, `.claude/hooks/`, GHA workflows untouched

## Phases done

- **Phase 0 — Discovery + Master ADR:** PR #84 (merged or queued — see GH state)
  - Discovery Report: `docs/architecture/2026-05-31-architect-discovery-report.md`
  - Master ADR: `docs/architecture/2026-05-31-ecc-migration-design.md`
  - All 10 Open Questions answered per Architect recommendations

## Phases remaining

- **Phase 2 — Hooks migration** (~1 week) — port 5 `.claude/hooks/*.sh` to ECC JSON matcher format
- **Phase 3 — Agent migration** (~2–3 weeks) — port 6 LLM agents to ECC YAML frontmatter, integrate ECC sub-agents
- **Phase 4 — Lessons → skills** (~1–2 weeks) — group lessons by topic, create custom skills, UA-legal stubs
- **Phase 5 — Workflows + GHA + rules** (~1 week) — extract cross-cutting rules, additive GHA jobs, cross-harness placeholders
- **Phase 6 — Cleanup + retrospective** (~1 week) — delete legacy `_legacy/`, update CLAUDE.md, write retrospective

---

## Active product backlog

**Current sprint:** Phase 6 — Документы (per CLAUDE.md), parallel to ECC migration

**Backlog priorities:**

1. Documents module (PHASE 6 в product roadmap) — Coder primary
2. Profile full (PHASE 7 — wallet/USDT entry, photo upload, legend editing)
3. Smart contracts (PHASE 8 — USDT ERC-20 PaymentSplitter, ethers.js v6)
4. Dashboard (PHASE 9 — TBD after operating experience)

**Daily dispatches:** PM продолжает оркестрировать Coder/AutoTest/Reviewer без пауз. Migration не блокирует product work (hard rule per architect.md).

---

## Active queues

| Queue                    | Owner                     | Status                               |
| ------------------------ | ------------------------- | ------------------------------------ |
| Foreground (product)     | PM                        | Normal — Coder dispatches as usual   |
| Background (CI watching) | PM via `e2e-watchdog.yml` | Healthy                              |
| Architect migration      | Architect                 | Phase 1 PR opened, awaiting approval |
| Legal consults           | Legal (on-demand)         | No active items                      |
| User testing rounds      | PM                        | R4 was last, no new round queued     |

---

## Active blockers

| Blocker             | Owner | Severity | Notes                                                       |
| ------------------- | ----- | -------- | ----------------------------------------------------------- |
| Phase 1 PR approval | User  | MED      | Awaiting user signal "approve" → Architect proceeds Phase 2 |

No critical blockers.

---

## Recent merged PRs (last 10)

- #69 `feat(drop): фаза 4a — schema + балансы (backend infrastructure)`
- #68 `feat(drop): фаза 3 — ручное подтверждение выплаты (backend)`
- #67 `test(e2e): coverage audit + регрессионные тесты на шаткие места`
- #66 `chore: backlog cleanup`
- #65 `feat(drop): фаза 2 — финансы drop-проекта (backend distribution)`
- #84 (recent) `docs(architect): Phase 0 — Discovery + Master ADR` (queued for auto-merge)

---

## Live system state

| Subsystem          | Status            | Notes                                                                                  |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`         | Working           | All 3 packages start clean                                                             |
| `pnpm test`        | Working           | Vitest + Playwright suites green                                                       |
| `pnpm typecheck`   | Working           | TS strict mode                                                                         |
| Drizzle migrations | 0000–0011 applied | Latest: project_logo, partner_ledger, exchange_rate                                    |
| MCP servers active | 8                 | ast-grep, context7, postgres, eslint, playwright, github, scheduled-tasks, ccd-session |
| GHA workflows      | Healthy           | ci, e2e, e2e-watchdog, auto-merge-on-label, labels-sync, check-no-skip-hooks           |

---

## Cross-harness state

| Harness     | Status                | Notes                      |
| ----------- | --------------------- | -------------------------- |
| Claude Code | Primary, fully active | All agents dispatched here |
| Codex       | Not active            | Placeholder dir в Phase 5  |
| Cursor      | Not active            | Placeholder dir в Phase 5  |
| Gemini      | Not active            | Placeholder dir в Phase 5  |
| Zed         | Not active            | Placeholder dir в Phase 5  |
| OpenCode    | Not active            | Placeholder dir в Phase 5  |
| Copilot     | Not active            | Placeholder dir в Phase 5  |

Per ADR Q2 = Option A (Claude Code only до Phase 7+).

---

## Recent decisions (architecture)

| Decision                                          | Date       | Rationale                                                                          | Source            |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- | ----------------- |
| Pin ECC v2.0.0-rc.1 (SHA `928076cc...`)           | 2026-05-31 | rc1 ships harness-optimizer, loop-operator; stable enough                          | ADR Section 7.1   |
| Manual cherry-pick install vs `install-apply.js`  | 2026-06-03 | install-apply targets `.claude/` conflicting w/ existing hooks; root layout per Q6 | This Phase 1 PR   |
| Adopt `developer` profile + selective security    | 2026-05-31 | REPO-ASSESSMENT.md fit; Phase 8 USDT incoming                                      | ADR Section 3     |
| Russian language: per-agent prepend + rule (both) | 2026-05-31 | Q7 = Option C, belt-and-suspenders                                                 | ADR Section 4.1   |
| Legal lessons stubs (defer content)               | 2026-05-31 | Q8 = Option A; lessons currently sparse skeleton                                   | ADR Section 2.4.6 |
| New event types in pm-state.json schema v2        | 2026-05-31 | Q10 = Option A; document now, implement Phase 6                                    | ADR Section 2.6.1 |

---

## ECC pin info

```
ECC_VERSION_TAG=v2.0.0-rc.1
ECC_VERSION_SHA=928076cc08cbb31e8549cea2883b4f51811de1c8
ECC_PIN_DATE=2026-05-31
ECC_PIN_ADOPTED_BY=Architect dispatch (Phase 0 master ADR)
ECC_REPO_URL=https://github.com/affaan-m/ECC
ECC_CHERRY_PICKS=
  # empty until first cherry-pick
ECC_NEXT_SYNC_DATE=2026-12-XX  # Q4 2026 quarterly sync post-migration
```

Source of truth: `ecc-pin.txt` at repo root.
