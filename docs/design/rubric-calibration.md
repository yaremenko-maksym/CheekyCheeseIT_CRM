# Rubric calibration — CRM redesign v2 (DRAFT)

> **Status:** DRAFT (Task 0.8, 2026-11-11). Not yet calibrated. The calibration council round (spec §5)
> runs after this draft lands; it fills the table in §5 and may move any anchor in §3.
> **Authority:** `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` §5 (the gate) and
> `docs/design/research/2026-11-11-mobile-benchmarks.md` § "Scoring rubric" (the 10 weighted criteria).
> This file adds only the written anchors; it does not change criteria, weights or gates.
> **Visual language the anchors assume:** `docs/design/foundation.md` v2.

---

## 1. How a score is made

- Score each criterion 0–10 **per device class**: mobile (< 640 px), tablet (640–1023 px), desktop
  (≥ 1024 px). On tablet use the mobile rule for touch and the desktop rule for layout.
- **Overall score per device class** = Σ(criterion score × weight) / Σ(weights of applicable criteria)
  — the weighted total out of 100 divided by 10, with criteria that do not apply dropped and the weights
  renormalised (for example, data-viz on a form).
- **Hard floors:** a score under 5 on criterion 2 ("never blocks") or criterion 4 ("forms and input") fails
  the screen, whatever the total. At the mockup gate the floors do not apply (spec §5); the qualitative
  anchors in §4 do.
- **Gates:** mockup gate ≥ 9.0 from every member; implementation gate ≥ 9.5 from every member on every
  device class, max 10 rounds. Quorum 3.
- The fixed anchors from the benchmarks file still hold: **0** = the benchmark pattern is absent or broken;
  **5** = it works, but has friction a reviewer can name; **10** = it matches or beats the benchmark.

| #   | Criterion                     | Weight |
| --- | ----------------------------- | -----: |
| 1   | Time-to-task                  |     15 |
| 2   | Never blocks (responsiveness) |     15 |
| 3   | Navigation and wayfinding     |     10 |
| 4   | Forms and input ergonomics    |     10 |
| 5   | Lists and tables              |     10 |
| 6   | Sheets, panels, gestures      |      8 |
| 7   | System states and feedback    |     10 |
| 8   | Data visualisation (stats)    |      7 |
| 9   | Platform fit                  |      8 |
| 10  | Accessibility (WCAG 2.2 AA)   |      7 |

---

## 2. Interaction thresholds (spec §5, verbatim)

Criteria 2 and the input part of 4 are scored at the implementation gate from measured facts. The
thresholds, copied verbatim from spec §5:

> 10 = INP < 100 ms and no long task > 50 ms during an interaction, no input lost; 9.5 = INP < 200 ms and no long
> task > 200 ms; below that it scales down to the < 5 floor at a visible freeze or a lost input

The 9 / 8 / 6 rows for criterion 2 in §3 interpolate that scale-down; the two endpoints above win on any
disagreement.

---

## 3. Anchors per criterion

Each cell describes what a screen **at** that score looks like. Score between anchors by the nearest fit.
"M" = mobile / tablet touch; "D" = desktop.

### 1. Time-to-task (15)

| Score | Anchor                                                                                                                                                                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Primary task in the fewest possible steps, matching Ramp / Things. Smart defaults pre-filled (date = today, currency = last used, project = current). M: reachable from any tab in ≤ 2 taps, one thumb, primary action in the bottom third. D: reachable without the mouse (single key or Cmd+K), ≤ 3 keystrokes to open the form. |
| 9.5   | As 10, but one avoidable step remains (one default the user must still set, or one extra confirm).                                                                                                                                                                                                                                 |
| 9     | Primary action is visible on the screen and reachable in ≤ 3 taps / one shortcut; defaults are present but generic (empty date, no last-used).                                                                                                                                                                                     |
| 8     | Primary action reachable, but behind one extra layer (overflow menu, a scroll on mobile, mouse-only on desktop), or the user re-enters data the system already knows.                                                                                                                                                              |
| 6     | Primary task needs a detour (another screen first, top-of-screen action on a phone, no keyboard path on desktop); a reviewer can count ≥ 2 avoidable steps.                                                                                                                                                                        |

### 2. Never blocks — responsiveness (15)

