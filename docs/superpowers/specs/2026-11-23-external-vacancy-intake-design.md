# External vacancy intake — design

Date: 2026-11-23. Status: approach and scope chosen by the owner in chat; this written form awaits
the owner's approval.

## Intent

Some job sources can never be connected to the automatic collector: DOU refused feed access
(2026-11-23), The Muse removed its public API (PR #1470), EU Remote Jobs forbids it, LinkedIn has no
usable feed, and many companies publish vacancies only on their own career sites. HR still finds
vacancies there by hand. Two things cost HR time today:

1. setting the same filters on every external site, for every senior;
2. recording a submission made outside the queue — there is no UI for it at all, although the API
   (`POST /job-queue/manual`) and the web hook (`useCreateManualJobQueueCard`) exist.

Success: HR opens a pre-filtered external feed in one click, and records an external submission with
the vacancy fields already filled in, so only the senior, the resume and "Submit" are left.

## Goals

- G1. A block on `/job-queue` listing the unconnectable sources, each with a deep link whose filters
  and sort are preset. With a senior selected, the filters come from that senior's `technicalRoles`;
  without one, general "senior / remote / newest" filters.
- G2. A dialog "Register an external submission" that creates the card and its first submission
  through the existing `POST /job-queue/manual`.
- G3. A bookmarklet "To CRM": one click on any vacancy page (DOU, LinkedIn, company career sites,
  anything) opens the CRM dialog of G2 with URL, title, company and description pre-filled.
- G4. A paste fallback: HR pastes the vacancy text into one field and a hosted model extracts title,
  company and description into the same dialog.

## Non-goals

- No server-side fetch of any external page. DOU refused us and the server IP is behind Cloudflare
  blocks; the data is read only by the HR's own browser (G3) or pasted by HR (G4).
- No browser extension.
- No exact per-senior filtering: a coarse filter is fine (owner, 2026-11-23).
- No change to how submissions and cancellations work server-side. Duplicates change in one way
  only (B, owner 2026-11-23): the manual-card URL key becomes per team, and the 409 names the card
  when the viewer can see it.

## Anti-goals

- Anything that makes CRM act on an external site on its own (requests, applying, scraping). HR
  decides and applies by hand; this stays true for what was told to DOU.
- A pre-filled form that saves without an explicit HR click.
- Rendering pasted / bookmarklet text as HTML.

## Constraints

- RBAC: everything here is ADMIN + HR, the same as `POST /job-queue/manual`. Security review is
  mandatory for: `technicalRoles` in `GET /job-queue/seniors` (widens what HR reads), the duplicate
  409 that names a card, the per-team URL key, and the post-login prefill restore (auth zone).
- `jobQueueSeniorOptionsResponseSchema` is `.strict()`; the new field changes schema, API and its
  spec together.
- `descriptionMd` max is `DESCRIPTION_MD_MAX` (50 000); `applicationUrl` is
  `externalHttpsUrlSchema` (https only).
- Product UI text in `uk` + `en` through Lingui.
- Jev-first: `Jev-first: page/paste "is this a vacancy" -> Jev (noul)`;
  `Jev-first: page/paste field extraction -> hosted (free-form fields: title, company, description)`.
- Free hosted routes only (no paid OpenRouter / OrcaRouter).

## Approaches considered (for G3/G4 — how HR avoids typing)

| Approach                                          | Trade-off                                                                                                     | Outcome                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Server fetches the URL HR pastes                  | zero install, but DOU refused us, server IP is blocked, LinkedIn rate-limits (429 seen on a single guest GET) | rejected                    |
| Bookmarklet reads the page in HR's browser        | one click, no AI, no server request; awkward on mobile; site markup may change                                | **picked (G3)**             |
| HR pastes page text, hosted model extracts fields | works on any page, nothing to install; seconds of latency, occasional mistakes, an AI call                    | **picked as fallback (G4)** |
| Browser extension                                 | most capable, but build + install + updates                                                                   | rejected (too heavy)        |

Owner picked "bookmarklet + AI paste" and asked that it work beyond DOU: LinkedIn, company career
sites and anything else.

## Design

### A. External feed links (G1)

- `packages/shared/src/job-sourcing/external-feeds.ts`: a list of `{ id, label, buildUrl(filters) }`
  where `filters = { keywords: string[], category?: string, seniorOnly: true, remote: true }`.
- `technicalRoles → filters` (my call: `users.technical_roles` is the closed list of 34 roles the
  queue matches on, `packages/shared/src/schemas/technical-roles.ts`; the free-text
  `users.tech_stack` is no longer used for matching): a static map from each role to each site's
  own taxonomy where the site has one (DOU `category`), otherwise `keywords` (the role's label).
- Verified 2026-11-23 (one GET each, from the developer machine):
  - DOU: `https://jobs.dou.ua/vacancies/?category=<C>&exp=5plus&remote` — works
    ("39 вакансій в категорії Python віддалено, досвід 5+ років"). `category` is a closed list of 59
    values (`Python`, `Java`, `Front End`, `Node.js`, `.NET`, `Golang`, `DevOps`, `QA`, `AI/ML`,
    `Data Engineer`, …); `exp` ∈ `0-1|1-3|3-5|5plus`; flags `remote`, `relocation`; free text
    `search=`. Stack without a category → `search=<stack>`.
  - LinkedIn: `https://www.linkedin.com/jobs/search/?keywords=<K>&f_E=4&f_WT=2&sortBy=DD` answers 200;
    the guest page does not show whether `f_E` (experience 4 = mid-senior) and `f_WT` (2 = remote)
    applied — **verify logged in** during manual QA.
  - The Muse site, EU Remote Jobs: templates verified during the build (owner go-ahead for single
    GETs). The Muse reads `q`, `remote=1` and `posted=30` and has no seniority filter; EU Remote Jobs
    reads `search_keywords` and is remote-only.
  - WTTJ is left out (build finding, 2026-11-24): its search no longer reads any filter from the
    URL, so a deep link would only open the landing page.
  - Only the senior's first role drives the links, and the block names that role. The role keywords
    are a separate English map, because the role labels are localized and the sites search in
    English. The module lives in `packages/shared/src/utils/external-feeds.ts`.
- UI: a collapsible "External sources" block on `/job-queue`, links `target="_blank"
rel="noopener noreferrer"`, current senior selection from the existing `seniorIds` search param
  (first selected senior; none → general filters).
- API: `technicalRoles` (role array) added to `GET /job-queue/seniors` items.

### B. Register external submission dialog (G2)

- Entry points: a button in the queue header and in the "External sources" block.
- Fields: application URL (optional, https), title, company and description (all three required by
  `jobQueueManualCardRequestSchema`; description plain text, stored as `descriptionMd`), team +
  senior (preselected from the current selection; ADMIN picks a team from `useActiveTeams()`).
- Resume: no picker. A senior has at most one resume (`senior_resumes.user_id` is unique) and it
  must be `READY` (otherwise the create answers 422). The dialog reads it from
  `GET /users/:id/resume`, fills `resumeId` itself and, when there is none or it is not `READY`,
  shows that state and disables Submit.
- Submit → `useCreateManualJobQueueCard`. `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` (409) → show the
  duplicates and a "Submit anyway" button that resends with `confirmPossibleDuplicate: true`.
- Duplicate URL (owner, 2026-11-23, "link to the card"):
  - The manual-card URL key becomes **per team**: team B may create its own manual card for a URL
    team A already registered. The key against collected (non-manual) opportunities stays global.
  - `JOB_QUEUE_MANUAL_DUPLICATE` (409) gains an optional `opportunityId`, present **only** when the
    actor can see that card under the queue's own visibility rules; otherwise the 409 stays as
    today (no team, no card). The dialog shows "This vacancy is already in the queue → Open and
    submit there"; without an id, a plain "already registered" error.
  - No migration: `application_url_key` has no unique index, the check is the query in
    `createManualCard`, so only that query changes. Needs a security review (no new existence oracle: a URL of a card the actor cannot see still gets the generic 409 it got before, with no `opportunityId`).
- On success the dialog closes and the queue switches to the `SUBMITTED` tab (the route defaults to
  `NEW`), where the new card is.
- Prefill entry: the route reads `location.hash` of the form `#external=<base64url(JSON)>`, parses it
  with a Zod schema `externalVacancyPrefillSchema` (`url?`, `title?`, `company?`, `description?`,
  all trimmed and length-capped), opens the dialog pre-filled, then clears the hash with
  `history.replaceState`. Invalid payload → open the empty dialog, no error page. The hash never
  reaches the server or its logs.
- Not logged in (verified: today the unauthenticated redirect in
  `apps/web/app/routes/_authenticated/route.tsx`, the 401 handler in `apps/web/app/lib/axios.ts` and
  the Google callback all land on `/` and drop path and hash): before the redirect to `/login`, a
  `#external=` payload is moved to `sessionStorage` (one key, same validation, cleared on read);
  after login, the authenticated root sees the key and navigates to `/job-queue` with the dialog
  open. Narrow, client-side only; no general "return-to" in the auth flow. Security review (auth
  zone).

### C. Bookmarklet "To CRM" (G3)

- Source: one TS module in `apps/web` compiled to a `javascript:` URL at build time with the CRM
  origin baked in.
- Install (owner, 2026-11-23: a button, no dragging): no browser lets a page create a bookmark
  (the last API, IE's `window.external.AddFavorite`, is gone), so a one-click install is impossible
  without an extension. A button "Add the script to bookmarks" on `/job-queue` opens a dialog:
  1. "Copy the script" → `navigator.clipboard.writeText(<javascript: URL>)` with a "copied" toast;
  2. short steps for the detected browser (Chrome/Edge: `Ctrl/Cmd+Shift+O` → "⋮" → "Add new
     bookmark", name "To CRM", paste into URL; Firefox and Safari: their own steps);
  3. the same script as a draggable "To CRM" link for those who prefer dragging (React refuses
     `javascript:` URLs in `href`, so the attribute is set through a ref, `setAttribute`);
  4. a "How it works" section for HR: open a vacancy on any site → on an unfamiliar site select the
     vacancy text → click "To CRM" → check fields marked "Not recognized" / "Check this value", pick
     senior and resume, Submit; what the "No vacancy was recognized" error means and what to do.
  - The dialog opens by itself on an HR's first visit until the bookmarklet has been used once
    (a `localStorage` flag set when the route first receives `#external=`), then stays behind a "?"
    button next to the install button.
- Extraction order, first hit wins per field:
  1. **The HR's text selection** (`getSelection().toString()`, if ≥ 200 chars) → description. This
     makes any site work: select the vacancy text, click.
  2. **JSON-LD `JobPosting`** (`title`, `hiringOrganization.name`, `description` → text).
  3. **Site profiles** (small selector sets): DOU (`h1.g-h2`, `.b-compinfo`,
     `.b-typo.vacancy-section`), LinkedIn job view, Greenhouse, Lever, Workable, Ashby, Djinni.
     PR 3 ships DOU, Greenhouse and the public LinkedIn job page (each from a saved real
     page); signed-in LinkedIn, Lever, Workable, Ashby and Djinni are backlog 491 and meanwhile
     go through JSON-LD, the generic path or the page text.
  4. **Generic:** `og:title` / `h1` / `document.title`; `og:site_name` or hostname as company;
     the largest `main` / `article` text block as description.
- Text only: every value goes through `innerText` / `textContent`, is trimmed and capped (description
  at `DESCRIPTION_MD_MAX`). Canonical URL: `link[rel=canonical]` else `location.href`, kept only if
  https.
- **No selection needed** (owner, 2026-11-23). Selection is an optional shortcut only. When the
  deterministic steps end in `partial` or `none`, the bookmarklet also sends the page text
  (`document.body` clone with `nav`, `header`, `footer`, `aside`, `script`, `style` removed,
  `innerText`, capped at the parse limit of D). The CRM dialog then calls the D parse route on it
  automatically, fills only still-empty fields and marks each AI-filled field "Check this value".
  The final state (`recognized` / `partial` / `none` below) is decided after that AI step; the
  "not recognized" error is shown only when the AI step also finds no vacancy (or fails — then the
  error names the outage and the fields stay editable).
- **Works on any page, always gives an answer** (owner, 2026-11-23). The script never fails
  silently: whatever site is open, a click ends in one of three visible outcomes.
  - **Recognized** — the page is a vacancy: a JSON-LD `JobPosting` was found, a site profile
    matched, the HR selected ≥ 200 chars, or the generic path found a title **and** a description
    that carries vacancy cues (e.g. requirements / responsibilities / qualifications / вимоги /
    обов'язки / досвід). The dialog opens pre-filled.
  - **Partly recognized** — recognized, but some fields are empty. The dialog opens with the found
    fields filled and every missing field marked "Not recognized — fill in manually"; Submit stays
    disabled until the required ones are filled. A field taken only from the generic path is marked
    "Check this value".
  - **Not recognized** — none of the above. The dialog opens with all fields empty and an error
    banner: "No vacancy was recognized on this page. Select the vacancy text and click again, paste
    it below, or fill in the fields manually." The page URL is still passed (it is useful as the
    application URL) but marked "check".
  - The payload carries a per-field status (`found` / `guessed` / `missing`) and an overall
    `recognized | partial | none`, so the dialog renders these states without re-guessing.
  - Script errors (an exception on an odd page) end in a browser `alert` naming the
    problem, never in nothing. One case no script can report: a browser that refuses to run
    bookmarklets on a page with a strict CSP runs nothing at all. Verify in Chrome on LinkedIn during
    manual QA; the paste fallback (D) covers such pages.
- Transfer: `window.open(<CRM>/job-queue#external=<base64url(JSON)>, '_blank', 'noopener,noreferrer')`
  (no `window.opener` for the source page). `noopener` makes the return value `null`, so a blocked
  pop-up cannot be detected; the how-it-works text tells HR to allow pop-ups for the CRM. The login
  flow drops the hash, so the app moves the payload to `sessionStorage` at boot, before any
  redirect, and the job-queue page reads it from there. The encoded hash is capped at 32 000 chars.
- Abuse note: any page could open that URL with a crafted hash. It only pre-fills a form the HR
  reviews and submits; the server validates as for manual entry. A crafted `pageText` can trigger
  one automatic parse per payload; the parse route's per-user throttle bounds the cost.

### D. Paste fallback (G4)

- In the dialog: "Paste the vacancy text" textarea + "Fill in" button.
- `POST /job-queue/manual/parse` (ADMIN, HR, throttled like other write routes): body `{ text }`
  (≤ 50 000 chars, the worker's `MAX_EXTRACTION_INPUT_CHARS`; the bookmarklet sends page text only when the description is missing, capped at 15 000 chars to fit the hash); answer `{ isVacancy: boolean, title?, companyName?, descriptionMd? }`. Nothing
  is stored. The same route serves the paste box and the bookmarklet's automatic fallback (C).
- `isVacancy` ("does this text describe one job vacancy?") is a yes/no question → Jev (`noul`), asked
  first; `false` → answer `{ isVacancy: false }` without the hosted call.
- Calls the extraction worker's hosted routes like vacancy structuring does
  (`apps/api/src/job-sourcing/structuring/model-structurer.ts` and `model-extraction-wiring.ts` are
  the analog), but on its **own budget** (my call): a per-user throttle and its own call budget,
  never the collector's per-cycle `HTML_MODEL_CALLS_PER_CYCLE`, and a short timeout (~30 s,
  synchronous) instead of the collector's up-to-120 s, so an HR paste can neither starve the
  collector nor hang the dialog. Reuse the worker's `/extract` if its contract fits; otherwise the
  builder adds an endpoint. Provider outage or timeout → a specific error, the form stays editable
  (owner rule: degrade, never break).
- Privacy: page text (a paste, or the bookmarklet's automatic fallback) can carry the HR's own name
  from a site's sidebar or header, even after `nav`/`header`/`aside` are stripped. It goes to a
  free hosted route that may log and train on it — the same class already used for vacancy text.
  Accepted by the owner 2026-11-23 ("yes, without extra cleaning"): strip `nav`/`header`/`footer`/
  `aside`/`script`/`style` only, nothing more.

## Delivery

Four PRs, each usable alone:

1. B — dialog + hash prefill + post-login restore + per-team duplicate key with card link
   (security review).
2. D — parse route (Jev `isVacancy` + hosted extraction) + paste box (depends on 1).
3. C — bookmarklet + install dialog + HR how-it-works (depends on 1 and 2 for the automatic
   fallback).
4. A — feed links + `technicalRoles` in `GET /job-queue/seniors` (security review).

## Left to the builder

- Exact role → DOU category map and which LinkedIn params to use, within "coarse is fine".
- Visual layout of the block and dialog (existing queue components and shadcn dialog patterns; no
  design-fidelity scoring before the redesign — owner rule).
- Which hosted route and prompt shape D uses, following the structuring analog.
