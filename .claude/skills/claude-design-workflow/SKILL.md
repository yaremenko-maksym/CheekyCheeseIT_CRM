---
name: claude-design-workflow
description: 'When the orchestrator (Master) or ui-ux-designer drives Claude Design (claude.ai/design) for a UI task: syncing the design system, generating a screen, exporting the bridge artifact for a headless coder, handoff. A cookbook on top of the native /design-* commands (CLI ≥ 2.1.185) + Chrome MCP drive + a fallback to the owner.'
when_to_use: "Use when the orchestrator (Master) or ui-ux-designer needs to drive Claude Design for a UI task or produce the handoff artifact (design-gate Tier 1/2). Examples: 'generate a screen design in Claude Design', 'sync the design system', 'export the artifact for the coder', 'let's go, HR-dashboard design', 'need design.html + design.png for the PR', 'how to drive claude.ai/design via Chrome MCP'."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - DesignSync
  - mcp__Claude_in_Chrome__navigate
  - mcp__Claude_in_Chrome__tabs_context_mcp
  - mcp__Claude_in_Chrome__read_page
  - mcp__Claude_in_Chrome__computer
  - mcp__Claude_in_Chrome__browser_batch
  - mcp__Claude_in_Chrome__find
  - Agent
---

# Claude Design Workflow (CRM)

A cookbook for driving **Claude Design** (claude.ai/design, Anthropic Labs, on Opus 4.8) as a designer-in-the-loop.
Implements the pipeline from `.claude/rules/common/design-gate.md` + ADR `docs/architecture/2026-06-22-claude-design-integration.md`.

**Hard constraint:** Claude Design is interactive/browser-based, there is **NO headless API/MCP connector**.
It is driven either by the orchestrator via Chrome MCP, or by the owner in the browser. A headless subagent (coder /
ui-ux-designer via `Agent`) CANNOT draw it itself — it reads the **file artifact** in the repo.

## When to invoke

- Before a Tier 1/2 UI task (design-gate) — design generation is needed.
- When design tokens (`globals.css`) or base components change — re-sync the design system.
- When the handoff artifact (`docs/design/<slug>.md` + `assets/<slug>/`) needs to be produced for the coder.

---

## 0. Native commands (CLI ≥ 2.1.185) — who runs them and how

CLI 2.1.185 ships native slash commands. They are **interactive** — they are **TYPED by the owner** in a live
`claude` session; the headless orchestrator does NOT invoke them via the Skill tool.

| Command         | What it does                                                                                                 | Who types it         |
| --------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| `/design-login` | Links Claude Code ↔ Claude Design (OAuth design-scope to the claude.ai login)                               | Owner, in `claude`   |
| `/design-sync`  | Reads tokens + React components from the code → creates/updates the design system in Claude Design ("BEST FIDELITY") | Owner, in `claude`   |
| `/design`       | Launch / handoff: generation against the design system                                                       | Owner, in `claude`   |

**Do NOT create project command equivalents** (`.claude/commands/design*.md`) — they would shadow/conflict
with the native ones. The project value = the gate + Mode E reconciliation + this skill + enforcement.

### The programmatic sync path (when the session has design-scope)

The session has a low-level tool **`DesignSync`** (`list_projects` / `get_project` / `list_files` /
`create_project` / `finalize_plan` / `write_files` …) — this is the very bridge the native
`/design-sync` uses. BUT:

> **Gotcha (verified 2026-06-22):** if the orchestrator session is authorized via `CLAUDE_CODE_OAUTH_TOKEN`
> (env injection), claude.ai **refuses to extend it with design scopes** → `DesignSync` fails with
> "Run /login in this session". A programmatic sync from such a session is impossible.
>
> **Solution:** the owner does the sync with the native `/design-sync` in a **fresh** `claude` (its own OAuth, not
> token injection), OR the owner does `/login` in the current session (risk: breaks token-auth) → then
> `DesignSync` comes alive and the orchestrator can sync/verify programmatically.

