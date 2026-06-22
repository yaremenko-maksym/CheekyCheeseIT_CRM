# Redesign Phase 0 — Foundation / Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`).
> **NOTE:** generation (T2–T3) is **interactive** — orchestrator drives Claude Design via Chrome MCP
> (text brief, NO file upload). Owner-approval (T5) waits on the owner.

**Goal:** Establish ONE professional visual language for the whole CRM (layout, density, type, color, motion, a11y) + the global app-shell, and get the owner to approve the DIRECTION via 3 north-star screens. This anchors every later domain phase.

**Architecture:** Orchestrator writes a foundation design-direction brief (grounded in current design system + elevated), drives Claude Design (Chrome MCP, on `CheekyCheeseIT CRM` system) to generate north-star screens from TEXT briefs, exports artifacts, owner approves the direction. No file upload (text-driven generation sidesteps the upload blocker).

**Tech Stack:** Claude Design (Opus 4.8) + Chrome MCP, `frontend-design-direction` skill, `docs/design/assets/_design-system/inventory.md`, design tokens `apps/web/app/styles/globals.css`.

**Spec:** [docs/superpowers/specs/2026-06-22-crm-redesign-program.md](../specs/2026-06-22-crm-redesign-program.md)

---

## File Structure

| Path                                                | Responsibility                                          | Task  |
| --------------------------------------------------- | ------------------------------------------------------- | ----- |
| `docs/design/foundation.md`                         | The professional design direction (system of decisions) | T1/T4 |
| `docs/design/screens/_foundation/assets/*.png,html` | North-star exports (app-shell, dashboard, data, dialog) | T3    |
| `docs/design/screens/INDEX.md` (modify)             | Foundation + north-star rows                            | T4    |

---

## Task 1: Draft the foundation design-direction brief

**Files:** Create `docs/design/foundation.md` (draft direction).

- [ ] **Step 1: Invoke `frontend-design-direction` skill** to set: purpose (dense SaaS recruiting/outstaffing ops tool), audience (ADMIN/SENIOR/HR/etc., daily power users), tone (dense / quiet / scannable / professional — NOT editorial/playful), memorable detail, constraints (Tailwind v4 + shadcn/ui + Russian UI + WCAG 2.2 AA + responsive 320–1440 + dark-default + brand yellow).
- [ ] **Step 2: Write `docs/design/foundation.md`** — the system of decisions: layout grid + page chrome, spacing rhythm/density scale, type scale + hierarchy (Inter), color semantics (brand yellow primary oklch, surfaces, status colors — map to `globals.css` tokens), elevation/depth, motion principles (durations/easing, compositor-only), a11y rules, component-styling direction (how Button/Card/Table/Dialog/Badge should feel). Reference `inventory.md`.

**Acceptance:** `foundation.md` states the elevated visual language concretely, in our tokens (no raw hex / AI-slop).

---

## Task 2: Verify Claude Design text-generation is drivable via Chrome MCP (de-risk linchpin)

**Files:** none (validation).

- [ ] **Step 1:** Chrome MCP → `claude.ai/design`, system = `CheekyCheeseIT CRM`, "Start with a file" / describe-box (ref to "Drop files here, or describe what you want to make…").
- [ ] **Step 2:** Type a SHORT north-star brief (the app-shell + dashboard) into the describe textbox and trigger generation.
- [ ] **Step 3:** Confirm a design generates on-system (dark, brand-yellow, our components). Screenshot to confirm.
- [ ] **Step 4 (decision):** If drivable → continue T3 autonomously. If fragile (Beta UI / can't submit) → fallback: hand briefs to owner, owner generates/exports, orchestrator picks up artifacts. Record the outcome.

**Acceptance:** Either a generated north-star design exists (autonomous path confirmed) OR the fallback is recorded and briefs are prepared for owner.

---

## Task 3: Generate the 3 north-star screens

**Files:** Create `docs/design/screens/_foundation/assets/{app-shell,dashboard,data-table,dialog}/{design.html,*.png}`.

- [ ] **Step 1: App-shell** (global nav-sidebar + header + page chrome) — generate from brief → refine → export. (Global: every screen inherits it.)
- [ ] **Step 2: Dashboard** (information-density showcase: KPI cards, sections) — generate → refine → export.
- [ ] **Step 3: Dense data screen** (a Users/Team-style table with filters, row actions, states) — generate → refine → export. (Validates dense data handling — the CRM's bread and butter.)
- [ ] **Step 4: Key dialog/form** (a representative modal — create/edit form) — generate → refine → export.
- [ ] **Step 5:** Chrome-MCP screenshot each + export standalone HTML to the asset dirs; record Claude Design URLs.

**Acceptance:** 3–4 north-star designs exist in Claude Design + exported to repo, all on the `CheekyCheeseIT CRM` system, embodying `foundation.md`.

---

## Task 4: Finalize foundation doc + registry

**Files:** modify `docs/design/foundation.md`, `docs/design/screens/INDEX.md`.

- [ ] **Step 1:** Reconcile `foundation.md` with what the north-stars actually established (any direction refinements discovered during generation). Add Claude Design URLs.
- [ ] **Step 2:** Add a `Foundation` section to `INDEX.md` with the north-star rows (status `captured`).
- [ ] **Step 3: Commit.**

```bash
git add docs/design/foundation.md docs/design/screens/_foundation/ docs/design/screens/INDEX.md
git commit -m "docs(design): redesign foundation direction + north-star screens (Phase 0)"
```

**Acceptance:** `foundation.md` is the single source for the visual language; north-stars exported + registered.

---

## Task 5: Owner approves the DIRECTION — WAITS ON OWNER

- [ ] **Step 1:** Present the 3–4 north-star designs (Claude Design URLs + exported screenshots) to the owner.
- [ ] **Step 2:** Owner reviews the DIRECTION (not pixel-perfect per-screen — the language: density, type, color, layout feel). Collect change requests → loop T3 refine.
- [ ] **Step 3:** On approval → `INDEX.md` foundation rows `approved`; commit. **This unlocks the domain phases (1–8).**

**Acceptance:** Owner has approved the professional design direction. Phase 1 (Interviews) can start against this foundation.

---

## Self-Review (against spec)

- **Spec §3 cycle** → T1 (brief) + T2/T3 (generate) + T4 (artifact) + T5 (approve). ✓
- **Spec §4 principles** → foundation.md encodes single-language + a11y + dense/professional; functional 1:1 enforced per-screen in later phases. ✓
- **Spec §5 Phase 0** → app-shell + 3 north-stars + direction approval. ✓
- **Spec §6 fallback** → T2 Step 4 (text-gen drivability check + owner fallback). ✓
- **Placeholder scan:** interactive steps flagged; no TBD.
- **Consistency:** `docs/design/foundation.md` + `_foundation/` asset paths + INDEX statuses consistent.
