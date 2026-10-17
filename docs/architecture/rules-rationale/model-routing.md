# Rationale: model-routing

Rationale layer for `.claude/rules/common/model-routing.md`. Not auto-loaded — read on demand when
you need to know **why** a routing rule says what it says, or before changing one.

**Source:** USER request 2026-06-11 (token optimization) + owner feedback 2026-10-03 / 2026-10-04 +
the orchestrator-session measurement 2026-09-21.

---

## Price table the rule was written against

Prices per 1M tokens (input/output), as of 2026-06-11:

| Model      | Input | Output |
| ---------- | ----- | ------ |
| Fable 5    | $10   | $50    |
| Opus 4.8   | $5    | $25    |
| Sonnet 4.6 | $3    | $15    |
| Haiku 4.5  | $1    | $5     |

The "1.7×" in the original static-assignment table referred to the Opus/Sonnet input ratio.

## Why the minimally sufficient model became the DEFAULT (owner feedback 2026-10-03)

The earlier wording framed the cheap tier as a permissible option and the strong tier as the safe
choice. In practice that read as "take the strong one unless you have a reason not to", and on a
project this size overpaying a tier on every mechanical task became the main expense line. Verbatim
direction from the owner: the cheapest tier that is **guaranteed** to suffice is tried first; strong
and new model versions are for the complex or for after the weaker one failed — not by default.

## Why reviewers were moved OFF opus (owner feedback 2026-10-04)

The edition before 2026-10-04 kept `copy-reviewer` and `security-reviewer` on **opus**, reasoning
that "security and text quality in five languages — judgment, not mechanics; the defect is caught by
no check". This bred overspend: expensive models went to text review that does not justify them.
Verbatim from the owner: "a copywriting task is not the level of such models."

The reconsidered reasoning, per axis:

- **copy-reviewer.** Detecting Russianisms (the Russian-only Cyrillic letters absent from Ukrainian,
  per the guard — the canonical literal glyphs live in `russian-language.md`) plus checking against
  the `_Avoid_` list in `CONTEXT.md` is essentially mechanical list-work. Bulky or nuanced text (a
  5-language landing, "reads like a translation") still earns sonnet.
- **code-reviewer / spec-reviewer.** A diff where statuses did not shift, uk strings changed and
  tests were updated is a mechanical reconciliation; a diff with real logic is not.
- **security-reviewer.** A text-only or low-logic migration is a checklist check (logic/statuses
  unchanged, no leak into params). A really risky surface — new auth logic, money movement, crypto
  contracts — is not, and keeps sonnet/opus.
- **The compensating mechanism** is that the orchestrator verifies the aggregate itself. A cheap
  reviewer plus orchestrator reconciliation is cheaper than an expensive reviewer, and the
  reconciliation was already mandatory (`review-findings-transfer.md`).

**Authoring vs review** is the distinction that makes the downgrade safe: generating a quality
bilingual catalog needs sonnet (haiku stumbled — incident #761), but _verifying_ a catalog against a
list is mechanics.

### A stale table was removed from the core file (2026-10-16)

Until this restructure the core rule carried **two** reviewer tier tables that contradicted each
other: the 2026-10-04 section above (copy/security → haiku for the simple case) and, further down
under "Dynamic overrides", the pre-2026-10-04 table asserting `security-reviewer, copy-reviewer →
**opus**` with the rationale "Security and text quality in five languages — judgment, not mechanics".

The second table was the thing the 2026-10-04 feedback superseded; it was simply never deleted. Both
were always-on, so an agent reading the file could legitimately justify either tier. The restructure
keeps **one** reviewer table — the operative 2026-10-04 one — and records the removed table here.
This was flagged in the PR body rather than resolved silently, because it is a behaviour change, not
a formatting change.

## The measurement behind the token diet (2026-09-21)

An analysis of one internationalization loop session, from its start through all compacts:

| Actor                     | Figure                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Orchestrator (Fable)      | **10,937 turns**, 14M output tokens, **5.86 bn cache reads** |
| Coders (Sonnet, 156 runs) | **33.8 bn cache reads**                                      |

In the equivalent of API prices the orchestrator's _output_ was ~8% of the sum; the rest was
re-reading 300–500k tokens of context on every turn. Hundreds of turns were an "I'm waiting" answer
to a monitor event ("CI: success", "Deploy: success"). The coders' figure came from fix rounds on 26
findings and ~1000 tool calls on a single agent.

The owner's conclusion and the analysis's coincided: **the expensive thing is not the intellect, but
the number of turns × the context size.** The cascade "cheap model by default, expensive by
necessity" already existed in the rule; the leak was in the orchestrator's mechanics and in the
length of tasks. Hence the diet table in the core rule — every row of it is a turn-count or
context-size lever, not an intelligence lever.

Two numbers drive specific rows:

- **26 findings = ~1000 tool calls and 20+ bn cache tokens on one coder** → the `≤ ~10 findings`
  per fix round rule, and the split into 2–3 coders by disjoint file groups.
- **55k tokens of memory index × every turn** → the rule to archive closed projects older than a
  quarter out of the loaded index.

## Why there is no gate on the token diet

Every row of the diet table is observable only across a transcript, after the fact: a "waiting" turn,
a monitor echoing every check, a fix-task control line with N > 12, a loop session on Fable. A hook
sees one tool call, not a turn pattern, so a mechanical check would have to score prose. The cost of
a violation is counted in tokens afterwards and is visible in the usage report, which makes the
after-the-fact check sufficient — this is the same reasoning as in
`review-findings-transfer.md` §"Mechanical check".

## Sources

- USER request 2026-06-11 (token optimization) — the original rule.
- Owner feedback 2026-10-03 — minimally sufficient model as the default.
- Owner feedback 2026-10-04 — reviewers off opus; lower model versions by default.
- Orchestrator session measurement 2026-09-21 — the token diet.
- Incident #761 — haiku stumbled on _authoring_ a bilingual catalog.
