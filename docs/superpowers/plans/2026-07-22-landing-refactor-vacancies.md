# Landing Refactor + Vacancies — Implementation Plan

> **For agentic workers:** this plan is executed through the project agent factory
> (Master dispatches Coder/AutoTest/DevOps per task, `Agent(isolation=worktree)`,
> waves ≤ 3–4). Each task below becomes a task file `.claude/tasks/<slug>.md`
> at dispatch. Checkboxes — for tracking.

**Goal:** redesign `apps/landing` to the level of top IT studios + a vacancies module
in the CRM (ADMIN/HR) + public résumé intake (PDF → R2) with retention.

**Spec:** `docs/superpowers/specs/2026-07-22-landing-refactor-design.md` (APPROVED).

**Architecture:** a new NestJS module `vacancies` (2 tables, admin CRUD +
public read/apply), Zod contracts in `@crm/shared`, the landing reads same-origin
`/api` via Router loaders, CRM screens for ADMIN/HR, a retention cron, Turnstile
on the public form.

**Tech Stack:** NestJS 11 + Fastify + Drizzle · Zod v4 · React + Vite SPA +
TanStack Router · Tailwind v4 + shadcn/ui + Framer Motion · Playwright/Vitest.

## Global Constraints (from the spec and rules — apply to EVERY task)

- Version pins: `rules/common/version-pins.md` (Vite ^6.4, TanStack pair EXACT, Zod v4, Node 20).
- The landing — English only; CRM UI — consistent with the current sidebar language.
- There are NO salary fields anywhere (schema/DTO/UI).
- Applications are NOT linked to the interviews kanban.
- All API DTOs via Zod `.parse()`, types from `@crm/shared`.
- git-policy: explicit `git add`, `ac_verified:` in the final commit, `DATABASE_URL= git push`, no `--no-verify`.
- E2E locally before pushing code; eslint MCP + typecheck before commit.
- Design-gate Tier 1: UI tasks (C, D) do NOT start without `docs/design/<slug>.md` + assets.
- Responsive hard gate: 320/375/768/1024/1280/1440/1920; touch targets ≥ 44px.
- security-reviewer is MANDATORY on the PRs of tasks A, B, C (public surface / RBAC / file upload).
- Prod DDL — only via the migration step of deploy.yml (no SSH).

---

## File map (who creates what — zone-of-write, tasks do not overlap by files)

| Task           | Creates / edits                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A (api-core)   | `packages/shared/src/schemas/vacancies.ts` (+`index.ts` export), `apps/api/src/database/schema.ts` (+2 tables, 5 enums), `apps/api/drizzle/migrations/00XX_vacancies.sql` (db:generate), `apps/api/src/vacancies/vacancies.module.ts` / `vacancies.service.ts` / `vacancies.controller.ts`, module spec files                        |
| B (api-public) | `apps/api/src/vacancies/public-vacancies.controller.ts`, `apps/api/src/vacancies/turnstile.service.ts`, `apps/api/src/vacancies/applications.service.ts`, `apps/api/src/vacancies/vacancies-retention.cron.ts`, `packages/shared/src/schemas/notifications.ts` (+1 enum value), api env schema (+`TURNSTILE_SECRET_KEY`), spec files |
| C (landing)    | `apps/landing/app/routes/index.tsx` (redesign), `apps/landing/app/routes/careers/index.tsx`, `apps/landing/app/routes/careers/$slug.tsx`, `apps/landing/app/components/**` (sections, form), `apps/landing/app/lib/api.ts`, `apps/landing/vite.config.ts` (dev-proxy), `apps/landing/app/__tests__/**`                               |
| D (crm-ui)     | `apps/web/app/routes/vacancies/index.tsx`, `apps/web/app/routes/vacancies/$vacancyId.tsx`, `apps/web/app/components/vacancies/**`, sidebar config (+ADMIN/HR item)                                                                                                                                                                   |
| E (e2e)        | `apps/e2e/tests/vacancies.spec.ts`, fixtures                                                                                                                                                                                                                                                                                         |
| F (devops)     | `.github/workflows/deploy.yml` (migration-step), `apps/landing/Dockerfile` (+ARG `VITE_TURNSTILE_SITE_KEY`), `.env.example`, `docs/runbooks/deployment.md` (secrets)                                                                                                                                                                 |

