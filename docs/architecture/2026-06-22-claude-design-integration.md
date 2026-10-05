# ADR / Design Spec: integrating Claude Design into the CRM agent factory

**Date:** 2026-06-22
**Status:** Approved (brainstorm) → pending implementation plan
**Author:** Master session (PM orchestrator)
**Related:** [[ui-ux-designer.md]], `.claude/rules/common/light-track.md`, `.claude/rules/common/zone-of-write.md`, [[feedback_reviewer_self_merge_incident]]

> **UPDATE 2026-06-22 (post-upgrade):** the CLI was updated 2.1.143 → **2.1.185**, which **ships native**
> `/design-login`, `/design-sync`, `/design` (verified in the binary: design-sync ×262, /design ×67,
> /design-login ×14). Therefore §4.3/§4.4 "create project commands" are **cancelled** — we rely on
> the native commands; the project value = the gate + Mode E reconciliation + the skill + enforcement.
> Implementation plan: `docs/superpowers/plans/2026-06-22-claude-design-integration.md`.

---

## 1. Goal

Owner: "any UI decision must involve the designer, so they arrange everything
beautifully — correct spacing, well-thought-out UX". Embed **Claude Design** (claude.ai/design,
Anthropic Labs, on Opus 4.8) into the pipeline so that:

1. The orchestrator hands the task to Claude Design for design and gets the result.
2. The design result is passed to the coder **without the owner's involvement**.
3. Any change in `apps/web` (and `apps/landing`) goes through the design gate.

## 2. Hard constraints (verified 2026-06-22)