| Score | Anchor (implementation gate: measured; mockup gate: §4)                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10    | INP < 100 ms and no long task > 50 ms during an interaction, no input lost. Optimistic update, feedback < 100 ms, no blocking spinner (Linear). M: no layout jump when the keyboard opens. |
| 9.5   | INP < 200 ms and no long task > 200 ms. No input lost, no blocking spinner.                                                                                                                |
| 9     | INP < 200 ms on the main flow, one long task 200–300 ms on a secondary interaction; no input lost.                                                                                         |
| 8     | INP 200–350 ms on the main flow, or a short (< 1 s) blocking spinner on a non-money action; no input lost.                                                                                 |
| 6     | INP 350–500 ms, or a blocking spinner over content on the main flow; input survives but the user waits.                                                                                    |
| < 5   | A visible freeze, or a lost input (floor: fails the screen).                                                                                                                               |

### 3. Navigation and wayfinding (10)

| Score | Anchor                                                                                                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | User always knows where they are and how to go back; sections are role-aware (Linear, HIG). M: tab bar ≤ 5 incl. «Ще», active tab marked by more than colour, in-app back on every pushed screen. D: sidebar + Cmd+K + `?` sheet, breadcrumb on deep pages. |
| 9.5   | As 10; one secondary path is weaker (a deep link lands without a breadcrumb, or a More item lacks its badge).                                                                                                                                               |
| 9     | Location and back are always clear; one role's tab set puts a rarely used destination ahead of a frequent one.                                                                                                                                              |
| 8     | Back exists but is inconsistent (system back only in standalone, or close vs back mixed), or Cmd+K misses the page's own actions.                                                                                                                           |
| 6     | User can get lost: no in-app back on a pushed screen, a hidden destination with no route to it, or a non-role-aware menu.                                                                                                                                   |

### 4. Forms and input ergonomics (10)

| Score | Anchor                                                                                                                                                                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Minimal required fields, correct keyboard types, inline validation, no input lost on error or accidental close (Mercury, HubSpot). M: inputs ≥ 16 px, `inputmode` set, receipt via camera or library, the keyboard never covers the focused field. D: Tab order = reading order, Enter submits, inline edit where the data allows. |
| 9.5   | As 10; one field lacks the ideal keyboard or one validation message is generic.                                                                                                                                                                                                                                                    |
| 9     | All of the above present; validation runs on submit rather than on blur, or one optional field is shown where progressive disclosure would hide it.                                                                                                                                                                                |
| 8     | Input survives errors, but a dirty form closes without asking, or one field needs a manual format (date typed as text).                                                                                                                                                                                                            |
| 6     | Wrong keyboard on a numeric field, inputs < 16 px (iOS zoom), or the keyboard covers the focused field; input still kept.                                                                                                                                                                                                          |
| < 5   | Input lost on error or accidental close (floor: fails the screen).                                                                                                                                                                                                                                                                 |

### 5. Lists and tables (10)

| Score | Anchor                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Scannable rows, key value right-aligned in `tabular-nums`, filters held in the URL (Mercury, Attio). M: 2-line rows, trailing-edge swipe actions with a menu alternative, sticky search. D: dense 40 px table, inline edit, bulk select, column sort. |
| 9.5   | As 10; one secondary affordance missing (no bulk select where it would help, or one column not sortable).                                                                                                                                             |
| 9     | Rows scan well and filters persist in the URL; swipe or inline edit is missing where the data would allow it.                                                                                                                                         |
| 8     | Scannable, but values are not aligned / not tabular, or filters reset on back.                                                                                                                                                                        |
| 6     | A desktop table squeezed onto the phone (h-scroll for the key value) or cut columns; a reviewer can name the friction.                                                                                                                                |

### 6. Sheets, panels, gestures (8)

| Score | Anchor                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Right container for the job (foundation §8), drag-to-dismiss, no gesture conflicts (HIG, Base UI Drawer). M: detent sheet for short forms, full screen for long ones, no left-edge swipe. D: side panel for preview, dialog for confirm, Esc closes. |
| 9.5   | As 10; one detent height or panel width is slightly off for its content.                                                                                                                                                                             |
| 9     | Containers right; drag-to-dismiss missing on one sheet, or a dirty sheet closes on scrim tap without asking.                                                                                                                                         |
| 8     | One job in the wrong container (a long form in a medium sheet, a confirm in a side panel).                                                                                                                                                           |
| 6     | Desktop modal reused on the phone, or a gesture conflicts with the system (left-edge swipe, scroll vs drag).                                                                                                                                         |

### 7. System states and feedback (10)