The only overlap is B→A (the same module) — therefore A and B are sequential in one
Coder pipeline (one branch, stacked commits, one PR).

---

## Contracts (single source — copied into task files verbatim)

### Zod (`packages/shared/src/schemas/vacancies.ts`) — key schemas

```ts
export const vacancyDomainSchema = z.enum(['AI', 'EDTECH', 'ECOMMERCE', 'OTHER'])
export const vacancySenioritySchema = z.enum(['SENIOR', 'LEAD'])
export const vacancyEmploymentTypeSchema = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT'])
export const vacancyStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'CLOSED'])
export const vacancyApplicationStatusSchema = z.enum(['NEW', 'VIEWED', 'REJECTED'])

export const publicVacancySchema = z.object({
  slug: z.string(),
  title: z.string(),
  domain: vacancyDomainSchema,
  seniority: vacancySenioritySchema,
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string(),
  publishedAt: z.string(), // ISO
})
export const publicVacancyDetailSchema = publicVacancySchema.extend({
  descriptionMd: z.string(),
})

export const vacancySchema = publicVacancyDetailSchema.extend({
  id: z.uuid(),
  status: vacancyStatusSchema,
  publishedAt: z.string().nullable(), // override: admin sees DRAFT too
  closedAt: z.string().nullable(),
  applicationsCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const createVacancySchema = z.object({
  title: z.string().min(3).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(3)
    .max(80),
  descriptionMd: z.string().min(10).max(20_000),
  domain: vacancyDomainSchema,
  seniority: vacancySenioritySchema,
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string().min(2).max(120),
})
export const updateVacancySchema = createVacancySchema
  .partial()
  .extend({ status: vacancyStatusSchema.optional() })

export const applyVacancyFieldsSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.email().max(254),
  telegram: z.string().max(120).optional(),
  linkedinUrl: z.url().startsWith('https://').max(300).optional(),
  githubUrl: z.url().startsWith('https://').max(300).optional(),
  coverLetter: z.string().max(2000).optional(),
  turnstileToken: z.string().min(1),
  website: z.string().max(0).optional(), // honeypot: non-empty → silent drop
})

export const vacancyApplicationSchema = z.object({
  id: z.uuid(),
  vacancyId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  telegram: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  coverLetter: z.string().nullable(),
  resumeSizeBytes: z.number().int(),
  status: vacancyApplicationStatusSchema,
  createdAt: z.string(),
})
```

### Endpoints (method → guard → input → output)

| Endpoint                                                | Guard               | Input                                                 | Output                                             |
| ------------------------------------------------------- | ------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `GET /api/public/vacancies`                             | none                | —                                                     | `publicVacancySchema[]`                            |
| `GET /api/public/vacancies/:slug`                       | none                | slug                                                  | `publicVacancyDetailSchema`; 404 for non-PUBLISHED |
| `POST /api/public/vacancies/:slug/apply`                | none (Turnstile+RL) | multipart: `applyVacancyFieldsSchema` + file `resume` | 201 `{ ok: true }`                                 |
| `GET /api/vacancies`                                    | ADMIN,HR            | —                                                     | `vacancySchema[]`                                  |
| `POST /api/vacancies`                                   | ADMIN,HR            | `createVacancySchema`                                 | `vacancySchema`                                    |
| `PATCH /api/vacancies/:id`                              | ADMIN,HR            | `updateVacancySchema`                                 | `vacancySchema`                                    |
| `DELETE /api/vacancies/:id`                             | ADMIN,HR            | —                                                     | 204; 409 if non-DRAFT or there are applications    |
| `GET /api/vacancies/:id/applications`                   | ADMIN,HR            | —                                                     | `vacancyApplicationSchema[]`                       |
| `PATCH /api/vacancies/:id/applications/:appId`          | ADMIN,HR            | `{ status }`                                          | `vacancyApplicationSchema`                         |
| `DELETE /api/vacancies/:id/applications/:appId`         | ADMIN,HR            | —                                                     | 204 (row + R2)                                     |
| `GET /api/vacancies/:id/applications/:appId/resume-url` | ADMIN,HR            | —                                                     | `{ url, expiresAt }` (TTL 600s)                    |