| Fact                                                                                                                                         | Source                                                                                                          | Consequence                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Design is **interactive, browser-based**, a research preview, Pro/Max+ subscription                                                   | anthropic.com/news/claude-design-anthropic-labs; a live check via Chrome MCP (owner's account "M", on Opus 4.8) | Only a human in a browser OR the orchestrator via Chrome MCP can drive it. **A headless subagent (coder/ui-ux-designer via the Agent tool) — CANNOT.** |
| **No headless API / MCP connector** to Claude Design                                                                                         | claude-code-guide recon                                                                                         | The bridge to the coder = a **file artifact in the repository**, not a live session.                                                                   |
| Native **`/design` / `/design-sync` / `/design-login`** in the build — **present** (CLI 2.1.185, upgrade 2026-06-22; verified in the binary) | a local check + the binary                                                                                      | We do NOT create project command equivalents; the value = the gate + the skill (`claude-design-workflow`) + Mode E.                                    |
| There is a **"Design systems"** section + "Set up design system" (reads the codebase → generates in your tokens)                             | a live UI check                                                                                                 | A high-leverage foundation: set up the CRM system once → generations immediately on-brand.                                                             |
| Export: standalone HTML / ZIP / PDF / PPTX; templates Product prototype / wireframe / Blank canvas                                           | a live UI check                                                                                                 | The artifact = the exported HTML + a Chrome-MCP screenshot.                                                                                            |

**Conclusion:** the "designer" in the loop = claude.ai/design, driven by the orchestrator via Chrome MCP.
The handoff to the coder — via a committed artifact-reference that the headless coder reads.

## 3. Architecture (approved — Approach 1: design-system-first + artifact handoff + fidelity audit)

```
[UI task: new screen / flow / component / redesign / edit]
  │
  (0) the CRM design-system in Claude Design is already set up (once; maintained via /design-sync)
  │
  (1) The orchestrator builds a design-brief (purpose / audience / tone / token-constraints / edge-cases)
  │       — reuses the frontend-design-direction 5 questions
  (2) The orchestrator → Chrome MCP → claude.ai/design:
  │       design-system = CRM, template = Product prototype/wireframe, inserts the brief → generation
  │       (refine via conversation; the owner may intervene for aesthetics — fallback §6)
  (3) Export the result INTO THE REPO  ← SOURCE OF TRUTH:
  │       docs/design/assets/<slug>/design.html      (the exported standalone HTML)
  │       docs/design/assets/<slug>/design.png       (+ state screenshots: empty/loading/error)
  │       docs/design/<slug>.md                       (brief + Claude Design URL + token-map)
  (4) The ui-ux-designer agent (Mode E — reconciliation):
  │       reconciles the generic HTML with our shadcn/ui components + Tailwind v4 tokens →
  │       a coder-ready spec in docs/design/<slug>.md (which existing components, what is new,
  │       the token-map, a11y/responsive, edge-cases). Does NOT let the coder blindly copy someone else's markup.
  (5) Dispatch the coder: builds in apps/web per the spec + the HTML reference + the screenshot (our components/tokens)
  (6) ui-ux-designer Mode B (fidelity audit): a Playwright screenshot live vs design.png →
          a score; BLOCK on drift of spacing/hierarchy/tokens. Closes the loop.
```

## 4. Components (well-bounded units)

### 4.1 The CRM design system in Claude Design (the foundation, once + maintenance)

- **What:** in claude.ai/design → "Set up design system" set up the "CheekyCheeseIT CRM" system
  from `apps/web/app/styles/globals.css` (Tailwind v4 `@theme inline` — colors/typography/spacing/radius)
  - the inventory of `apps/web/app/components/ui/` (36 shadcn/ui components).
- **Why:** without it generation = a generic AI-look (purple gradients, oversized hero — what
  ui-ux-designer Mode C catches as AI-slop). With it — immediately in our tokens → a high-fidelity handoff.
- **Depends on:** Chrome MCP + the owner's browser; access to the repository (import from GitHub or paste the tokens).
- **Maintenance:** on a token change — `/design-sync` (§4.4).

### 4.2 The artifact contract (the interface between the designer and the coder)

- `docs/design/<slug>.md` — a coder-ready spec (written by ui-ux-designer Mode E). Contains: the brief,
  a link to the Claude Design project, the token-map, a list of components (existing + new),
  motion/a11y/responsive, edge-cases, the path to the reference screenshots. **Extends the existing
  convention** (`docs/design/` already stores `drop-role-ux.md`, `junior-hub.md`, etc.).
- `docs/design/assets/<slug>/` — `design.html` (the export) + `*.png` (state screenshots).
- **This is the only interface** the headless coder sees. Everything else (the browser, the
  Claude Design session) — an implementation detail of the orchestrator.

### 4.3 `/design <brief>` (SUPERSEDED by the native command)

> **2026-06-22:** CLI 2.1.185 ships a **native** `/design` → we do NOT create a project command (it would shadow/
> conflict with the native one). The project value instead of a command = the gate (`design-gate.md`) + the skill
> (`claude-design-workflow`) + ui-ux-designer Mode E. The description below is historical (how the flow was conceived).

- **Command:** ~~`.claude/commands/design.md`~~ → native `/design` (CLI ≥ 2.1.185), the owner types it.
- **Launched by:** ONLY the main session / the owner (Chrome MCP + a browser are needed; headless cannot).
- **Does:** steps (1)→(4) — builds the brief, drives Claude Design, exports the artifact,
  dispatches ui-ux-designer Mode E. The output — a ready `docs/design/<slug>.md` for the coder.
- **Documents:** a cookbook for driving claude.ai/design via Chrome MCP — now in the skill (§4.6).

### 4.4 `/design-sync` (SUPERSEDED by the native command)

> **2026-06-22:** CLI 2.1.185 ships a **native** `/design-sync` (+`/design-login`) — we do NOT create a project command.
> The sync is done by the owner with the native command in a fresh session (see plan T1).

- **Command:** ~~`.claude/commands/design-sync.md`~~ → native `/design-sync` (CLI ≥ 2.1.185).
- **Does:** (re)synchronizes the CRM design-system in Claude Design from `globals.css` +
  the component inventory. Run it on a change of design tokens / addition of base components.
- **Launched by:** the owner in a fresh `claude` session (their own OAuth). The programmatic path via the `DesignSync` tool
  requires a design-scope that a `CLAUDE_CODE_OAUTH_TOKEN` session does not have (see the skill `claude-design-workflow` §0).

### 4.5 ui-ux-designer — a new Mode E + a reinforced Mode B

- **Mode E (reconciliation, new):** input = `docs/design/assets/<slug>/` (the Claude Design export).
  Output = `docs/design/<slug>.md` a coder spec with a mapping to our components/tokens. A headless agent
  (reads files, not a browser). Add it to `.claude/agents/ui-ux-designer.md`.
- **Mode B (fidelity audit, reinforced):** now reconciles the live implementation against the `design.png`
  reference (not only the 10-dimension heuristic). BLOCK on drift.

### 4.6 The skill `claude-design-workflow` (Chrome MCP cookbook)

- **File:** `.claude/skills/claude-design-workflow/SKILL.md`.
- **Why:** a reliable drive of claude.ai/design via Chrome MCP — template selectors, the choice of
  design-system, inserting the brief, exporting the HTML, taking state screenshots, recovery on
  UI fragmentation. Triggered by `/design` and on the manual design flow.

### 4.7 The three-tier design gate (rule, approved)

- **File:** `.claude/rules/common/design-gate.md`. **Always-on.** The designer is involved ALWAYS,
  the intensity by tier:

| Tier  | Trigger                                           | Designer's action                                                                                       |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **1** | New screen / flow / component / redesign          | Full generation in Claude Design (`/design`) → artifact → Mode E spec                                   |
| **2** | An edit of an existing screen                     | An edit of the existing design in Claude Design OR a ui-ux-designer conformance check → an updated spec |
| **3** | Trivial cosmetics (text, 1 margin, a token color) | A ui-ux-designer conformance check against the synced design-system (without a browser round)           |

- **The tier is classified** by PM/the orchestrator when creating the task (the field `## Design tier:` in the task-file).

### 4.8 Enforcement (PM + Reviewer)

- **PM-dispatch gate:** PM does NOT dispatch a UI coder without `docs/design/<slug>.md` (Tier 1/2) or
  a conformance note (Tier 3). A snippet in `.claude/agents/pm-snippets.md`.
- **Reviewer check:** on a PR touching `apps/web/**` / `apps/landing/**`, code-reviewer checks
  for the presence of the design artifact and the fidelity audit; otherwise `Verdict: BLOCK`.
- **merge-approved** — unchanged: set ONLY by PM/owner (see [[feedback_reviewer_self_merge_incident]]).

## 5. Control flow by tier (brief)

- **Tier 1:** `/design` → (1-4) → PM dispatch coder (5) → Mode B (6) → review → UT → merge-gate.
- **Tier 2:** update the design (a Claude Design edit or conformance) → update the spec → coder → Mode B.
- **Tier 3:** ui-ux-designer conformance vs the design-system → coder/Mode D edit → a Playwright screenshot.

## 6. Failure modes & fallbacks

- **The Chrome MCP drive is fragile/slow** (the Claude Design UI changes, selectors drift) →
  fallback: the orchestrator forms the brief, the owner refines it in the browser for 1-2 iterations and hits Export;
  the orchestrator picks up the artifact from the repo/screenshot and continues from step (3). Skill §4.6 describes
  both branches. The owner sanctioned the autonomous drive, the fallback — a safety net.
- **design.html generic markup** (divs instead of our components) → this is exactly what Mode E (§4.5) is for:
  the coder builds per the spec, not by copying the HTML. design.html — a visual reference, not code for insertion.
- **Token drift** (globals.css changed, Claude Design lagged) → `/design-sync` before a Tier 1 generation.
- **Claude Design unavailable / limit** → degradation to the current flow (ui-ux-designer Mode A text
  spec); note in the PR "design-gate: degraded, Claude Design unavailable".

## 7. Out of scope (YAGNI)

- Two-way live-sync code ↔ design (no headless API; we do not build it).
- Auto-triggering design in CI/CD (Claude Design is interactive).
- A custom MCP server to Claude Design (no official one; a self-written one — a separate initiative).
- Replacing the ui-ux-designer agent — it stays (reconciliation + audit), not removed.
- Deploy / public module / other open threads — we do not touch them.

## 8. Open questions — resolved

- Where the artifacts go → `docs/design/<slug>.md` + `docs/design/assets/<slug>/` (extends the convention).
- Who drives Claude Design → the orchestrator via Chrome MCP (fallback — the owner, §6).
- The gate scope → literally any UI, three-tier intensity (§4.7).
- Subscription → Max includes Claude Design (verified: access is present).

## 9. Deliverables (for the implementation plan)

1. The CRM design-system set up in Claude Design (§4.1) + a pilot generation to verify the export.
2. `.claude/rules/common/design-gate.md` (§4.7).
3. ~~Project commands~~ → **native** `/design` / `/design-sync` / `/design-login` (CLI ≥ 2.1.185); the project value = the skill `claude-design-workflow` (§4.6) + Mode E reconciliation. Implementation — the plan `docs/superpowers/plans/2026-06-22-claude-design-integration.md` (T1–T7).
4. `.claude/skills/claude-design-workflow/SKILL.md` (§4.6).
5. `.claude/agents/ui-ux-designer.md` — Mode E + a reinforced Mode B (§4.5).
6. `.claude/agents/pm-snippets.md` + the reviewer docs — enforcement (§4.8).
7. Update `.claude/rules/common/skills-invocation.md` (trigger → claude-design-workflow) +
   the `CLAUDE.md` pointer map.
8. Pilot: run one real UI task end-to-end (Tier 1) to validate the pipeline.

**Zone-of-write:** everything in `.claude/**` + `docs/**` — the master/architect zone (NOT apps/packages).
The implementation — predominantly by the main session; the ADR wrapping can be via the architect agent.

---

## 10. Synced design systems (verified 2026-06-22, Chrome MCP)

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System name           | `CheekyCheeseIT CRM` (single source — `design-gate.md` + `claude-design-workflow` reference this name); **Default + Published**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Claude Design project | `https://claude.ai/design/p/89317b4c-60ea-4ff5-832a-231b4ad76c23` (owner's account "M")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Source                | `apps/web` (`@crm/web@0.0.1`) — tokens `app/styles/globals.css` + `app/components/**`; import via the native `/design-sync` (**real upstream code**, not a generic re-render)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Sync date             | 2026-06-22 (owner, native `/design-sync` in a design-logged terminal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| What was captured     | **218 tokens** verbatim (color 81, spacing 6, typography 15 incl. `--font-sans`, radius 2 = `--radius`/`--radius-2xl`, shadow 8, other 106) + **35 components** (real upstream): core shadcn/ui (Alert, AlertDialog, Avatar, Badge, Button, Calendar, Card, Command, Dialog, DropdownMenu, Input, Label, Popover, RadioGroup, ScrollArea, Select, Separator, Sheet, Skeleton, Table, Tabs, Textarea, Tooltip, Toaster) + CRM composites (AmountCurrencyInput, AnimatedTabs, CrmDialogContent, DatePickerField, ImageUploadField, PhoneInput, RoleSelect, SegmentedToggle, ShareSlider, SliderNumberInput, TechAutocompleteInput) |
| Landing               | Skipped by default (CRM-first); re-sync `apps/landing` — on a landing redesign                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Gaps                  | (1) **Inter brand font** not uploaded → rendered with a substitute (fix: "Upload fonts" in Claude Design; not a blocker). (2) Page-level compositions (KpiCard, nav-sidebar, finance/profile dialogs) are NOT in the `@crm/web` export library — **expected**, generated on-demand via `/design`. The full reference surface — `docs/design/assets/_design-system/inventory.md` (22 ui primitives, 103 composites, 42 dialogs).                                                                                                                                                                                                  |

> Screen _compositions_ do not have to exist as static designs in advance — they are generated on-demand
> via the native `/design` under this system. This section — what per-feature generations reference (T7+).
