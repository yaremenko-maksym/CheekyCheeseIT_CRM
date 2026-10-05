---
name: writing-for-agents
description: 'How to write documents that agents read: rules, agent prompts, skills, CLAUDE.md, docs behind a pointer. The levers — the wording of the pointer, information hierarchy and progressive disclosure, completion criteria (clarity and demandingness), leading words, negation as an anti-pattern. Plus the discipline of weeding: tests for no-op, the environment cache, and relevance.'
when_to_use: "Use when creating or editing anything an agent reads: a rule in rules/common, an agent system prompt, a SKILL.md, CLAUDE.md, a task template. Also when a rule is not being followed and the wording may be the cause. Examples: 'write a new rule', 'the rule is not followed', 'clean up the rules', 'this doc has grown', 'the agent ignores the instruction', 'reduce the agent's context'."
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash
---

# How to write for agents

A reference for any document an agent consumes: a rule in `rules/common/`, an agent system
prompt, a `SKILL.md`, `CLAUDE.md`, a task template. The packaging differs, the writing is one: the same
levers make each one predictable — the agent repeats the **process**, not produces an identical result.

The reason for existing: 1600 lines of rules and 5600 lines of agent prompts are written without this
discipline, and we found the symptoms ourselves — the desync of `zone-of-write.md` and
`architect.md`, the "fifteen exceptions" that turned out to be the norm, an unfeasible skill trigger
that lived for months.

## The pointer is itself the firing

A **pointer** is a link that lives in the agent's context, names material outside the context, and encodes
the condition under which it must be reached. A skill's `description` is a pointer. A line in
`CLAUDE.md` naming a rule is the same object.

**What decides is the wording of the pointer, not its target.** Mandatory material behind a weakly worded
pointer is a variance bug: the agent reaches it hit-or-miss. It is fixed by **sharpening
the wording**, and only if that did not help — by inlining the material.

A pointer does two things: it says what this material is, and it lists the **branches** on which it
is reached.

- **Put the trigger word up front** — a pointer works by its beginning.
- **One branch — one trigger.** Synonyms naming one branch are one branch written
  twice: collapse them.
- **Remove identity that the body already carries.**

## Two loads

- **Contextual** — the cost of what is always loaded: a line in `CLAUDE.md`, a skill's `description`. Spent
  every turn, whether the pointer fires or not.
- **Cognitive** — the cost on the human: which documents exist and when to go to which.

**Our skew is deliberate.** The owner works remotely, so everything an agent might need
must be reachable by the **agent**, not by the human's memory. We save not on reachability but
on the precision of wording. (The source's technique — hiding a skill from the model to save context — is
inapplicable to us: a hidden skill is never invoked in AFK.)

## Information hierarchy

A document consists of **steps** (ordered actions) and **reference** (definitions, rules, facts
on demand). Mixing is free. The decision is on which rung each piece lies:

1. **A step in the file** — what the agent does, in order.
2. **Reference in the file** — read on demand. A flat set of equal-weight rules on one
   rung is a normal construction, not a smell.
3. **Disclosable reference** — moved to a separate file behind a pointer, loaded on firing.

**Progressive disclosure** — moving down the ladder so the top stays readable. It is not
so much saving tokens as protecting the hierarchy. The test for extraction is **branching**: inline what
every branch needs; extract what only some reach.

**Sprawl** — a separate failure: the document is simply too long, even if every line is alive.
Attention is smeared, and each extra line is one more that has to be kept current.

## Completion criteria

Each step ends with a condition by which the agent understands that it finished. Two properties make it
a lever:

- **Clarity** — will the agent tell "done" from "not done"? A blurry boundary ("understanding
  achieved") invites **premature completion**. Steps visible ahead pull toward finishing
  faster; the clarity of the criterion is the resistance. Fix in this order: first sharpen the boundary; and
  only if it is irreducibly blurry **and** haste is observed — split the sequence.
- **Demandingness** — how much the criterion requires. "Every changed model accounted for" makes you
  dig; "compile a list of changes" does not. It works on flat reference too: "every
  rule applied" sets the bar of an exhaustive check without a single step.

A strong criterion is simultaneously **checkable** and **exhaustive**.

## Leading words

A **leading word** is a compact concept already living in pretraining, which the agent thinks with along
the document: a _tight_ loop, a _red_ command, the _frontier_, a _seam_, a _guard_. Repeated as a **token**,
not as a sentence, it accumulates a distributed definition and anchors a whole area of behavior
with a minimum of tokens, because it pulls in already-present priors.

Your own word works too, if clearly defined, but an invented one pulls in nothing: you pay
tokens for the definition for what the ready-made one gives for free. First look for an existing one.

Look for what to collapse: a triad spelled out in three places; a pointer spending a sentence on one
idea. "Fast, deterministic, cheap" → _tight_. "A loop you trust" → _red_,
turning a blurry gate into a binary observable state.

**Negation is a failure next to this lever.** Governing through a ban drags the banned
behavior into context and makes it **more accessible**: negation is a weak modifier, a strongly
activated concept overrides it. Formulate **positively**: name the target behavior, then
the banned one is not uttered at all. A ban is justified only as a hard guardrail that
cannot be formulated otherwise — and even then paired with a positive goal. How this looks
in practice, see `git-policy.md` §Zero-tolerance.

## Weeding

Three tests, each a ground to delete, not to trim.

**No-op.** Does the sentence change behavior against the model's default? An instruction the model already
performs pays context for nothing. The test is **model-relative**, not reader-relative:
two people arguing about a no-op are arguing about the default, and it is decided by a **run of the
document**, not by discussion. Failed — the **whole sentence** is deleted. The test applies to leading words too:
a word weaker than the default ("be attentive" when the agent is already attentive) — is a no-op, and is fixed by a
**stronger word**, not by another technique.

**Environment cache.** The environment is also a source of truth: `package.json`, configs, the layout
of directories, `--help` output. A document that retells it is a **cache**, justified only
when the lookup itself is expensive. Cache what cannot be found by a glance: an unwritten convention, the reason
for a choice, the gotchas the config is silent about. One-file one-command references leave to
the environment, where they will not go stale.

**Relevance.** A line loses it in two ways: it never touched the task (exposition or a branch
that should have been extracted) or it went stale together with the world it describes. Without the discipline
of weeding the default fate is **sediment**: layers settle because adding is safe
and deleting is scary, and then you have to drill through them to the living.

**A single source of truth.** One meaning — one place. Duplication costs maintenance, costs
tokens and inflates the apparent importance of a meaning above its real rank. (A leading word is the inverse
case: the **token** is repeated, never the meaning.) If the same thing is described in two files, mark
both with an explicit line "edit one — edit the second" — or, better, leave one.

## What to check before considering a document done

- The pointer leads with a trigger word and lists only real branches.
- Every branch not reached by all is extracted behind a pointer.
- Each step has a checkable completion criterion.
- Each ban stands paired with a positive goal, and the goal goes first.
- No sentence fails the no-op test.
- No fact retells the environment without a reason.
- Each meaning lives in one place.

## Related

- `.claude/rules/common/skills-invocation.md` — how a skill's trigger gets into the catalog.
- `.claude/rules/common/doc-durability.md` — what to write in records that live for months.
- `.claude/agents/README.md` — the agent's reading budget at startup.
