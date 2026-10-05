# Module: File storage (Documents)

## Status: ✅ Implemented (PHASE 6) + task-file-storage-hardening tightening (2026-08-01, refined after security-review round 2 — 2026-08-03)

File storage for two domains: employees' internal documents (`documents` —
resumes/scans/contracts/receipts/avatars/logos/invoices) and public vacancy applications
(`vacancy_applications` — candidates' resumes). Both use the same S3-compatible
bucket (dev: the local S3 stand RustFS, prod: Cloudflare R2), with different S3 prefixes (`documents/` and
`vacancy-applications/`).

Origin of the section: the 2026-08-01 storage audit found that there are no direct paths to "get someone else's
file" (the object key is server-side, the signature covers the path, permissions are checked before the
link is issued), but the standard permissions were wider than intended, and the data lifetime was not limited. Below is the
matrix fixed by the owner, which previously existed nowhere except a code comment
(which is why the audit could not tell the intent from a defect).

## Document categories (`documents` table)

`RESUME` · `SCAN` · `CONTRACT` · `RECEIPT` · `INVOICE` · `AVATAR` · `LOGO`

## Read access matrix (list + download/preview)

The gate is single for the list (`GET /api/documents`) and for issuing the download/preview link
(`GET /api/documents/:id/download|preview`) — both paths go through the same RBAC check
in `DocumentsService` (`buildVisibilityClause` for the list, `findActiveOrThrow` for
a single document). A denial of access is **always 404** ("Документ не найден"), never
403 — the response code must not let an outside
observer establish the fact that a document exists.

| Category     | ADMIN | SENIOR                        | JUNIOR | HR                            | ACCOUNTANT          | DROP |
| ------------ | ----- | ----------------------------- | ------ | ----------------------------- | ------------------- | ---- |
| **RESUME**   | all   | **team+projects** (see below) | own    | **team+projects** (see below) | ❌                  | own  |
| **SCAN**     | all   | **team+projects**             | own    | **team+projects**             | **all** (see below) | own  |
| **CONTRACT** | all   | own                           | ❌     | their SENIORs' (own team)     | ❌                  | own  |
| **RECEIPT**  | all   | own                           | ❌     | ❌                            | all                 | ❌   |
| **INVOICE**  | all   | own (as a counterparty)       | own    | own                           | all                 | own  |
| **AVATAR**   | all   | own                           | own    | own                           | own                 | own  |
| **LOGO**     | all   | all (read)                    | ❌     | all (read)                    | ❌                  | ❌   |

**Own documents are always available to all roles**, regardless of team —
this is not a table row but a separate fast-path (`doc.ownerId === actor.id`).

### Owner decision 2026-08-01: RESUME/SCAN narrowed to the team + the team's projects (transitively)

**Before:** any SENIOR or HR saw and downloaded the RESUME/SCAN of **any** company employee,
including other SENIORs and ADMIN, with no tie to projects/teams.

**After:** SENIOR and HR see the RESUME/SCAN of **their team AND the projects of that team**, not
only the literal `team_members` rows — because a JUNIOR is **never** a
`team_members` row (a JUNIOR joins the company exclusively via `project_members`;
`TeamsService.addMember` rejects adding a JUNIOR with an active project to
`team_members`). The predicate is built as two steps (`getTeammateIds`,
`apps/api/src/documents/documents.service.ts`):

1. **"Team" step:** the actor + everyone who has an **active** membership in the same
   team as the actor (`team_members.leftAt IS NULL`) — `HrAccessService.getActiveTeamPeers`.
   This yields direct colleagues (SENIOR/HR/ADMIN etc. in the team), but NOT juniors.
2. **"Project" step:** for the actor themselves (if a SENIOR) and/or each SENIOR among
   the colleagues found in step 1 — take their **non-archived** projects
   (`projects.archivedAt IS NULL`), and from those projects — all **current** participants
   (`project_members.leftAt IS NULL`). This is exactly the path by which SENIOR/HR reach
   a JUNIOR: team → a SENIOR inside it → that SENIOR's projects → the juniors on them.

The resulting coverage is the union of both steps. Important consequences of this model:

- A SENIOR/HR who currently has no active team still sees the juniors of **their own**
  projects: step 2 runs for the actor themselves regardless of the result of step 1
  (a zero team does not block the project path).
