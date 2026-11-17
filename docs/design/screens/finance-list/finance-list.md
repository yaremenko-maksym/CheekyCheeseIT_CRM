# Screen: Finance list (CRM redesign v2, Task 1.2)

> Per-screen artifact (CRM redesign v2). Coder-ready spec of the finance list on every device class.
> The coder relies ONLY on this file + `assets/` (no browser access). Template:
> `docs/design/screens/_TEMPLATE.md`. Visual and interaction language: `docs/design/foundation.md`,
> `docs/design/screens/_foundation/primitives-v2.md`, `docs/design/screens/_foundation/shell-v2.md`.

| Field              | Value                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Screen             | Finance list («Фінанси»): the transaction list and its role variants                                      |
| Route / trigger    | `/finance` (tab «Фінанси»; sidebar «Гроші → Фінанси»; deep link `/finance?status=PENDING`)                |
| Roles              | ADMIN, ACCOUNTANT, SENIOR, HR, JUNIOR, DROP (each a variant below)                                        |
| Claude Design URL  | none — `design-gate: degraded` (Claude Design cannot be driven headless; HTML prototypes, Playwright PNG) |
| Status             | Draft (Mode A), pending orchestrator review                                                               |
| Last synced commit | `11554c089` (foundation v2, #1319)                                                                        |
| Out of scope       | The add / edit transaction sheet (Task 1.3, designed in parallel): only its entry points are shown here   |

---

## 1. Current (capture-grounded inventory)

> Baseline device captures and the network baseline: **pending** (Wave 0 capture run). This
> inventory is read from the code of `routes/_authenticated/finance/index.tsx` and its components.

_Section being written: see the next commit._

## 2. Design direction

_Pending._

## 3. Layout per device class

_Pending._

## 4. States

_Pending._

## 5. Role variants

_Pending._

## 6. Interaction and motion

_Pending._

## 7. Accessibility (WCAG 2.2 AA)

_Pending._

## 8. Strings (`uk` / `en`)

_Pending._

## 9. Data and network

_Pending._

## 10. Self-score (rubric-calibration)

_Pending._

## 11. Open points

_Pending._
