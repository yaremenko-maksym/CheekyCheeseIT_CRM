# Landing Refactor + Vacancies — Design Spec

**Date:** 2026-07-22
**Status:** APPROVED (owner, chat session 2026-07-22)
**Scope:** redesign of `apps/landing` to the level of top IT studios + a vacancies module in the CRM (ADMIN/HR) + public résumé intake.

---

## 1. Goal and context

The landing (`cheekycheese.tech`) is currently a raw single-pager. We need a professional
landing at the level of Linear/Vercel: "about us" and "our projects" blocks, vacancy pages,
a public application form with a CV. Vacancies are managed from the CRM by the **ADMIN and HR** roles.

**Key product fact:** vacancies are the hiring channel for **new SENIORs**. Applications
live inside the CRM vacancies section and are **NOT linked** to the interview kanban
(interviews) — that serves a different process.

**Owner decisions (fixed):**

| Question           | Decision                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Landing language   | English only                                                                             |
| Structure          | Single-pager `/` + `/careers` + `/careers/:slug`                                         |
| "Projects" block   | 3–4 anonymous cases (the assistant drafts, the owner edits the facts)                    |
| Applications → CRM | A section inside the vacancy; deletable; WITHOUT integration with the interviews kanban  |
| CV                 | PDF ≤ 5MB (file) + optional LinkedIn/GitHub links                                        |
| Spam protection    | Cloudflare Turnstile + rate-limit + honeypot                                             |
| Retention          | Manual deletion + auto-purge: REJECTED > 90d; applications of vacancies closed > 90d ago |
| Design process     | Claude Design Tier 1 with the owner's participation (all 4 device classes)               |
| Visual direction   | Brand evolution: dark + brand yellow + dev motifs (terminal), Linear/Vercel level        |
| Animations         | Premium-restrained (Framer Motion; no WebGL/3D)                                          |
| "About us"         | Without people (mission, approach, numbers, values)                                      |
| Salary range       | NOT shown and NOT stored (no fields — YAGNI)                                             |

**Rejected alternatives:** an external ATS/form (no CRM management, data at a third
party); static vacancies in the repo (no management from the CRM).

---

## 2. Landing (`apps/landing`)

### 2.1. Routes and sections

- **`/`** (redesign of the current page):
  1. **Hero** — evolution of the animated terminal (bigger, livelier), heading, CTA.
  2. **About us** — mission, approach, numbers (updated stats), values. No photos/names.
  3. **Case studies** — 3–4 anonymous cases by domain (AI / EdTech / E-Commerce):
     format challenge → solution → metrics. Content — an assistant draft, edited by the owner.
  4. **Services** — the existing 3 domains, deepened.
  5. **How we work** — a process timeline (discovery → build → ship → support). A new section.
  6. **Tech stack** — existing chips, polished.
  7. **Careers teaser** — up to 3 live PUBLISHED vacancies from the API + a link to `/careers`.
     With 0 vacancies the section shows a CTA "write to hr@cheekycheese.tech" (mailto), it is not hidden.
  8. **Contact / Footer**.
- **`/careers`** — a list of PUBLISHED vacancies (title, domain, seniority, location),
  **without filters/tabs** (owner decision 2026-07-23: we show the whole list as is).
  Empty state: "no open roles" + mailto.
- **The contact email everywhere** (nav CTA, contact, footer, careers empty state):
  `hr@cheekycheese.tech` — no other emails remain on the landing.
- **`/careers/:slug`** — a vacancy detail (markdown description, rendered HTML) +
  an application form + a success state after submission.

### 2.2. Application form (fields)

| Field           | Required                    | Validation                   |
| --------------- | --------------------------- | ---------------------------- |
| Full name       | required                    | 2–120 chars                  |
| Email           | required                    | email                        |
| Telegram        | optional                    | @handle / t.me link          |
| LinkedIn URL    | optional                    | https URL                    |
| GitHub URL      | optional                    | https URL                    |
| Cover letter    | optional                    | ≤ 2000 chars                 |
| CV (PDF)        | required                    | PDF, ≤ 5MB (client + server) |
| Turnstile token | required (invisible widget) | server-side siteverify       |
| Honeypot        | hidden field, must be empty | filled → silent reject       |

A confirmation email to the candidate — **out of scope v1** (there is no email infra in the project).
The candidate sees a success screen. Duplicate protection: the same email + the same vacancy within
24h → 429 with a clear message.

### 2.3. Landing technical decisions

- Data — **TanStack Router loaders + `fetch`** to same-origin `/api`
  (nginx already proxies `cheekycheese.tech/api → api:3001`; no config change needed).
  We do NOT add react-query to the landing.
- Dev: in `apps/landing/vite.config.ts` add `server.proxy` `/api → localhost:3001`.
- The form — controlled + a Zod schema from `@crm/shared` (the landing already builds shared
  in the Dockerfile). We do not add TanStack Form.
