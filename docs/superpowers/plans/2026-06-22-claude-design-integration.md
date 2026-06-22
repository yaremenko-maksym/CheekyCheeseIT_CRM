# Claude Design Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: Task 1 + every Claude-Design generation step are **interactive** (native slash commands the USER types in a fresh `claude` session + orchestrator Chrome-MCP driving) — they cannot be run by a headless subagent. Tasks 2-7 are markdown/doc authoring in `.claude/**` + `docs/**` (master/architect zone).

**Goal:** Make every CRM UI change pass through Claude Design (claude.ai/design) as a mandatory designer-in-the-loop, with the orchestrator handing the resulting design to the coder via a repo artifact.

**Architecture:** Native Claude Design ↔ Claude Code integration (CLI ≥ 2.1.185 ships `/design-login`, `/design-sync`, `/design`). One-time `/design-sync` teaches Claude Design our Tailwind v4 tokens + shadcn/ui components ("BEST FIDELITY" path). Per-feature, the orchestrator drives Claude Design (Chrome MCP) to generate a design, exports it as a repo artifact (`docs/design/<slug>.md` + `assets/<slug>/`), the `ui-ux-designer` agent reconciles it to a coder-ready spec, the coder implements with our components, and `ui-ux-designer` runs a fidelity audit. A 3-tier gate makes the designer always-involved at the right intensity.

**Tech Stack:** Claude Code CLI 2.1.185 (native `/design*` commands), Claude Design (Opus 4.8, Beta), Chrome MCP (`mcp__Claude_in_Chrome__*`), apps/web (Vite SPA + TanStack Router + Tailwind v4 + shadcn/ui), `.claude/` agent factory (rules/agents/skills/commands).

**Spec:** [docs/architecture/2026-06-22-claude-design-integration.md](../../architecture/2026-06-22-claude-design-integration.md)
**UI-surface inventory (grounds the sync):** 28 route files · ~45 modals/dialogs · 36 shadcn primitives + ~70 composites · oklch token system (brand yellow hue 85.3, dark-default, light/dark parity) · 6 RBAC roles + ~22 role-conditional surfaces. Full data in the workflow result; key facts inlined per task below.

---

## File Structure