After any sync: the design system is **`CheekyCheeseIT CRM`** (the name is the single source, see the spec § "Synced
design systems"). All `/design` generations run against it → on-brand, not a generic AI look.

---

## 1. Per-feature generation via Chrome MCP (autonomous drive)

When a screen needs to be generated without the owner — the orchestrator drives the browser.

1. **Your own MCP tab:** `tabs_context_mcp` → get/create a tab; work only in it (do not touch
   the owner's live tabs).
2. **Navigation:** `navigate` → `https://claude.ai/design`.
3. **State before a click:** `read_page` with `filter: interactive` — see the real buttons/inputs BEFORE
   an action (the Claude Design UI is Beta, selectors drift; do not click blindly).
4. **Design system:** select `Design system = CheekyCheeseIT CRM` (otherwise a generic generation).
5. **Template:** Product prototype (screen/flow) or Wireframe (low detail). Blank — rarely.
6. **Brief:** paste the design brief (reuse the `frontend-design-direction` 5 questions: purpose /
   audience / tone=`dense/quiet/scannable` / memorable detail / constraints=Tailwind v4 + shadcn/ui +
   Russian UI + WCAG 2.2 AA + responsive 320-1440 + edge-cases).
7. **Generation → refine:** via conversation. Multi-step actions — `browser_batch` (navigate →
   click → type → screenshot in one round-trip). After each step — a screenshot for confirmation.

---

## 2. Exporting the artifact (the bridge to the headless coder) — SOURCE OF TRUTH

The artifact is the **only** interface the coder sees. It is placed in the repo (`docs/design/**` = the master/designer zone).

1. **HTML:** in Claude Design Export → standalone HTML → save to
   `docs/design/assets/<slug>/design.html`.
2. **State screenshots:** Chrome-MCP `computer action:screenshot save_to_disk:true` for each
   state (default / empty / loading / error) → `docs/design/assets/<slug>/*.png`. The main frame —
   `design.png` (the fidelity reference for ui-ux-designer Mode B).
3. **Brief file:** write `docs/design/<slug>.md` — brief + the URL of the Claude Design project + a preliminary
   token-map. (The full coder-spec will be completed by ui-ux-designer Mode E — step 3 below.)

**Slug** — kebab-case by screen (`hr-dashboard`, `senior-payouts`). One slug = one assets folder.

---

## 3. Handoff → ui-ux-designer Mode E → coder

1. Dispatch **ui-ux-designer Mode E** (`Agent subagent_type=ui-ux-designer`): input = `docs/design/assets/<slug>/`,
   output = a coder-ready `docs/design/<slug>.md` (mapping onto our shadcn/ui + token-map + a11y/responsive/
   edge-cases). See `ui-ux-designer.md` Mode E. **The coder builds from the spec, does NOT copy the raw `design.html`.**
2. Master dispatches the coder with the path to the artifact (see `design-gate.md` enforcement).
3. After implementation — ui-ux-designer **Mode B** fidelity audit (live Playwright vs `design.png`), then
   code-reviewer (checks the artifact is present), then User Testing → the merge gate (`merge-approved` —
   Master/owner only).

---

## 4. Fallback (degradation) — a safety net

- **Chrome MCP drive is fragile / slow** (the Claude Design UI changes) → the orchestrator forms the brief,
  the **owner** refines in the browser for 1-2 iterations and presses Export; the orchestrator picks up the artifact from
  `docs/design/assets/<slug>/` and continues from step 2. The owner sanctioned the autonomous drive; the fallback is a safety net.
- **Claude Design is unavailable / over the limit** → ui-ux-designer Mode A text spec (without the browser); in the PR body
  mark `design-gate: degraded`.
- **Generic markup in the export** (divs/hex instead of our components) → this is expected; this is exactly what
  Mode E is for. `design.html` is a visual reference, NOT code to paste.
- **Token drift** (`globals.css` ran ahead) → re-`/design-sync` before generation.

---

## Anti-patterns

- **The coder copies the raw `design.html`** → our components/tokens are lost. Always via the Mode E spec.
- **Generation without `Design system = CheekyCheeseIT CRM`** → AI-slop (purple-gradients, oversized hero).
- **Project commands `.claude/commands/design*.md`** → conflict with the native ones; do not create.
- **Clicking blindly without `read_page`/a screenshot** → breaks on the drift of the Claude Design Beta UI.
- **Sync from a token-injected session without `/login`** → `DesignSync` fails; do it in a fresh session.

## Related

- `.claude/rules/common/design-gate.md` — the 3-tier gate + the artifact contract + enforcement.
- `.claude/agents/ui-ux-designer.md` — Mode E (reconciliation) + Mode B (fidelity audit).
- `.claude/rules/common/design-gate.md` — enforcement (Master does not dispatch a UI coder without an artifact).
- ADR: `docs/architecture/2026-06-22-claude-design-integration.md`.
