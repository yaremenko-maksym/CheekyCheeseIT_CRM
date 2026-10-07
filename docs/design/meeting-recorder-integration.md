# Design Spec — Meeting Recorder CRM integration

> **Design gate:** fallback textual spec (Mode A; no visual artifact).
> **Status:** implemented for the defined events-only API surfaces. The unmatched inbox uses
> `GET /api/interview-recordings/unmatched`; the current shared unmatched DTO still has no typed
> possible-match hint, so V1 renders the neutral no-hint state described in §4.
> **Architecture source:** `docs/architecture/2026-10-07-meeting-recorder-integration-plan.md`,
> especially C3 and C7-C9.
> **Fidelity reference:** this spec plus the current `/admin` shell and
> `InterviewDetailSheet`. No new design tokens are required.

## 1. Direction

- **Purpose:** let an administrator configure Meeting Recorder delivery, resolve recordings that
  could not be matched automatically, and let permitted interview viewers inspect linked recordings
  without mixing recorder output into human CRM notes.
- **Audience:** ADMIN repeats connection/unmatched workflows occasionally; ADMIN/HR/SENIOR inspect
  recordings from the existing interview workflow.
- **Tone:** dense, quiet, scannable SaaS operations UI. Prefer compact rows, restrained status text,
  existing surfaces and explicit actions.
- **Memorable detail:** recording readiness is always a small textual status cluster beside the
  recording metadata. The same vocabulary is used in unmatched, interview summary and recording
  detail surfaces, so users can scan state without opening each recording.
- **Constraints:** existing Tailwind v4 + shadcn/Radix primitives, existing color/radius tokens,
  Lingui for every visible string with Ukrainian source copy, WCAG 2.2 AA, dark-only UI,
  320-1440 px.

The CRM runtime is **dark-only today** (`apps/web/index.html` pins `<html class="dark">`).
`globals.css` also contains dormant `:root` light tokens, but there is no user-facing theme switch;
do not add theme controls or feature-local light overrides in this pass. Every new user-visible
string in the implementation must use the project's existing Lingui pattern with **Ukrainian source
text**; English translations remain catalog output, not source literals in these components.

Do not add gradients, glass surfaces, oversized headings, nested cards, raw hex colors or a new
status palette. Use `bg-background`, `bg-card`, `bg-muted/20`, `border-border`,
`text-foreground`, `text-muted-foreground`, `text-destructive`, `primary` and existing
`Badge` variants.

## 2. Existing patterns to preserve

