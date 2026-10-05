---
paths:
  - 'apps/web/**'
  - 'apps/landing/**'
---

# Rule: Design-fidelity review — mockup ↔ localhost diff on ALL screens (mandatory gate)

**Status:** Always-on (hard gate; reviewer-enforced + Master-aggregate)
**Applies to:** ui-ux-designer (executor of Mode B), Master (aggregate/dispatch), code-reviewer (presence + coverage check), manual-qa (live behaviour)
**Source:** Owner request 2026-06-23 — "add a reviewer to the test pipeline that compares the mockup and localhost for differences, across different screens" + "design straight away for all screens". Goal of the redesign program: **design = UI source of truth**.

---

## The rule

After implementing ANY UI (the diff touches a visual surface in `apps/web/**` or `apps/landing/**`) and
BEFORE merge — a **fidelity-diff review is MANDATORY**: comparing the **design reference** (Claude Design mockup /
`design.png` / spec `docs/design/<slug>.md`) against **live localhost** on ALL device classes. A discrepancy
OR incomplete class coverage = `Fidelity: BLOCK` → merge forbidden until resolved.

This closes the "design → code" loop: it guarantees the implemented screen follows the approved mockup on
EVERY device, not "roughly similar on desktop". Without this gate, design cannot be the source of truth.

## Test widths (device classes)

`320 · 375` (mobile) · `768` (tablet) · `1024 · 1280` (laptop) · `1440 · 1920` (large). They match
`responsive-design.md`. The fidelity-diff runs on each one; a "desktop-only check" = incomplete audit = BLOCK.

## Who does what

- **Executor — `ui-ux-designer` (Mode B, fidelity-diff).** Loads the design reference + opens localhost
  in Playwright, runs the test widths, and on each compares **expected (mockup) ↔ actual (localhost)**:
  layout, spacing rhythm, typography, tokens, hierarchy, clipping/overflow, breakpoint behaviour,
  touch targets (≥44px on mobile). Posts a per-breakpoint diff table to the PR
  `[Width | Component | Expected | Actual | Severity]` + state screenshots.
- **Verdict (second line of the Designer's PR comment, after `Design Review:`):** `Fidelity: PASS | ISSUES | BLOCK`.
  - `PASS` — matches on all classes (minor nuances within tolerance).
  - `ISSUES` — discrepancies found → fix before merge (as strict as a code BLOCK).
  - `BLOCK` — noticeable drift / a class not covered / no reference where one should exist.
- **Master (aggregate).** For a UI PR the fidelity verdict is a MANDATORY part of the designer result
  (visual verdict + fidelity verdict + list of issues). No fidelity comment covering all
  classes → the aggregate is INCOMPLETE, return the designer for further investigation (like Manual QA without a design rubric).
  `Fidelity: ISSUES|BLOCK` → `do-not-merge` + fix task for the coder.
- **`code-reviewer`.** Verifies the fidelity comment exists AND covers ALL classes (not desktop-only).
  Absent/partial on a UI PR (tier ≠ 3) → `Verdict: BLOCK` with a link to this rule.
- **`manual-qa`.** Checks real BEHAVIOUR on mobile/desktop (live pass) — complements the fidelity-diff
  (designer = conformance to the mockup; manual-qa = functionality/RBAC/console).

## Design is done for ALL classes up front (precondition — mandatory)

A fidelity-diff is impossible without mockups for all classes. Therefore (reinforces `responsive-design.md`):

- **Generation (Claude Design):** the brief MUST require frames for 4 classes (320 mobile · 768 tablet ·
  1024 laptop · 1440 large) + states (default/empty/loading/error) on each — NOT "desktop, then
  adaptive". After generation verify the mobile frame is actually present; if not → draw it before
  handoff. A desktop-only mockup on a UI task = a violation of the rule.
- **Spec (`ui-ux-designer` Mode E):** `docs/design/<slug>.md` describes responsive behaviour per class
  (what collapses / scrolls / reflows).
- **`design.png`:** exported at minimum for mobile (320) AND desktop (1440) as Mode B fidelity references.

## Degradation (fallback)

- **No clean `design.png`** (CD drifted / Tier 3) → fidelity-diff against spec `docs/design/<slug>.md` +
  `foundation.md`; in the PR body note `fidelity: degraded` with the reason. **The responsive check on all classes
  at localhost stays mandatory** (overflow / clipping / touch targets) — only the "reference" degrades,
  NOT device coverage.
- **The artifact has only a desktop mockup** → at minimum a `320 + 1440` comparison + Master escalation (Tier 3 degradation).

## Related rules

- `.claude/rules/common/design-gate.md` — designer-in-the-loop BEFORE (generation/conformance) and AFTER (this fidelity audit); the reviewer check links here.
- `.claude/rules/common/responsive-design.md` — 4 device classes (this rule is the acceptance of mockup conformance on them).
- `.claude/rules/common/zone-of-write.md` — `ui-ux-designer` / `manual-qa` cosmetic-fix zone.

## Sources

- Owner request 2026-06-23 (fidelity reviewer + design for all screens; design = UI source of truth).
- Pipeline map (workflow `redesign-rules-map`, 2026-06-23): Mode B today takes screenshots, but the fidelity-diff
  is NOT formalized as a mandatory gate with all-class coverage — this rule closes the gap.
