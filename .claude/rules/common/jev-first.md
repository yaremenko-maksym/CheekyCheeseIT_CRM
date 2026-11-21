---
paths:
  - 'packages/inference/**'
  - 'apps/api/src/inference/**'
  - 'apps/api/src/extraction-worker/**'
  - 'apps/api/src/resumes/verification/**'
  - 'apps/api/src/job-sourcing/structuring/**'
  - 'apps/api/src/job-sourcing/role-ai/**'
---

# Rule: Jev first — every product AI call starts with "can Jev answer this?"

**Status:** Always-on for product AI work (owner decision 2026-11-21).
**Applies to:** everyone who designs, plans, builds or reviews a model call inside the product (Master, Architect, Coder, code-reviewer).

---

## The rule

Before you add a model call to the product, or change what an existing one asks, **route it to Jev
when Jev can answer it**. Only the remainder goes to the extraction worker's hosted routes
(Gemini, Groq, Cloudflare, OpenRouter `:free`). Those routes run on small shared free quotas; every
call Jev takes off them makes the rest of the product steadier.

Jev (TypeSafe System One, `DecisionPort`, adapter `packages/inference/src/adapters/jev.decision-adapter.ts`)
answers **typed questions about a bounded state**:

| Question type | Answer                             | Fits                                                  |
| ------------- | ---------------------------------- | ----------------------------------------------------- |
| `noul`        | probability that a statement holds | yes/no checks, gates, "does X contain a defect"       |
| `choice`      | one option out of named criteria   | classification into a closed list (roles, categories) |
| `score`       | a position on an ordered scale     | urgency, seniority, relevance grades                  |
| `box`         | a region of an image               | locating something on a rendered page                 |

The state may carry **images** (`assets`, png/jpeg, with the header `TypeSafe-Danger-Zone-Images: true`)
and long text (header `TypeSafe-Danger-Zone-Long-Context: true`). Verified against the live API
2026-11-21 (`jev-latest` answered image `noul` questions). The API reference is
`https://docs.typesafe.ai/api.md`; read it before you build a new question shape.

## The check, in order

1. Write down what the call must return.
2. If the return is a verdict, a choice from a closed list, a grade, a probability or a location —
   it goes to Jev. Done when the call is a `DecisionPort` question set.
3. If the return is **free-form text or an open structure** (writing resume prose, extracting
   arbitrary fields from a page), it stays on the hosted routes. Then split it: every closed-list or
   yes/no field inside that output (remote or not, seniority, employment type) is a candidate for a
   Jev question next to the generation call. Done when each remaining hosted-route field is one Jev
   cannot express.
4. Record the outcome in the task file or PR body as one line:
   `Jev-first: <call> -> Jev | hosted (<why Jev cannot answer it>)`.

## How we know it is violated

| What is reconciled                                                                             | Who                   |
| ---------------------------------------------------------------------------------------------- | --------------------- |
| A PR adding or changing a model call carries the `Jev-first:` line                             | code-reviewer         |
| A hosted-route call whose output is a closed list, a yes/no or a grade, with no `hosted (why)` | code-reviewer, Master |

## Related

- `CONTEXT.md` → **Decision (port)** — the domain term.
- `docs/runbooks/extraction-worker.md` — the hosted routes and their quotas.
- `.claude/tasks/task-jev-offload.md` — the first migration of existing calls.