| Existing pattern       | Requirement for this feature                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/route.tsx`      | Add one `AnimatedTabs` item with value `integrations`; active state continues to derive from `/admin/<value>`. Parent `PageHeader` and the existing scrollable child area stay unchanged.      |
| Admin child pages      | Use compact `flex flex-col gap-4` content, `Card` only for genuine grouped settings, `Button size="sm"`, `Skeleton` for loading.                                                               |
| `InterviewDetailSheet` | Keep `w-full sm:max-w-lg flex flex-col overflow-hidden`, fixed header/footer and one scroll body. Recording summaries are another section inside that body.                                    |
| Nested modal handling  | Recording detail/link confirmation is rendered as a sibling `Dialog`/`AlertDialog` outside `<Sheet>`, following the existing delete/unsaved dialogs. Do not put a modal inside `SheetContent`. |
| Long dialogs           | Prefer the existing `CrmDialogContent` + `CrmDialogHeader` + `CrmDialogBody` + `CrmDialogFooter` pattern. It already owns `max-h-[90dvh]`, fixed header/footer and the scroll body.            |
| Query persistence      | `PERSISTED_KEY_PREFIXES` matches `queryKey[0]` exactly. Recording/integration keys defined in this spec stay outside that allow-list.                                                          |

When extending the admin tab list, also add the matching hidden integration link beside the current
sr-only compatibility links in `admin/route.tsx`; do not hand-edit `routeTree.gen.ts`.

## 3. `/admin/integrations` — connection management

Add the ADMIN tab **«Інтеграції»** to the existing admin tab bar and a child route
`/admin/integrations`. The page is connection management only; unmatched recordings belong to the
Interviews workflow (§4).

### 3.1 Page layout

Top row:

- a short muted sentence explaining that these connections receive Meeting Recorder events;
- primary `Button size="sm"`: **«Додати підключення»**.

Below it, render one flat stack of connection `Card`s, maximum readable width about `max-w-3xl`.
One card represents one connection; do not put cards inside it. Use the existing card radius and
token surface as-is rather than introducing a feature-specific radius.

Each card contains:

1. header row: connection name, status `Badge`, compact overflow/actions area; keep management
   actions in one `DropdownMenu` triggered by a `MoreHorizontal` icon button so four secondary
   actions do not dominate the card or wrap unpredictably on mobile;
2. webhook URL block: label, read-only monospace URL with `break-all`, icon-only Copy button;
3. secret row: **never the secret value**; show only **«Секрет налаштовано»** / **«Секрет не налаштовано»**
   and `signingSecretUpdatedAt` when available;
4. activity metadata: **«Остання перевірка»** from `lastVerifiedAt` and
   **«Остання подія»** from `lastEventAt`; render `—` for a missing timestamp;
5. actions: rename, enable/disable, replace/set secret, reset pairing.

Status precedence:

| Condition                                   | Visible status                                    |
| ------------------------------------------- | ------------------------------------------------- |
| `enabled === false`                         | `Badge variant="secondary"`: **«Вимкнено»**       |
| `secretSet === false`                       | `Badge variant="pending"`: **«Потрібен секрет»**  |
| enabled + `secretSet` + no `lastVerifiedAt` | `Badge variant="pending"`: **«Очікує перевірки»** |
| enabled + verified                          | `Badge variant="status-active"`: **«Підключено»** |

Status text is mandatory; color is only reinforcement.

### 3.2 Connection actions

- **Create:** one user flow may collect `name` and signing secret in the same dialog, but the wire
  contract is two-stage: `POST /api/integrations/meeting-recorder/connections` with `{ name }`, then
  `PUT .../connections/:id/secret` with `{ secret }`. The secret is a password-style write-only
  input validated with the shared `meetingRecorderSigningSecretSchema` (`whsec_`, 24-64 decoded
  bytes). If secret setup fails after create, do not roll the connection back; refresh the list and
  keep it visible as **«Потрібен секрет»** with the secret error still actionable.
- **Rename:** small `Dialog` or the same edit dialog; one labeled name field.
- **Enable/Disable:** reversible direct action. Disable uses a secondary/outline button and never
  implies deletion.
- **Replace secret:** `Dialog` with one new secret field. On success, clear the input immediately;
  plaintext must never be re-rendered.
- **Reset pairing:** `AlertDialog`. Explain that the pinned recorder identity will be cleared and
  a new signing secret must be configured before the replacement destination can connect. After
  success `secretSet === false`, `expectedSource === null` and `lastVerifiedAt === null`; preserve
  `enabled` and show **«Потрібен секрет»** until replacement succeeds.
- Copy URL from the API's `webhookPath` using URL resolution against `window.location.origin`
  (`new URL(webhookPath, window.location.origin)` semantics); do not concatenate slashes manually
  and do not hardcode the production hostname.
- Copy is `Button size="icon"` with a Copy icon and `aria-label`; the visible URL remains selectable.

Use toast feedback for successful mutations and mutation failures, matching current admin pages.
Loading failures use an inline `Alert variant="destructive"` with **«Повторити»**.

Use a stable non-persisted list key such as `['meeting-recorder-connections']`. Update/invalidate
that key after create, rename, enable/disable, secret replacement and pairing reset. Never place it
under `['interviews', ...]`.

### 3.3 States

| State            | Rendering                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Loading          | 2 compact card skeletons: header line, URL line, metadata line.                                            |
| Empty            | One dashed, unframed empty block: **«Підключень Meeting Recorder поки немає»** + **«Додати підключення»**. |
| Error            | Inline destructive Alert; keep the tab shell usable.                                                       |
| Mutation pending | Disable only the affected action/card controls; do not blank the whole page.                               |

## 4. ADMIN unmatched recordings

Follow C7 literally as an Interviews sub-flow. For ADMIN only, add an outline action
**«Неприв'язані записи»** to the existing `/interviews` top action cluster and route it to
`/interviews/unmatched`. Do not add unmatched content to `/admin/integrations`.

The new route must enforce `ADMIN` itself (for example through the existing role-guard pattern).
Hiding the board button is not an authorization boundary. The unmatched page uses the same compact
CRM page spacing as Interviews, with a small back/navigation action to `/interviews`, page title and
the list below; it must not recreate the kanban shell.

The unmatched page uses a compact list, not a kanban and not a grid of cards.

The ADMIN inbox is served by `GET /api/interview-recordings/unmatched` and parsed as
`MeetingRecorderUnmatchedRecordingDto[]`. Use the stable frontend query key
`['interview-recordings-unmatched']` and keep it outside `PERSISTED_KEY_PREFIXES`. The V1 DTO has no
typed possible-match hint, so render the neutral **«Збіг не знайдено»** state until that contract is
extended explicitly.

### 4.1 List row

Information order:

- recording title;
- date/time + duration;
- provider when present;
- meeting URL when present;
- **«Можливий збіг»**: company + stage when the backend supplies a hint;
- readiness text;
- `Button size="sm"`: **«Прив'язати»**.

At 320-767 px the same row is a vertical block: title, date/duration/provider, meeting URL, possible
match/readiness, then a full-width action. At 768-1023 px use a two-line grid so title/metadata and
match/readiness have room; keep the action aligned at the end. Only at >=1024 px may the row collapse
into one dense multi-column line. Do not use a `<Table>` or horizontal scrolling for this inbox.

Possible-match hints are visually muted and informational. They never create a one-click automatic
link. Pressing **«Прив'язати»** opens the explicit selection flow below, optionally preselecting the
hinted interview.

**Current contract limitation:** `MeetingRecorderUnmatchedRecordingDto` has no possible-match field
today. Do not derive a hint client-side by downloading/searching every interview. Until the shared
DTO gains a typed hint (including enough identity to preselect a target safely), render the no-hint
state. When that contract exists, consume only the typed server hint; display stage through the
existing localized stage-label map, never as a raw enum.

### 4.2 `LinkRecordingDialog`

Use `Dialog` from `components/ui/crm-dialog` with `CrmDialogContent` so search results scroll while
the title and submit controls stay fixed. Title: **«Прив'язати запис до співбесіди»**.

- Reuse `useBoardSeniors` / `GET /api/interviews/seniors`: choose a senior first, then fetch that
  board from `GET /api/interviews?seniorId=<id>`. The interview search field filters the already
  fetched board client-side by visible company/stage text. Do not add a search API or global
  all-interviews endpoint.
- Each interview option shows company + stage; the selected senior remains visible above the list.
- Do not default to the first interview. A typed server hint may preselect an interview only when it
  identifies that exact interview; submit is still explicit.
- The selected target is summarized above the footer before submit.
- Submit uses `PATCH /api/interview-recordings/:id/link` with `{ interviewId: selectedId }`.
- On success: close dialog, remove/invalidate the unmatched item, invalidate
  `['interview-recordings', selectedId]` and `['interview-recording', recordingId]`, then show a
  success toast. Do not invalidate `['interviews']`; recordings are deliberately outside
  `InterviewDto`.
- While linking, disable submit and the selected row's action only.
- Server validation/access errors remain visible in the dialog as text; do not silently choose a
  different interview.
- Because the successful mutation removes the trigger row, explicitly move focus to the next
  **«Прив'язати»** button, the previous row if there is no next row, or the empty-state/page heading
  (`tabIndex={-1}`) when the list becomes empty. Do not rely on Radix to restore focus to an element
  that has just been removed.

ADMIN can later **«Відв'язати»** or **«Переприв'язати»** from recording detail (§5.4).

### 4.3 States

- Loading: 4 row skeletons preserving row height.
- Empty: dashed empty state, **«Неприв'язаних записів немає»**.
- Error: destructive Alert + **«Повторити»**.
- No possible match: show **«Збіг не знайдено»** in muted text; linking is still available.

Unmatched responses are summaries only. Never fetch/render full snapshots just to populate this
inbox.

## 5. Linked recordings in `InterviewDetailSheet`

Add a section **«Записи»** after the stage controls and before **«Нотатки сеньйора»**. This keeps
recorder-derived content visibly separate from editable human CRM fields.

Fetch summaries only while the sheet is open with the architecture key:

```ts
;['interview-recordings', interview.id]
```

Do not put recording data into `InterviewDto`, and do not nest this key under `interviews`.
Set the query `enabled` from the sheet's open state; do not prefetch full recording content with the
board. The API remains the RBAC authority: ADMIN/HR/SENIOR see summaries only when they already have
access to that interview, including the existing teamless-SENIOR restriction.

### 5.1 Summary row

Each recording is a compact bordered row (`rounded-md border border-border px-3 py-2`), not a
second-level `Card`.

First line: title, then a small **«Відкрити»** outline button.

Second line, muted: localized start date/time, duration and provider.

Third line: readiness text cluster:

- **«Транскрипт готовий»** / **«Транскрипт обробляється»**;
- **«Аналіз готовий»** / **«Аналіз обробляється»**.

Readiness comes from `readiness.pending`; never display missing pending content as completed.
If a content section was omitted by sender policy and is not pending, say **«Транскрипт не передано»**
or **«Аналіз не передано»** instead of showing an empty ready section.

For analysis, `readiness.pending` is necessary but not sufficient to say **«Аналіз готовий»** because
the typed payload also has `analysis.status`:

| Condition                                                          | Analysis text             |
| ------------------------------------------------------------------ | ------------------------- |
| `pending` contains `analysis` or `analysis.status === 'analyzing'` | **«Аналіз обробляється»** |
| no `analysis` and not pending                                      | **«Аналіз не передано»**  |
| `analysis.status === 'completed'`                                  | **«Аналіз готовий»**      |
| `analysis.status === 'failed'`                                     | **«Помилка аналізу»**     |
| `analysis.status === 'canceled'`                                   | **«Аналіз скасовано»**    |
| `analysis.status === 'unsupported'`                                | **«Аналіз недоступний»**  |

If `readiness.pending` contains `artifact-delivery`, add one muted text line saying delivery is still
in progress. This is status only: V1 does **not** render artifact links, media controls or playback.

Section states:

- loading: 2 row skeletons;
- empty: compact dashed block **«Для цієї співбесіди записів немає»**;
- error: compact destructive Alert + **«Повторити»**.

## 6. Recording detail

Open a sibling `RecordingDetailDialog` from the summary row, rendered outside
`InterviewDetailSheet` alongside the existing sibling dialogs. Keep the interview sheet mounted so
unsaved interview edits are not discarded. Add the recording dialog's open state to the sheet-close
guard for the same reason existing confirm dialogs are guarded. The guard must cover every recorder
modal that can be open from the sheet (`RecordingDetailDialog`, link/relink dialog and unlink
confirmation), not only the first detail dialog.

Use `CrmDialogContent maxWidth="sm:max-w-3xl"` with `CrmDialogHeader`, `CrmDialogBody` and an
optional fixed `CrmDialogFooter`. On 320 px, override the base full width so the dialog keeps about
8 px outer breathing room instead of touching both viewport edges.

Fetch the full snapshot only here:

```ts
;['interview-recording', recordingId]
```

Enable this query only while this specific detail dialog is open. The full snapshot is sensitive
and can approach 2 MiB: use `gcTime: 0` (or the local equivalent that removes an unobserved detail
query immediately) so closing the detail does not keep transcript content in React Query memory.
Do not use `placeholderData`/`keepPreviousData` across recording IDs. The key remains forbidden from
IndexedDB persistence regardless.

### 6.1 Header

- title;
- localized start date/time and duration when present;
- provider and meeting URL when present;
- readiness status cluster.

The meeting URL may be visually truncated but its accessible/copy value remains complete. Render the
date as semantic `<time dateTime={startedAt}>`; never display `0`/`undefined` for a missing duration
or provider.

### 6.2 Content order

1. **«Транскрипт»**
2. **«Нотатка рекордера»** — payload `note`, free text
3. **«Нотатки за часом»** — payload `notations`
4. **«Аналіз»** — typed analysis content, including topics when present

Do not merge any of these into `notesTechStack`, `notesGeneral` or other human-entered interview
fields. V1 has no **Apply to CRM notes** action.

### 6.3 Transcript rendering

- Render payload text as React text nodes only. Never use `dangerouslySetInnerHTML`, markdown HTML
  or arbitrary HTML injection.
- Preserve segment order.
- At >=768 px a segment row uses timestamp, optional speaker, then transcript text. At <768 px use
  a two-column layout: narrow timestamp at left, with optional speaker above the text in the right
  column. This prevents speaker names from squeezing transcript text at 320 px. Speaker is omitted
  entirely when sender policy omits speakers; render supplied names or pseudonyms verbatim as plain
  text.
- Use `font-variant-numeric: tabular-nums` / `tabular-nums` for timestamps and durations.
- Thousands of segments must not create a huge initial layout cost: apply
  `content-visibility: auto` to segment rows first and pair it with a reasonable
  `contain-intrinsic-size` estimate to reduce scrollbar jumps. Measure before adding any
  virtualization dependency.
- Do not put the entire transcript in an `aria-live` region. Only compact readiness/status changes
  may use `aria-live="polite"`.

### 6.4 Notes and analysis rendering

- Time-coded `notations`: timestamp + plain-text body, same timestamp treatment as transcript.
- Recorder `note`: normal wrapping text, `whitespace-pre-wrap break-words`.
- Analysis: render only explicit typed fields from the shared V1 DTO. The current contract is
  `status`, optional `error`, and optional `topics[]`; each topic has `keywords[]`, `importance` and
  `spans[]` (`tStartMs`/`tEndMs`). Do not invent a topic `name`, summary/body field or normalized
  score, and never generic-dump JSON. Render topic keywords as plain text and spans as compact
  time ranges/counts; if `status === 'failed'`, the optional `error` may appear as wrapped plain text.
- Pending section: show a small muted state inside the section, not a spinner that replaces the
  rest of the recording.
- Omitted section: show **«Не передано»** only when the distinction matters; otherwise omit an empty
  optional subsection. The readiness status in the header remains the source of truth.

### 6.5 ADMIN link controls

Only ADMIN sees link-management controls in recording detail:

- linked recording: **«Відв'язати»** and **«Переприв'язати»**;
- **«Відв'язати»** uses `AlertDialog` and explains the recording will return to the unmatched inbox;
- **«Переприв'язати»** reuses `LinkRecordingDialog`.

Both actions use the same architecture endpoint: `PATCH /api/interview-recordings/:id/link`.
Unlink sends `{ interviewId: null }`; relink sends the newly selected interview ID. After unlink or
relink, close recording detail because the item no longer belongs to the currently displayed
interview, then invalidate the old interview summary key, the new interview summary key when any,
`['interview-recordings-unmatched']`, and `['interview-recording', recordingId]`. Restore focus to a
remaining recording **«Відкрити»** button or to the **«Записи»** heading when the row disappears.

Non-ADMIN interview viewers never see these controls. Their ability to open the recording follows
the interview RBAC exactly; do not invent recording-specific roles.

## 7. Responsive behavior

| Width     | Required behavior                                                                                                                                                                                                                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 320-639   | Admin cards and unmatched rows are single-column; connection secondary actions live in the overflow menu; primary actions become full-width where needed; webhook/meeting URLs use `break-all`/`break-words`; `InterviewDetailSheet` remains full-width; recording dialog keeps ~8 px viewport breathing room; transcript uses the two-column mobile row. |
| 640-767   | Existing `sm:max-w-lg` interview sheet applies; admin metadata may remain stacked.                                                                                                                                                                                                                                                                        |
| 768-1023  | Connection metadata can use a 2-column grid; unmatched rows use the defined two-line grid; recording transcript may use a separate speaker column.                                                                                                                                                                                                        |
| 1024-1440 | Unmatched rows may use one dense multi-column line; keep `max-w-3xl`-class readable widths for connections/detail text and do not stretch transcript paragraphs across the whole viewport.                                                                                                                                                                |

The existing admin `AnimatedTabs` overflow wrapper remains horizontally scrollable; adding the
new tab must not create a second navigation row.

## 8. Accessibility

- All interactive targets are at least 24x24 CSS px; existing `Button size="sm"` already exceeds
  this. Icon-only Copy uses an explicit `aria-label`.
- Every input has a visible `Label`; validation errors are text, associated with the field and not
  color-only.
- Dialogs have `DialogTitle` + `DialogDescription`, trap focus, close with Escape unless an
  explicit destructive confirmation is active, and restore focus to the trigger on close.
- When a successful mutation removes its own trigger (link/unlink/relink), focus recovery follows
  the explicit next/previous/section-heading rules in §§4.2 and 6.5 instead of default Radix restore.
- Statuses always contain visible text; do not encode connected/pending/error by color alone.
- Keyboard order follows visual order. Link selection, retry, copy, enable/disable and recording
  open actions are reachable without pointer input.
- Visible focus uses existing `focus-visible:ring-ring` behavior. Do not remove outlines.
- Transcript/analysis sections use semantic headings; timestamps should expose a meaningful spoken
  value when the visible form is abbreviated (for example `08:14`).
- Long text reflows without horizontal page scrolling at 320 px and at 400% zoom.

## 9. Data/cache contract the UI must preserve

- `GET /api/interviews/:interviewId/recordings` supplies summary rows only.
- `GET /api/interview-recordings/:recordingId` supplies the full snapshot only after detail opens.
- Linked recordings inherit interview access; unmatched is ADMIN-only.
- Use the exact query-key prefixes `interview-recordings` and `interview-recording`; they must
  remain outside persisted browser-cache prefixes.
- Use `['interview-recordings-unmatched']` for the ADMIN inbox and keep it outside persistence too.
- Link invalidates unmatched + new interview summary + recording detail. Unlink invalidates unmatched
  - old interview summary + recording detail. Relink invalidates unmatched + old summary + new
    summary + recording detail. Do not invalidate `['interviews']` for recorder-only mutations.
- Connection APIs never return the signing secret; UI state may only know whether it is configured
  and when it changed.
- Do not add an artifact/media/playback query, button, preview or placeholder in this implementation;
  PLAN C remains outside this design gate.

## 10. Component/file handoff

Prefer the following split; names may follow local route-file conventions:

| Surface             | Suggested implementation                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Admin tab           | extend `routes/_authenticated/admin/route.tsx` with `integrations` tab only                                  |
| Connections         | new `routes/_authenticated/admin/integrations.index.tsx` + small connection card/dialog components           |
| Unmatched inbox     | new `routes/_authenticated/interviews/unmatched.tsx` + `LinkRecordingDialog`                                 |
| Interview summaries | extend `InterviewDetailSheet.tsx` with a small `RecordingSummaryList`                                        |
| Recording detail    | new `RecordingDetailDialog` using the `crm-dialog.tsx` pattern, rendered as a sibling of the interview sheet |

Reuse `AnimatedTabs`, `Card`, `Badge`, `Button`, `DropdownMenu`, `Dialog` + the existing
`CrmDialogContent`/header/body/footer helpers, `AlertDialog`, `Input`, `Label`, `Skeleton`, `Alert`
and the existing `Sheet`. No new primitive, token or animation is needed.

## 11. Acceptance checklist

- ADMIN can create/configure/enable/disable/rename/reset a Meeting Recorder connection without ever
  seeing a stored secret.
- ADMIN can open the unmatched inbox, see possible-match hints when a typed server hint exists, and
  explicitly link a recording regardless of hint availability.
- A linked recording appears in the existing interview sheet without changing human notes.
- Recording detail clearly distinguishes transcript, recorder note, time-coded notations and
  analysis.
- Pending/omitted content is represented honestly.
- Full snapshots are fetched only for recording detail and are not persisted via the interviews
  cache.
- Closing recording detail releases the full snapshot from the in-memory query cache; switching IDs
  never shows the previous recording as placeholder content.
- ADMIN-only unmatched access is enforced by the route/API, not only by hiding its board action.
- Possible-match UI never derives private hints client-side; it consumes a typed server hint only
  after the shared contract defines one.
- No artifact/media/playback UI from PLAN C appears in V1.
- 320/768/1024/1440 layouts have no clipped controls or horizontal page overflow.
- Keyboard/focus/status behavior satisfies WCAG 2.2 AA requirements above.