### Vacancy status transitions (the service enforces)

`DRAFT → PUBLISHED` (sets publishedAt) · `PUBLISHED → CLOSED` (sets closedAt) ·
`CLOSED → PUBLISHED` (re-open: resets closedAt) · everything else → 409.

### R2 résumé key

`vacancy-applications/<vacancyId>/<applicationId>.pdf` (ASCII only — uuids).

---

## Execution order (waves)

```
Phase 0 (owner + orchestrator, BLOCKS C and D):
  0.1 Claude Design session: landing (all sections, 320/768/1024/1440, states)
  0.2 Claude Design: CRM vacancy screens (list + detail with applications)
  0.3 Owner: Turnstile site key + secret → GH secrets (blocks only F/prod)
  → artifacts docs/design/landing-redesign.md + docs/design/crm-vacancies.md + assets

Phase 1 (in parallel with Phase 0): Task A+B — one Coder, one branch feat/vacancies-api
  → PR#1: code-review + security-review + integration tests

Phase 2 (after Phase 0 and merge of PR#1; a wave of 2):
  Task C — Coder: landing (feat/landing-redesign)
  Task D — Coder: CRM screens (feat/crm-vacancies-ui)
  → PR#2, PR#3: code-review + security-review(C) + manual-qa + fidelity Mode B

Phase 3 (after merge of PR#2/PR#3; a wave of 2):
  Task E — AutoTest: E2E vacancies (test/vacancies-e2e)
  Task F — DevOps: deploy-wiring (infra/vacancies-deploy)
  → PR#4, PR#5 → final User Testing → merge signals → deploy → prod smoke
```

Agent model: A+B — sonnet (the Drizzle migration is simple, but we do not touch finance;
escalation to opus by model-routing triggers) · C, D — sonnet · E — sonnet ·
F — sonnet. Reviewers — by their frontmatter tiers.

---

### Task A: Vacancies core (schemas + DB + admin CRUD)

**Files:** see the file map. **Model:** sonnet. **Design tier:** — (no UI).

**Produces (for B/C/D):** tables `vacancies`/`vacancy_applications`, all the Zod schemas
above, `VacanciesService` with methods `list/create/update/delete/transition`,
an admin controller per the endpoints table.

- [ ] Zod schemas (code above) + export from `packages/shared/src/schemas/index.ts`; unit specs of the schemas (valid/invalid cases: slug-regex, honeypot max(0), length limits).
- [ ] Drizzle schema: 2 tables + 5 pgEnum (`vacancy_domain`, `vacancy_seniority`, `vacancy_employment_type`, `vacancy_status`, `vacancy_application_status`) exactly per spec §3.1; `pnpm --filter @crm/api db:generate` → migration.
- [ ] `VacanciesService`: CRUD + slug uniqueness (409 on duplicate) + status transitions (table above) + `applicationsCount` via a subquery + a delete guard (only DRAFT without applications, otherwise 409).
- [ ] `VacanciesController` (`@UseGuards(JwtGuard, RolesGuard)` + `@Roles('ADMIN','HR')` on the class) — all private endpoints.
- [ ] Unit specs of the service: transitions (3 valid + invalid → 409), delete guard, slug duplicate.
- [ ] Integration spec (real DB, the pattern of the existing `*.integration.spec.ts`): RBAC matrix — ADMIN 200, HR 200, SENIOR/JUNIOR/ACCOUNTANT/DROP 403 on each private endpoint.
- [ ] `mcp eslint` + `pnpm typecheck` + a full Vitest run; commit `feat(api): vacancies core module` with `ac_verified:`.

