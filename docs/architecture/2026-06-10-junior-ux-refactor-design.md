# Junior UX refactor — design (2026-06-10)

> Status: DRAFT under owner review. Source — brainstorming session 2026-06-10.
> Next step after approval — implementation plan (writing-plans).

## 1. Context and goal

The junior's current UX is scattered and in places empty: the dashboard shows only "—", finance is sparse and without context, documents confuse with their categories (disabled "Archive", wrong subtitle), navigating to others' profiles leads to a 403, and ADMIN noise is visible in the toolbars.

**Goal — a project-centric reframe.** The junior works around their own project and the "senior" legend-persona; does not see real seniors/drops and their data; the legend becomes a living per-project document that the junior maintains.

## 2. Principles (cross-cutting rules)

1. **Project-centricity.** The junior's home is "My project" + "Legend". Everything revolves around the project and the persona.
2. **Mutual invisibility junior↔senior/drop.** The junior sees only the legend persona (through the project), never the real senior/drop, their contacts or user profile. The senior/drop do not see juniors and do not see legends (including their own).
3. **Always a "senior"; the drop does not exist for the junior.** Whatever stands behind the persona on the backend (a senior- or drop-user), the junior sees and writes "senior". The word "drop" is absent from the interface and from the data accessible to the junior.
4. **Financial boundary.** The junior sees ONLY their own salary incomes. The project rate (`rate`/`currency`), payouts/distributions on the project, the senior's income — hidden.
5. **The legend is a living document.** A per-project persona maintained by ADMIN / HR / junior; the junior appends new information "for the future".

## 3. Identity and legend model

**The legend is a project entity, not a subsection of the senior's profile.**

- A record per `(projectId, userId)` pair — a full independent persona. One senior on projects A and B has different personas (full name/DoB/address/hobbies may differ for each client).
- Conceptually the legend "moves" from the senior's profile into the project card: "the project dossier — who we are to this client".
- The junior reaches the legend through the project (`/api/projects/:projectId/legend`), never through `/api/users/:seniorId`.

**Legend content (three blocks):**

1. **The "senior" persona** (who we are to the client): full name · date of birth · address · hobbies/interests. No photo — an avatar from the full-name initials (the senior's real photo is not shown to the junior).
2. **What the client knows about us** (cover story): presented role · claimed stack · background/history.
3. **Journal** (append-only): a feed of entries `date · author · text` — "what we learned / what the client knows / agreements". The "new info appeared → recorded for the future" mechanism.

**Editing:** ADMIN · HR (of their own team) · JUNIOR (active member of the project). The senior/drop (the persona's subject) — does not see and does not edit.

## 4. Target UX

**Navigation — 5 sections** (Legend split out separately due to its centrality):

`My project · Legend · Finance · Documents · Profile`

We remove from the junior: separate "Team" and "Projects" (collapsed into "My project"), viewing others' user profiles, any ADMIN noise (the "senior" filter, etc.).

### 🏠 My project (hub; replaces the empty dashboard)

- **Project card:** logo · company · domain · start · status. **No rate.**
- **Project senior (persona):** avatar-initials · full name (from the legend) · presented role · → "Open legend". Marked as "senior", never "drop". No real photo/contacts.
- **Contract:** status (signed / needs signing → CTA).
- **My salary (snapshot):** last payout (amount/month/status) → "All my payouts". Only their own.
- **Your HR:** name · contact — through HR the junior asks work questions (they do not see the senior).
- **Quick links:** Legend · Documents · Finance.
- If active projects >1 — a project switcher at the top.

### 🎭 Legend (persona-document; the junior maintains)

The three blocks from §3. Always "senior". Editing the persona + cover + adding entries to the journal (ADMIN/HR/junior).

### 💰 Finance

Only their own SALARY incomes with context: project · period · status · amount (+ an explanation of what a TX hash and the statuses are). Neither rate, nor distributions, nor others' finances.

### 📄 Documents

Only those relevant to the junior: their own resume, scans, their own contract, salary invoices. Remove the disabled "Archive", fix the subtitle, do not show unavailable categories as "broken".

### 👤 Profile

Their own data, requisites, their own contract/onboarding. No viewing of others' profiles.

## 5. Data and schema

```
-- was:
legends(id, userId UNIQUE, fullName, dateOfBirth, address, hobbies, notes, ts)

-- will become:
legends(
  id, projectId FK→projects(id) ON DELETE CASCADE,
  userId FK→users(id) ON DELETE CASCADE,
  fullName, dateOfBirth, address, hobbies,        -- persona
  presentedRole, presentedStack, backstory,        -- cover (what the client knows)
  ts
)
UNIQUE(projectId, userId)   -- drop the former UNIQUE(userId)

legend_entries(            -- journal (append-only)
  id, legendId FK→legends(id) ON DELETE CASCADE,
  authorId FK→users(id), text, createdAt
)
```

**Migration per-senior → per-project:** for each current `legends(userId=X)` copy the record into every active project where `seniorId=X` OR `dropId=X`. The old `notes` → the first journal entry. Orphaned legends (a senior with no active projects) — **deleted**.

## 6. RBAC

| Who                          | Project legend (view+edit) | Journal         |
| ---------------------------- | -------------------------- | --------------- |
| ADMIN                        | all                        | +               |
| HR (of their own team)       | yes                        | +               |
| JUNIOR (active on project)   | yes                        | + (appends)     |
| Senior/drop (the subject)    | ❌                         | ❌              |
| Others                       | ❌                         | ❌              |

**Junior financial masking:** project DTOs do not return `rate`/`currency`/distributions to the JUNIOR role; `/api/finance/*` and transactions for the junior — only their own SALARY (already partial, finish it).

**Persona invisibility:** junior-facing project DTOs replace the real senior/drop with the legend persona (full name from the legend, no real contacts/displayName/avatar), the label is always "senior".

**Side backend fix (by the same principle):** `getViewPermissions` — close off a senior viewing other seniors/drops (currently `isSeniorViewingOwnProjectMember` lets a non-JUNIOR target through). Not part of the junior's visuals, but of the same "do not see each other" class.

**Endpoints:** `GET/PUT /api/projects/:projectId/legend`, `POST /api/projects/:projectId/legend/entries`. Deprecate `/api/users/:id/legend`.

## 7. Rollout phases

1. **Backend (data + RBAC + endpoints).** Schema migration + data transfer; RBAC (per-project legend; financial masking; persona replacement; senior↔senior invisibility); new endpoints. Backend tests (403/masking) — mandatory (RBAC-audit discipline, not mocked-E2E).
2. **UX core.** "Legend" (persona + cover + journal, the junior edits) + "My project" (hub) + simplifying navigation down to 5 sections.
3. **UX cleanup.** Finance (own salary + context), Documents (categories/archive/subtitle), Profile (own), remove ADMIN noise.

## 8. Decisions (formerly open questions)

1. **Cover fields** — `presentedRole` / `presentedStack` / `backstory`, as is (sufficient).
2. **Orphaned legends** on migration — **deleted**.
3. **Persona photo** — **not needed** (avatar from full-name initials).
4. **Several active projects** — the main case is 1 project (≈95%), support up to 2 (switcher in "My project").
5. **Junior escalation** — **through HR** (the HR contact is visible to the junior in "My project").

## 9. Out of scope (explicitly)

- Active work-hub features (tasks, chat, metrics) — rejected (YAGNI) in this iteration.
- Changes to the UX of senior/drop/HR/ADMIN, except the backend senior↔senior invisibility.
