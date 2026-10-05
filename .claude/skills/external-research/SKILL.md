---
name: external-research
description: 'Recon OUTSIDE the repository from primary sources: official documentation, source code, specifications, first-party APIs, texts of laws. Every claim is traced to the owner of the claim, not to a retelling. The result is a citable markdown file in the repository, not text dissolved into the session transcript.'
when_to_use: "Use when the answer lives outside this repo: a library's actual behaviour, a third-party API contract, a spec, a law's status, a vendor's IP ranges. Examples: 'how X actually works in the library', 'what this external API returns', 'what is the status of the law', 'a vendor's IP ranges', 'check whether it changed in the new version', 'need a summary of the spec'."
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - WebSearch
  - WebFetch
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
---

# External research — primary sources only, result in the repository

`codebase-audit` covers recon **inside** the repository. Outward (a library, a third-party API,
a specification, a law, a vendor's IP ranges) recon ran unsystematically, and its result stayed
in the session transcript — that is, it disappeared.

Two things make this skill a skill: the **primary source** and the **file in the repository**.

## What counts as a primary source

| Topic                     | Primary source                                                           | Not a primary source                      |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| Library behaviour         | its source code, changelog, official documentation (`context7`)          | an article, a Stack Overflow answer, a tutorial |
| Third-party API contract  | the vendor's official spec, OpenAPI, a live response to a trial call     | a blog example, an npm wrapper            |
| Standard / format         | an RFC, W3C, a specification                                             | an MDN retelling (useful, but secondary)  |
| Law                       | the text of the act, the bill registry, an agency clarification          | a legal blog, a news item                 |
| Vendor infrastructure     | the endpoint / list published by the vendor                              | a GitHub gist, a copied list              |

**Tracing rule:** every claim in the report leads to the party that **owns** it. If you found a
fact in a retelling, go to the source of the retelling and cite it. The primary source is unavailable
(paywalled, removed, no public version) — say so: "primary source unavailable, fact per secondary
source <link>, lower confidence". A claim without a link is **not a finding**.

## Process

1. **State the question in one line** and **which decision** depends on it. This calibrates the
   depth: "needed for a PR description" and "needed to choose a library" are different work.
2. **Recon runs in the background.** Launched as a subagent while the main work continues. The owner and
   the main session do not wait (`phase-boundaries.md`, the "subagent" option).
3. **Collect facts, each with a link.** A contradiction between sources is itself a finding:
   record both and say which you believe and why.
4. **Check applicability to us.** A fact may be true in general, but we have a pinned version
   (`version-pins.md`): "this is fixed in v7" is useless while we are on v6. Cross-check with the pinned
   versions before writing "it works like this".
5. **Write the file** per the repository's existing convention (`docs/architecture/` for things that
   affect decisions; `.claude/knowledge/legal/` for a legal topic). There is a suitable place —
   put it there; there is not — put it in `docs/architecture/` and say where.

## File format

```markdown
# <Question in one line>

**Date:** <YYYY-MM-DD> · **Why:** <which decision depends on this>
**Shelf life:** <when to recheck and by what signal>

## Short answer

<2–4 lines. What the file is opened for a month later.>

## Facts

- <claim> — [<source>](url), <access date>
- <claim> — [<source>](url), <access date>

## Applicability to us

<accounting for our pinned versions, stack, and constraints>

## What could not be established

<honestly: where the primary source is unavailable, where sources diverge>
```

**Shelf life is mandatory.** An external fact goes stale silently, and a file without a staleness
signal is more dangerous than its absence: it looks verified. The signal is concrete: "recheck on a
major bump", "watch the bill registry", "cross-check the list monthly".

## How we know it is violated

- A claim without a link in the recon file is not a finding, it is struck out.
- A file without a "Shelf life" is unfinished.
- Recon that stayed only in chat is not done: the result does not survive the session.

## Live applications right now

- **Cloudflare IP ranges** — after the firewall is enabled, a stale list **takes the site down**, it does not
  merely make noise; a file with a shelf life and a recheck signal is needed.
- **Status of law 2074-IX** (virtual assets) — not enacted, awaiting the related bill;
  legal skills reference a snapshot that must have a shelf life.

## Related

- `.claude/skills/codebase-audit/SKILL.md` — recon **inside** the repository.
- `.claude/rules/common/version-pins.md` — applicability of an external fact to our versions.
- `.claude/rules/common/doc-durability.md` — how to write what lives for months.
- `.claude/rules/common/mcp-first.md` — `context7` instead of guessing a library's API.
