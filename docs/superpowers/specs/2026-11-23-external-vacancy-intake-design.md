# External vacancy intake — design

Date: 2026-11-23. Status: approved by the owner in chat (approach and scope); this document is the
written form.

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
  and sort are preset. With a senior selected, the filters come from that senior's `techStack`;
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
- No change to how submissions, cancellations or duplicates work server-side.

## Anti-goals

- Anything that makes CRM act on an external site on its own (requests, applying, scraping). HR
  decides and applies by hand; this stays true for what was told to DOU.
- A pre-filled form that saves without an explicit HR click.
- Rendering pasted / bookmarklet text as HTML.

## Constraints

- RBAC: everything here is ADMIN + HR, the same as `POST /job-queue/manual`. Adding `techStack` to
  `GET /job-queue/seniors` widens what HR reads → security review is mandatory for that PR.
- `jobQueueSeniorOptionsResponseSchema` is `.strict()`; the new field changes schema, API and its
  spec together.
- `descriptionMd` max is `DESCRIPTION_MD_MAX` (50 000); `applicationUrl` is
  `externalHttpsUrlSchema` (https only).
- Product UI text in `uk` + `en` through Lingui.
- Jev-first: `Jev-first: paste extraction -> hosted (free-form fields: title, company, description;
no closed-list field is needed)`.
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
- `techStack → filters`: a small static map from stack values to each site's own taxonomy where the
  site has one (DOU `category`), otherwise `keywords` (first 1–2 stack items).
- Verified 2026-11-23 (one GET each, from the developer machine):
  - DOU: `https://jobs.dou.ua/vacancies/?category=<C>&exp=5plus&remote` — works
    ("39 вакансій в категорії Python віддалено, досвід 5+ років"). `category` is a closed list of 59
    values (`Python`, `Java`, `Front End`, `Node.js`, `.NET`, `Golang`, `DevOps`, `QA`, `AI/ML`,
    `Data Engineer`, …); `exp` ∈ `0-1|1-3|3-5|5plus`; flags `remote`, `relocation`; free text
    `search=`. Stack without a category → `search=<stack>`.
  - LinkedIn: `https://www.linkedin.com/jobs/search/?keywords=<K>&f_E=4&f_WT=2&sortBy=DD` answers 200;
    the guest page does not show whether `f_E` (experience 4 = mid-senior) and `f_WT` (2 = remote)
    applied — **verify logged in** during manual QA.
  - WTTJ, The Muse site, EU Remote Jobs: templates verified during the build (owner go-ahead for
    single GETs).
- UI: a collapsible "External sources" block on `/job-queue`, links `target="_blank"
rel="noopener noreferrer"`, current senior selection from the existing `seniorIds` search param
  (first selected senior; none → general filters).
- API: `techStack` (string array) added to `GET /job-queue/seniors` items.

### B. Register external submission dialog (G2)

- Entry points: a button in the queue header and in the "External sources" block.
- Fields: application URL (optional, https), title, company, description (required, plain text,
  stored as `descriptionMd`), team + senior (preselected from the current selection), resume (that
  senior's existing CRM resumes).
- Submit → `useCreateManualJobQueueCard`. `JOB_QUEUE_MANUAL_DUPLICATE` (409) → inline error with a
  link to the existing card. `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` (409) → show the duplicates and
  a "Submit anyway" button that resends with `confirmPossibleDuplicate: true`.
- On success the dialog closes and the new card shows in the queue as submitted.
- Prefill entry: the route reads `location.hash` of the form `#external=<base64url(JSON)>`, parses it
  with a Zod schema `externalVacancyPrefillSchema` (`url?`, `title?`, `company?`, `description?`,
  all trimmed and length-capped), opens the dialog pre-filled, then clears the hash with
  `history.replaceState`. Invalid payload → open the empty dialog, no error page. The hash never
  reaches the server or its logs.

### C. Bookmarklet "To CRM" (G3)

- Source: one TS module in `apps/web` compiled to a `javascript:` URL at build time with the CRM
  origin baked in. Shown on `/job-queue` as a draggable link with a one-line "drag me to your
  bookmarks bar" hint. React refuses `javascript:` URLs in `href`, so the attribute is set through a
  ref (`setAttribute`).
- Extraction order, first hit wins per field:
  1. **The HR's text selection** (`getSelection().toString()`, if ≥ 200 chars) → description. This
     makes any site work: select the vacancy text, click.
  2. **JSON-LD `JobPosting`** (`title`, `hiringOrganization.name`, `description` → text).
  3. **Site profiles** (small selector sets): DOU (`h1.g-h2`, `.b-compinfo`,
     `.b-typo.vacancy-section`), LinkedIn job view, Greenhouse, Lever, Workable, Ashby, Djinni.
  4. **Generic:** `og:title` / `h1` / `document.title`; `og:site_name` or hostname as company;
     the largest `main` / `article` text block as description.
- Text only: every value goes through `innerText` / `textContent`, is trimmed and capped (description
  at `DESCRIPTION_MD_MAX`). Canonical URL: `link[rel=canonical]` else `location.href`, kept only if
  https.
- Transfer: `window.open(<CRM>/job-queue#external=<base64url(JSON)>)`. HR must already be logged in;
  otherwise the login flow must keep the hash (verify; if it drops it, stash the payload in
  `sessionStorage` before redirecting).
- Abuse note: any page could open that URL with a crafted hash. It only pre-fills a form the HR
  reviews and submits; the server validates as for manual entry.

### D. Paste fallback (G4)

- In the dialog: "Paste the vacancy text" textarea + "Fill in" button.
- `POST /job-queue/manual/parse` (ADMIN, HR, throttled like other write routes): body `{ text }`
  (≤ 60 000 chars); answer `{ title?, companyName?, descriptionMd? }`. Nothing is stored.
- Calls the hosted extraction route the project already uses for vacancy structuring
  (`apps/api/src/job-sourcing/structuring/model-structurer.ts` is the analog). Provider outage →
  a specific error, the form stays editable (owner rule: degrade, never break).
- Privacy: a whole-page copy (Ctrl+A) of LinkedIn can carry the HR's own name and sidebar. The UI hint
  asks to copy the vacancy text, and the hosted route is the same class already used for vacancy
  text.

## Delivery

Four PRs, each usable alone:

1. B — dialog + hash prefill (no backend change).
2. C — bookmarklet (depends on 1).
3. A — feed links + `techStack` in `GET /job-queue/seniors` (security review).
4. D — paste parse route + UI (depends on 1).

## Left to the builder

- Exact stack → DOU category map and which LinkedIn/WTTJ params to use, within "coarse is fine".
- Visual layout of the block and dialog (existing queue components and shadcn dialog patterns; no
  design-fidelity scoring before the redesign — owner rule).
- Which hosted route and prompt shape D uses, following the structuring analog.
