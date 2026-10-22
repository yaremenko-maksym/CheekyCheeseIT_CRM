# vacancy-queue — design spec («Черга зовнішніх вакансій», r5 Task 0.1, Tier 1)

**Status:** Tier 1 artifact, **degraded**: no Claude Design session was driven (it is browser-only and unavailable
to a headless agent). The visual reference `assets/vacancy-queue/design.html` is hand-authored from the `.dark`
custom properties of `apps/web/app/styles/globals.css`, rendered with Playwright. It is a **visual reference, not
code to paste** — build with our components and tokens per this spec. Recommend re-running Claude Design against
the synced `CheekyCheeseIT CRM` system when a session is available (`fidelity: degraded` in the PR).
**Source of requirements:** `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md` Task 0.1 (the plan wins
where it differs from the dispatch message) + the owner addendum of 2026-10-18 (infinite scroll; per-senior
submission; no cross-team signal) + the copy review of PR #1031 + the owner's request to see the filters.
Reference for tone: `docs/design/job-sourcing-suggestion.md`.
**Audience of the screen:** HR and ADMIN only. Dark theme only (one theme in the CRM — `design-gate.md`).
**Skills used:** `claude-design-workflow`, `design-system`, `accessibility`, `frontend-design-direction`, `copywriting`.

## 0. Open dependencies (read first)

| #   | Pending item                                                                                                                                                                                                                                                                                                                                                                                                           | Owner / who confirms | Effect on this spec                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Per-senior submission model.** A _submission_ is a per-senior fact on one vacancy; several of the actor's own seniors may be submitted independently. There is **no global "taken" state**. Needs the schema change (global `UNIQUE(opportunity_id)` on assignments is incompatible).                                                                                                                                | Owner, via Master    | The whole card (§5) and the «Подані» tab (§4.2) are designed to this model. If the owner picks another model the card's working surface and footer change; the list, tokens and states stand.                                                                                                                                                                                                                                 |
| D2  | **Scope of the row's match count.** Studio-wide total vs actor's-team-scoped. A match count is not knowledge of where another team applies, but it tells team A that other teams have candidates.                                                                                                                                                                                                                      | Owner / Master       | **Settled at the copy level for HR:** the string is team-scoped («{n} сеньйор **вашої команди** має збіг стеку»), so a scoped number needs no decision about revealing other teams. ADMIN in studio scope uses the unscoped variant. The layout is unchanged either way: one number in one slot (`data-slot="matched-count"`). Pending only if the owner wants HR to see a studio-wide figure — this spec recommends against. |
| D3  | Whether HR may see that a senior was excluded by their own stop-list (count only vs nothing), and whether HR may submit for a stop-listed senior (spec: no).                                                                                                                                                                                                                                                           | Owner / Master       | §5.4 shows a **count only**, no names. Remove the block if the answer is "nothing". **Exception decided by the owner (2026-10-18):** the per-senior filter (§4.1a) hides vacancies whose company the chosen senior stop-listed — see §3 "Intended inference".                                                                                                                                                                 |
| D4  | Can a submission be cancelled, and by whom. Spec assumes ADMIN-only «Скасувати подачу…» in a per-senior menu; the plan's ADMIN _reassign_ loses its meaning under D1 and is **dropped** from this spec.                                                                                                                                                                                                                | Master / owner       | §5.6.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D5  | Can HR submit a senior to a **triage** item. Spec: yes, same as any item (triage is a classification, not a lock).                                                                                                                                                                                                                                                                                                     | Master               | §5.5.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D6  | **Decided (owner, 2026-10-18): «Записати подачу» only records.** The CRM sends nothing; HR still sends the résumé. The label says what the button does, and a persistent line above the senior list — «Спершу подайте на сайті джерела («Відкрити оригінал»), потім запишіть подачу тут.» — sits where the click happens (not in a tooltip), because the failure mode is logging instead of applying.                  | Owner (answered)     | Applied in §5.3 and §6. If the CRM ever sends something, the label and the line change. The tab stays «Подані».                                                                                                                                                                                                                                                                                                               |
| D7  | **Decided (owner, 2026-10-18): two filters removed, one promoted.** The engagement-form and salary filters are **removed** (the funnel already enforces remote and the $3500 floor, so they are redundant) — but the **engagement form and the «salary not listed» flag stay visible on the card** (the owner accepted B2B on that condition). The per-senior filter is **promoted** from proposal to a normal filter. | Owner (answered)     | §4.1a, §5.1.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D8  | The uncertainty mark on a matched senior («Збіг неточний» / "Match is approximate") is assumed to mean **match confidence**, not availability.                                                                                                                                                                                                                                                                         | Master               | If it means availability, the label becomes «Доступність неточна» / "Availability uncertain" (§5.2).                                                                                                                                                                                                                                                                                                                          |

Assumptions made on the record (A1, reversible, one PR): `?card=<id>` search param so Back closes the card; filters and
search live in URL search params; undo toast 8 s; per-senior submit button is the _default_ Button variant (one per senior
row), the footer carries **no** primary; tab counts are the authorized totals and are **not** narrowed by filters.

## 1. Conflicts with the plan / inherited text (the plan wins; reported)

| Plan / brief text                                                                                                                         | What this spec does                                                                                                                                                                                        | Why                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Task 0.1 ««вже взято» state with the name masked outside the actor's scope»; Task 7.3 «взято <name> <when>»; one primary «Взяти в роботу» | **Removed.** No global taken state; primary action is «Записати подачу» per senior                                                                                                                         | Addendum §2 (owner): teams must not see each other's activity           |
| Task 0.1 «Завантажити ще» load-more button; Task 7.2 «Завантажити ще» by `nextCursor`                                                     | **Infinite scroll** with a visible quiet «Показати ще» button as the keyboard/AT path                                                                                                                      | Addendum §1                                                             |
| Task 0.1 «matched seniors — names only inside the actor's team scope»                                                                     | Kept; plus per-senior state and actions                                                                                                                                                                    | —                                                                       |
| Task 0.1 ADMIN «release/reassign/suppress»                                                                                                | release → per-senior «Скасувати подачу…»; reassign dropped; suppress kept (vacancy level)                                                                                                                  | D1, D4                                                                  |
| Task 0.1 ADMIN source block `enabled` switch + «вимкнено: <reason>»                                                                       | Disabled / paused / readiness-blocked are **three distinct states** (§7)                                                                                                                                   | Plan "Inherited-text conflicts" table                                   |
| Task 7.2 badge «не вдалося визначити стек»                                                                                                | Triage items are labelled **«Потребує розгляду»**, distinct from leads                                                                                                                                     | Plan "Inherited-text conflicts" table; copy review                      |
| Plan Tasks 0.1 / 7.2 tab «У роботі»                                                                                                       | Tab is **«Подані» / "Submitted"**: it is about _our_ submissions, not a vacancy state                                                                                                                      | Copy review COPY-M-3. **The plan text is for the coordinator to amend** |
| Screen name «Черга вакансій»                                                                                                              | **«Черга зовнішніх вакансій» / "External vacancy queue"** in the nav and the `h1`, because the CRM already has «Вакансії» for the studio's own postings                                                    | Copy review COPY-M-7                                                    |
| Brief: frames **320/768/1024/1440 × default/empty/loading/error**                                                                         | Present for the list. The card and ADMIN block are shown at 320 (full-screen), 768 and 1440 (dialog) because the dialog is a single 672 px column from 640 up; 1024 is identical to 768 for the card (§10) | Dialog width is capped, so extra card frames add nothing                |

## 2. Direction (frontend-design-direction)

- **Purpose:** HR scans a ranked feed of external vacancies, decides in seconds, opens the original, and submits
  _their own_ seniors one by one.
- **Audience:** HR several times a day, ADMIN supervising and operating the sources. Scanning order: title →
  company → stack fit → how fresh → whether the team already acted.
- **Tone:** `dense / quiet / scannable`. No hero, no illustration, no decorative gradient. The only warm colour is the
  brand yellow, used for **stack matches and the one action per senior**.
