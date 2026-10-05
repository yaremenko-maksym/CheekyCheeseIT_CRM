# Product backlog (deferred features)

> A running backlog of ideas and features deferred by the owner "for later". Not a plan for immediate implementation —
> an entry point for when we get to it. Each item: context, desired behavior, affected places in the code,
> open questions. When taken into work → BA brief → PM → tasks (full pipeline).

---

## Interviews — scheduling logic + views

**Added:** 2026-06-23 (owner, while reviewing the kanban redesign). **Priority:** low ("much later").
**Why deferred:** the kanban redesign is going now as a purely visual change; this logic is a separate feature with a
schema migration and edge cases, not mixed with the visual step.

**Current model** (for reference): the `interviews` table (`apps/api/src/database/schema.ts:352`) —
`companyName · vacancyUrl · callUrl · hrId · stage · position · createdAt · notes*`. Stages in
`apps/web/app/routes/_authenticated/interviews/constants.ts`. The board is per-senior; the move is in
`InterviewsService.move()` (`apps/api/src/interviews/interviews.service.ts:214`).

### 1. Reset the call link when moving stage

- When moving a card between **active** stages — the `callUrl` field (and future scheduling fields)
  is **reset**: a new stage = a new meeting that has to be arranged again.
- Implementation: in `move()` when `oldStage !== newStage` (and newStage is not terminal), clear the meeting fields.
- Terminal stages (HIRED/REJECTED/ARCHIVED) do not require a meeting — do not reset/do not warn.

### 2. "Meeting not scheduled" warning + completion

- After moving to a new active stage the card **highlights a warning** "meeting not scheduled".
- To fill in: the meeting **date + time** (new field `scheduledAt: timestamp`) and the **contact method**:
  - **video call** → link (`callUrl`, Google Meet / Teams), OR
  - **messenger** → a marker + **contact** (new field `messengerContact`: a Telegram link or a phone number).
- Contact method model: `meetingMethod: 'video' | 'messenger'` (new enum/field) — determines which field is
  required. Validation on the client + server (Zod in `@crm/shared`).

### 3. "Took place N days ago" reminder

- When `scheduledAt` is in the past — the card shows relative-time ("took place 4 days ago", "a week ago").
- The owner liked the "reminders" in the redesign — this is their functional content.
- A relative-time helper (ru locale); no heavy dependencies (`Intl.RelativeTimeFormat`).

### 4. List view of interviews

- An alternative to the kanban — a list (table/rows). Design it (our data-table pattern).
- In the UI — a **view toggle** (Kanban / List), a **disabled placeholder** until it is done.

### 5. Calendar view + Google Calendar integration

- A calendar view of meetings (by `scheduledAt`). When the calendar is shown — **Google Calendar integration**
  (OAuth + Calendar API: creating/syncing meeting events). A separate large feature (its own OAuth scope, ADR).
- In the UI — the view item is a **disabled placeholder** until it is done.

### Open questions (decide when taken into work)

- `meetingMethod` — a separate enum column or derived from the filled field? (recommendation: an explicit enum).
- Store the meeting history per stage (audit) or only the current meeting on the card? (now — the current one).
- Are notifications (in-app/email/Telegram) needed about an unscheduled/upcoming meeting? (probably later).
- Google Calendar: two-way sync or one-way (CRM → GCal)? OAuth per-user vs a service account.

### Affected on implementation

- Schema + migration (`interviews`: `scheduledAt`, `meetingMethod`, `messengerContact`).
- `@crm/shared` (Zod schemas `InterviewDto` / Create / Update / Move + contact-method validation).
- API: `InterviewsService.move()` (reset), `update()` (completion), new validations.
- Web: the card (reminder zone: warning / date-time / call link / messenger contact / relative-time),
  the completion form, view toggles (disabled), `InterviewDetailSheet`.
- Tests: unit (move-reset, relative-time, validation), E2E (warning-flow, completion).
