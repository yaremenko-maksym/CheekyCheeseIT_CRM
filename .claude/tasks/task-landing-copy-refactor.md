# task-landing-copy-refactor — critical refactor of the landing copywriting

## Agent: coder · Model: opus · Branch: `docs/landing-copy-refactor` (continue the existing one)

> The branch already contains the `copywriting` skill, the `copy-reviewer` agent and this task — do
> not branch off `main`, the skill is not there yet and `Skill('copywriting')` will fail. Do not create a separate branch
> on top of this one: stacked PRs in this project get closed when the base is squashed.

## Design tier: 2

Text is a visual surface: the length of a heading changes line wrapping and the rhythm of the page.
A separate mockup generation is not required, but a fidelity pass across device classes is
mandatory (`.claude/rules/common/design-fidelity-review.md`).

## Required skills

`copywriting` (load **before** the first text edit) · `frontend-design-direction`
(tone and audience) · `verification-before-completion`.

## Owner's request (verbatim)

> We need a critical refactor of the landing in terms of copywriting! We need to write proper
> headings so that they read easily, concisely and informatively. No fluff and no extra words!
> Also, the style of the text must be a priority, the text must look stylish.
> We do not put periods at the end of sentences in such headings. […] refactor the text for
> all languages. […] a separate agent checked the text for readability, beauty, style,
> informativeness (maybe some information is superfluous or something could be added or
> something looks inappropriate or crooked).

## What is already known

- Five dictionaries: `apps/landing/app/i18n/dictionaries/{en,uk,ru,es,pt}.ts`, ~317 lines
  each, `en` is the reference.
- Key consistency is already checked by a test (`apps/landing/app/__tests__/i18n.spec.ts`).
  It guarantees an identical set of keys, but **says nothing about the quality of the text**.
- The rule about periods is violated **right now**: `heroH1Highlight: 'that scale.'`,
  `aboutH2Line2: 'senior hands.'`, `workH2: 'Anonymised, but real.'` — and that is only `en`.

## Scope

### 1. The rule about periods — by a test, not by discipline

A rule that relies on attentiveness breaks on the very first new key. Add
a check in `apps/landing/app/__tests__/`:

- A heading key **does not end with a period** in any of the five dictionaries.
- A "heading" is defined **by exclusion**: there is an explicit list of prose keys
  (`seoDescription`, `heroParagraph`, `aboutP1/P2`, `workP`, `caseStudies[].challenge`,
  `caseStudies[].solution`, `footer.rights`, form error and hint texts — refine against
  the actual state), **everything else is considered a heading**. A new key falls under the
  strict rule by default — this is a deliberate choice: when adding prose, the author does it explicitly.
- Question and exclamation marks are allowed — the rule is only about the period.
  An ellipsis is forbidden together with the period.
- The test must **fail on the current code before the text is edited** — show this in the PR (the same
  order as in the other tasks: red test first, then the fix).

### 2. Rewrite the text — in five languages

- English is written first as the reference, the other four are **written anew in their own
  language, not translated**. A literal translation of a successful English heading yields a calque;
  this is the main defect the reviewer will look for.
- Every heading passes the logo-swap test (skill `copywriting` §1).
  Headings that fail it are rewritten first.
- Remove fluff: the first two or three words of a heading are almost always superfluous.
- Do **not invent** numbers and claims about the company. Everything factual (40+ projects,
  20+ engineers, case metrics) stays as is — the wording changes, not the facts.
  If a strong heading lacks a fact — do not make one up, put the question to the owner
  in the PR body as a separate list.

### 3. Check the layout, not only the dictionary

A heading that is beautiful in the file produces an orphan word on a phone. A run across all device
classes (320 · 375 · 768 · 1024 · 1280 · 1440 · 1920) for the **longest language**
of each block — usually ru or es. Orphan words, breaks in the middle of a semantic pair,
truncation — are fixed by rephrasing, not by CSS.

### 4. Do not hurt SEO

`seoTitle`/`seoDescription` and the structured data of vacancies already deliver results in
search and were recently fixed (#421–#425, #459). They may be changed, but deliberately: title
length ≤ ~60 characters, description ≤ ~155, the domain keywords (AI, EdTech,
E-Commerce) are preserved. Do **not touch** the vacancy markup (`baseSalary` and the rest).

## AC

1. A test for periods in headings exists, failed on the original text (show it in the PR),
   passes after the edit — on all five dictionaries.
2. The key-consistency test keeps passing (the set of keys has not diverged).
3. All five languages rewritten; in the PR body — one example per language explaining
   why it is not a translation of the English.
4. A run across seven widths on the longest language: mobile and desktop screenshots in the PR,
   no orphan words and no truncation.
5. SEO fields within limits, domain keywords in place, vacancy markup untouched.
6. `pnpm --filter @crm/landing test` + typecheck + lint green. Run the landing E2E
   locally (a text edit breaks text-based selectors — check and fix in `apps/e2e`
   ONLY if the selector is tied to a changed string; otherwise it is an AutoTest task).
7. PR `refactor(landing): rewrite headings and copy across all five locales`.
8. **Mandatory `copy-reviewer` review** — verdict `Copy Review: PASS`. `ISSUES`/`BLOCK`
   are resolved before merge, like any review findings.

## Process

Your own worktree; `DATABASE_URL= git push -u origin feature/landing-copy-refactor`;
prettier gate (fix and push — in SEPARATE commands); eslint MCP on changed files;
final commit `ac_verified: 1..8`. Do not touch labels, merge — on the owner's explicit
confirmation.

## For the owner

Tone is a matter of taste that cannot be derived from the code. If the options fork
(restrained-engineering versus bold), put **two variants of the main screen** in the PR body
and let the owner choose, do not decide silently.