- **Memorable detail:** the **working surface is the senior list**. A vacancy is not "taken"; each of the actor's
  seniors has its own state (not submitted / submitting / submitted / excluded by stop-list). Matched stack tokens
  are highlighted in the same amber on the row, the card chips and the senior's «Збіг за:» line, so the eye links
  "what the vacancy wants" to "who has it".
- **Constraints:** Tailwind v4 + shadcn/ui, `uk` default + `en`, WCAG 2.2 AA, 320–1440+, no hover-only action.

## 3. Visibility matrix (scoping is the design, not decoration)

| Fact                                                         | HR                                                                                                                     | ADMIN                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Matched seniors' **names**                                   | Only seniors of the actor's active teams                                                                               | All, grouped under a team heading (heading shown to ADMIN only)  |
| Row figure «N сеньйорів … мають збіг стеку»                  | **Team-scoped wording** («вашої команди») — D2, one slot                                                               | Studio wording (no «вашої команди»)                              |
| Companion «N подано»                                         | Own team's submissions only                                                                                            | Studio total in studio scope; per team when a team is selected   |
| A vacancy submitted **by another team**                      | **Indistinguishable from untouched.** No badge, no grey, no «вже…», no count, no name, no "in work"                    | Sees per-team groups (explicit, because ADMIN works studio-wide) |
| Submitted-by name on a senior                                | Same-team recruiters only                                                                                              | All                                                              |
| Possible-duplicate preview                                   | Only duplicates in the actor's authorized view; the «your team already submitted» line only for own team               | all                                                              |
| Stop-list exclusion                                          | Count of **own** seniors excluded (D3); never names of foreign seniors                                                 | all, per team                                                    |
| «Matches senior» filter picker                               | **Only the actor's own team's seniors**; derived server-side from the actor's scope, never from a client-supplied list | all seniors, grouped by team                                     |
| Team switcher                                                | Only when HR has **several** active teams (one validated team per request)                                             | none; a «Уся студія» scope control instead                       |
| Source block, suppress, triage assignment, cancel submission | not rendered                                                                                                           | rendered                                                         |
| Dismiss («Приховати») scope                                  | Own team (menu states it)                                                                                              | Whole studio (menu states it)                                    |

`aria-live` announcements, toasts, error messages and the 409 conflict text are bound by the same matrix: **no text
may reveal another team's activity.** A 409 on submit shows the generic «Дані змінилися. Оновіть картку й повторіть.»
(the stale state, §5.7), never who or where.

**Mechanical check (re-run when any string changes).** Whether a string leaks depends on **who sees it**, and the audience is not
in the string — so every hit is annotated with its audience (HR / ADMIN / own team) and the verdict is recorded in the PR. The
pattern covers both languages (case-insensitive) and the phrasings that _imply_ occupancy, routing or a state change, not only
the words for them. Run it over the **source of `design.html`** (the whole dictionary) **and** over the **rendered text plus
`aria-label`s of every frame**:

`вже|already|більше не|no longer|призначен|assign|лише|only|для всіх|everyone|every team|всієї студії|whole studio|зайнят|busy|колег|colleague|у роботі|in progress|взят|taken|claim|occupied|іншої команди|інших команд|other team|another team|studio-wide`

ADMIN-only strings (audience ADMIN): `studio`, `seniorsA`, `stopRowA`, `stopAllTA`, `noMatchPA`, `hideScopeA`, `suppT/suppP/suppYes/keep`,
`suppress`, `triageAdmin`, `adminMenu`, `cancelSubmission`, `cancSub*`, `teamHdr`, and every key of the source block (§7). «Зайнято» / "Busy"
is a legitimate _senior-availability_ label today and a leak if it ever lands on a vacancy.

**Intended inference (owner-decided, 2026-10-18 — not a leak).** When the picker selects senior X, vacancies whose company X has
stop-listed are not shown. This is not a separate rule: X's stop-list already removes X from that vacancy's matches, so "vacancies
for X" excludes them by construction. HR can therefore infer X's stop-list **by absence**. The owner decided this knowingly; nobody
should later treat it as a leak, and the leak check below must not flag it. It is bounded to the actor's own team's seniors.

## 4. List screen

### 4.1 Anatomy (`job-queue-page`)

1. **Header row:** `h1` «Черга зовнішніх вакансій» / "External vacancy queue" (page titles are not E2E anchors — `data-testid` is).
2. **Toolbar:** [Team switcher — multi-team HR only] · search (title/company) · «Фільтри» button (§4.1a).
3. **Applied summary** (only when filter groups are applied): «Застосовано: DOU, Djinni · Відкрита» — it lists **every group the badge counts** (muted; wraps — about three lines at 320 in the worst case with proposals applied — while the reset stays inline on the right) + «Скинути фільтри» (44 px, stays inline, `nowrap`).
4. **Status tabs** (`job-queue-tab-<status>`): «Нові» · «Подані» · «Приховані» with **authorized counts**.
5. **Notices** (when applicable, one at a time, above the list): refresh prompt · partial-source notice.
6. **ADMIN only:** collapsed «Джерела вакансій» block with a one-line health summary (§7).
7. **List** (`job-queue-list`) in API order; **no numeric rank or score is ever shown.**
8. **Foot slot** (infinite scroll, §4.4).

### 4.1a Filters (frames: `filters-*`, `design.html` board sections «Filters …»)

**Toolbar.** Below 560 px of content the button is a 44×44 icon button (`aria-label` «Фільтри»); from 560 px icon + label.
A **count badge** shows the number of filter _groups_ with a non-default selection (not options, not the text search).
When ≥1 group is applied, the **applied summary** line appears under the toolbar.

**Panel.** A modal bottom **`Sheet`** below 560 px (drag grip, header with title + 44 px close, scrollable body, sticky
footer) and a non-modal **`Popover`** anchored under the button from 560 px (max-height ≈ 80 vh, body scrolls). Both hold the
same groups and the same footer: **«Скинути вибір»** (outline) and **«Застосувати»** (primary). Escape and the close button close
without applying. Filters apply **explicitly** (one refetch) — not on every tick — so the list never jumps under the cursor.

- **Three resets, three different words, each with one effect:** **«Скинути вибір»** / "Clear selection" in the panel clears only the draft ticks
  (nothing visible changes until «Застосувати»); **«Скинути фільтри»** / "Clear filters" — in the summary line **and** in the filtered-empty state, the same
  string — clears the _applied_ filters and refetches immediately; **«Очистити пошук»** / "Clear search" clears the text only. «Скасувати» is never used for a reset.
- Applied filters and search live in URL search params (deep-linkable, survive reload).
- **Tab counts stay the authorized totals** — they are not narrowed by filters; the list below is.

**Specified fields** (control → options, uk / en):

| Group (uk / en)                      | Control            | Options                                                                                                                                                                  |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Джерело / Source                     | checkboxes (multi) | DOU · Djinni · Work.ua · LinkedIn (the enabled sources)                                                                                                                  |
| Тип збігу / Match type               | checkboxes         | Збіг за стеком / Stack match · Потребує розгляду / Needs review                                                                                                          |
| Статус на джерелі / Status at source | checkboxes         | Відкрита / Open · Невідомо / Unknown · Закрита / Closed · Прострочена / Expired                                                                                          |
| Підходить сеньйору / Matches senior  | `Select` (single)  | Усі сеньйори вашої команди / All seniors on your team (default) · the actor's own team's seniors by name. ADMIN: «Усі сеньйори» / "All seniors", options grouped by team |

«Статус на джерелі» is deliberately not called "availability": «Вільно / Зайнято» already means a _senior's_ availability. There is **no «Submissions» group**: the tabs «Нові» / «Подані» already carry that axis, and a group that can only return nothing on one of them is a trap.
No selection in a group = no restriction. **Source** lists enabled sources only (an ADMIN-disabled source has nothing to filter).