### Task B: Public surface + apply pipeline + retention (the same Coder, the same branch)

**Consumes:** everything from A. **Produces (for C):** the public endpoints per the table.

- [ ] `TurnstileService.verify(token, ip): Promise<boolean>` — POST `https://challenges.cloudflare.com/turnstile/v0/siteverify`, secret from env `TURNSTILE_SECRET_KEY` (add to the env schema; in dev/test the CF dummy secret `1x0000000000000000000000000000000AA` is allowed).
- [ ] `PublicVacanciesController`: list/detail (404 for non-PUBLISHED — without revealing existence) + `apply`.
- [ ] `ApplicationsService.apply` — a pipeline strictly per spec §4 (order: RL → honeypot(201 mimicry+log) → Turnstile(400) → duplicate email+vacancy 24h(429) → size ≤5MB(413) → magic-bytes PDF (`detectMimeFromBuffer`, 415) → `CompressionService.compressPdf` → DB-row-first + compensation → R2 `vacancy-applications/<vacancyId>/<appId>.pdf` → notification to all ADMIN/HR).
- [ ] Rate-limit: a hard bucket on apply (~5/hour/IP; the specific mechanism — the existing API throttler, the RelaxableThrottle pattern for E2E relax), soft on public GETs.
- [ ] `NotificationType` + `'VACANCY_APPLICATION'` in shared; an emitter after a successful persist (a link to the CRM vacancy page).
- [ ] `VacanciesRetentionCron` (daily, the salary-cron pattern): REJECTED > 90d and applications of vacancies with closedAt > 90d → delete row + `S3Service.delete`; log the count; R2 errors do not interrupt the batch.
- [ ] `applications` service methods: list by vacancy, status transition, delete (row+R2), resume-url (`S3Service.getPresignedDownloadUrl`, TTL 600s, `attachment`).
- [ ] Unit specs: each apply rejection branch (7 of them) + cron idempotency + boundary dates (89/90/91 days).
- [ ] Integration specs: the public happy-path (real DB, a PDF file fixture), 404 DRAFT-slug, RBAC 403 on applications endpoints, throttle-429.
- [ ] eslint + typecheck + Vitest + a local E2E run; the final commit with `ac_verified:`; `DATABASE_URL= git push`; PR#1 "feat(api): vacancies module + public apply".

### Task C: Landing redesign (after Phase 0 + PR#1)

**Consumes:** the public endpoints of B; the artifact `docs/design/landing-redesign.md` + `design.png` (320+1440 minimum). **Design tier:** 1.

- [ ] `apps/landing/app/lib/api.ts`: `fetchVacancies()`, `fetchVacancy(slug)`, `submitApplication(slug, FormData)` — typed with the shared schemas, `.parse()` of responses.
- [ ] `vite.config.ts`: `server.proxy = { '/api': 'http://localhost:3001' }`.
- [ ] The `/` sections per the design artifact (Hero/About/Cases/Services/HowWeWork/Stack/CareersTeaser/Footer) — a component per section in `app/components/sections/`; careers teaser: loader → up to 3 PUBLISHED, at 0 — a mailto CTA.
- [ ] Cases: content drafts (3–4, challenge→solution→metrics, EN) — in a separate `app/content/case-studies.ts` for easy editing by the owner.
- [ ] `/careers` + `/careers/:slug` (loaders, markdown render with sanitization, a 404 state).
- [ ] Application form: Zod validation on the client, the Turnstile widget (site key from `import.meta.env.VITE_TURNSTILE_SITE_KEY`), the honeypot field `website` (visually-hidden), success/error states, a disabled submit during sending.
- [ ] Animations per the design artifact; `prefers-reduced-motion` disables the decorative loops.
- [ ] SEO: per-route title/OG.
- [ ] Vitest component tests: form (valid/invalid/success/network error), careers list (data/empty), teaser.
- [ ] Playwright screenshot run across test widths 320–1920: no horizontal overflow, touch targets ≥ 44px (screenshots in the PR).
- [ ] eslint + typecheck + tests; PR#2 "feat(landing): redesign + careers + application form".

