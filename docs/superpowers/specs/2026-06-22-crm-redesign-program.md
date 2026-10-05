# Spec: CRM full redesign program (designer-first, phased)

**Date:** 2026-06-22
**Status:** Approved (brainstorm) → pending implementation plans (per phase)
**Author:** Master session (PM orchestrator)
**Related:** `docs/architecture/2026-06-22-claude-design-integration.md` (machinery, merged #279),
`.claude/rules/common/design-gate.md`, `.claude/agents/ui-ux-designer.md`,
`docs/design/assets/_design-system/inventory.md` (functional inventory).
**Supersedes:** `docs/superpowers/specs/2026-06-22-ui-mirror-claude-design-design.md` (faithful-mirror —
replaced with redesign-from-scratch; the captured Interviews screenshots are reused as a functional reference).

---

## 1. Goal

Owner: "a gradual design refactor of the whole project — fully draw the CRM design from scratch, accounting for
all the current functionality; the design must be correct and professional across the whole project; split into
phases and implement."

That is: a **professional redesign of every CRM screen/modal**, in a single visual language, preserving
**all current functionality 1:1** (redesign = visual + UX, NOT a change to business logic),
rolled out in **phases**, designer-first (the owner approves the mockup before code).

## 2. Why redesign-from-scratch, not mirror (architecture decision)

Mirroring the existing UI via Claude Design AI generation is low value (CD will "redraw"
an approximate copy of what already exists exactly in the code) + high friction (file_upload accepts only
session-shared files, the native picker cannot be driven). **Claude Design's strength is generating new/changed
designs.** Therefore:

- **Generation input = a text functional brief** (screen description + all functionality + our tokens/components),
  NOT uploading a screenshot → **removes the blocker**: the "describe what you want to make" field is driven via
  Chrome MCP autonomously (text, no upload).
- Captured faithful screenshots (`docs/design/screens/<domain>/assets/`) + reading the code = a **functional
  reference** for the brief (what should be on the screen), not the output.

## 3. Repeatable per-screen cycle (designer-first dev-loop)

```
(0) Foundation ready (Phase 0): a single visual language on the CheekyCheeseIT CRM system
(1) Functional brief: the orchestrator extracts from code/screenshots ALL screen functionality (features, data,
    states, roles, edge-cases) + design-direction (Phase 0) + our tokens/components
(2) Generation in Claude Design (Chrome MCP, text brief, system=CheekyCheeseIT CRM) → professional
    design → refine via conversation
(3) Export artifact to the repo: docs/design/screens/<domain>/<screen>.md (coder-spec) +
    assets/<screen>/{design.html, *.png} + entry in docs/design/screens/INDEX.md (status captured)
(4) The OWNER visually approves the mockup → registry approved (GATE: no approval, no coder dispatch)
(5) Coder implements in apps/web per the artifact (our components/tokens; functionality preserved 1:1)
(6) ui-ux-designer Mode B fidelity audit (live vs design.png) → code-review → User Testing → "merge it"
    → registry implemented
```

The machinery is already in main (#279): `design-gate.md` (3-tier + enforcement), ui-ux-designer Mode E (reconciliation)

- Mode B (fidelity), the `claude-design-workflow` skill, the artifact contract. Reused as-is.

## 4. Principles

- **Blocks + data 1:1 (CRITICAL):** redesign = a **restyle of existing blocks** — the same blocks, the same
  labels, the same data filling as on the REAL screen. We change ONLY the visual / spacing / hierarchy /
  arrangement per UI/UX canon. **Add nothing new** — no new buttons/links/cards/
  KPIs/widgets, do not duplicate logic. Do not remove features, do not touch business logic/API/RBAC.
  **Capture-grounded brief:** before generation the orchestrator captures the REAL screen (Playwright :3100) and
  lists its exact blocks/labels/data in the brief + an explicit prohibition "add nothing not listed". (Lesson
  2026-06-22: a free brief → CD invented KPIs/buttons/"Income" that are not on the real dashboard.)
- **Single language:** Phase 0 sets the layout grid, density, type-scale, color semantics, motion, a11y (WCAG 2.2 AA),
  component patterns. All phases follow it → consistency.
- **Professional, not AI-slop:** ui-ux-designer Mode C catches generic patterns; the goal is a dense SaaS operations tool.
- **Phase order:** from representative/low-risk to money/RBAC-heavy.
- **Owner gate:** each screen — `approved` in the registry before code; merge — only an explicit "merge it".
- **Registry** `docs/design/screens/INDEX.md` — a progress map (captured→approved→implemented).

## 5. Phases

| Phase | Scope                                                                     | Notes                                                                                           |
| ----- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **0** | **Foundation / direction** + app-shell (nav-sidebar, header, page-chrome) | North-star: 2–3 reference screens → the owner approves the DIRECTION. The anchor of all phases. |
| **1** | **Interviews** (kanban + 5 modals)                                        | Pilot; the functional reference is already captured (`docs/design/screens/interviews/assets/`). |
| **2** | **Team & Users** (dense data, role-conditional)                           | Core CRUD + tables.                                                                             |
| **3** | **Projects** (list, detail, credentials, legend)                          |                                                                                                 |
| **4** | **Finance / Invoices / Accountant** (money)                               | security-reviewer mandatory; careful with calculations/RBAC.                                    |
| **5** | **Documents / Contracts / Onboarding**                                    | S3/preview, contract rendering.                                                                 |
| **6** | **Profiles** (role-conditional, drop/junior masking)                      | A complex RBAC matrix "who views → whose profile".                                              |
| **7** | **Dashboards** (admin / HR / role, statistics)                            |                                                                                                 |
| **8** | **Auth/login, empty/404/error states, final polish pass**                 | Cross-slice consistency.                                                                        |

Each phase — a separate implementation plan (`docs/superpowers/plans/2026-06-22-redesign-phaseN-*.md`)

- a separate PR(s). Phase 0 gates all the others (direction approved by the owner).

## 6. Failure modes & fallbacks

- **Text generation in CD cannot be driven via Chrome MCP** → fallback: the orchestrator hands over the brief,
  the owner generates/refines in the browser, the orchestrator picks up the export. (Checked in Phase 0 Step 1.)
- **Drift from current functionality** → the brief lists functionality as a checklist; Mode B + code-review verify
  that no feature is lost.
- **CD unavailable / over limit** → ui-ux-designer Mode A text spec; the PR is marked `design-gate: degraded`.
- **Volume** → strictly in phases; do not start the next phase until the previous is `approved`+merged (or an explicit parallel dispatch by the owner).

## 7. Out of scope (YAGNI)

- Changing business logic / API / DB schema (only visual+UX).
- `apps/landing` (separately, during the landing redesign).
- Auto-CI design trigger (CD is interactive).
- Faithful mirroring of the existing (replaced by the redesign).

## 8. Self-review

- Placeholder scan: phases are concrete; per-phase plans are written separately before each phase starts.
- Consistency: the §3 cycle + registry + #279 machinery are unified across all phases.
- Scope: Phase 0 + Phase 1 get plans first; phases 2–8 — plans as they come up.
- Ambiguity: "functionality 1:1" is fixed explicitly (§4) to avoid feature loss during the redesign.
