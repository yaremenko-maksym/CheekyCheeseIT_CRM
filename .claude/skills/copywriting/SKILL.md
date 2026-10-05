---
name: copywriting
description: Copywriting for the landing page and product UI of an IT company — headlines, subheadlines, CTAs, microcopy. Multilingual (en/uk/ru/es/pt).
when_to_use: You are writing or editing any text a client or candidate will see — landing headlines, subheadlines, CTAs, empty states, errors, vacancy texts. Also when reviewing such text.
---

# Copywriting for an IT studio

A project skill. Assembled because nothing ready-made was found, neither locally nor in the packs, and a
generic one would not know our rules anyway, nor that the text lives in five languages
with different line lengths.

**The positioning everything follows from:** CheekyCheeseIT is an outsource/outstaff studio of
senior engineers for international product companies. **Not limited by domain**;
the confirmed experience to date is AI, EdTech, E-Commerce (each has a real case
with real numbers). The reader of the headline is a CTO or a founder who has looked through
five such landings in a day. He does not read, he **scans** and looks for a reason not to close the tab.

> **Distinguish "we take on" and "we have experience" — these are not synonyms.** The first can
> be asserted about any domain. The second — only where there is a case, because the cases section on the landing directly
> states: the names are hidden by agreement, **but the tasks, solutions and numbers are exactly what they were**.
> One invented case turns this phrase into a lie addressed to clients, and devalues
> all the others. A fact is missing — a question to the owner, not a guess.
>
> Updated 2026-08-05 (PR #489). Before this, "Three domains: AI, EdTech,
> E-Commerce" stood here — the owner cancelled that positioning, and the wording would have spread
> across all future text tasks had it not been caught during the review of the same PR.

---

## 1. The logo-swap test (the main one)

Cover the company name. If you can put any competitor's logo under the text and
nothing breaks — the text is empty, no matter how polished it is.

```
❌ "We build products that scale"            → fits everyone
❌ "We work in any domain"                   → fits everyone
✅ "Seniors only. Shipping every week"       → fits us
```

The test is applied to EACH headline separately, not to the page as a whole.
A page can be concrete while half its headlines are interchangeable filler.

## 2. A headline is a label, not a sentence

- **One thought per headline.** Two thoughts are two headlines or a headline and a subheadline.
- **A ceiling of ~6 words** for the hero screen, ~8 for section ones. Not a hard limit but a signal:
  longer — there is almost always something to throw out.
- **No period at the end.** A period says "this is a sentence, read on"; a headline
  is a caption for a section. A question mark and an exclamation mark — by meaning, they change
  the intonation, but a period adds nothing. An ellipsis — almost always affectation.
- **The first two or three words are usually thrown out.** "We are a studio that helps…" →
  "We help…" → most often even this is extra. Start with a noun or a verb that carries meaning.

## 3. The concrete beats the abstract

Nouns you can touch, and verbs that describe an action.
Abstractions ("solutions", "approaches", "capabilities", "expertise") — almost always a sign
that the author has not decided what exactly they want to say.

A claim requires support next to it: a number, a mechanism or an example. Without support it is bragging,
and bragging reads as noise and lowers trust in the neighboring claims, including
the true ones.

```
❌ "High performance"
✅ "p95 — 80 ms instead of 400"
```

## 4. Signs of machine text (to scrub out)

Living text is uneven. Machine text is smooth, rhythmically uniform and assembled from
universal positive words.

- **Filler words:** "unlock potential", "seamless", "cutting-edge", "innovative",
  "in today's fast-changing world", "take to the next level", "transform",
  "full spectrum", "turnkey" (unless literally).
- **Triads.** "Fast, reliable, convenient" — three adjectives in a row cancel each other out.
  Keep one, the most unexpected, and prop it up.
- **The same rhythm.** Three paragraphs of three sentences of the same length read as generated.
  Alternate: a short phrase. Then longer, with a subordinate clause that finishes the thought.
- **Symmetric constructions** ("not just X, but Y") are good one per page, not in every block.

## 5. Five languages are five originals, not a translation

> **CRM (since 2026-09-19):** the product has two languages — `uk` (the source text in the code and in the catalog) and `en`. Everything
> below applies to them the same way: the English catalog is written anew, not translated; the claim of
> each string is identical in both; measure the length at 320 px for the longer language (Ukrainian is
> longer than English by 15–30%). There is no Russian text in the migrated CRM modules.

**The main rule: the text is written anew in the language, not translated.** A literal translation
of a good English headline almost always yields in Russian a clumsy calque that is
formally correct and at the same time reads immediately as translated.

**But it is the wording that is written anew, NOT the claim.** This constraint is more important than the rule itself
and is broken first. "Write anew in the language" changes _how_ it is said, and never — _what_
is promised. If the English headline names a cadence and the Russian loses it, that is not
an adaptation to the language but two different promises on one site.

The mechanic that catches this: **before writing, write out the claim of each headline in one
line** ("we do the complex" + "every week"), and after writing check that all five
languages carry the same set. It diverges — rewrite, do not explain.

The excuse "it does not fit in this language" is accepted **only after measurement**. Verified on
a live landing: a headline about which the author wrote "the cadence does not fit in Russian,
so it went into a paragraph", after substituting "weekly" gave zero new layout defects
at all seven widths. It did not fit not by layout but by oversight.

Practical consequences:

- **The length diverges.** ru/uk are longer than English by about 15–30%, es/pt — by 20–25%.
  A headline of six English words turns into nine Russian ones and wraps onto two
  lines on a phone. Count the length **in characters for the longest language**, not in words
  for English.
- **You have to check the layout, not only the meaning.** A headline, beautiful in a dictionary, can give
  a widow word on the last line at 320px. This is a defect of the text, not the layout: it is fixed
  by rewording.
- **The register of address is fixed once per language** and does not float afterward: ru/uk — the formal "you" (vy)
  in lowercase, without groveling; es/pt — the tú/usted decision is made explicitly and held everywhere.
- **Idioms do not move over.** An English pun that has no local equivalent is replaced
  by another device in that language, not calqued.
- **Industry terms live as borrowings — and this is encouraged.** "Deploy", "SaaS",
  "AI" in English; "ofer" (offer), "dedlain" (deadline), "fidbek" (feedback), "deploi" (deploy), "miting" (meeting), "apruv" (approve) in Ukrainian and
  Russian — the living language of the industry, which the reader and the team speak. A forced translation
  ("rozgortannya" instead of "deploy") sounds like a textbook and reads worse than the borrowing.
  An anglicism-**term** is not considered a finding — neither in review nor in self-check.
  _(Owner decision 2026-09-26: borrowings are allowed and encouraged; the boundary is only
  terms, not domain decisions.)_
- **The boundary runs along the unity of the domain term, not along the origin of the word.** Where a
  concept already has a chosen canonical form (the `CONTEXT.md` glossary), a borrowing-**substitution** is a
  finding: "korystuvach" (the Ukrainian for user), not "yuzer" (a borrowing of 'user'); "spivrobitnyk" (employee), not "vorker" (a borrowing of 'worker'); "chastka" (share), not "sher" (a borrowing of 'share'); "USDT",
  not "krypta" ('crypto'). The defect here is not that the word is foreign, but that one concept
  is called by two words on neighboring screens — navigation through the product breaks. Slang instead of
  a precise term ("dzhun" instead of the JUNIOR role, "krypta" instead of USDT) — the same defect.

## 6. The page hierarchy

Each screen has an eyebrow, a headline and body text. They must not
retell each other: if the headline can be deleted and the meaning does not change — it is extra.

- **Eyebrow** — a category, 1–3 words, nominative case.
- **H2** — the claim the reader stopped for.
- **Paragraph** — the proof or the unfolding of the claim. Here periods ARE placed, it is prose.
- **CTA** — a verb + an object ("Discuss the project"), not "Send" and not "Learn more".

## 7. The order of work

1. Write out the current headlines in one list **without the surroundings** — this makes visible the repeats and the fluff
   that are masked by images in the layout.
2. Run each through the logo-swap test. Rewrite the failed ones first.
3. Write English as the anchor, then **write anew** the other four.
4. Check the length of the longest language at 320px — by eye, not by a character counter.
5. Give it to `copy-reviewer` for review — self-check on your own text does not work.

## Related

- `.claude/agents/copy-reviewer.md` — mandatory text review by the rubric.
- `.claude/skills/design-system/` — the visual part of the same check (typography, rhythm).
- `.claude/rules/common/responsive-design.md` — 320px as a mandatory check class.
- `.claude/skills/frontend-design-direction/` — tone and audience before writing the text.
