---
paths:
  - 'apps/web/**'
  - 'apps/landing/**'
---

# Rule: Design-gate — mandatory designer-in-the-loop for any UI

**Status:** Always-on
**Applies to:** Master (dispatch), Coder, ui-ux-designer, code-reviewer
**Source:** `docs/architecture/2026-06-22-claude-design-integration.md` (§4.7 + §4.8) + approved by the owner 2026-06-22 ("any UI decision must involve the designer").

---

## The rule

**Any task whose diff touches a visual surface in `apps/web/**`or`apps/landing/**`**
(`.tsx` rendering, `globals.css`, classNames, layout, icons, motion) MUST:

1. **before** the coder starts building — go through the designer (Claude Design generation OR
   ui-ux-designer conformance check), and
2. **after** implementation — pass a fidelity audit (ui-ux-designer Mode B).

The intensity of involvement is set by tier (below). The designer is ALWAYS involved; the only question is "how much".

## Tier table

| Tier  | Trigger                                             | Designer action                                                                                                                |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **1** | New screen / flow / component / redesign            | Full generation in Claude Design (native `/design` OR orchestrator via Chrome MCP) → artifact → **ui-ux-designer Mode E** spec |
| **2** | Edit to an existing screen                          | Edit the existing design in Claude Design OR ui-ux-designer conformance check → updated spec                                   |
| **3** | Trivial cosmetics (text, one padding / token color) | ui-ux-designer conformance check against the synced design-system `CheekyCheeseIT CRM` (no browser round)                      |

- **Master / orchestrator sets the tier** when creating the task — the `## Design tier:` field in the task file
  (`.claude/tasks/<task>.md`). If the field is absent on a UI task — default **Tier 1** (safe).

## Artifact contract (the only interface for the headless coder)

- `docs/design/<slug>.md` — coder-ready spec (written by ui-ux-designer Mode E): brief, link to the
  Claude Design project, **token-map** (only our tokens from `globals.css`, not raw hex),
  component list (existing shadcn/ui + what is new), motion / a11y (WCAG 2.2) / responsive
  (320/768/1024/1440), edge cases (empty/loading/error/overflow), path to reference screenshots.
- `docs/design/assets/<slug>/` — `design.html` (export from Claude Design) + `*.png` (state
  screenshots; `design.png` — the main fidelity reference for Mode B).
- **The headless coder sees ONLY these files.** The browser, the Claude Design session, Chrome MCP — are an
  implementation detail of the orchestrator, inaccessible to the coder. The coder builds from the spec with OUR
  components/tokens, **does NOT copy the raw exported HTML** (it is generic — divs instead of our components).

## Enforcement

- **Dispatch gate:** Master does NOT dispatch a UI coder without `docs/design/<slug>.md` (Tier 1/2) or
  a recorded Tier-3 conformance note. The coder's dispatch prompt contains the path to the artifact +
  "build with our shadcn/ui components, conform to `design.png`; do NOT paste raw HTML".
- **Reviewer check:** on a PR touching a visual surface in `apps/web/**` / `apps/landing/**`,
  code-reviewer verifies the presence of a design artifact (`docs/design/<slug>.md`) **and** of a
  fidelity-audit comment (Mode B) **covering ALL device classes** (`Fidelity: PASS|ISSUES|BLOCK` —
  see `.claude/rules/common/design-fidelity-review.md`). Absent / partial (desktop-only) and
  tier ≠ 3 → `Verdict: BLOCK` with a link to the rule.
- **Text — a separate gate.** A PR changing text for a client or candidate (dictionaries
  `apps/landing/app/i18n/dictionaries/**`, visible strings in `apps/web/**` / `apps/landing/**`,
  vacancy texts) requires a `copy-reviewer` verdict (`Copy Review: PASS|ISSUES|BLOCK` —
  see `.claude/agents/copy-reviewer.md`). A visual check does not replace a text check:
  ui-ux-designer looks at how a string looks, copy-reviewer at what it says and whether it says it
  equally well in all five languages. No verdict → `Verdict: BLOCK`.
- **`merge-approved` — unchanged:** set ONLY by Master / owner on the owner's explicit "merge".
  The reviewer / any agent does NOT touch `merge-approved` (see [[feedback_reviewer_self_merge_incident]]).

## There is one theme — dark. Do NOT check the light one

**Owner decision 2026-08-16.** There is no light theme in the CRM and none is planned yet:
`apps/web/index.html` hard-carries `class="dark"`, there is no `ThemeProvider` anywhere in `apps/web`,
no `useTheme`, no `prefers-color-scheme`, and `globals.css` defines only `.dark`.

**The imported ECC rules (`rules/ecc/web/testing.md`, `rules/ecc/web/design-quality.md`)
require checking both themes. That requirement does not apply here** — project rules take
precedence over ECC (see `rules/ecc/README.md` §Precedence).

In practice: do not request light frames during generation, do not audit the light one in Mode B,
do not file "broken in light theme" findings. The requirement was unfulfillable from the start —
there is nothing to check, and agents were spending turns on it.

If a light theme is ever introduced — that is a separate task (tokens + switch +
a run over all screens), and then this block is removed along with it.

## Fallback (degradation)

- **Claude Design unavailable / rate-limited / Chrome MCP drive fragile** → ui-ux-designer Mode A text
  spec (no browser round); in the PR body note `design-gate: degraded` with the reason.
- **Token drift** (`globals.css` changed, Claude Design is behind) → re-`/design-sync` before
  Tier 1 generation (details — `.claude/skills/claude-design-workflow/SKILL.md`).

## Related rules

- `.claude/rules/common/zone-of-write.md` — `apps/web/**` = Coder/Designer zone; artifacts in `docs/design/**`.
- `.claude/rules/common/light-track.md` — UI cosmetics (Tier 3) is allowed on the light track, but the conformance check is mandatory.
- `.claude/rules/common/skills-invocation.md` — trigger → `claude-design-workflow` skill.
- `.claude/rules/common/responsive-design.md` — adaptive on 4 device classes (hard gate); Mode B audits ALL classes, generation requests frames for all.
- `.claude/rules/common/design-fidelity-review.md` — post-impl fidelity-diff mockup↔localhost on all classes = mandatory gate before merge (this file — the gate BEFORE code, fidelity-review — AFTER).

## Sources

- ADR / spec: `docs/architecture/2026-06-22-claude-design-integration.md`.
- Implementation plan: `docs/superpowers/plans/2026-06-22-claude-design-integration.md`.
- Memory: `project_claude_design_integration`, `feedback_reviewer_self_merge_incident`.
