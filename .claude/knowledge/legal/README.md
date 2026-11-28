# Legal Knowledge Base

The legal corpus for the Legal agent. It is the primary source when the agent answers a consultation.

## Principles

1. **Git-versioned.** The change history is visible and can be rolled back.
2. **Open to every agent.** A Coder working on finance can read the compliance rules; a Reviewer can check a PR against them. It is not private to Legal.
3. **Citation source.** Every file is a source Legal may cite in an answer, so it must be verifiable: it links to authoritative external sources itself.
4. **Updated through a PR.** Changes go through a PR with review, like code. The Legal agent does not edit this corpus directly: it is a consumer, not the maintainer.

## Structure

```
.claude/knowledge/legal/
  README.md                 # this file
  domain-lessons.md         # distilled domain conclusions from past consultations (reference, not process lessons)
  cross-cutting/
    escalation-zones.md     # when Legal must escalate to a human lawyer
    citation-rules.md       # citation format in answers
```

Full consultations live in `.claude/knowledge/legal-consultations/`. Agent process lessons live in
`.claude/agents/memory/legal/lessons.md`.

## Topic folders

There are no topic folders yet (planned: `ua-fop/`, `crypto-usdt/`, `gdpr/`, `it-contracts/`). Legal
uses WebSearch as the primary source plus general legal principles, and marks an answer
`Confidence: LOW` when no static file covers it. A topic folder is added when real consultations show
the topic is needed; there is no upfront seeding.

## How to add content

A new topic file must contain:

1. **Topic title** — specific (not "FOP" but "FOP group 3 — income limit 2026")
2. **Authoritative source** — a link to zakon.rada.gov.ua / gdpr-info.eu / etc.
3. **Last verified date** — when the content was last checked
4. **Body** — the substance plus how it applies to our business (CRM Cheeky Cheese IT, UA outsourcing)
5. **Related** — links to related files in `.claude/knowledge/legal/` or `docs/business/`

Example (illustrative; the figures and the related file are placeholders):

```markdown
# FOP group 3 — income limit

**Authoritative source:** [Article 291.4 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17#n4877)
**Last verified:** 2026-05-31

## Summary

For 2026 the income limit for FOP group 3 is **UAH 7M** (1167 minimum wages as of 1 January). Exceeding it
requires moving to the general system / group 4.

## Applicability to our business

SENIORs work as FOP group 3 (5% rate). The limit can be exceeded at a rate above $5800/month over a year.
Checked monthly in the Finance dashboard.

## Related

- `.claude/knowledge/legal/ua-fop/fop-currency-ops.md` — currency operations within the limit
- `docs/business/modules/finance.md` — the finance flow
```

## Not done here

- Do not copy laws in full — link to zakon.rada.
- Do not publish confidential data (client contracts, internal procedures).
- Do not edit through the Legal agent — maintenance belongs to the owner.