- An HR/SENIOR removed from a team (`leftAt` set) loses access to the whole chain —
  the same principle that already applied to HR→CONTRACT.
- A former project participant (`project_members.leftAt` set) is unreachable, even if
  they formally were once in the team/project.
- **An archived project is excluded explicitly, by `projects.archivedAt`, not by the `leftAt` of its
  participants** (MED, security-review round 2, 2026-08-03): `ProjectsService.archive()`
  sets `leftAt` on active juniors at the moment of archiving, but `unarchive()` deliberately
  **does not restore** `leftAt` back (see the comment in the method itself) — that is, after
  unarchiving a project may end up in the state "the participant is formally still active
  (`leftAt IS NULL`), but the project was already archived". A filter on `leftAt` alone does not
  distinguish this combination, so the predicate checks `projects.archivedAt` directly —
  the same technique already used in `UsersAccessService.isJuniorUnderLegendSubject`.

### Owner decision 2026-08-03: ACCOUNTANT on SCAN — all, unconditionally (not transactional)

**Intermediate state (round 1, cancelled):** in the first iteration of this task the agent
on its own narrowed ACCOUNTANT's access to SCAN by the criterion "there is at least one transaction with
the document owner" — the intent was to exclude "just any company SCAN", by analogy
with the RESUME/SCAN narrowing for SENIOR/HR. The second round of security-review rejected this criterion
and the owner decided to restore unconditional access. Below is the rationale for REJECTING the
transactional criterion, so that the next audit does not raise the question again.

**Why the "has a transaction" criterion does not work — for two reasons at once:**

1. **It is self-satisfiable.** An ACCOUNTANT creates transactions themselves (it is part of their regular
   work) — that is, they can unlock access to someone else's SCAN with a single action
   (create any, even a zero/test transaction with that person). It is not a restriction,
   but an illusion of one.
2. **It breaks onboarding.** In fact in prod at the time of the check transactions existed only for
   5 of 21 users; HR and the DROP role had none at all. A newly hired employee whose SCAN
   needs to be checked BEFORE the first payout (the typical reason an ACCOUNTANT opens a SCAN at all) would have
   got a 404 exactly when access is needed most.

**The owner's final decision: ACCOUNTANT sees ALL scans, with no tie to a team, project
or the presence of transactions.** Rationale:

1. The role is **audit and read-only** — an ACCOUNTANT does not upload RESUME/SCAN for others
   (`assertCanUpload` gives ACCOUNTANT no such right), so wide access creates the risk
   of "read an outsider's file", but not the risk of "substituted/uploaded someone else's file". The same pattern is already
   applied to RECEIPT and INVOICE — ACCOUNTANT sees both categories in full.
2. Since this same task (§7) every issuance of a SCAN link is written to `document_access_log` — that
   is, wide access is now accompanied by a log of "who opened whose scan and when", which
   was previously absent and was the only real way to limit abuse
   without destroying onboarding.

Team/project/transactional predicates for ACCOUNTANT are **deliberately not introduced** — this is
not a gap, but a closed question.

## Upload (`assertCanUpload`) — not changed in this round

The right to **upload** a RESUME/SCAN for another person (ADMIN/SENIOR/HR — for any owner;
JUNIOR/DROP — only for themselves; ACCOUNTANT — cannot) remained as before. The 2026-08-01 narrowing
concerns only **reading** (list + download/preview) — the audit had no finding
that uploading "for another" is by itself a leak (the uploader already owns
the file anyway).

## Retention period

| What                                          | Period                                   | What happens                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vacancy application, `REJECTED`               | 90 days from creation                    | The whole row + file is deleted (`VacanciesRetentionCronService.purgeExpiredApplications`)                                                                                                                                                                              |
| Vacancy application, vacancy closed > 90 days | 90 days from the vacancy's closing       | The whole row + file is deleted (the same method)                                                                                                                                                                                                                       |
| **Any** vacancy application (any status)      | **180 days** from creation (§2)          | **Only the file** is deleted (`resumeS3Key`/`resumeSizeBytes` → `null`); the application row (full name, email, phone/telegram, status) remains — the historical value of hiring outweighs deleting the record that a person applied at all (`purgeExpiredResumeFiles`) |
| Other documents (`documents` table)           | Indefinitely (soft/hard delete manually) | —                                                                                                                                                                                                                                                                       |