**Per-senior filter (promoted from proposal, owner-decided).** A recruiter preparing applications for one person wants that person's
vacancies. The control is a `Select` whose options are **the actor's own team's seniors only** — it is a filter, not a directory; the
options come from the actor's scope on the server, never from the client. The default reads «Усі сеньйори вашої команди» / "All
seniors on your team" (never «Усі сеньйори», which reads studio-wide); the group is «Підходить сеньйору» / "Matches senior" (not «Для
сеньйора», which reads as job seniority). Selecting X narrows the list to vacancies X matches and has not stop-listed (§3 "Intended
inference"). The applied summary prefixes the value: «Сеньйор: Олена Ковальчук» / "Senior: Olena Kovalchuk".

**Removed (owner, 2026-10-18).** The engagement-form and salary filters are gone — the funnel already enforces remote and the $3500
floor. **The field stays on the card:** §5.1 shows «Форма співпраці: B2B» / "Contract type: B2B" and, when a posting states no
salary, the flag «Зарплату не вказано» / "Salary not listed". Removing the filter does not remove the field.

**Filtered-to-nothing** (frames `filters-none-*`, `filters-none-search-*`): when search or filters are applied and the result is empty, show the
**filtered-empty state** — sliders icon (search icon for a search with no filters), headline «Нічого не знайдено», body «Змініть пошук або
фільтри.», and a button for **what is actually set**: **«Скинути фільтри»** when filter groups are applied, **«Очистити пошук»** when only a
search text is set (both when both are set). The headline makes no claim about the queue, so it is true on every tab. It differs from
the empty queue (search icon, «У черзі немає нових вакансій», no button) in icon, headline and the way out; the summary line and the badge
stay visible above it so the cause is on screen.

**Empty states per tab** (each string true where it is shown): «Нові» → «У черзі немає нових вакансій · Нові з’являться після наступного
оновлення джерел.» (shown only when nothing is applied, so it gives no filter advice); «Подані» → «Ваша команда ще нікого не подала»;
«Приховані» → «Немає прихованих вакансій». Frames `list-empty-*`, `list-empty-submitted-320`, `list-empty-hidden-320`.

### 4.2 Tabs

| Tab (uk / en)        | Meaning for this actor                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| «Нові» / New         | Not hidden for the actor's scope, and no senior of the actor's team submitted                                               |
| «Подані» / Submitted | The actor's team has ≥1 submitted senior. Says nothing about the vacancy's state and never includes another team's activity |
| «Приховані» / Hidden | Dismissed in the actor's scope (team for HR, studio for ADMIN); row offers «Повернути»                                      |

A vacancy can be in «Подані» (a senior submitted) **and** still be actionable for the team's other seniors; its card
keeps «Записати подачу» on those. Counts: `tabular-nums`; above 999 render «999+».

**Width (measured at 320 and 375, uk and en):** tabs use three equal columns with the **label over the count**
below 560 px of content; every label stays on one line. The longest labels are «Приховані» and "Submitted" (9 characters
each); from 560 px: label + count pill in a row. A tab row that wraps is a defect.

### 4.3 Row (`job-queue-row-<id>`)

The whole row is one button (≥44 px) that opens the card. No action lives only on hover; a trailing chevron
appears from 560 px.

| Slot                     | Content                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Line 1                   | [«Потребує розгляду» badge for triage] · seniority badge (omitted when unknown) · flags (§4.6) |
| Title                    | `font-semibold`, clamp 2 lines, `overflow-wrap:anywhere`; full text in the card                |
| Company                  | Source icon (20 px chip) + company, single-line truncate                                       |
| Stack chips              | Up to 4 + «+K»; matched tokens use the **hit** style (amber), the rest neutral                 |
| Meta (right column ≥720) | Publication age, `data-slot="matched-count"`, `+N також на …`                                  |

- **Publication age** uses the trusted date: «Опубліковано 2 дні тому». Unknown: «Дата публікації невідома ·
  вперше побачено 3 дні тому» with a calendar-off icon. When last-observed is notably older, add «востаннє бачили
  вчора» as a plain muted phrase. The pairs «вперше побачено», «востаннє бачили», "first seen", "last seen" and
  every "number + unit" use a **no-break space** so a wrap never splits them.
- **Matched count:** «3 сеньйори вашої команди мають збіг стеку» (plural via Lingui; uk one/few/many/other, en one/other).
  Hidden at 0. ADMIN in studio scope reads «3 сеньйори мають збіг стеку». On the «Подані» tab — the only place the actor's team has submissions; «Нові» rows never carry it — a **separate**
  clause follows on the same line, wrapping on mobile: «✓ 1 подано» / "✓ 1 submitted". Never «1 з 3».
- **`+N також на DOU, Djinni`:** from `totalAlsoSeenOnCount`; the count always shows, names truncate first.
- Triage rows replace the stack line with the reason: «Роботодавця не вдалося підтвердити» (the badge already says
  «Потребує розгляду», so the reason does not repeat it).

### 4.4 Infinite scroll (owner addendum §1) — keyset pagination unchanged

**Mechanism.** An `IntersectionObserver` sentinel (root = the list's scroll container, `rootMargin` ≈ 400 px) calls the
same "fetch next page by `nextCursor`" the button calls. The **foot slot** is one element, **≥44 px tall, in the same
place in every state**, so nothing shifts when it changes.

| State                               | Foot slot                                                                                                                                          | Live region                         | Notes                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First load                          | Three skeleton rows; tabs show no counts yet; `aria-busy="true"` on the list                                                                       | —                                   | `job-queue-list` busy                                                                                                                                           |
| Idle, more pages                    | **Quiet ghost button «Показати ще»** (muted text, full width) + «Показано 6 із 12»                                                                 | —                                   | The **keyboard / screen-reader path.** Always rendered when `nextCursor` exists, even though the sentinel normally fires first. Enter/Space loads the next page |
| Appending                           | Same slot becomes a status row «⟳ Завантажуємо ще…» (`role="status"`), two ghost skeleton rows above it                                            | «Завантажуємо ще…»                  | Rows already shown stay interactive; list `aria-busy="true"`; repeated triggers ignored (one in-flight request)                                                 |
| End of list                         | A dashed hairline + «Усі вакансії показано: 6»                                                                                                     | «Усі вакансії показано: 6» (polite) | **Not** an empty state: no icon, no illustration, no headline. The number is invariable after the colon in uk                                                   |
| Error while appending               | `note` (destructive outline, `role="alert"`) «Не вдалося завантажити ще» · «Уже завантажені вакансії залишаються на екрані.» · **«Спробувати ще»** | alert                               | The loaded rows stay exactly where they are. Retry re-requests the same cursor. The sentinel is **suspended** until retry succeeds (no retry storm)             |
| Cursor expired («refresh-required») | The **refresh prompt** (§4.5), not the append error                                                                                                | status                              | Retrying cannot succeed, so it must not offer a retry                                                                                                           |

**Focus and announcement.** After a _keyboard_-triggered append, move focus to the **first newly added row** and announce
«Завантажено ще 20. Показано 40 із 87» in the polite live region (`job-queue-live`); after a _sentinel_-triggered append,
do not move focus (it would steal it mid-scroll) and announce the same sentence. Row order and `aria-posinset`
are not used: the rows are interactive controls, so the WAI-ARIA **feed** pattern (reading-article model, custom
Page Down contract) was considered and rejected in favour of a plain list + live region + the visible button.
Reduced motion: the spinner and skeleton pulse stop (`prefers-reduced-motion`).

### 4.5 Notices above the list

| Notice                                      | Look                                                    | Behaviour                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Refresh prompt** (generation invalidated) | `note info` (amber tint, refresh icon), `role="status"` | «Список змінився» · «З’явилися оновлення.» + «Показати оновлений список». The list does **not** reload by itself    |
| **Partial source health**                   | `note dash` (dashed border, warn icon)                  | «Деякі джерела тимчасово недоступні. Список може бути неповним.» ADMIN additionally gets a link to the source block |
| **No team (HR)**                            | Empty state with users icon                             | «Вам не призначено жодної команди». This is a different cause from "empty queue"                                    |

### 4.6 Warning taxonomy — each is visibly different (a generic row would go blind within a week)

Differentiation is by **icon + text + shape**, never colour alone. Colour is only a reinforcement and uses tokens.

| Condition                                                           | Where                                                                                                                                  | Treatment                                                                                                                                                                                                                                                                  | Colour reinforcement         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Updated since the list was built**                                | Row flag; card info note                                                                                                               | Refresh icon + «Оновлено»; card: «Вакансію оновлено після побудови списку · Нижче — актуальні дані»                                                                                                                                                                        | `primary` (amber)            |
| **A newer version appeared while the card is open** (blocks submit) | Card, blocking                                                                                                                         | `note` with destructive outline + «Оновити картку»; all «Записати подачу» disabled                                                                                                                                                                                         | `destructive`                |
| **Possible duplicate**                                              | Row flag; card note                                                                                                                    | Copy icon + «Можливий дублікат»; card note «У черзі є схожа вакансія»; submit shows the per-senior confirm (§5.8)                                                                                                                                                          | neutral `foreground`         |
| **Unknown publication date**                                        | Row/card meta                                                                                                                          | Calendar-off icon + text; no tint                                                                                                                                                                                                                                          | `muted-foreground`           |
| **Zero matches**                                                    | Row: line hidden; card: empty block «Немає сеньйорів зі збігом стеку» with users icon                                                  | Plain empty, not a warning                                                                                                                                                                                                                                                 | none                         |
| **All matching seniors stop-listed the company**                    | Row: «⊘ Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листа»; card: empty block with **ban icon** and the same headline | **Must not read as "no matches"**: different icon, a headline that names the stop-list and who did it, body «Стек збігається, проте вакансію їм не пропонують.» ADMIN (studio scope) reads the same without «вашої команди»                                                | none                         |
| **Some matching seniors stop-listed the company**                   | Card, under the senior list                                                                                                            | ban icon + «Виключено за стоп-листом: 1» + one explanatory sentence; count only (D3)                                                                                                                                                                                       | none                         |
| **Triage item**                                                     | Row badge + reason line; card dashed note                                                                                              | **Dashed-outline badge «Потребує розгляду»** with help icon (shape = "unresolved"), reason «Роботодавця не вдалося підтвердити», card dashed `note` «Сеньйорів не підібрано автоматично» (no word about teams: HR must not read anything suggesting routing between teams) | `yellow-muted` dashed border |
| **Closed / expired at source**                                      | Card header status + blocking note                                                                                                     | «Закрита» status chip (destructive outline, warn icon); «Записати подачу» disabled on every senior                                                                                                                                                                         | `destructive`                |
| **Source degraded** (partial)                                       | List notice                                                                                                                            | §4.5                                                                                                                                                                                                                                                                       | dashed neutral               |

## 5. Card (`Dialog`, labelled by its `h2`; full-screen below 640 px)

### 5.1 Layout, top to bottom

1. **Header:** badges (triage, seniority, closed) · title (**wraps fully, no clamp**, `overflow-wrap:anywhere`) · company
   (wraps) · meta (published / unknown date, last seen) · **terms line: «Форма співпраці: B2B» / "Contract type: B2B" (Трудовий
   договір / Employment contract / Не вказано / Not stated) and, when no salary is stated, the flag «Зарплату не вказано» /
   "Salary not listed"** (`job-queue-terms`; owner: the engagement form must stay visible) · close button (44×44, `aria-label` «Закрити»).
2. **Notices** relevant to this vacancy (§4.6).
3. **Matching seniors — the working surface (§5.2–5.5).** It comes **before** the description because it is the
   decision surface; the description is reference.
4. **Опис** — markdown via the extracted `PostingMarkdown` (untrusted; no raw HTML, no remote images/autolinks).
5. **Також опубліковано на:** — source rows with `openOriginalPosting`, totals and continuation («Показано 3 із 34 ·
   Показати ще (20)»).
6. **Збіг стеку** — vacancy stack chips, hit style on matched ones.
7. **Sticky footer (vacancy-level actions only):** «Відкрити оригінал» · «Приховати» (reason menu) · [ADMIN «⋯»]. **No
   primary button** here: a vacancy is never "occupied"; the primary action is per senior.

### 5.2 One block per own senior (`job-queue-senior-<id>`)

Avatar (initials, `avatar-text` on `yellow-subtle`) · name · availability · optional uncertainty · «Збіг за:» chips (the
matched tokens) · «Чому збіг» disclosure (evidence; `aria-expanded`, ≥44 px target) · action area.

- **Availability** is text + a dot shape, not colour, and is **gender-neutral**: filled dot «Вільно з 1 лис.», hollow dot «Зайнято»
  (the senior may be of either gender, so no «Вільний/Вільна»).
- **Uncertainty:** info icon + «Збіг неточний» (never a colour-only mark). Assumed to mean match confidence (D8).
- **Attribution:** «Збіг за:» names the signals that produced the match.

### 5.3 Per-senior states (independent; any order; several seniors may be submitted)

| State                         | Action area                                                                                                                                      | Details                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Not submitted                 | **«Записати подачу»** (en "Log submission") — default Button, ≥44 px on mobile (full width of the block), `aria-label="Записати подачу: <ім'я>"` | One per senior; the only yellow fill in the card. It **records** that the recruiter submitted; the CRM sends nothing (D6) |
| Submitting                    | Disabled «⟳ Записуємо…» / "Saving…", `aria-busy`                                                                                                 | Repeated activation ignored                                                                                               |
| Submitted                     | Check icon + «Подано · 2 год тому» + submitter name (same-team recruiters only); no button                                                       | ADMIN also gets a per-senior «⋯» → «Скасувати подачу…» (D4)                                                               |
| Excluded by own stop-list     | **Not listed**; counted in §5.4                                                                                                                  | The senior "disappears" from the list, so the explanation must live elsewhere                                             |
| Blocked (stale / closed card) | «Записати подачу» disabled (`aria-disabled`), reason is in the blocking note above; the apply-first line is hidden                               | Disabled controls keep their layout                                                                                       |
| Success / failure             | Toast «Подачу записано: <ім'я>» / «Не вдалося записати подачу. Спробуйте ще раз.»                                                                | Frame `dialogs-*`                                                                                                         |

A conflict (409 from a concurrent change) re-fetches the card and shows the stale note (§5.7). It never says who or where.

**Apply-first reminder (COPY-H-6).** Directly under the «Сеньйори зі збігом» heading, above the first senior, a **persistent** `note` (no
dismiss, not a tooltip, hidden only when every button is disabled): «Спершу подайте на сайті джерела («Відкрити оригінал»), потім
запишіть подачу тут.» / "Apply at the source first (Open original), then log the submission here." The failure it prevents is a
recruiter clicking the button _instead of_ applying: the senior would be recorded as submitted without ever having been, which
suppresses every follow-up and shows teammates "Submitted". `data-testid="job-queue-apply-first"`.

### 5.4 Stop-list display (company stop-lists are per senior, never global)

- Partial: under the list, a quiet `note` (muted, no tint): ban icon · **«Виключено за стоп-листом: 1»** · «Ці сеньйори
  внесли компанію до власного стоп-листа, тому вакансія їм не пропонується.» Count only (D3). The number is invariable
  after the colon in uk, which avoids a genitive-plural table.
- All: the whole block becomes an empty state with the **ban** icon and the headline **«Усі сеньйори вашої команди зі збігом
  внесли компанію до стоп-листа»** (ADMIN, studio scope: «Усі сеньйори зі збігом …», key `stopAllTA`) + «Стек збігається, проте вакансію їм не
  пропонують.» The row uses the **same scoped sentence** (`stopRow` / ADMIN `stopRowA`). The subject of the sentence is the
  seniors, the object is the company — in both languages.
- The vacancy stays fully visible and actionable for every other senior and team; the stop-list never hides it.

### 5.5 Triage and zero-match cards

Triage: dashed note + the senior block shows the empty state with the triage reason (no names, because the classifier
placed nobody). Zero matches: plain empty state «Немає сеньйорів зі збігом стеку» + «Вакансія лишається в черзі, але
жоден сеньйор із вашої команди не збігається за стеком.» The two empties differ in **icon and headline** (users vs ban).

### 5.6 ADMIN

- Studio scope: the senior block is grouped under **team headings** («Команда «Альфа»») — rendered for ADMIN only.
- Vacancy-level «⋯» (footer): **«Приховати для всіх…»** (suppress; `AlertDialog`, bounded reason) and, for
  triage items, **«Призначити команді…»**. Menu header states the scope («Буде приховано для всієї студії»).
- Per-senior «⋯» on a submitted senior: **«Скасувати подачу…»** (`AlertDialog`). Reassign is dropped (D4). This is the **only**
  place the verb «Скасувати подачу» appears; «Скасувати» alone means _undo the hide_ and nothing else.
- Conflict (expected version mismatch): inline destructive note «Дані змінилися. Оновіть картку й повторіть.» (one text, used everywhere).
- Dialogs (frame `dialogs-*`): suppress «Приховати для всієї студії?» + «Вакансія зникне з черги для всіх команд.» (confirm «Приховати
  для всіх», safe «Не приховувати»); cancel submission «Скасувати подачу?» + «Подачу «{who}» буде скасовано. Подати можна буде
  знову.» (confirm «Скасувати подачу», safe «Залишити»). The safe button is the initial focus; the destructive one is outline/destructive.

### 5.7 Card freshness states

| State                                        | Treatment                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opened from a list built earlier, data newer | **Informational** amber note «Вакансію оновлено після побудови списку»; actions stay enabled                                                                |
| A newer revision arrives while open          | **Blocking** destructive note + «Оновити картку»; every «Записати подачу» disabled until refreshed (an old card can never submit)                           |
| Policy/authorization change closes access    | Card closes, list refetches, toast «Цю вакансію не знайдено» (identical for 403 and 404, so it never says whether access changed); no stale names are shown |

### 5.8 Possible duplicate and the per-senior confirm

The duplicate note says «У черзі є схожа вакансія» and lists a bounded preview; the line **«На схожу вакансію вже подано: <назва> ·
<senior>»** (team-neutral wording, so it reads correctly for ADMIN too) appears only when **own team** submitted there. Duplicates in other
teams are not mentioned. When the actor presses «Записати подачу» for a senior who was already submitted to a similar vacancy by the own
team (`confirmPossibleDuplicate` required, or the 409 `POSSIBLE_DUPLICATE_CLAIMED`), the **senior's block expands inline** (the
«Записати подачу» button is replaced) — no second dialog: «Цього сеньйора вже подано на схожу вакансію · Ви впевнені, що це інша
вакансія?» with **«Не записувати» as the primary/initial-focus (safe) button** and **«Так, записати все одно»** as the outline button.
The word «Скасувати» is not used here, so the default focus cannot be read as cancelling the earlier submission.

### 5.9 Hide («Приховати»)

Menu (Radix `DropdownMenu`, keyboard accessible) with a scope line first, then **Нерелевантна / Спам / Мертве
посилання**. Success: toast «Приховано · Скасувати» (8 s, undo scoped and versioned). In «Приховані» the row carries
a visible «Повернути» button (no hover-only undo).

## 6. i18n — both languages for every string (Lingui macros, source `uk`; `en` written anew, not translated)

Length rule: measure the longer language at 320 px; Ukrainian is ≈15–30 % longer. The English labels below are
**proposals for `copy-reviewer`**. Every message with a number is an ICU `plural` with the forms the language needs (uk:
`one`, `few`, `many`, `other`; en: `one`, `other`). Invariable-after-colon forms («Виключено за стоп-листом: {n}», «{n} подано»,
«Усі вакансії показано: {n}») are deliberate. Hide a sentence that would read «…: 0».

| Key                                | uk (source)                                                                                                                                                                                                                                                                | en                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| title (nav + `h1`)                 | Черга зовнішніх вакансій                                                                                                                                                                                                                                                   | External vacancy queue                                                                                                                                                                                                                       |
| tabs                               | Нові · Подані · Приховані                                                                                                                                                                                                                                                  | New · Submitted · Hidden                                                                                                                                                                                                                     |
| search                             | Назва або компанія                                                                                                                                                                                                                                                         | Title or company                                                                                                                                                                                                                             |
| studio scope                       | Уся студія                                                                                                                                                                                                                                                                 | Whole studio                                                                                                                                                                                                                                 |
| row: seniors (HR)                  | `{n, plural, one {# сеньйор вашої команди має збіг стеку} few {# сеньйори вашої команди мають збіг стеку} many {# сеньйорів вашої команди мають збіг стеку} other {# сеньйора вашої команди мають збіг стеку}}`                                                            | `{n, plural, one {# senior on your team matches the stack} other {# seniors on your team match the stack}}`                                                                                                                                  |
| row: seniors (ADMIN, studio)       | `{n, plural, one {# сеньйор має збіг стеку} few {# сеньйори мають збіг стеку} many {# сеньйорів мають збіг стеку} other {# сеньйора мають збіг стеку}}`                                                                                                                    | `{n, plural, one {# senior matches the stack} other {# seniors match the stack}}`                                                                                                                                                            |
| row: companion                     | {n} подано                                                                                                                                                                                                                                                                 | {n} submitted                                                                                                                                                                                                                                |
| row: also on                       | +{n} також на {list}                                                                                                                                                                                                                                                       | +{n} also on {list}                                                                                                                                                                                                                          |
| posted / unknown (no-break spaces) | Опубліковано {ago} · Дата публікації невідома · вперше побачено {ago} · востаннє бачили {ago}                                                                                                                                                                              | Posted {ago} · Publication date unknown · first seen {ago} · last seen {ago}                                                                                                                                                                 |
| triage                             | Потребує розгляду · Роботодавця не вдалося підтвердити · Сеньйорів не підібрано автоматично                                                                                                                                                                                | Needs review · Employer could not be verified · No seniors matched automatically                                                                                                                                                             |
| flags                              | Оновлено · Можливий дублікат                                                                                                                                                                                                                                               | Updated · Possible duplicate                                                                                                                                                                                                                 |
| submit                             | Записати подачу · Записуємо… · Подано · {when} · Подано: {who} · {when}                                                                                                                                                                                                    | Log submission · Saving… · Submitted · {when} · Submitted by {who} · {when}                                                                                                                                                                  |
| submit aria                        | Записати подачу: {who}                                                                                                                                                                                                                                                     | Log submission: {who}                                                                                                                                                                                                                        |
| submit toast / failure             | Подачу записано: {who} · Не вдалося записати подачу. Спробуйте ще раз.                                                                                                                                                                                                     | Submission logged: {who} · Could not log the submission. Please try again.                                                                                                                                                                   |
| apply-first reminder               | Спершу подайте на сайті джерела («Відкрити оригінал»), потім запишіть подачу тут.                                                                                                                                                                                          | Apply at the source first (Open original), then log the submission here.                                                                                                                                                                     |
| card terms                         | Форма співпраці · Трудовий договір · B2B · Не вказано · Зарплату не вказано                                                                                                                                                                                                | Contract type · Employment contract · B2B · Not stated · Salary not listed                                                                                                                                                                   |
| availability / uncertainty         | Вільно з {d} · Зайнято · Збіг неточний                                                                                                                                                                                                                                     | Free from {d} · Busy · Match is approximate                                                                                                                                                                                                  |
| stop-list                          | Виключено за стоп-листом: {n} · Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листа (ADMIN: без «вашої команди»)                                                                                                                                            | Excluded by stop-list: {n} · Every matching senior on your team has stop-listed this company (ADMIN: without "on your team")                                                                                                                 |
| duplicate                          | У черзі є схожа вакансія · На схожу вакансію вже подано: {t} · Цього сеньйора вже подано на схожу вакансію · Не записувати · Так, записати все одно                                                                                                                        | There is a similar vacancy in the queue · Already submitted to a similar vacancy: {t} · This senior is already submitted to a similar vacancy · Don't log it · Yes, log it anyway                                                            |
| footer                             | Відкрити оригінал · Приховати · Також опубліковано на:                                                                                                                                                                                                                     | Open original · Hide · Also listed on:                                                                                                                                                                                                       |
| hide reasons                       | Нерелевантна · Спам · Мертве посилання                                                                                                                                                                                                                                     | Not relevant · Spam · Dead link                                                                                                                                                                                                              |
| hide scope                         | Буде приховано для вашої команди / для всієї студії                                                                                                                                                                                                                        | Will be hidden for your team / for the whole studio                                                                                                                                                                                          |
| undo / restore                     | Приховано · Скасувати · Повернути                                                                                                                                                                                                                                          | Hidden · Undo · Restore                                                                                                                                                                                                                      |
| infinite scroll                    | Показати ще · Завантажуємо ще… · Усі вакансії показано: {n} · Не вдалося завантажити ще · Уже завантажені вакансії залишаються на екрані. · Спробувати ще                                                                                                                  | Show more · Loading more… · All vacancies shown: {n} · Could not load more · Vacancies already loaded are still shown. · Try again                                                                                                           |
| live region                        | Завантажено ще {n}. Показано {a} із {b}                                                                                                                                                                                                                                    | {n} more loaded. Showing {a} of {b}                                                                                                                                                                                                          |
| shown                              | Показано {a} із {b}                                                                                                                                                                                                                                                        | Showing {a} of {b}                                                                                                                                                                                                                           |
| empty («Нові»)                     | У черзі немає нових вакансій · Нові з’являться після наступного оновлення джерел.                                                                                                                                                                                          | No new vacancies in the queue · New ones appear after the next source refresh.                                                                                                                                                               |
| empty (other tabs)                 | Ваша команда ще нікого не подала · Тут з’являться вакансії, на які подано сеньйорів вашої команди. · Немає прихованих вакансій · Приховані вакансії можна повернути звідси.                                                                                                | Your team has not submitted anyone yet · Vacancies with submitted seniors from your team will appear here. · No hidden vacancies · Hidden vacancies can be restored from here.                                                               |
| no team                            | Вам не призначено жодної команди                                                                                                                                                                                                                                           | You are not assigned to any team                                                                                                                                                                                                             |
| error                              | Не вдалося завантажити чергу · Спробуйте ще раз.                                                                                                                                                                                                                           | Could not load the queue · Please try again.                                                                                                                                                                                                 |
| refresh                            | Список змінився · З’явилися оновлення. · Показати оновлений список                                                                                                                                                                                                         | The list has changed · Updates are available. · Show updated list                                                                                                                                                                            |
| stale / conflict / not found       | З’явилася новіша версія вакансії · Ця картка застаріла, тому записати подачу з неї не можна. · Оновити картку · Дані змінилися. Оновіть картку й повторіть. · Цю вакансію не знайдено                                                                                      | A newer version of the vacancy is available · This card is out of date, so you cannot log a submission from it. · Refresh card · The data has changed. Refresh the card and try again. · This vacancy was not found                          |
| closed                             | Вакансію закрито на джерелі · Нові подачі неможливі. Раніше подано: {n}. (hidden at 0)                                                                                                                                                                                     | The vacancy is closed at the source · New submissions are not possible. Previously submitted: {n}. (hidden at 0)                                                                                                                             |
| admin menus                        | Приховати для всіх… · Призначити команді… · Скасувати подачу… · Дії адміністратора                                                                                                                                                                                         | Hide for everyone… · Assign to a team… · Cancel submission… · Administrator actions                                                                                                                                                          |
| admin dialogs                      | Приховати для всієї студії? · Вакансія зникне з черги для всіх команд. · Приховати для всіх · Не приховувати · Скасувати подачу? · Подачу «{who}» буде скасовано. Записати її можна буде знову. · Скасувати подачу · Залишити                                              | Hide for the whole studio? · The vacancy will disappear from every team’s queue. · Hide for everyone · Keep · Cancel this submission? · The submission for “{who}” will be cancelled. You can log it again later. · Cancel submission · Keep |
| sources summary                    | `{src} · {a} призупинено · {b} заблоковано` with `{src}` = `{n, plural, one {# джерело} few {# джерела} many {# джерел} other {# джерела}}`                                                                                                                                | `{src} · {a} paused · {b} blocked` with `{src}` = `{n, plural, one {# source} other {# sources}}`                                                                                                                                            |
| filters (specified)                | Фільтри · Скинути вибір · Застосувати · Застосовано: · Джерело · Тип збігу · Збіг за стеком · Потребує розгляду · Статус на джерелі · Відкрита · Невідомо · Закрита · Прострочена · Підходить сеньйору · Усі сеньйори вашої команди (ADMIN: Усі сеньйори) · Сеньйор: {who} | Filters · Clear selection · Apply · Applied: · Source · Match type · Stack match · Needs review · Status at source · Open · Unknown · Closed · Expired · Matches senior · All seniors on your team (ADMIN: All seniors) · Senior: {who}      |
| filtered-empty                     | Нічого не знайдено · Змініть пошук або фільтри. · Скинути фільтри · Очистити пошук                                                                                                                                                                                         | Nothing found · Change the search or filters. · Clear filters · Clear search                                                                                                                                                                 |
| sources                            | see §7 and the HTML dictionary (`design.html`, `D.uk` / `D.en`)                                                                                                                                                                                                            | —                                                                                                                                                                                                                                            |

The full dictionary with plurals is the `D` object in `design.html`; it is the source for `messages.po`, and **every key
renders in at least one frame** (the dialogs, toasts and error texts in `dialogs-*`). Internal keys use the same
vocabulary as the screen (`closedBlocked`, `cancelSubmission`, `dontSubmit` — not "claimed", "taken", "release").

**Terms and the glossary.** The screen's two core terms, **submission** («подача», «записати подачу») and **stop-list** («стоп-лист»), are
**not yet in `CONTEXT.md`**; entries (with `_Avoid_`: «відправка», «відгук», «чорний список») are for the coordinator to add — this
spec uses them as the proposed canonical forms. The screen name carries «зовнішні вакансії» (the glossary's **Job opportunity**
term); inside the screen plain «вакансія» is used, which the glossary allows where context is unambiguous. Avoided: «парсер»,
«пост», «объявление», «кандидат».

## 7. ADMIN source block (Design Tier 2 — extends `SourceBudgetPanel`)

Placed on the queue page for ADMIN as a **collapsed** section «Джерела вакансій» with a one-line health summary
(«4 джерела · 1 призупинено · 1 заблоковано» — the count uses the plural form for its number: 1 джерело, 2 джерела, 5 джерел,
21 джерело; verified for 0, 1, 2, 5, 11, 21, 22 in uk and 1, 2, 5, 21 in en); the existing placement inside
`JobSuggestionDialog` stays. Each source:

- **Name + source icon + `Switch`** (`role="switch"`, 44×44 hit area, `aria-label` = source name).
- **State chip — three separate states**, never one «вимкнено»:

| State                                   | Chip                                          | Explanation line                                             |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Running                                 | outlined, check icon, «Працює»                | —                                                            |
| **Disabled** (admin switched off)       | `secondary` fill, power icon, «Вимкнено»      | «Вимкнено адміністратором» (plain, muted)                    |
| **Paused** (cooldown / 429 / challenge) | amber tint, pause icon, «Призупинено»         | «Пауза до 14:30: джерело просило зачекати (429)» (info note) |
| **Readiness-blocked** (policy / auth)   | destructive outline, lock icon, «Заблоковано» | «Не готове: сплив термін авторизації» (destructive note)     |

- **Unit and quota:** «Ліміт: 232 / 500 запитів» + a **three-segment bar** — used (`primary`), reserved (`yellow-muted`, 60 %),
  uncertain (**hatched** `muted-foreground`) — with a legend carrying the numbers (`tabular-nums`). The hatch means
  the bar is not colour-only; the bar has `role="img"` and an `aria-label` with all three numbers.
- **Timestamps:** «Остання спроба», «Остання вдала», «Остання з даними» (relative; «ніколи» when none), «Політика діє до»,
  «Авторизація до» — `dl`, one column on mobile, three from 560 px.
- **Enable failure:** a destructive note under the source: «Не вдалося увімкнути · Причина: … Стан не змінено.» — the
  switch returns to its previous position; no toggle clears policy or cost state.
- Non-ADMIN: block not rendered.

## 8. Token map — `apps/web/app/styles/globals.css` only (dark)

| Role          | Token                                                                               | Used for                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Page          | `--background`                                                                      | canvas                                                                                                                     |
| Surfaces      | `--card`, `--popover`, `--surface`, `--accent`, `--secondary`, `--muted`, `--input` | rows/cards, menus and filter panel, tinted notes, tab count pill, skeleton, field fill                                     |
| Text          | `--foreground`, `--muted-foreground`                                                | primary / secondary text                                                                                                   |
| Brand         | `--primary`, `--primary-foreground`                                                 | the per-senior «Записати подачу», tab underline, links, matched-stack chips (text), refresh flag, checked checkbox / radio |
| Amber tints   | `--yellow-subtle`, `--yellow-muted`, `--avatar-text`                                | matched-stack chip fill, info note fill, triage dashed border, reserved-quota segment, senior avatar                       |
| Danger        | `--destructive`                                                                     | blocked/closed/stale/error text and outlines                                                                               |
| Lines / focus | `--border`, `--ring`                                                                | dividers, outlines, focus ring                                                                                             |
| Shape         | `--radius`, `--radius-sm/md/lg/xl`                                                  | chips `md`, buttons `md`, notes `lg`, cards/list/panels `xl`                                                               |
| Type          | `--font-sans` (Inter)                                                               | all text                                                                                                                   |

**Not used:** `--tag-ai/edtech/ecommerce` (decorative domain dots); the Tailwind palette classes in `Badge`'s role/status
variants (`green-400`, `purple-400` …) — they are not `globals.css` tokens, so this screen builds its chips from the tokens
above. No hex, no raw `oklch()`, no gradient except the hatch pattern in the quota bar (`repeating-linear-gradient` of
`--muted-foreground`). **Contrast, computed from the token values:** muted-foreground on card **4.74:1**, on background 4.85:1;
primary on yellow-subtle **10.48:1**; foreground on yellow-subtle 15.90:1; primary-foreground on primary 12.56:1;
destructive on card 5.67:1; primary on card 12.26:1; yellow-muted dashed border vs card 8.12:1.
**Finding:** `muted-foreground` on `secondary` is **4.23:1** (< 4.5) — never put muted text on `secondary`; the «Вимкнено» chip
therefore uses `foreground`, and the quiet «Показати ще» hover state must switch to `foreground`.
**Inherited, not introduced here:** a 1px `--border` against `--card` is 1.17:1, so input/outline-button _boundaries_
fall short of SC 1.4.11 as everywhere in the CRM; every control on this screen is identified by its text/icon and has a
12:1 focus ring. Checkbox/radio outlines use `--muted-foreground` (4.74:1), so those two controls _do_ meet 1.4.11.
Raise the border item as a separate foundation item rather than patching it on one screen.

## 9. Components

**Existing (reuse as-is):** `Button` (default / outline / ghost; sizes `default` and `lg` for the 44 px mobile target),
`Badge` (outline / secondary), `Card`, `Dialog` + `CrmDialogContent/Header/Body/Footer` (card; `h-dvh` full-screen
below `sm`), `Sheet` (filters, <560), `Popover` (filters, ≥560), `RadioGroup` (submissions, salary), `Select` (team switcher,
«Matches senior» picker), `Input`, `DropdownMenu` (hide + admin menus), `AlertDialog` (suppress, cancel submission), `Switch`, `Skeleton`,
`Alert`, `Avatar`, `ScrollArea`, `Command` (assign-to-team picker), `Tabs` (Radix), `Tooltip` (supplementary only — nothing
essential lives in a tooltip), `sonner` toast, `StickyPageHeader`/`PageHeader`. Existing non-`ui`: `SourceBudgetPanel` (extended),
`PostingMarkdown` (extracted from `JobSuggestionDialog`), `openOriginalPosting`.

**New (named in the plan; composed from the above, not new primitives, except where marked):**

| Component                            | Why existing does not fit                                                                              | API sketch                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **`Checkbox` (new primitive)**       | `apps/web/app/components/ui` has no checkbox (only `radio-group`); the filter panel needs multi-select | Radix `Checkbox`, shadcn pattern, tokens in §8; 44 px row hit area                                             |
| `JobQueueFilters`                    | one body rendered in `Sheet` (<560) and `Popover` (≥560) with Apply/Clear selection                    | `{ value, onApply, onClear, sources, teamSeniors }` — `teamSeniors` comes from the actor's scope on the server |
| `JobQueueStatusTabs`                 | `AnimatedTabs` has no count slot and no stacked-label layout                                           | `{ value, counts: Record<Status,number\|null>, onChange }` over Radix `Tabs`                                   |
| `JobQueueRow` / `JobQueueList`       | list semantics + the foot slot                                                                         | `{ item, onOpen }`; list owns sentinel + foot slot                                                             |
| `JobQueueFoot`                       | one slot for idle/appending/end/error                                                                  | `{ state, shown, total, onLoadMore, onRetry }` (renders the live region)                                       |
| `JobQueueCard`                       | dialog composition                                                                                     | `{ opportunityId, teamId }`                                                                                    |
| `MatchedSeniors` + `SeniorSubmitRow` | per-senior state machine                                                                               | `{ seniors, onSubmit, state }`; row state `todo \| submitting \| submitted \| blocked`                         |
| `StopListNotice`                     | ban-icon explanatory note / all-excluded empty                                                         | `{ excludedCount, allExcluded }`                                                                               |
| `AlsoSeenOn`, `PossibleDuplicates`   | bounded lists with continuation                                                                        | per plan                                                                                                       |
| `JobQueueActions`, `DismissMenu`     | footer and reason menu                                                                                 | per plan                                                                                                       |
| `TeamSwitcher`                       | one validated team per request                                                                         | `{ teams, value, onChange }`                                                                                   |
| **`QueueNotice`**                    | `Alert` lacks the `info` (amber), `dashed`, `soft` variants                                            | add **variants to `Alert`**, not a new component                                                               |
| **`StackChip`**                      | hit/neutral/more chip                                                                                  | add **variants to `Badge`** (`stack-hit`, `stack`, `stack-more`, `triage` dashed) — tokens only                |
| `QuotaBar`                           | three-segment hatched bar with legend                                                                  | `{ used, reserved, uncertain, total, unit }`; `role="img"` + `aria-label`                                      |
| `SourceStateChip`                    | three distinct states                                                                                  | `{ state: 'running'\|'disabled'\|'paused'\|'blocked' }`                                                        |

## 10. Responsive (class → what changes). Content width = viewport − sidebar 208 px (≥768) − page padding

| Class  | Viewport  | List                                                                                                                                                                                                          | Card                                                                                | Notes                                                            |
| ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Mobile | 320–639   | **Card stack** (each row a bordered card), toolbar: search + icon-only filters (**bottom Sheet**), tabs = label over count, foot button full width, nav is the burger/`Sheet`                                 | **Full-screen**, footer stacked full-width, per-senior «Записати подачу» full width | 44 px targets; no horizontal scroll (measured at 320 and 375)    |
| Tablet | 640–1023  | At 768 the content region is only ≈512 px, so it **still renders the card stack** and the Sheet; tabs keep the stacked layout. Content ≥560 switches to the dense bordered list with chevrons and the Popover | Centered dialog, max-w-2xl                                                          | The breakpoint is on **content** width (container), not viewport |
| Laptop | 1024–1439 | Dense bordered list, two-column rows from content ≥720 (right column 230 px); filters in a 400 px Popover                                                                                                     | same dialog                                                                         | Primary operator target                                          |
| Large  | ≥1440     | Same as laptop; **list is capped at `max-w-5xl` (1024 px)** so lines never stretch; sidebar + whitespace                                                                                                      | same dialog (672 px)                                                                | Verified at 1440 and 1920                                        |

## 11. Accessibility (WCAG 2.2 AA)

- **Target size (2.5.8) / mobile 44 px:** every `button`, `summary`, tab and switch on the mobile frames measured ≥44×44 (rows,
  tabs, filter button, panel footer, switches, source «open» icon buttons, «Чому збіг», «Записати подачу», menu items). Measured by
  script at 320 and 375, uk and en, across **29 list/card/source/dialog states = 116 cases — 0 failures** (the sweep also fails a frame whose summary reset button detaches from its text), with the longer
  strings of the copy round ("Log submission" included; the sweep also fails a submit button that wraps to two lines). Filter options are 44 px rows (`role="checkbox"`/`"radio"` in the mock;
  real controls in code).
- **Focus (2.4.7 / 2.4.11):** rely on the `Button`/`Input` ring (`--ring`, 12.26:1 on card). Dialog and the filter `Sheet`
  trap focus and return it to the originating control on close; the `Popover` is non-modal (focus moves in, Escape returns it).
  In the duplicate confirm and in both `AlertDialog`s the **initial focus is the safe button** («Не записувати», «Не приховувати»,
  «Залишити»).
- **Names:** icon-only buttons carry `aria-label` (filters, close, source open links with the source name, admin menu, per-senior
  cancel). The row button is named by its title + company; «Записати подачу» is `aria-label="Записати подачу: <ім'я>"` (visible
  label is a prefix, SC 2.5.3).
- **Status without colour (1.4.1):** availability = dot shape + text; triage = dashed shape + icon + text; stop-list = ban
  icon + text; quota = hatch + numbers; blocked/paused/off = distinct icons + words; checked option = tick/dot + fill.
- **Live regions:** refresh prompt `role="status"`; append error and conflicts `role="alert"`; infinite-scroll results in
  one polite region (`job-queue-live`). Skeleton lists set `aria-busy`. The filter button has `aria-expanded`.
- **Keyboard:** no behaviour requires a pointer; the infinite-scroll sentinel is backed by the visible «Показати ще» button
  that is a normal tab stop; menus are Radix (arrow keys, type-ahead, Escape, focus return).
- **Reflow (1.4.10):** no horizontal scroll at 320; text wraps (`overflow-wrap:anywhere`) — verified with a 200-character title.
- **Contrast:** §8. Disabled buttons (`opacity:.5`) are exempt, and the reason is always in adjacent text.

## 12. Motion

Quiet. Radix dialog fade/zoom ≤150 ms; `Sheet` slide ≤200 ms; tab underline move ≤200 ms (existing `AnimatedTabs` easing may
be reused); skeleton pulse 1.6 s; spinner 1 s; toast slide per `sonner`. **No scroll-linked or entrance animation on rows.**
Under `prefers-reduced-motion`: pulse and spinner stop, dialog and sheet use opacity only. Row→card has no shared-element transition.

## 13. Edge cases

| Case                                          | Behaviour (frame)                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Empty authorized queue**                    | «У черзі немає нових вакансій» with the filters hint (`list-empty-*`); HR with no team gets the separate no-team empty (`list-noteam-320`)                                       |
| **Filtered to nothing / search with no hits** | Sliders (or search) icon + «Нічого не знайдено» + «Скинути фільтри» and/or «Очистити пошук» (`filters-none-*`, `filters-none-search-*`) — reads differently from the empty queue |
| **200-character title**                       | List clamps to 2 lines with ellipsis; the card wraps it fully; company wraps in the card (`design.png`, `card-long-title-*`)                                                     |
| **Zero matches**                              | Row hides the line; card shows the plain empty (`card-zero-matches-320`)                                                                                                         |
| **All matches stop-listed**                   | Distinct row line + empty with ban icon (`card-stoplist-all-320`, last list row)                                                                                                 |
| **Triage item**                               | Dashed badge + reason on row; dashed note + empty seniors in the card (`card-triage-320`)                                                                                        |
| **Unknown publication date**                  | Calendar-off line in row and card (`card-unknown-date-320`)                                                                                                                      |
| Very long company name                        | Truncates on the row, wraps in the card                                                                                                                                          |
| Many stack chips                              | 4 + «+K» on the row; all in the card                                                                                                                                             |
| ≥20 sources / ≥200 seniors                    | Bounded previews with «Показати ще (N)» continuation and independent totals                                                                                                      |
| Closed at source                              | Status chip + blocking note; submits disabled (`card-closed-320`)                                                                                                                |
| Appending / end / append error                | `list-appending-*`, `list-end-*`, `list-appenderr-*`                                                                                                                             |
| First-load error                              | `list-error-*` with «Спробувати ще»                                                                                                                                              |
| Partial source health                         | `list-partial-320`                                                                                                                                                               |
| Generation invalidated                        | `list-refresh-320`                                                                                                                                                               |
| Permission change while open                  | card closes, list refetches, toast «Цю вакансію не знайдено» (same text for 403 and 404), no stale names                                                                         |

## 14. Testids (E2E anchors are testids, not headings)

`job-queue-page`, `job-queue-list`, `job-queue-row-<id>`, `job-queue-tab-<status>`, `job-queue-load-more`,
`job-queue-appending`, `job-queue-end`, `job-queue-append-error`, `job-queue-live`, `job-queue-filtered-empty`,
`job-queue-filters-button`, `job-queue-filters-panel`, `job-queue-filters-apply`, `job-queue-filters-clear`,
`job-queue-senior-<id>`, `job-queue-submit-<seniorId>`, `job-queue-source-<id>`. Row figure slot: `data-slot="matched-count"`.
`job-queue-terms` (engagement form + salary flag), `job-queue-apply-first`.

## 15. Assets (`docs/design/assets/vacancy-queue/`)

- `design.html` — the reference; `?s=list|card|sources|dialogs&w=<px>&st=<state>&lang=uk|en[&admin=1]` renders one isolated frame,
  without params it renders a board of every frame. Fonts load from Google Fonts like the app; offline falls back to system-ui
  (widths then differ by a few %).
- `design.png` (list, 1440) · `design-320.png` · `design-768.png` · `design-1024.png` · `design-1920.png` — list default.
  **Fidelity references for Mode B: `design.png` (desktop) and `design-320.png` (mobile).**
- English: `list-320-en`, `list-768-en`, `list-1440-en`, `card-default-320-en`, `card-admin-teams-768`, `sources-320-en`,
  `list-appenderr-320-en`, `filters-open-sheet-320-en`, `filters-open-sheet-senior-320-en`, `filters-open-popover-1440-en`,
  `filters-none-320-en`, `dialogs-320-en`.
- **Filters:** `filters-applied-{320,1440}` (toolbar with badge + summary; the no-filter toolbar is `design-320` / `design`),
  `filters-open-sheet-320` (specified groups), `filters-open-sheet-senior-320` (scrolled to the picker), `filters-open-sheet-senior-picker-320` (picker open: own team's seniors only),
  `filters-open-popover-{768,1440}`, `filters-none-{320,1440}`, `filters-none-search-320`, `filters-applied-long-320` (summary with the senior picker applied: wraps, reset stays inline), `list-empty-submitted-320`, `list-empty-hidden-320`.
- States: `list-{empty,loading,error}-*`, `list-{appending,end,appenderr}-*`, `list-{refresh,partial,noteam,wip,hidden,multiteam}-320`,
  `list-admin-*`, `card-*` (default 320/768/1440, submitting, dup, dupconfirm, stoplist-all, triage, zero-matches, unknown-date,
  updated, stale, closed, long-title, hide-menu, admin-menu, hidden-toast, admin-teams), `sources-*`, `dialogs-*`.

**For the coder:** build with **our** components and tokens per this spec; `design.html` is a visual reference — do **not**
copy its markup. Where the HTML and this document differ, this document wins (the HTML uses plain divs, a simplified switch,
and shows the sticky footer unrolled).