| Score | Anchor                                                                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Skeletons matching the final layout, useful empty states with an action, recoverable errors that keep input, undo where the action is reversible. M: progressive haptic tick on success. |
| 9.5   | As 10; one state is plain (an empty state without its action, or no haptic).                                                                                                             |
| 9     | Every state exists; one uses a generic spinner or a generic error text.                                                                                                                  |
| 8     | One state missing (no empty state, or offline is not handled), or an error is shown but not recoverable in place.                                                                        |
| 6     | Spinners instead of skeletons on the main content, blank empty state, errors as dead-end toasts.                                                                                         |

### 8. Data visualisation (7)

| Score | Anchor                                                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Answer visible in 2 s; tap / hover drill-down; colour-blind-safe; sign not colour (Copilot). M: one chart per screen, tap a bar for detail, swipe the period. D: the chart follows the table filters (Mercury). |
| 9.5   | As 10; one drill-down path is weaker (tooltip but no keyboard access, or no period swipe).                                                                                                                      |
| 9     | Clear answer and safe palette; drill-down present but the chart ignores the table filters (D) or two charts share one phone screen.                                                                             |
| 8     | Readable but slow: the answer needs a legend lookup, or the sign is carried by colour only in one place.                                                                                                        |
| 6     | Several charts competing, unlabelled axes, red/green only, or no drill-down.                                                                                                                                    |

### 9. Platform fit (8)

| Score | Anchor                                                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Respects safe areas, viewport, standalone mode and dark-theme contrast (benchmarks § "iOS Safari / PWA constraints"). M: nothing under the home indicator or notch, no 100vh jump, works in standalone. D: works 1024–2560 px, no stretched line length. |
| 9.5   | As 10; one minor fit issue (a scroll bounce reveals the canvas colour, one frame jumps on rotation).                                                                                                                                                     |
| 9     | Safe areas and standalone right; one control sits close to (but not under) the home indicator, or 2560 shows a wide but readable column.                                                                                                                 |
| 8     | One platform rule broken but usable (100vh jump when the toolbar hides, lines over ~100 characters at 1440).                                                                                                                                             |
| 6     | Content under the home indicator or notch, input zoom on focus, or the desktop layout stretches edge to edge at 2560.                                                                                                                                    |

### 10. Accessibility — WCAG 2.2 AA (7)

| Score | Anchor                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Labels, focus order, contrast ≥ 4.5:1 (3:1 for UI parts), reduced motion honoured, zoom not disabled. M: every target ≥ 44 px. D: visible focus ring, full keyboard operation. Gestures have a single-pointer alternative. |
| 9.5   | As 10; one non-critical control slightly under target (40–43 px) or one decorative icon with a redundant label.                                                                                                            |
| 9     | AA met; one secondary control lacks a visible focus ring or one live region is missing (toast not announced).                                                                                                              |
| 8     | One AA miss off the critical path (a 3:1 border on a secondary input, a gesture-only action with a menu missing).                                                                                                          |
| 6     | An AA miss on the critical path (an icon-only button without a name, text under 4.5:1, a modal that does not trap focus).                                                                                                  |

---

## 4. Mockup-gate qualitative anchors (criteria 2 and 4)

A mockup has no running code, so criteria 2 and the input part of 4 are scored from the **stated
behaviour** in the screen spec. The measured thresholds (§2) and the < 5 floor apply only at the
implementation gate.

| Score | Criterion 2 — what the spec says the screen does                                                                                                                                                      | Criterion 4 (input part) — what happens to input on error / close                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | Every write optimistic where reversible (finance: sent immediately, shown optimistically, rollback + visible error); no blocking state anywhere; skeleton for first load; no layout jump on keyboard. | Error keeps every value, shows inline above the form, never covers a field, retry is manual; a dirty form asks before close; no double submit. |
| 9.5   | As 10; one secondary action waits for the server with a non-blocking inline pending state.                                                                                                            | As 10; the close-confirm wording or the error text is generic.                                                                                 |
| 9     | Main flow optimistic; one secondary action shows a blocking (but short, local) spinner.                                                                                                               | Values kept on error; a dirty form closes without asking on one path (scrim tap).                                                              |
| 8     | Main flow waits for the server with a local pending state (button spinner), no optimistic update.                                                                                                     | Values kept, but the error is a toast that can cover the field or disappears before it is read.                                                |
| 6     | A blocking overlay or full-screen spinner on the main flow.                                                                                                                                           | The spec does not say what happens to input on error or close.                                                                                 |
| < 5   | The spec describes a freeze or a lost action (for example, auto-retry of a money create).                                                                                                             | The spec loses input (reset on error, or close without confirm on a long form).                                                                |