**Before 2026-08-01:** an application in status "new"/"under review" on an evergreen (never
closed) vacancy was stored indefinitely — together with the resume file, email, phone and
cover letter. The 180-day rule closes this gap regardless of the status of the
application or the state of the vacancy.

`GET /resume-url` for an application whose file has already been purged responds **404** ("Резюме удалено по
истечении срока хранения") — the same logic of "not found, rather than no access".

## Object caching in S3/R2

| Category                                               | `Cache-Control`                            | Signed link TTL |
| ------------------------------------------------------ | ------------------------------------------ | --------------- |
| `CONTRACT` / `RECEIPT` / `INVOICE` / `RESUME` / `SCAN` | `private, no-store` (not cached at all)    | 30 minutes      |
| `AVATAR` / `LOGO`                                      | `public, max-age=31536000, immutable`      | 24 hours        |
| Vacancy application (`vacancy-applications/`)          | `private, no-store` (same logic as RESUME) | 10 minutes      |

**Before 2026-08-01:** the header was `public, max-age=31536000, immutable` for ALL categories —
the lifetime of the LINK for sensitive categories was honestly cut to 30 minutes, but the BYTES themselves
sat in the browser cache (and any intermediate proxy) for a year.

## Sanitizing uploaded PDFs

A resume arriving through the public (anonymous, no authorization) `POST /apply` is the only
entry point for files from outside the company. PDF metadata (author/title/producer/creator — often
containing the candidate's real name and a "fingerprint" of the software they prepared the document with) is stripped
**unconditionally in the first compression pass** for any PDF (`CompressionService.compressPdf`), and
for this specific public path the file-growth protection does **not** roll back to the
original buffer (`neverFallbackToOriginal: true`) — otherwise the anti-bloat guard would periodically return
byte-for-byte what the anonymous user sent, cancelling the sanitization.

**Residual risk (deliberately not taken into this task):** active PDF content (`/OpenAction`,
embedded JavaScript, attached files) — pdf-lib offers no supported way to remove it without
risking breaking legitimate PDFs. The antivirus class of task is a separate owner decision, outside
this iteration.

## Link issuance log

Every issuance of a presigned link for download/preview/**thumbnail** (clarified following
security-review round 1, MED-5) of a **sensitive** category
(`CONTRACT`/`RECEIPT`/`INVOICE`/`RESUME`/`SCAN`, including candidates' resumes) writes a record to
`document_access_log` (`actorId` — indexed, `targetId` — the document/application id, `action`
`DOWNLOAD`/`PREVIEW`/`THUMBNAIL`, `category` in `metadata`, `createdAt`). The link itself
never reaches the log. The write is best-effort (a write failure does not block issuing the file). AVATAR/LOGO
are not logged — they are loaded constantly as part of ordinary list rendering, and the question "who downloaded"
makes no sense for them.

**The log retention period is 365 days** (`DocumentAccessLogRetentionCronService`, a daily cron,
a plain DELETE with no external storage to compensate). This is a deliberate agent default (the audit
trail lives longer than the PII it describes), not an owner decision — to be revisited if
needed.

## Orphaned objects (orphan reconciliation)

`POST /api/documents/reconcile-orphans` (ADMIN-only) scans **both** managed bucket prefixes
(`documents/` and `vacancy-applications/`, added in §4) and reconciles them with the known keys
from **both** tables (`documents.s3Key`/`thumbnailS3Key` and `vacancy_applications.resumeS3Key`,
excluding `NULL` — a file purged by retention is not "known" but legitimately absent).

Manual deletion of an application (`ApplicationsService.remove`) deletes the R2 object **first**
(`deleteOrThrow`, throws on failure) and only then the row — the same order that the
retention cron already had: a file-deletion failure leaves the row in place instead of silently
orphaning a file with personal data.

## Entities

- **documents** — `id, ownerId, projectId?, category, name, originalName, s3Key,
thumbnailS3Key?, sizeBytes, mimeType, uploadedBy, deletedAt?, deletedBy?, createdAt`
- **vacancy_applications** — `id, vacancyId, fullName, email, telegram?, linkedinUrl?,
githubUrl?, coverLetter?, resumeS3Key?` (nullable, §2), `resumeSizeBytes?` (nullable, §2),
  `status, createdAt`
- **document_access_log** (new, §7) — `id, actorId?, targetId, action, metadata, createdAt`
  — no FK on `targetId` (the log must outlive the deletion/retention of the document it
  refers to)
