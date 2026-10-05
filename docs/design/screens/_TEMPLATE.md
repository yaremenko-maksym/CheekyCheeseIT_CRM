# <Screen name> — <domain>

> Per-screen artifact (CRM redesign). Coder-ready spec on our shadcn/ui + tokens. Headless agents
> rely ONLY on this file + `assets/` (they have no browser access). Template: `docs/design/screens/_TEMPLATE.md`.
> Program: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.

| Field              | Value                                                |
| ------------------ | ---------------------------------------------------- |
| Screen             | `<name>`                                             |
| Route / trigger    | `<route or how to open the modal>`                   |
| Roles              | `<which roles see it>`                               |
| Claude Design URL  | `<link to the mockup>`                               |
| Status             | `captured` \| `approved` \| `implemented` \| `stale` |
| Last synced commit | `<short SHA of main it was captured on>`             |

## States

| State             | Screenshot (reference)        | Notes                                   |
| ----------------- | ----------------------------- | --------------------------------------- |
| default           | `assets/<screen>/default.png` |                                         |
| empty             | `assets/<screen>/empty.png`   |                                         |
| loading           | `assets/<screen>/loading.png` | skeleton                                |
| error             | `assets/<screen>/error.png`   |                                         |
| <domain-specific> | `assets/<screen>/<state>.png` | e.g. drag / expanded / validation-error |

> If a state could not be captured — state the reason here explicitly, do NOT silently delete the row.

## Components (mapping to our stack)

From the inventory `docs/design/assets/_design-system/inventory.md`:

| Visual block | Our component (shadcn/ui / composite) | New? |
| ------------ | ------------------------------------- | ---- |
| <block>      | `<Button / Card / CrmDialog / ...>`   | no   |

## Token-map

Only tokens from `apps/web/app/styles/globals.css` (no raw hex / generic gradients).

## A11y / responsive / motion

- **A11y (WCAG 2.2):** target-size ≥ 24px, focus order + visible focus, contrast 4.5:1/3:1, aria-label for icon-only, focus-trap for modals.
- **Responsive:** 320 / 768 / 1024 / 1440.
- **Motion:** <description of animations/transitions — duration, easing, what moves; frames in assets, not playable>.

## For the coder

Build with OUR components per this spec; `design.png` is the fidelity reference (Mode B will compare). Do NOT copy
the raw exported HTML from `design.html` (it is a visual reference, not code to paste).