- Animations: Framer Motion (already in deps) — scroll-reveal, gradient glow,
  micro-interactions, magnetic buttons, a live terminal. `prefers-reduced-motion`
  is respected (Framer Motion's built-in mechanisms + disabling decorative loops).
- SEO: per-route `<title>` + meta/OG tags (the document head is updated in the route; no SSR,
  none planned).
- The Turnstile site key reaches the build via `VITE_TURNSTILE_SITE_KEY`
  (build ARG in `apps/landing/Dockerfile` + GHA secret; dev — `.env`).
- Responsive — a hard gate: 320/375/768/1024/1280/1440/1920, mobile-first,
  no horizontal overflow, touch targets ≥ 44px (`rules/common/responsive-design.md`).

---

## 3. DB and API (`apps/api`, new `vacancies` module)

### 3.1. Tables (Drizzle migration; prod DDL — only via deploy.yml)

**`vacancies`**

| Column                   | Type                                      | Note                                                   |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------ |
| id                       | uuid PK                                   |                                                        |
| slug                     | text UNIQUE                               | generated from the title, editable until publish       |
| title                    | text                                      |                                                        |
| description_md           | text                                      | markdown                                               |
| domain                   | enum `AI \| EDTECH \| ECOMMERCE \| OTHER` |                                                        |
| seniority                | enum `SENIOR \| LEAD`                     | the senior hiring channel; extensible                  |
| employment_type          | enum `FULL_TIME \| PART_TIME \| CONTRACT` |                                                        |
| location                 | text                                      | e.g. "Remote (Europe)"                                 |
| status                   | enum `DRAFT \| PUBLISHED \| CLOSED`       | DRAFT → PUBLISHED → CLOSED; from CLOSED can re-publish |
| published_at / closed_at | timestamp nullable                        |                                                        |
| created_by               | uuid FK users                             |                                                        |
| created_at / updated_at  | timestamp                                 |                                                        |

**`vacancy_applications`**

| Column                               | Type                                | Note                                                  |
| ------------------------------------ | ----------------------------------- | ----------------------------------------------------- |
| id                                   | uuid PK                             |                                                       |
| vacancy_id                           | uuid FK vacancies ON DELETE CASCADE |                                                       |
| full_name                            | text                                |                                                       |
| email                                | text                                |                                                       |
| telegram / linkedin_url / github_url | text nullable                       |                                                       |
| cover_letter                         | text nullable                       | ≤ 2000                                                |
| resume_s3_key                        | text                                | prefix `vacancy-applications/<vacancyId>/<appId>.pdf` |
| resume_size_bytes                    | integer                             | after compression                                     |
| status                               | enum `NEW \| VIEWED \| REJECTED`    |                                                       |
| created_at                           | timestamp                           |                                                       |

**Why NOT the `documents` table:** it is tied to `users` (ownerId/uploadedBy),
and candidates are not users. A direct R2 key on the application row is simpler, cheaper and
isolated from user documents. We reuse `S3Service` + `CompressionService`
as services, not the table.

### 3.2. Endpoints

**Public (no auth, a separate controller `public-vacancies.controller.ts`):**

- `GET /api/public/vacancies` — PUBLISHED only; fields: slug, title, domain,
  seniority, employmentType, location, publishedAt. No application counters.
- `GET /api/public/vacancies/:slug` — the same + descriptionMd. 404 for
  DRAFT/CLOSED/nonexistent (we do not reveal existence).
- `POST /api/public/vacancies/:slug/apply` — multipart (fields + PDF).
  The protection pipeline — §4. Response 201 `{ ok: true }` without an id (we do not reveal internal ids).

**Private (JwtGuard + RolesGuard `@Roles(ADMIN, HR)`):**

- `GET /api/vacancies` (all statuses, + an application counter) · `POST /api/vacancies` ·
  `PATCH /api/vacancies/:id` (edits + status change) · `DELETE /api/vacancies/:id`
  (only DRAFT without applications; otherwise — close).
- `GET /api/vacancies/:id/applications` · `PATCH …/applications/:appId`
  (status NEW→VIEWED→REJECTED) · `DELETE …/applications/:appId` (row + R2 object) ·
  `GET …/applications/:appId/resume-url` (presigned GET, TTL 10 min,
  `S3Service.getPresignedDownloadUrl`).

Zod schemas of all DTOs — `packages/shared/src/schemas/vacancies.ts`, exported from the index.

### 3.3. RBAC: who views → what they see

| Role                                | Vacancies                   | Applications / CV                  |
| ----------------------------------- | --------------------------- | ---------------------------------- |
| Anonymous (landing)                 | PUBLISHED only (public DTO) | nothing (403/404)                  |
| ADMIN, HR                           | all statuses, CRUD          | full access, CV download, deletion |
| SENIOR / JUNIOR / ACCOUNTANT / DROP | 403 on private endpoints    | 403                                |

CRM sidebar: the "Vacancies" item is visible only to ADMIN/HR (the wording — consistent
with the current sidebar language).

---

## 4. Protection of the public `apply` (security-critical)

Check order (fail-fast, cheap before expensive):

1. **Rate-limit** by IP — a separate hard bucket of the existing throttler
   (order: ~5 attempts/hour per IP on apply; vacancy lists — softer).
2. **Honeypot** — filled → 201 mimicry (silent drop, log).
3. **Turnstile** — a server-side POST to CF siteverify with `TURNSTILE_SECRET_KEY`;
   an invalid token → 400.
4. **Duplicate** — email+vacancy within 24h → 429.
5. **Size** ≤ 5MB (multipart limit at the Fastify level + a buffer check).
6. **MIME + magic-bytes** — only `application/pdf`, the pattern
   `detectMimeFromBuffer` from the documents module; a mismatch → 415.
7. **Compression + metadata strip** — `CompressionService.compressPdf`.
8. **Persist** — DB-row-first, then R2 upload, compensation (delete row) on an
   R2 failure — the `DocumentsService.upload` pattern.
9. **Notification** — `NotificationsService.create` to every ADMIN/HR:
   a new `NotificationType` `VACANCY_APPLICATION`, a link to the CRM vacancy page.

Inputs are sanitized by the Zod schema; vacancy markdown is rendered on the landing with a
safe renderer (HTML sanitization). Candidate PII (email/telegram) does not
get into logs. **security-reviewer is mandatory on the PR** (public endpoint +
file upload + RBAC + PII).

---

## 5. Retention (storage optimization)

- **Manual**: DELETE of an application in the CRM removes the row + the R2 object
  (`S3Service.delete` is idempotent).
- **Cron** (the salary-cron pattern, daily):
  - applications with `status=REJECTED` and `created_at` older than 90 days → delete (row + R2);
  - applications of vacancies with `closed_at` older than 90 days → delete (row + R2).
    Fail-loud logging of the deleted count; R2 errors do not interrupt the batch
    (the object is caught up on the next run).

---

## 6. CRM screens (`apps/web`)

- **`/vacancies`** — a table/cards of vacancies: status badges, an application counter,
  creation (dialog/form), publish/close actions.
- **`/vacancies/:id`** — editing the fields + a markdown editor for the description
  (reuse the existing lazy CodeMirror) + an **"Applications" tab**: candidate cards
  (name, contacts, cover letter, date), CV download (presigned),
  status change, deletion with a confirm dialog. A NEW indicator.
- Design — the synced `CheekyCheeseIT CRM` system (Claude Design), responsive
  per the common rules.

---

## 7. Tests (AC skeleton; detailed AC — in the plan's task files)

- **Unit (Vitest, api):** vacancies.service (CRUD, status transitions, slug),
  the apply pipeline (all rejection branches §4), the retention cron (boundary dates).
- **Integration (real DB):** RBAC guards — 403 for SENIOR/JUNIOR/ACCOUNTANT/DROP
  on private endpoints; the public flow end-to-end; 404 on a DRAFT slug; rate-limit.
- **E2E (Playwright, apps/e2e):** CRM — create a vacancy → publish → apply via
  the public API → see it in the CRM → change status → delete. Turnstile in tests —
  the official CF test keys (always-pass).
- **Landing:** vitest component tests (form, validation, states) + a Playwright run
  across test widths 320–1920 (no horizontal overflow, touch targets ≥ 44px).
- **Fidelity gate:** ui-ux-designer Mode B — diff mockup ↔ localhost on all device
  classes for the landing AND the CRM screens (`design-fidelity-review.md`).

---

## 8. Deploy and configuration

- nginx: no changes (the `/api` proxy already exists on both domains).
- New env: `TURNSTILE_SECRET_KEY` (api, prod env + `.env.example`);
  `VITE_TURNSTILE_SITE_KEY` (landing build ARG in the Dockerfile + GHA secret + dev `.env`).
- Prod DDL (2 tables + enums) — via the migration step of deploy.yml (no SSH).
- R2: the same bucket, prefix `vacancy-applications/`.

**Owner-TODO (blockers at their stages):**

1. Create a Cloudflare Turnstile site (domains `cheekycheese.tech`, localhost for dev) →
   site key + secret → GH secrets + prod env (needed by the apply implementation stage).
2. Claude Design sessions — mockup generation (needed before markup).
3. Final edit of the case facts and vacancy texts (can be after the draft markup).

---

## 9. Implementation process (after the spec is approved)

1. `superpowers:writing-plans` → an implementation plan with phases and task files.
2. Claude Design (Tier 1, with the owner): landing mockups (all sections, 4 device
   classes, states) + CRM vacancy screens → artifacts `docs/design/<slug>.md` +
   `docs/design/assets/<slug>/`.
3. PM decomposition → agent waves ≤ 3–4 (`orchestration-routing.md` Decision 1:
   API module / landing / CRM screens — almost disjoint by files; E2E — after).
4. Full review pipeline: code-reviewer + **security-reviewer** (mandatory) +
   manual-qa (live stack) + Mode B fidelity audit → User Testing → the owner's merge
   signal → deploy → prod smoke.

## 10. Out of scope v1

- Email notifications to the candidate (no email infra).
- Linking applications to the interviews kanban (owner decision).
- Landing multilingualism (EN only).
- Salary fields/ranges.
- Vacancy subscriptions, RSS, job aggregators.