| Path                                                                 | Responsibility                                                                                           | Task |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| `.claude/rules/common/design-gate.md`                                | Always-on 3-tier mandatory UI design gate                                                                | T2   |
| `.claude/agents/ui-ux-designer.md` (modify)                          | Add Mode E (Claude Design → coder spec reconciliation); strengthen Mode B (fidelity audit vs design.png) | T3   |
| `.claude/skills/claude-design-workflow/SKILL.md`                     | Cookbook: drive Claude Design via Chrome MCP, native command usage, artifact export, handoff, fallbacks  | T4   |
| `.claude/rules/common/skills-invocation.md` (modify)                 | Add trigger → `claude-design-workflow` row                                                               | T4   |
| `.claude/agents/pm-snippets.md` (modify)                             | Design-gate dispatch flow (PM won't dispatch UI coder without artifact)                                  | T5   |
| `.claude/agents/code-reviewer.md` (modify)                           | Reviewer checks design artifact presence on apps/web PRs                                                 | T5   |
| `CLAUDE.md` (modify)                                                 | Pointer-map row for design-gate + Claude Design workflow                                                 | T6   |
| `docs/architecture/2026-06-22-claude-design-integration.md` (modify) | Reconcile spec with native-command reality (post-upgrade)                                                | T6   |
| `docs/design/<pilot-slug>.md` + `docs/design/assets/<pilot-slug>/`   | Pilot artifact proving the pipeline                                                                      | T7   |

**No new `.claude/commands/` files** — `/design`, `/design-sync`, `/design-login` are now native (CLI 2.1.185). We document + wrap them in process, not reimplement (YAGNI; project commands would shadow/conflict with native).

---

## Task 1: Sync CRM design system + components into Claude Design

**Goal:** Teach Claude Design our full design system (tokens + every shadcn/ui primitive + composites + dialog/modal components + screen components) via native `/design-sync`, so all later generations are on-brand and our screens/modals are understood.

**Who runs what:** USER types the native slash commands (this orchestrator session runs the pre-upgrade binary and cannot invoke them; a fresh `claude` session picks up 2.1.185). Orchestrator verifies via Chrome MCP and records the resulting design-system identity.

**Files:** none created in repo by the sync itself (the design system lives in Claude Design, server-side). Source read by `/design-sync`: `apps/web/app/styles/globals.css` + `apps/web/app/components/**`.

- [x] **Step 1: Confirm CLI version in a fresh shell**

Run: `claude --version`
Expected: `2.1.185 (Claude Code)` or higher. (If lower: `claude update`.)

- [x] **Step 2: Authenticate Claude Design from the CLI (USER, fresh session)**

```bash
cd /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM
claude            # fresh session on 2.1.185
```

In that session type: `/design-login`
Expected: a browser/OAuth confirmation that Claude Code is connected to Claude Design (same Anthropic account «M», Max plan — already logged into claude.ai/design).

- [x] **Step 3: Point at the design-system package**

Our design system source = `apps/web` (tokens in `app/styles/globals.css`; components in `app/components/ui/` (36 primitives) + `app/components/**` + `app/routes/**/components/` (composites + all dialogs)).
In the fresh `claude` session: `cd apps/web` (or stay at repo root — `/design-sync` discovers the package; prefer `apps/web` for a tight scope).

- [x] **Step 4: Run the native sync (USER)**

Type: `/design-sync`
Expected: Claude Code reads tokens + React components and creates a design system in Claude Design. When it finishes, per the Claude Design UI: «your system appears under Design systems for everyone in your org.» Name it (or accept default) — record the exact name, e.g. `CheekyCheeseIT CRM`.
If `/design-sync` prompts create-new vs update-existing → choose **create new** (first run).

- [x] **Step 5: Orchestrator verifies the result (Chrome MCP)**

Orchestrator (this session) navigates the connected browser:

- `claude.ai/design#design-systems` → confirm the new system `CheekyCheeseIT CRM` is listed.
- Open it → screenshot. Confirm captured: **tokens** (brand yellow primary oklch hue 85.3, dark-as-default, light/dark parity, `--radius` 0.625rem, Inter font) and **components** (Button, Card, Badge, CrmDialog, Dialog, AnimatedTabs, KpiCard, SegmentedToggle, AmountCurrencyInput, ShareSlider, finance dialogs, etc.).
- Save screenshots to `/tmp/design-sync-verify/` and (curated) to `docs/design/assets/_design-system/`.

- [x] **Step 6: Coverage check vs inventory**

Compare what Claude Design captured against the inventory's component list (36 primitives + ~70 composites) and the ~45 dialogs/modals. Note any gaps in a short list. Acceptance: tokens fully captured + all 36 ui/ primitives + the dominant composites (Card family, KpiCard, CrmDialog, the finance dialog family, nav-sidebar). Screen _compositions_ need NOT all pre-exist as static designs — they are generated on demand via `/design` using this system (Step note, not a gap).

- [x] **Step 7: (Decision) Landing design system**

`apps/landing` ships a near-identical token copy (own `globals.css`) but only Button/Badge/BrandMark/cn. Decide: (a) skip for now (CRM-first), or (b) a second `cd apps/landing && /design-sync` → system `CheekyCheeseIT Landing`. Default: **(a) skip** — revisit when public-module/landing redesign is scheduled. Record the decision.

- [x] **Step 8: Record design-system identity for downstream use**

Append to `docs/architecture/2026-06-22-claude-design-integration.md` (§ new "Synced design systems"): the design-system name(s), date synced, source dir, and what was captured. This is what the workflow skill (T4) and per-feature `/design` runs reference.

- [x] **Step 9: Commit the doc updates**

```bash
git add docs/architecture/2026-06-22-claude-design-integration.md docs/design/assets/_design-system/
git commit -m "docs(design): record CRM design system synced to Claude Design"
```

(No `ac_verified:` required — docs-only, branch is not `feature/*`. Prettier pre-commit will format.)

**Acceptance:** `CheekyCheeseIT CRM` design system exists in Claude Design, verified to carry our tokens + component library; identity recorded in the spec. A subsequent `/design` (T7 pilot) generating with `design system = CheekyCheeseIT CRM` produces on-brand output (dark, brand-yellow, our components) — not generic AI-slop.

---

## Task 2: Author the 3-tier design-gate rule

**Goal:** Encode the always-on policy that every `apps/web/**` (and `apps/landing/**`) visual change involves the designer, at tiered intensity.

**Files:**

- Create: `.claude/rules/common/design-gate.md`

- [x] **Step 1: Write `.claude/rules/common/design-gate.md`**

Content (concrete, mirrors spec §4.7 + §4.8):

- Header: `**Status:** Always-on`, `**Applies to:** PM (dispatch), Coder, ui-ux-designer, code-reviewer`, `**Source:** docs/architecture/2026-06-22-claude-design-integration.md`.
- **The rule:** any task whose diff touches `apps/web/**` or `apps/landing/**` visual surface (`.tsx` rendering, `globals.css`, classNames) MUST involve the designer before the coder implements, and a fidelity audit after.
- **Tier table:**
  - Tier 1 (new screen/flow/component/redesign) → full Claude Design generation (`/design` or orchestrator Chrome-MCP drive) → artifact → ui-ux-designer Mode E spec.
  - Tier 2 (modify existing screen) → edit existing design in Claude Design OR ui-ux-designer conformance check → updated spec.
  - Tier 3 (trivial cosmetic: text, one spacing/color token) → ui-ux-designer conformance check vs synced design system (no browser round-trip).
- **Tier is set by PM/orchestrator** at task creation via `## Design tier:` in the task file.
- **Artifact contract:** `docs/design/<slug>.md` (coder-ready spec) + `docs/design/assets/<slug>/` (design.html + screenshots). This is the only interface the headless coder sees.
- **Enforcement:** PM-dispatch gate (no UI coder without artifact/conformance), code-reviewer BLOCK if an `apps/web` PR lacks the design artifact + fidelity audit. `merge-approved` stays PM/owner-only (link [[feedback_reviewer_self_merge_incident]]).
- **Fallback (degraded):** if Claude Design unavailable/over-limit → ui-ux-designer Mode A textual spec; PR body notes `design-gate: degraded`.
- **Связанные правила:** link `zone-of-write.md`, `light-track.md`, `skills-invocation.md`.

- [x] **Step 2: Lint-check the markdown & commit**

Run: `git add .claude/rules/common/design-gate.md && git commit -m "feat(rules): add 3-tier Claude Design mandatory UI gate"`
Expected: prettier pre-commit passes (md formatted).

**Acceptance:** Rule file exists, is auto-loaded (lives in `.claude/rules/common/`), and unambiguously states the tier classification + enforcement points.

---

## Task 3: Add ui-ux-designer Mode E + strengthen Mode B

**Goal:** Give the designer agent a headless reconciliation mode (Claude Design export → coder spec mapped to our components/tokens) and a reference-based fidelity audit.

**Files:**

- Modify: `.claude/agents/ui-ux-designer.md` (Workflow по режимам section; Mandatory skill table)

- [x] **Step 1: Add Mode E to the "Workflow по режимам" section**

Insert a `### Mode E — Reconciliation (Claude Design → coder spec)` block:

- Trigger: PM dispatch after a Claude Design artifact exists in `docs/design/assets/<slug>/`.
- Input: `design.html` + screenshots + brief.
- Steps: read the export; map each visual element to an existing shadcn/ui primitive or composite (cite the inventory: Button/Card/Badge/CrmDialog/KpiCard/AnimatedTabs/SegmentedToggle/etc.); flag anything that needs a NEW component; produce token-map (only our `globals.css` tokens — never raw hex/generic gradients); list a11y (WCAG 2.2 target-size/focus/contrast), responsive (320/768/1024/1440), and edge-cases (empty/loading/error/overflow).
- Output: `docs/design/<slug>.md` coder-ready spec (extends existing `docs/design/` convention). Explicitly instruct: coder builds with our components, does NOT paste Claude Design's raw HTML.
- This mode is **headless** (file-based; no browser).

- [x] **Step 2: Strengthen Mode B (fidelity audit)**

In the existing `### Mode B` block, add: when a `docs/design/assets/<slug>/design.png` reference exists, compare the live Playwright screenshot against it (spacing rhythm, hierarchy, token usage); `BLOCK` on visible drift, in addition to the existing 10-dimension score.

- [x] **Step 3: Update the Mandatory skill table**

Add a row: `| Mode E — Claude Design reconciliation | claude-design-workflow |`.

- [x] **Step 4: Commit**

Run: `git add .claude/agents/ui-ux-designer.md && git commit -m "feat(agents): ui-ux-designer Mode E (Claude Design reconciliation) + reference fidelity audit"`

**Acceptance:** ui-ux-designer.md documents Mode E with the exact artifact paths + component-mapping discipline, and Mode B references the design.png.

---

## Task 4: Author the `claude-design-workflow` skill + register trigger

**Goal:** A reliable cookbook for the orchestrator to drive Claude Design and produce the handoff artifact.

**Files:**

- Create: `.claude/skills/claude-design-workflow/SKILL.md`
- Modify: `.claude/rules/common/skills-invocation.md`

- [x] **Step 1: Write `.claude/skills/claude-design-workflow/SKILL.md`**

Frontmatter `name`, `description`, `when_to_use` (mirrors the skills-invocation trigger). Body cookbook:

- **Native commands:** `/design-login` (auth), `/design-sync` (system sync — Task 1), `/design` (launch/handoff). Note these are user-typed in a fresh `claude` session; orchestrator cannot invoke them headlessly.
- **Per-feature generation (orchestrator via Chrome MCP):** open `claude.ai/design`, set `Design system = CheekyCheeseIT CRM`, pick template (Product prototype / wireframe), paste the design-brief (reuse `frontend-design-direction` 5 questions), generate, refine.
- **Export the artifact:** Export → standalone HTML → save to `docs/design/assets/<slug>/design.html`; Chrome-MCP screenshot each state (default/empty/loading/error) → `docs/design/assets/<slug>/*.png`; write `docs/design/<slug>.md` brief + Claude Design URL.
- **Chrome MCP hygiene:** create own MCP tab (`tabs_context_mcp`), `read_page filter:interactive` before clicks, `browser_batch` for multi-step, screenshot to confirm.
- **Fallback:** if driving is fragile/slow → produce brief, USER refines in browser + exports; orchestrator picks up artifact from `docs/design/assets/<slug>/`.
- **Handoff:** dispatch ui-ux-designer Mode E (T3) → coder.

- [x] **Step 2: Register the trigger in `skills-invocation.md`**

Add a row to the project-local skills table: `| claude-design-workflow | Orchestrator drives Claude Design for a UI task / handoff artifact | Master, PM, ui-ux-designer |`.

- [x] **Step 3: Commit**

Run: `git add .claude/skills/claude-design-workflow/ .claude/rules/common/skills-invocation.md && git commit -m "feat(skills): claude-design-workflow cookbook + trigger registration"`

**Acceptance:** Skill exists with ≥3 substantive patterns (native commands, Chrome-MCP drive, export, fallback, handoff) and is discoverable via skills-invocation.

---

## Task 5: Enforcement — PM dispatch gate + reviewer check

**Goal:** The gate is actually enforced, not just documented.

**Files:**

- Modify: `.claude/agents/pm-snippets.md`
- Modify: `.claude/agents/code-reviewer.md`

- [x] **Step 1: pm-snippets — add design-gate dispatch flow**

Add a snippet: before dispatching a Coder on a UI task, PM verifies a `docs/design/<slug>.md` artifact (Tier 1/2) or records a Tier-3 conformance note; the Coder dispatch prompt includes the artifact path + "build with our shadcn/ui components, match design.png; do NOT paste raw exported HTML."

- [x] **Step 2: code-reviewer — add artifact presence check**

Add to code-reviewer.md: on a PR touching `apps/web/**` or `apps/landing/**` visual surface, verify a design artifact (`docs/design/<slug>.md`) + a Mode B fidelity audit comment exist; if absent and tier ≠ 3 → `Verdict: BLOCK` with the design-gate citation. Reviewer must NOT set `merge-approved` (existing P0 guard).

- [x] **Step 3: Commit**

Run: `git add .claude/agents/pm-snippets.md .claude/agents/code-reviewer.md && git commit -m "feat(agents): enforce design-gate at PM dispatch + code review"`

**Acceptance:** PM and reviewer docs both reference the artifact requirement with concrete paths + BLOCK conditions.

---

## Task 6: Docs reconciliation (spec + CLAUDE.md)

**Goal:** Keep the source-of-truth docs consistent with native-command reality.

**Files:**

- Modify: `docs/architecture/2026-06-22-claude-design-integration.md`
- Modify: `CLAUDE.md`

- [x] **Step 1: Update the spec for native commands**

In §2 add a row: «CLI upgraded 2.1.143 → 2.1.185 (2026-06-22) → native `/design-login` `/design-sync` `/design` present (verified in binary)». In §4.3/§4.4 replace "create project commands" with "use native commands; project value-add = gate + skill + Mode E". Update §9 deliverables to match this plan.

- [x] **Step 2: Update CLAUDE.md pointer map**

Add a row to the «Карта указателей» table: `| Claude Design UI-гейт + workflow | .claude/rules/common/design-gate.md + .claude/skills/claude-design-workflow/ |`. Add `design-gate` to the «Сессионный минимум» rules reminder line.

- [x] **Step 3: Commit**

Run: `git add docs/architecture/2026-06-22-claude-design-integration.md CLAUDE.md && git commit -m "docs: reconcile Claude Design spec with native commands; CLAUDE.md pointer"`

**Acceptance:** Spec §2/§4/§9 + CLAUDE.md reflect native commands and point to the new rule/skill.

---

## Task 7: Pilot — one real UI task end-to-end (Tier 1)

**Goal:** Prove the full pipeline on a real, low-risk screen before declaring the integration live.

**Pilot candidate (recommend):** a **non-money, presentational** screen so the pilot tests design fidelity without finance/RBAC risk. Options from the inventory: the **HR dashboard** (`HRDashboard.tsx`, KPI grid — visual, no money-path) or the **NotFound / empty-states** polish. Default recommendation: **HR dashboard refresh** (Tier 1, visual, isolated). Confirm with owner before running.

- [ ] **Step 1: Brief** — orchestrator writes the design-brief (purpose/audience/tone/tokens/edge-cases) for the chosen screen.
- [ ] **Step 2: Generate** — Chrome-MCP drive Claude Design (`design system = CheekyCheeseIT CRM`, Product prototype) → refine → export to `docs/design/assets/<slug>/`.
- [ ] **Step 3: Reconcile** — dispatch ui-ux-designer Mode E → `docs/design/<slug>.md`.
- [ ] **Step 4: Implement** — dispatch coder (worktree) → build in `apps/web` with our components; E2E unaffected (presentational).
- [ ] **Step 5: Audit** — ui-ux-designer Mode B: Playwright live screenshot vs `design.png` → PASS/BLOCK.
- [ ] **Step 6: Review + UT** — code-reviewer (design-gate satisfied) → owner User Testing → merge gate (PM sets `merge-approved` only on owner «мерджим»).

**Acceptance:** A merged (or UT-approved) PR whose UI was generated in Claude Design, reconciled, implemented, and fidelity-audited — the loop demonstrably works.

---

## Self-Review (against spec)

- **Spec §3 pipeline** → T1 (sync/step 0) + T4 (generate/export) + T3 (reconcile) + T7 (coder + audit). ✓
- **Spec §4.1 design-system** → T1. ✓ **§4.2 artifact contract** → T2 (paths) + T4 (export). ✓
- **Spec §4.3/4.4 commands** → superseded by native commands (T6 reconciles). ✓
- **Spec §4.5 Mode E + Mode B** → T3. ✓ **§4.6 skill** → T4. ✓ **§4.7 tiers** → T2. ✓ **§4.8 enforcement** → T5. ✓
- **Spec §9 pilot** → T7. ✓
- **Placeholder scan:** no TBD/TODO; every task has exact paths + concrete content. Interactive steps explicitly flagged (who runs them).
- **Consistency:** design-system name `CheekyCheeseIT CRM` and artifact paths `docs/design/<slug>.md` + `docs/design/assets/<slug>/` used identically across T1–T7.
