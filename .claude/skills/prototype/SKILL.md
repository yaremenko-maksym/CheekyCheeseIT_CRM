---
name: prototype
description: 'A throwaway prototype that answers ONE design question. Two branches: UI — several structurally different variants on one route via ?variant= with a switcher hidden in prod; logic — one self-contained HTML file with buttons and scenarios that the owner opens from a phone. Cheaper than a full design-gate Tier 1 where it is not yet decided what the screen should be.'
when_to_use: "Use when a design question cannot be settled on paper: what should this screen look like, does this state model hold up, is this flow right. Examples: 'we have not decided how the screen should look', 'show dashboard variants', 'is the state model correct', 'poke at the logic before implementation', 'three options to choose from'."
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_take_screenshot
  - mcp__playwright__browser_resize
---

# Prototype — throwaway code that answers one question

Our `design-gate` knows three tiers, and any new screen is Tier 1: generation in Claude Design, a spec,
a fidelity audit across four device classes. For an **exploratory** screen, where it is not yet decided
what it should be, that is expensive and answers the wrong question.

A prototype is cheaper and answers **one** question. "Throwaway" is a constraint on **how the code is
written**, not a promise to delete it: the validated solution moves into real code.

## First thing — write down the question

One line at the top of the prototype: **which question it answers**. A prototype without a written question
is not a prototype but a draft that no one will later be able to accept or reject.

Next pick the branch. The wrong branch devalues all the work:

| Question                                          | Branch     |
| ------------------------------------------------- | ---------- |
| "How should this look?"                           | **UI**     |
| "Is the state model / business logic correct?"    | **Logic**  |

The question is ambiguous, the owner is unavailable → a backend module gives logic, a screen or component gives UI;
record the assumption as a line at the top (this is A1 per `autonomy-levels.md`).

## UI branch — variants on one route

**Prefer an existing route.** A variant that stands inside a real page — with a real header,
sidebar, real data and real density — is judged honestly. A separate
empty route is a vacuum where any variant looks decent.

- **Do (by default):** the route already exists, variants render on the **same** route under
  `?variant=`. Data loading, params and authorization stay; only the rendering changes.
- **Otherwise (last resort):** an entirely new surface that has nowhere to embed. A throwaway route
  per the existing TanStack Router routing convention, with the word `prototype` in the path.

Next:

1. **Three variants by default**, five at most. More — no longer "radically different" but noise.
2. **Differ by structure**, not color: a different layout, a different information hierarchy, a different
   main affordance. Three slightly different card grids are wallpaper, not a prototype. Two variants
   came out similar → redo one with an explicit ban on accepting the first.
3. Assemble with **our** components (shadcn/ui) and `globals.css` tokens — otherwise the chosen
   variant does not transfer and the decision is made on an image that does not exist in prod.
4. **The switcher** — a floating panel at the bottom center: left arrow, variant label, right
   arrow; keyboard arrows also page through it (except when focus is in an `input` / `textarea` /
   `contenteditable`); it updates the search param via the router so the link is shareable;
   **hidden in the prod build** (`import.meta.env.PROD`), so an accidentally merged prototype does not reach
   users.
5. **Screenshots of each variant** at 375 and 1440 (`browser_resize` + `browser_take_screenshot`) —
   in one message to the owner. This is exactly the AFK form: three pictures, a one-word answer.

A typical answer is "the header from B, the sidebar from C". That is the sought design.

## Logic branch — one HTML file

One self-contained `.html`: no build, no server, no framework. Opens with a double tap,
survives being forwarded into a messenger.

1. **Logic as a pure module** in one `<script>`: a reducer `(state, action) => state`,
   a state machine, a set of pure functions or a class — whichever answers the question more honestly. No DOM
   inside: the page calls the module, nothing flows back. That is exactly what makes the module portable into
   real code after the answer.
2. **Domain language, not code.** Buttons and state fields read as words from `CONTEXT.md`:
   "obligation", "calculation", "drop share", not `PENDING_PAYOUT`, `settleByCompany`.
3. **Layout:** heading and question → a current-state panel (labeled fields, not a JSON dump),
   re-drawn after each click → free-play buttons (one per action) → scenario tabs: a short description of
   the situation and a button per step, start resets to a known initial
   state.
4. **Scenarios are about the awkward cases**: the happy path, the tricky edge, an attempt to do what
   should be forbidden.

## Rules for both branches

- **No tests.** A prototype that needs tests is no longer a prototype.
- **No real writes to the DB.** State in memory. If the question is precisely about persistence —
  a scratch DB with an obvious name; never write to the live `crm_db` (`live-db-access.md`).
- **Do not generalize.** "What if X is needed later" — it will not be: the prototype answers one question.
- **Show state** after each action or variant switch.
- **Trivially launched**: one task-runner command or a double click.

## When the answer is obtained

1. Record the **answer and the question** it answers in the task file or the PR body. An answer without a
   question is unreadable a week later.
2. The validated solution (variant / logic module) is moved into real code — **rewritten
   as production**, not copied: the prototype was written without error handling and tests.
3. The prototype itself is the **primary source**: a commit on a discarded branch `prototype/<name>` outside main,
   a pointer to it from the task. In main there remain neither the losing variants nor the switcher:
   they rot and confuse the next reader.
4. The chosen UI then goes the usual `design-gate` path — the prototype answers "what", not
   "is it done well enough".

## Related

- `.claude/rules/common/design-gate.md` — tiers; the prototype goes BEFORE Tier 1 generation.
- `.claude/rules/common/responsive-design.md` — device classes for screenshots.
- `.claude/rules/common/autonomy-levels.md` — choosing a branch without the owner = A1 with a record.
- `CONTEXT.md` — the language the buttons and states are labeled with.
