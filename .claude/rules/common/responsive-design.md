---
paths:
  - 'apps/web/**'
  - 'apps/landing/**'
---

# Rule: Responsive design — CRM usable on any device (mandatory)

**Status:** Always-on
**Applies to:** Coder, ui-ux-designer, code-reviewer, manual-qa, Master/orchestrator (dispatch — AC, design generation)
**Source:** Owner request 2026-06-23 — "I want to use the CRM from any device; the entire interface must have mobile / tablet / laptop / large-screen adaptivity; adapt the design system to the mobile version".

---

## The rule

**ANY visual surface in `apps/web/**`(and`apps/landing/**`) MUST be fully usable
and visually correct on 4 device classes: mobile · tablet · laptop · large screen.**

"Usable" = no horizontal overflow; nothing clipped or unreachable; primary actions
available; controls/targets comfortable for touch on mobile; content scans rather than breaks.

This is a **hard gate** — on par with design-gate. A UI task without confirmed adaptivity across all 4 classes =
`Verdict: BLOCK`.

## Device classes → breakpoints (Tailwind) → test widths

| Class      | Range     | Tailwind     | Test widths (Playwright) |
| ---------- | --------- | ------------ | ------------------------ |
| **Mobile** | 320–639   | base (`<sm`) | 320, 375                 |
| **Tablet** | 640–1023  | `sm` / `md`  | 768                      |
| **Laptop** | 1024–1439 | `lg` / `xl`  | 1024, 1280               |
| **Large**  | ≥ 1440    | `xl` / `2xl` | 1440, 1920               |

**Mobile-first:** base styles — mobile; scale up via `sm:`/`md:`/`lg:`/`xl:`/`2xl:`. NOT desktop-first
with fallbacks.

## Per-class patterns (inherited by all screens; source — `docs/design/foundation.md`)

- **Mobile (<640):** single column; nav-sidebar → `Sheet` overlay (burger in the header); dense tables →
  card stack OR horizontal scroll with a sticky first column (do NOT clip); large modals →
  full-screen / bottom-sheet; touch targets **≥44×44px** (larger than the a11y minimum of 24px); do NOT rely on
  hover-only (touch does not hover) — actions visible/available on tap; long labels wrap/truncate.
- **Tablet (640–1023):** 1–2 columns; sidebar may be visible (`md:flex`) or collapsible; condensed
  toolbars; forms — 1–2 columns.
- **Laptop (1024–1439):** the main desktop target for operators; full layout.
- **Large (≥1440):** content columns (lists/details/forms) — `max-w` cap so lines don't stretch
  at ultra-width; tables/dashboards may be full-width; stable grid, no "holes".

## Mandatory enforcement

- **Master/orchestrator (dispatch):** every UI task carries explicit **responsive AC** (4 classes + test widths).
- **Design generation (Claude Design) — design for ALL classes up front (MANDATORY):** the brief MUST require
  frames for 4 classes (320 mobile · 768 tablet · 1024 laptop · 1440 large) + states
  (default/empty/loading/error) on each — NOT "desktop, then adaptive". After generation verify the
  mobile frame is actually present; if not → draw it before handoff. `design.png` is exported at minimum
  for mobile (320) AND desktop (1440). A desktop-only mockup on a UI task = a violation.
- **Fidelity acceptance (mockup ↔ localhost on all classes):** after implementation — a mandatory fidelity-diff
  gate before merge, see `.claude/rules/common/design-fidelity-review.md`. This file sets WHAT must be
  adaptive; fidelity-review — the acceptance of mockup conformance on each class.
- **Coder:** mobile-first; builds all 4 classes; before "done" — a Playwright check on the test widths
  (overflow scan + touch targets on mobile).
- **ui-ux-designer Mode B:** the fidelity audit runs on ALL test widths (320/375/768/1024/1280/1440/1920),
  not just desktop. Drift/overflow/clipping on any class → BLOCK.
- **code-reviewer:** on a PR touching `apps/web/**`/`apps/landing/**` visuals — verifies the presence of
  responsive handling (breakpoint classes, no fixed widths that break mobile) + responsive AC.
- **manual-qa:** live pass on mobile + desktop viewports.

## Design system — mobile adaptation

"Design system" = `foundation.md` (our visual language) + the synced Claude Design system
`CheekyCheeseIT CRM` + tokens/components. Mobile adaptation:

- **Component mobile-adaptation patterns** are fixed in `foundation.md` (sidebar→Sheet,
  table→card-stack/scroll, dialog→sheet, touch targets, responsive type-scale). All generations/builds follow them.
- **Tokens** (color/radius/font) are device-agnostic — not duplicated per device; adaptivity comes from layout +
  spacing + type-scale (`clamp()` for large headings where needed).
- **Claude Design re-sync for mobile** — when needed, the owner runs `/design-sync` after
  expanding mobile patterns (interactive; see `claude-design-workflow`).

## Verification (Playwright)

On every UI task: run the test widths → assert no horizontal page scroll
(`document.scrollWidth <= clientWidth`), key blocks visible/reachable, on mobile touch targets ≥44px,
sidebar→Sheet works. Mobile+desktop screenshots in the PR/Mode B.

## Related rules

- `.claude/rules/common/design-fidelity-review.md` — fidelity-diff mockup↔localhost on all classes (mandatory gate before merge; this rule is its precondition).
- `.claude/rules/common/design-gate.md` — designer-in-the-loop; responsive — part of the fidelity gate (Mode B over all classes).
- `docs/design/foundation.md` §10 — concrete mobile patterns of the design system.
- `.claude/rules/ecc/web/testing.md` — visual regression at breakpoints 320/375/768/1024/1440/1920.
- `.claude/skills/accessibility/` — target-size (24px a11y minimum; on mobile we aim ≥44px).
- `.claude/skills/claude-design-workflow/` — generation of frames for all device classes.