---

## 5. Calibration council (to be filled — Wave 0)

**Procedure (spec §5):** one council round, quorum 3, on public screenshots of 2–3 benchmark apps per
static criterion. Each member scores each set against the anchors above. **If a benchmark does not land
around 9–10, the anchors are fixed first** (the "Anchor fix" column), then the round is repeated for that
criterion. Criteria 2 and the input part of 4 are not calibrated on screenshots (§2 thresholds apply).

**Proposed benchmark sets (A1, from the benchmarks file "10 looks like" column; the orchestrator
collects the public screenshots):**

| #   | Criterion                  | Benchmark set                                  |
| --- | -------------------------- | ---------------------------------------------- |
| 1   | Time-to-task               | Ramp (expense + receipt), Things (quick entry) |
| 3   | Navigation and wayfinding  | Linear (sidebar + Cmd+K), iOS HIG tab bar app  |
| 5   | Lists and tables           | Mercury (transactions), Attio (table)          |
| 6   | Sheets, panels, gestures   | iOS HIG sheets (Maps / Mail), Linear panel     |
| 7   | System states and feedback | Linear (empty + undo), Mercury (skeleton)      |
| 8   | Data visualisation         | Copilot Money (mobile), Mercury (desktop)      |
| 9   | Platform fit               | Things (iPhone), Linear (desktop 1440 / 2560)  |
| 10  | Accessibility              | iOS HIG reference app, Linear (keyboard)       |

**Score table — empty.** One row per criterion × device class × benchmark set. "Lands 9–10?" = the
median of the members is ≥ 9.

| #   | Criterion                  | Class   | Benchmark set | Member 1 | Member 2 | Member 3 | Median | Lands 9–10? | Anchor fix (if any) |
| --- | -------------------------- | ------- | ------------- | -------- | -------- | -------- | ------ | ----------- | ------------------- |
| 1   | Time-to-task               | mobile  |               |          |          |          |        |             |                     |
| 1   | Time-to-task               | tablet  |               |          |          |          |        |             |                     |
| 1   | Time-to-task               | desktop |               |          |          |          |        |             |                     |
| 3   | Navigation and wayfinding  | mobile  |               |          |          |          |        |             |                     |
| 3   | Navigation and wayfinding  | tablet  |               |          |          |          |        |             |                     |
| 3   | Navigation and wayfinding  | desktop |               |          |          |          |        |             |                     |
| 5   | Lists and tables           | mobile  |               |          |          |          |        |             |                     |
| 5   | Lists and tables           | tablet  |               |          |          |          |        |             |                     |
| 5   | Lists and tables           | desktop |               |          |          |          |        |             |                     |
| 6   | Sheets, panels, gestures   | mobile  |               |          |          |          |        |             |                     |
| 6   | Sheets, panels, gestures   | tablet  |               |          |          |          |        |             |                     |
| 6   | Sheets, panels, gestures   | desktop |               |          |          |          |        |             |                     |
| 7   | System states and feedback | mobile  |               |          |          |          |        |             |                     |
| 7   | System states and feedback | tablet  |               |          |          |          |        |             |                     |
| 7   | System states and feedback | desktop |               |          |          |          |        |             |                     |
| 8   | Data visualisation         | mobile  |               |          |          |          |        |             |                     |
| 8   | Data visualisation         | tablet  |               |          |          |          |        |             |                     |
| 8   | Data visualisation         | desktop |               |          |          |          |        |             |                     |
| 9   | Platform fit               | mobile  |               |          |          |          |        |             |                     |
| 9   | Platform fit               | tablet  |               |          |          |          |        |             |                     |
| 9   | Platform fit               | desktop |               |          |          |          |        |             |                     |
| 10  | Accessibility              | mobile  |               |          |          |          |        |             |                     |
| 10  | Accessibility              | tablet  |               |          |          |          |        |             |                     |
| 10  | Accessibility              | desktop |               |          |          |          |        |             |                     |

**Round log:** _empty — the orchestrator records the date, members (by seat, not model), and outcome
of each calibration round here._

---

## 6. Assumptions (A1, Task 0.8)

- The 9 / 8 / 6 anchors of criterion 2 interpolate the verbatim spec scale-down; the spec's 10 / 9.5 /
  floor endpoints win on disagreement.
- The benchmark sets in §5 are proposals drawn from the benchmarks file; the calibration round may swap
  them.
- Members are recorded by seat, not by model name (spec §5 does not name models).
