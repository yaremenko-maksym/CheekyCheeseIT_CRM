---
name: codebase-design
description: 'A shared vocabulary and principles for designing deep modules: module, interface, depth, seam, adapter, leverage, locality. Plus three checkable principles — the deletion test, "interface = test surface", "one adapter = a hypothetical seam, two = a real one" — and the "design it twice" pattern via parallel subagents.'
when_to_use: "Use when designing or reshaping a module's interface, deciding where a seam goes, arguing that code is hard to test, or writing an architectural review finding. Examples: 'where to put the seam', 'this module is too shallow', 'how to make the code testable', 'propose an interface', 'an architectural finding in review', 'there is no right seam for a regression test'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - mcp__ast-grep__find_code
  - mcp__codegraph__codegraph_explore
  - mcp__codegraph__codegraph_callers
---

# Design: deep modules

A shared vocabulary for architectural conversations. Without it reviewers and designers write "component",
"service", "layer", "boundary" however it falls, and an architectural finding has no checkable form —
it is easy to deflect and impossible to confirm.

**The goal of design:** leverage for callers, locality for maintainers, testability for
everyone.

## Vocabulary — use it precisely

Do not substitute "component", "service", "API", "boundary". The uniformity of the language is the whole point.

**Module** — anything that has an interface and an implementation. Deliberately sizeless: a function, a class,
a package, a vertical slice across layers.
_Avoid_: unit, component, service.

**Interface** — everything the caller must know to use it correctly: not only
the type signature, but invariants, call order, error modes, mandatory configuration,
performance characteristics.
_Avoid_: API, signature (too narrow — only the type surface).

**Implementation** — what is inside. Differs from an **adapter**: there is a small adapter with a large
implementation (a Postgres repository) and a large adapter with a tiny implementation (an in-memory fake).
"Adapter" — when the matter is a seam; "implementation" — in the other cases.

**Depth** — leverage on the interface: how much behavior the caller (or a test) can engage per
unit of interface that must be learned. A module is **deep** when behind a small
interface there is a lot of behavior; **shallow** when the interface is almost as complex as the implementation.

**Seam** (Feathers) — a place where behavior can be changed without editing at that place; the _location_ of
a module's interface. Where to put the seam is a separate decision, not the same as "what to hide behind it".
_Avoid_: boundary (overloaded by bounded context from DDD).

**Adapter** — a concrete thing that satisfies the interface at the seam. Describes the **role** (which slot
it occupies), not the content.

**Leverage** — what callers get from depth: more capability per unit of learned
interface. One implementation pays off across N call sites and M tests.

**Locality** — what maintainers get: change, bugs, knowledge and verification
concentrate in one place rather than being smeared across callers. Fixed once — fixed everywhere.

## Three checkable principles

**The deletion test.** Mentally delete the module. The complexity **disappeared** — it was a pass-through layer, and it did not
pay off. The complexity **surfaced at N callers** — the module earned its living.

An architectural finding without a run deletion test is an opinion, not a finding.

**The interface is the test surface.** Callers and tests cross the same seam.
If you want to test **behind** the interface — most likely the module has the wrong shape.

**One adapter — the seam is hypothetical. Two — it is real.** Do not establish a seam until something
actually varies through it (usually prod + test). A seam with one adapter is just an extra level of
indirection.

**Depth is a property of the interface, not the implementation.** A deep module may internally consist of
small swappable parts — they are simply not part of the interface. A module has **internal** seams
(private, for its own tests) and an **external** seam on the interface. Do not expose the internal ones outward
only because tests use them.

## Designing for testability

1. **Accept dependencies, do not create them.** `processPayout(request, gateway)` is testable;
   `processPayout(request)` with `new EtherscanClient()` inside — not.
2. **Return a result, do not produce a side effect.** `calculateDropShare(project): Share` is
   testable; `applyDropShare(project): void` — not.
3. **A small surface.** Fewer methods — fewer tests; fewer parameters — a simpler setup.

## How to deepen with an eye to dependencies

The category of the dependency determines how a deepened module is tested through its seam:

| Category                 | What it is                                             | How it is tested                                                                 |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **In-process**           | pure computation, memory, no I/O                       | always deepenable; the test goes directly through the new interface, no adapter needed |
| **Locally swappable**    | a local stand exists (Postgres in docker, in-memory FS) | the seam is internal, a port on the external interface is not needed             |
| **Ours, but over the network** | our services behind a network boundary          | a port on the seam: logic in the module, transport injected by an adapter (HTTP / queue) |
| **Truly external**       | Etherscan, S3/R2, NBU, mail — not ours                 | the dependency is injected by a port, the tests give a mock adapter              |

**Replace, do not layer.** Old unit tests on shallow modules become garbage the moment
tests on the deepened module's interface appear — delete them. A test that has to change when the
implementation changes is testing behind the interface.

## Design it twice

When the shape of the interface itself is in question, the first idea is almost certainly not the best.

1. **State the problem space**: constraints, dependencies and their categories, a code sketch
   for concreteness (not a proposal — a way to make the constraints tangible).
2. **Launch 3–4 parallel subagents**, each with its own constraint:
   - "minimize the interface: 1–3 entry points, maximum leverage per point";
   - "maximize flexibility: many scenarios and extension";
   - "optimize for the most frequent caller: the default case is trivial";
   - "design around ports and adapters" (if the dependency is network or external).

   Each one gets, in the brief, this vocabulary **and** the language of `CONTEXT.md`, so they name things the same.
   The parallelism ceiling is ≈ 3-4 (`orchestration-routing.md`).

3. **Compare** by depth, locality and the placement of the seam. Give your recommendation — not a menu, but an opinion;
   combining the good parts of different variants is allowed and encouraged.

## Rejected formulations

- **Depth as the ratio of implementation lines to interface lines** (Ousterhout): encourages
  bloating the implementation. We use depth-as-leverage.
- **"Interface" = the `interface` keyword in TypeScript** or a class's public methods: too
  narrow, the interface includes every fact the caller must know.
- **"Boundary"**: overloaded by bounded context. We say **seam** or **interface**.

## Related

- `.claude/skills/diagnosing-bugs/SKILL.md` — "there is no right seam" as a phase-5 finding.
- `.claude/skills/codebase-audit/SKILL.md` — the fan-out mechanics for "design it twice".
- `.claude/rules/common/orchestration-routing.md` — the parallelism ceiling.
- `CONTEXT.md` — domain names for seams and modules.