### Task D: CRM vacancies UI (after Phase 0 + PR#1; in parallel with C)

**Consumes:** the admin endpoints of A/B; the artifact `docs/design/crm-vacancies.md`. **Design tier:** 1.

- [ ] Sidebar: a "Vacancies" item (language — consistent with the current items), visibility ADMIN|HR (the existing RBAC navigation mechanism).
- [ ] `/vacancies`: a list (status badges, an application counter, a NEW indicator), creation (a form per `createVacancySchema`), publish/close/re-open actions with a confirm.
- [ ] `/vacancies/:id`: editing + a markdown editor (the existing lazy CodeMirror) + an "Applications" tab: cards (contacts, cover letter, date), CV download (presigned, `window.open`), status change, deletion with a confirm dialog.
- [ ] Route guard: non-ADMIN/HR → redirect to the dashboard (the pattern of the existing pages).
- [ ] Vitest component tests: forms, status actions, the guard.
- [ ] Playwright run across test widths; eslint + typecheck + local E2E; PR#3 "feat(web): vacancies management screens".

### Task E: E2E (after merge of PR#2/PR#3)

- [ ] `apps/e2e/tests/vacancies.spec.ts`: ADMIN creates → publish → public apply via an API request (CF test keys always-pass) → HR sees the application → VIEWED → REJECTED → delete; RBAC smoke (SENIOR/DROP 403 on /api/vacancies); landing flow `/careers` (list → detail → form validation).
- [ ] Sharding: add the spec to a suitable E2E CI shard (allow-list guard #274 — update).
- [ ] 3× stable local run (zero-flaky policy); PR#4.

### Task F: Deploy wiring (in parallel with E)

- [ ] `deploy.yml`: a step to apply the new migration (the Step 2b pattern from #350 — idempotent DDL via `docker exec psql`; after applying — de-wire per our pattern OR a permanent `drizzle-kit migrate` step, decide by the current state of deploy.yml).
- [ ] `apps/landing/Dockerfile`: `ARG VITE_TURNSTILE_SITE_KEY` + passing it into the build; deploy.yml passes it from a GH secret.
- [ ] api prod env: `TURNSTILE_SECRET_KEY`; `.env.example` — both keys + a comment about the CF dummy keys for dev.
- [ ] `docs/runbooks/deployment.md`: a "Turnstile secrets" section.
- [ ] PR#5; after all are merged — prod smoke: the landing opens, vacancies are visible, a test application goes through and is visible in the CRM, the file downloads.

---

## Quality gates (per PR)

code-reviewer (all) · security-reviewer (PR#1, PR#2, PR#3) · manual-qa on the live
stack (PR#2, PR#3) · ui-ux-designer Mode B fidelity-diff on ALL test widths
(PR#2, PR#3) · all H/M/L findings resolved · User Testing by the owner →
an explicit merge signal per PR → the label `merge-approved` when mss=CLEAN.

## Plan self-review

- Spec coverage: §2 → C; §3 → A+B; §4 → B; §5 → B(cron); §6 → D; §7 → tests in A/B/C/D + E; §8 → F; §9 → wave structure. No gaps.
- Contracts aligned: schema/endpoint/key names are unified across all tasks (source — the "Contracts" section).
- Owner blockers are moved into Phase 0 and do not block Phase 1.
