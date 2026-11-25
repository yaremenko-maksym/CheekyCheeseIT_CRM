# Bookmarklet: AI reads the page through a block map (design)

Status: draft, awaiting owner approval. Date: 2026-11-25.

## Intent

The owner wants the bookmarklet to find title, company, description (with pay and benefits)
on any job page almost without error. Rules hand-written per layout (PR B, `pane.ts`) top out:
platforms hide the text under deep tag cascades, and raw HTML does not show what sits where.
The browser already knows: the bookmarklet runs inside the rendered page. So the model gets
what a person sees (position, size, weight, region), not raw HTML.

## Goals / non-goals / anti-goals

- Goal: on a new blind set of about 100 pages (holdout3, stratified like holdout2: ATS, boards,
  career sites, two-pane lists; several languages), pre-registered as counts before the run:
  title correct >= 97/100, full description (intro to closing, pay, benefits) >= 95/100,
  foreign text in the description on <= 3/100 pages (Master's bars, owner may change). A set
  of 32 cannot show "almost error-free": one ambiguous gold page would decide it.
- Goal: works on any site, including JS-rendered and logged-in pages (LinkedIn), with no
  per-site code.
- Non-goal: server-side fetch of job sites (owner rule stays). Non-goal: screenshots in stage 1.
- Anti-goal: the model writing or paraphrasing vacancy text. Every character HR gets must come
  from the page verbatim; a model that invents a salary is worse than an empty field.
- Anti-goal: the form breaking when AI is down or out of quota (degrade, never break).

## Approaches considered

1. **Block map (picked by the owner).** The bookmarklet cuts the page into visible text blocks
   with layout facts; the model answers with block numbers; text is assembled from the page.
2. Screenshot + vision model (Jev `box` can locate a region on an image). A bookmarklet cannot
   take a full-page screenshot by itself: `getDisplayMedia` asks the user every time and
   captures only the viewport. Automatic full-page capture with scrolling needs a browser
   extension (`chrome.tabs.captureVisibleTab` + scroll stitching, or the debugger API); there the
   permission is granted once, at install. Kept as stage 2, only if stage 1 misses the bars.
3. Both at once. Rejected for now: the most work before we know stage 1 is not enough.

## Design (stage 1)

1. **Block map, in the page.** The bookmarklet walks the rendered DOM and emits blocks: an id,
   verbatim text (capped), the element kind (h1–h6, p, li, td, a, button…), its box on the page
   (x, y, w, h), font size and weight, and flags: inside nav / header / footer / aside / main /
   dialog, link density. Invisible elements (`display:none`, `visibility:hidden`, zero size,
   off-screen, `aria-hidden`) are dropped. Shadow DOM and same-origin iframes are walked.
2. **Transport.** Today the bookmarklet opens the CRM tab with the data in the URL hash
   (`HASH_MAX` 32 000). Measured on the 76 dev pages (bench + spent holdout, rendered with CSS,
   JS off): 91 blocks median, 176 at p90, 399 max; map text 9.7 k chars median, 31.7 k max;
   deflate + base64 5.1 k median, 14.2 k max. So the compressed map fits the hash on every
   dev page, and the same channel is kept. `postMessage` is not used: a job site with
   `Cross-Origin-Opener-Policy: same-origin` (seen on captured sites) severs the opener handle.
   Over the cap, the map drops nav / footer blocks first, then truncates the longest blocks.
   The in-page walker adds to the bookmarklet bundle, which must stay under the existing
   20 000-char `javascript:` URL budget (`bundle.test.ts`).
3. **The question to the model.** The API renders the map as compact lines, e.g.
   `#12 h1 32px/700 x120 y210 w600 main | Senior Java Engineer`, plus the page URL and title
   tag, and asks for JSON only: `titleBlock`, `companyBlock`, `descriptionBlocks` (ordered id
   ranges), `payBlocks`, `confidence`. Zod validates it; every id must exist in the map.
   The server assembles the text from the referenced blocks verbatim, so the model can pick
   wrong but cannot invent.
4. **Jev first.** "Is this a vacancy" stays the existing Jev `noul` gate (`ManualParseService`).
   The title among the top heading candidates is a closed choice: a Jev `choice` question is a
   candidate next to the hosted call. Picking description ranges is an open structure:
   hosted route (Gemini / Groq / Cloudflare / OpenRouter `:free`).
   `Jev-first: block-map pick -> hosted (ordered id ranges are an open structure); vacancy gate + title -> Jev`.
5. **Cross-check and fallback.** The deterministic extractor of PR B still runs. AI down, out
   of quota or invalid JSON -> PR B's result fills the form, as today. AI and extractor
   disagree on the title or the description start -> the form marks the fields to check
   (a UI change: design gate applies). PR B (#1497) continues as planned: it is this fallback.
6. **Privacy.** Contacts are stripped (`stripContacts`) before the hosted call, as in the manual
   parse today. Nav / header / footer blocks send flags and short text only; the HR's own name
   in a logged-in header must not reach the model in full.

## How the prompt is built

Step one is a throwaway spike: a free hosted model gets the rendered map of the pages the
current extractor misses on the dev sets and must return correct block ids; the map is about
4.7 k tokens at p90, within the context of the free routes. The build starts only if the
spike works.

Spike result (2026-11-25, first prompt, no tuning; `nvidia/nemotron-3-ultra-550b-a55b:free` on
OpenRouter; 20 dev pages = 10 the extractor misses + 10 controls, JS off): title 20/20, full
description 19/20 (career-shopify missed the closing block), foreign text on 2/20 (a "hiring
process" section, filter chips). `google/gemma-4-31b-it:free` was rate-limited on every call;
`meta-llama/llama-3.3-70b-instruct:free` is no longer free (404). Free-route quota per day is a
design constraint: the hosted call needs a fallback route and PR B's extractor behind it.
Status: owner approved the design and the spike on 2026-11-25.

The prompt is tuned on bench (n=44) and the spent holdout (n=32), gold per page. holdout2
(n=32) stays blind until PR B's round 5 has had its single run on it; only then does it join
the dev data. The eval harness opens each saved page in Chromium with its CSS, injects the
same block-map code and scores the model's picks against gold. Iterate on the dev sets only;
then capture a fresh blind set (holdout3), pre-register the bars, run once. The prompt, the
few-shot examples and the model route live in the repo with the eval numbers in the PR body.

## Left to the builder

Block-splitting rules (what counts as one block, merging inline runs), the caps, the exact line
format, which hosted model, the few-shot choice, the disagreement rule's thresholds.

## Stage 2 (only if stage 1 misses the bars)

A small browser extension takes an automatic full-page screenshot (scroll + stitch); Jev `box`
or a vision model locates title and description regions; the regions map back to block ids and
confirm or override the stage-1 pick. Only for pages where stage 1 reports low confidence.
