# vacancy-queue — design spec («Черга вакансій», r5 Task 0.1, Tier 1)

**Status:** Tier 1 artifact, **degraded**: no Claude Design session was driven (it is browser-only and unavailable
to a headless agent). The visual reference `assets/vacancy-queue/design.html` is hand-authored from the `.dark`
custom properties of `apps/web/app/styles/globals.css`, rendered with Playwright. It is a **visual reference, not
code to paste** — build with our components and tokens per this spec. Recommend re-running Claude Design against
the synced `CheekyCheeseIT CRM` system when a session is available (`fidelity: degraded` in the PR).
**Source of requirements:** `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md` Task 0.1 (the plan wins
where it differs from the dispatch message) + the owner addendum of 2026-10-18 (infinite scroll; per-senior
submission; no cross-team signal). Reference for tone: `docs/design/job-sourcing-suggestion.md`.
**Audience of the screen:** HR and ADMIN only. Dark theme only (one theme in the CRM — `design-gate.md`).
**Skills used:** `claude-design-workflow`, `design-system`, `accessibility`, `frontend-design-direction`, `copywriting`.

## 0. Open dependencies (read first)

| #   | Pending item                                                                                                                                                                                                                                                                            | Owner / who confirms              | Effect on this spec                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Per-senior submission model.** A _submission_ is a per-senior fact on one vacancy; several of the actor's own seniors may be submitted independently. There is **no global "taken" state**. Needs the schema change (global `UNIQUE(opportunity_id)` on assignments is incompatible). | Owner, via Master                 | The whole card (§5) and the «У роботі» tab (§4.2) are designed to this model. If the owner picks another model the card's working surface and footer change; the list, tokens and states stand.                                                      |
| D2  | **Scope of the row's «N сеньйорів мають збіг стеку».** Studio-wide total vs actor's-team-scoped. A match count is not knowledge of where another team applies, but it tells team A that other teams have candidates.                                                                    | Owner (one narrow question asked) | **Layout-neutral by construction:** one number in one slot (`data-slot="matched-count"`), phrase unchanged. The companion «N подано» is always own-team and is a separate clause, never «x з y». Do not build anything that needs the larger number. |
| D3  | Whether HR may see that a senior was excluded by their own stop-list (count only vs nothing), and whether HR may submit for a stop-listed senior (spec: no).                                                                                                                            | Owner / Master                    | §5.4 shows a **count only**, no names. Remove the block if the answer is "nothing".                                                                                                                                                                  |
| D4  | Can a submission be cancelled, and by whom. Spec assumes ADMIN-only «Скасувати подачу…» in a per-senior menu; the plan's ADMIN _reassign_ loses its meaning under D1 and is **dropped** from this spec.                                                                                 | Master / owner                    | §5.6.                                                                                                                                                                                                                                                |
| D5  | Can HR submit a senior to a **triage** item. Spec: yes, same as any item (triage is a classification, not a lock).                                                                                                                                                                      | Master                            | §5.5.                                                                                                                                                                                                                                                |

Assumptions made on the record (A1, reversible, one PR): `?card=<id>` search param so Back closes the card; undo toast
8 s; per-senior submit button is the _default_ Button variant (one per senior row), the footer carries **no** primary.

## 1. Conflicts with the plan / inherited text (the plan wins; reported)

| Plan / brief text                                                                                                                         | What this spec does                                                                                                                                                                                            | Why                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Task 0.1 ««вже взято» state with the name masked outside the actor's scope»; Task 7.3 «взято <name> <when>»; one primary «Взяти в роботу» | **Removed.** No global taken state; primary action is «Подати» per senior                                                                                                                                      | Addendum §2 (owner): teams must not see each other's activity |
| Task 0.1 «Завантажити ще» load-more button; Task 7.2 «Завантажити ще» by `nextCursor`                                                     | **Infinite scroll** with a visible quiet «Показати ще» button as the keyboard/AT path                                                                                                                          | Addendum §1                                                   |
| Task 0.1 «matched seniors — names only inside the actor's team scope»                                                                     | Kept; plus per-senior state and actions                                                                                                                                                                        | —                                                             |
| Task 0.1 ADMIN «release/reassign/suppress»                                                                                                | release → per-senior «Скасувати подачу…»; reassign dropped; suppress kept (vacancy level)                                                                                                                      | D1, D4                                                        |
| Task 0.1 ADMIN source block `enabled` switch + «вимкнено: <reason>»                                                                       | Disabled / paused / readiness-blocked are **three distinct states** (§7)                                                                                                                                       | Plan "Inherited-text conflicts" table                         |
| Task 7.2 badge «не вдалося визначити стек»                                                                                                | Triage items are labelled **«На розгляд»**, distinct from leads                                                                                                                                                | Plan "Inherited-text conflicts" table                         |
| Brief: frames **320/768/1024/1440 × default/empty/loading/error**                                                                         | Present for the list. The card and ADMIN block are shown at 320 (full-screen), 768 and 1440 (dialog) because the dialog is a single 672 px column from 640 up; 1024 is identical to 768 for the card (see §10) | Dialog width is capped, so extra card frames add nothing      |

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

| Fact                                                         | HR                                                                                                       | ADMIN                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Matched seniors' **names**                                   | Only seniors of the actor's active teams                                                                 | All, grouped under a team heading (heading shown to ADMIN only)  |
| Row figure «N сеньйорів мають збіг стеку»                    | Scoped or total — **D2**, one slot                                                                       | same                                                             |
| Companion «N подано»                                         | Own team's submissions only                                                                              | Studio total in studio scope; per team when a team is selected   |
| A vacancy submitted/claimed **by another team**              | **Indistinguishable from untouched.** No badge, no grey, no «вже взято», no count, no name               | Sees per-team groups (explicit, because ADMIN works studio-wide) |
| Submitted-by name on a senior                                | Same-team recruiters only                                                                                | All                                                              |
| Possible-duplicate preview                                   | Only duplicates in the actor's authorized view; the «your team already submitted» line only for own team | all                                                              |
| Stop-list exclusion                                          | Count of **own** seniors excluded (D3); never names of foreign seniors                                   | all, per team                                                    |
| Team switcher                                                | Only when HR has **several** active teams (one validated team per request)                               | none; a «Уся студія» scope control instead                       |
| Source block, suppress, triage assignment, cancel submission | not rendered                                                                                             | rendered                                                         |
| Dismiss («Приховати») scope                                  | Own team (menu states it)                                                                                | Whole studio (menu states it)                                    |

`aria-live` announcements, toasts, error messages and the 409 conflict text are bound by the same matrix: **no text
may reveal another team's activity.** A 409 on submit shows the generic «Дані змінилися. Оновіть картку» (the stale
state, §5.7), never who or where.

## 4. List screen

### 4.1 Anatomy (`job-queue-page`)

1. **Header row:** `h1` «Черга вакансій» / "Vacancy queue" (page titles are not E2E anchors — `data-testid` is).
2. **Toolbar:** [Team switcher — multi-team HR only] · search (title/company) · «Фільтри» button.
   - <560 px content: search grows, «Фільтри» is a 44×44 icon button (`aria-label`, count badge when filters active);
     ≥560: icon + label.
   - Filters open a **bottom `Sheet`** below 560 and a **`Popover`** from 560 up. Bounded fields: source (multi),
     eligibility (leads / triage), availability (open / unknown / closed / expired), activity (mine-team submitted /
     not submitted). Applied filters show as a count on the button; a «Скинути» link lives in the panel.
3. **Status tabs** (`job-queue-tab-<status>`): «Нові» · «У роботі» · «Приховані» with **authorized counts**.
4. **Notices** (when applicable, one at a time, above the list): refresh prompt · partial-source notice.
5. **ADMIN only:** collapsed «Джерела вакансій» block with a one-line health summary (§7).
6. **List** (`job-queue-list`) in API order; **no numeric rank or score is ever shown.**
7. **Foot slot** (infinite scroll, §4.4).

### 4.2 Tabs

| Tab (uk / en)            | Meaning for this actor                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| «Нові» / New             | Not hidden for the actor's scope, and no senior of the actor's team submitted          |
| «У роботі» / In progress | The actor's team has ≥1 submitted senior. Never includes anything another team did     |
| «Приховані» / Hidden     | Dismissed in the actor's scope (team for HR, studio for ADMIN); row offers «Повернути» |

A vacancy can be in «У роботі» (a senior submitted) **and** still be actionable for the team's other seniors; its card
keeps «Подати» on those. Counts: `tabular-nums`; above 999 render «999+».

**Width (measured at 320 and 375, uk and en):** tabs use three equal columns with the **label over the count**
below 560 px of content; `In progress` / `У роботі` stay on one line. From 560 px: label + count pill in a row.
English is shorter than Ukrainian here, so the Ukrainian label sets the minimum; a tab row that wraps is a defect.

### 4.3 Row (`job-queue-row-<id>`)

The whole row is one button (≥44 px) that opens the card. No action lives only on hover; a trailing chevron
appears from 560 px.

| Slot                     | Content                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Line 1                   | [«На розгляд» badge for triage] · seniority badge (omitted when unknown) · flags (§4.6) |
| Title                    | `font-semibold`, clamp 2 lines, `overflow-wrap:anywhere`; full text in the card         |
| Company                  | Source icon (20 px chip) + company, single-line truncate                                |
| Stack chips              | Up to 4 + «+K»; matched tokens use the **hit** style (amber), the rest neutral          |
| Meta (right column ≥720) | Publication age, `data-slot="matched-count"`, `+N також на …`                           |

- **Publication age** uses the trusted date: «Опубліковано 2 дні тому». Unknown: «Дата публікації невідома ·
  вперше побачено 3 дні тому» with a calendar-off icon. When last-observed is notably older, add «востаннє бачили
  вчора» as a plain muted phrase.
- **Matched count:** «3 сеньйори мають збіг стеку» (plural via Lingui; uk one/few/many, en one/other). Hidden at 0.
  When the actor's team has submissions, a **separate** clause follows on the same line, wrapping on mobile:
  «✓ 1 подано» / "✓ 1 submitted". Never «1 з 3» (D2: the two numbers may have different scopes).
- **`+N також на DOU, Djinni`:** from `totalAlsoSeenOnCount`; the count always shows, names truncate first.
- Triage rows replace the stack line with the reason: «Потребує ручної оцінки: роботодавця не вдалося підтвердити».

### 4.4 Infinite scroll (owner addendum §1) — keyset pagination unchanged

**Mechanism.** An `IntersectionObserver` sentinel (root = the list's scroll container, `rootMargin` ≈ 400 px) calls the
same "fetch next page by `nextCursor`" the button calls. The **foot slot** is one element, **≥44 px tall, in the same
place in every state**, so nothing shifts when it changes.

| State                               | Foot slot                                                                                                                              | Live region                         | Notes                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First load                          | Three skeleton rows; tabs show no counts yet; `aria-busy="true"` on the list                                                           | —                                   | `job-queue-list` busy                                                                                                                                           |
| Idle, more pages                    | **Quiet ghost button «Показати ще»** (muted text, full width) + «Показано 6 із 12»                                                     | —                                   | The **keyboard / screen-reader path.** Always rendered when `nextCursor` exists, even though the sentinel normally fires first. Enter/Space loads the next page |
| Appending                           | Same slot becomes a status row «⟳ Завантажуємо ще…» (`role="status"`), two ghost skeleton rows above it                                | «Завантажуємо ще…»                  | Rows already shown stay interactive; list `aria-busy="true"`; repeated triggers ignored (one in-flight request)                                                 |
| End of list                         | A dashed hairline + «Усі вакансії показано: 6»                                                                                         | «Усі вакансії показано: 6» (polite) | **Not** an empty state: no icon, no illustration, no headline. The number is invariable after the colon in uk                                                   |
| Error while appending               | `note` (destructive outline, `role="alert"`) «Не вдалося завантажити ще» · «Уже завантажені вакансії збережено.» · **«Спробувати ще»** | alert                               | The loaded rows stay exactly where they are. Retry re-requests the same cursor. The sentinel is **suspended** until retry succeeds (no retry storm)             |
| Cursor expired («refresh-required») | The **refresh prompt** (§4.5), not the append error                                                                                    | status                              | Retrying cannot succeed, so it must not offer a retry                                                                                                           |

**Focus and announcement.** After a _keyboard_-triggered append, move focus to the **first newly added row** and announce
«Завантажено ще 20. Показано 40 із 87» in the polite live region (`job-queue-live`); after a _sentinel_-triggered append,
do not move focus (it would steal it mid-scroll) and announce the same sentence. Row order and `aria-posinset`
are not used: the rows are interactive controls, so the WAI-ARIA **feed** pattern (reading-article model, custom
Page Down contract) was considered and rejected in favour of a plain list + live region + the visible button.
Reduced motion: the spinner and skeleton pulse stop (`prefers-reduced-motion`).

### 4.5 Notices above the list

| Notice                                      | Look                                                    | Behaviour                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Refresh prompt** (generation invalidated) | `note info` (amber tint, refresh icon), `role="status"` | «Список змінився» + «Показати оновлений». The list does **not** reload by itself, so rows do not jump               |
| **Partial source health**                   | `note dash` (dashed border, warn icon)                  | «Деякі джерела тимчасово недоступні. Список може бути неповним.» ADMIN additionally gets a link to the source block |
| **No team (HR)**                            | Empty state with users icon                             | «Вам не призначено жодної команди». This is a different cause from "empty queue"                                    |

### 4.6 Warning taxonomy — each is visibly different (a generic row would go blind within a week)

Differentiation is by **icon + text + shape**, never colour alone. Colour is only a reinforcement and uses tokens.

| Condition                                                           | Where                                                                                                                   | Treatment                                                                                                                                                   | Colour reinforcement         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Updated since the list was built**                                | Row flag; card info note                                                                                                | Refresh icon + «Оновлено»; card: «Вакансію оновлено після побудови списку · Нижче — актуальні дані»                                                         | `primary` (amber)            |
| **A newer version appeared while the card is open** (blocks submit) | Card, blocking                                                                                                          | `note` with destructive outline + «Оновити картку»; all «Подати» disabled                                                                                   | `destructive`                |
| **Possible duplicate**                                              | Row flag; card note                                                                                                     | Copy icon + «Можливий дублікат»; card lists the duplicate; submit shows the per-senior confirm (§5.8)                                                       | neutral `foreground`         |
| **Unknown publication date**                                        | Row/card meta                                                                                                           | Calendar-off icon + text; no tint                                                                                                                           | `muted-foreground`           |
| **Zero matches**                                                    | Row: line hidden; card: empty block «Немає сеньйорів зі збігом стеку» with users icon                                   | Plain empty, not a warning                                                                                                                                  | none                         |
| **All matches excluded by stop-lists**                              | Row: «⊘ Усі збіги — за стоп-листом»; card: empty block with **ban icon** «Усіх збіжних сеньйорів виключено стоп-листом» | **Must not read as "no matches"**: different icon, different headline, and the body says «Це не те саме, що відсутність збігів»                             | none                         |
| **Some matches excluded by stop-lists**                             | Card, under the senior list                                                                                             | ban icon + «Виключено за стоп-листом: 1» + one explanatory sentence; count only (D3)                                                                        | none                         |
| **Triage item**                                                     | Row badge + reason line; card dashed note                                                                               | **Dashed-outline badge «На розгляд»** with help icon (shape = "unresolved"), reason text, in the card a dashed `note` «Не віднесено до команди автоматично» | `yellow-muted` dashed border |
| **Closed / expired at source**                                      | Card header status + blocking note                                                                                      | «Закрита» status chip (destructive outline, warn icon); «Подати» disabled on every senior                                                                   | `destructive`                |
| **Source degraded** (partial)                                       | List notice                                                                                                             | §4.5                                                                                                                                                        | dashed neutral               |

## 5. Card (`Dialog`, labelled by its `h2`; full-screen below 640 px)

### 5.1 Layout, top to bottom

1. **Header:** badges (triage, seniority, closed) · title (**wraps fully, no clamp**, `overflow-wrap:anywhere`) · company
   (wraps) · meta (published / unknown date, last seen) · close button (44×44, `aria-label` «Закрити»).
2. **Notices** relevant to this vacancy (§4.6).
3. **Matching seniors — the working surface (§5.2–5.5).** It comes **before** the description because it is the
   decision surface; the description is reference.
4. **Опис** — markdown via the extracted `PostingMarkdown` (untrusted; no raw HTML, no remote images/autolinks).
5. **Також відкрито на:** — source rows with `openOriginalPosting`, totals and continuation («Показано 3 із 34 ·
   Показати ще (20)»).
6. **Збіг стеку** — vacancy stack chips, hit style on matched ones.
7. **Sticky footer (vacancy-level actions only):** «Відкрити оригінал» · «Приховати» (reason menu) · [ADMIN «⋯»]. **No
   primary button** here: a vacancy is never "taken"; the primary action is per senior.

### 5.2 One block per own senior (`job-queue-senior-<id>`)

Avatar (initials, `avatar-text` on `yellow-subtle`) · name · availability · optional uncertainty · «Збіг за:» chips (the
matched tokens) · «Чому збіг» disclosure (evidence; `aria-expanded`, ≥44 px target) · action area.

- **Availability** is text + a dot shape, not colour: filled dot «Вільний з 1 лис.», hollow dot «Зайнятий».
- **Uncertainty:** info icon + «Оцінка неточна» (never a colour-only mark).
- **Attribution:** «Збіг за:» names the signals that produced the match.

### 5.3 Per-senior states (independent; any order; several seniors may be submitted)

| State                         | Action area                                                                                              | Details                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Not submitted                 | **«Подати»** — default Button, ≥44 px on mobile (full width of the block), `aria-label="Подати: <ім'я>"` | One per senior; the only yellow fill in the card                              |
| Submitting                    | Disabled «⟳ Подаємо…», `aria-busy`                                                                       | Repeated activation ignored                                                   |
| Submitted                     | Check icon + «Подано · 2 год тому» + submitter name (same-team recruiters only); no button               | ADMIN also gets a per-senior «⋯» → «Скасувати подачу…» (D4)                   |
| Excluded by own stop-list     | **Not listed**; counted in §5.4                                                                          | The senior "disappears" from the list, so the explanation must live elsewhere |
| Blocked (stale / closed card) | «Подати» disabled (`aria-disabled`), reason is in the blocking note above                                | Disabled controls keep their layout                                           |

A conflict (409 from a concurrent change) re-fetches the card and shows the stale note (§5.7). It never says who or where.

### 5.4 Stop-list display (company stop-lists are per senior, never global)

- Partial: under the list, a quiet `note` (muted, no tint): ban icon · **«Виключено за стоп-листом: 1»** · «Ці сеньйори
  внесли компанію до власного стоп-листа, тому вакансія їм не пропонується.» Count only (D3). The number is invariable
  after the colon in uk, which avoids a genitive-plural table.
- All: the whole block becomes an empty state with the **ban** icon and the headline «Усіх збіжних сеньйорів виключено
  стоп-листом» + «Стек збігається, але кожен із них вніс цю компанію до стоп-листа. Це не те саме, що відсутність
  збігів.» On the row: «⊘ Усі збіги — за стоп-листом».
- The vacancy stays fully visible and actionable for every other senior and team; the stop-list never hides it.

### 5.5 Triage and zero-match cards

Triage: dashed note + the senior block shows the empty state with the triage reason (no names, because the classifier
placed nobody). Zero matches: plain empty state «Немає сеньйорів зі збігом стеку» + «Вакансія лишається в черзі, але
жоден сеньйор із вашої команди не збігається за стеком.» The two empties differ in **icon and headline** (users vs ban).

### 5.6 ADMIN

- Studio scope: the senior block is grouped under **team headings** («Команда «Альфа»») — rendered for ADMIN only.
- Vacancy-level «⋯» (footer): **«Приховати для всіх…»** (suppress; confirm in `AlertDialog` with a bounded reason) and, for
  triage items, **«Призначити команді…»**. Menu header states the scope («Буде приховано для всієї студії»).
- Per-senior «⋯» on a submitted senior: **«Скасувати подачу…»** (`AlertDialog`, reason). Reassign is dropped (D4).
- Conflict (expected version mismatch): inline destructive note «Дані змінилися. Оновіть картку й повторіть.»

### 5.7 Card freshness states

| State                                        | Treatment                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Opened from a list built earlier, data newer | **Informational** amber note «Вакансію оновлено після побудови списку»; actions stay enabled                             |
| A newer revision arrives while open          | **Blocking** destructive note + «Оновити картку»; every «Подати» disabled until refreshed (an old card can never submit) |
| Policy/authorization change closes access    | Card closes and the list refetches; no stale names are shown                                                             |

### 5.8 Possible duplicate and the per-senior confirm

The duplicate note lists up to a bounded preview: «Схожа вакансія вже є в черзі … **Ваша команда вже подавала на
схожу: <назва> · <senior>**» — the second line only when **own team** submitted there. Duplicates in other teams are not
mentioned. When the actor presses «Подати» for a senior who was already submitted to a similar vacancy by the own
team (`confirmPossibleDuplicate` required, or the 409 `POSSIBLE_DUPLICATE_CLAIMED`), the **block itself expands**
inline — no second dialog: «Цього сеньйора вже подано на схожу вакансію · Ви впевнені, що це інша вакансія?» with
**«Скасувати» as the primary/initial-focus button** and «Так, подати все одно» as the outline button.

### 5.9 Hide («Приховати»)

Menu (Radix `DropdownMenu`, keyboard accessible) with a scope line first, then **Не релевантна / Спам / Мертве
посилання**. Success: toast «Приховано · Скасувати» (8 s, undo scoped and versioned). In «Приховані» the row carries
a visible «Повернути» button (no hover-only undo).

## 6. i18n — both languages for every string (Lingui macros, source `uk`; `en` written anew, not translated)

Length rule: measure the longer language at 320 px; Ukrainian is ≈15–30 % longer. The English labels below are
**proposals for `copy-reviewer`** (notably «Подати» → "Submit"; the owner's word is «податься»).

| Key                   | uk (source)                                                                                                                                   | en                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| title                 | Черга вакансій                                                                                                                                | Vacancy queue                                                                                                                   |
| tabs                  | Нові · У роботі · Приховані                                                                                                                   | New · In progress · Hidden                                                                                                      |
| search                | Назва або компанія                                                                                                                            | Title or company                                                                                                                |
| filters               | Фільтри                                                                                                                                       | Filters                                                                                                                         |
| studio scope          | Уся студія                                                                                                                                    | Whole studio                                                                                                                    |
| row: seniors (plural) | {n} сеньйор має / сеньйори мають / сеньйорів мають збіг стеку                                                                                 | {n} senior matches / seniors match the stack                                                                                    |
| row: companion        | {n} подано                                                                                                                                    | {n} submitted                                                                                                                   |
| row: also on          | +{n} також на {list}                                                                                                                          | +{n} also on {list}                                                                                                             |
| posted / unknown      | Опубліковано {ago} · Дата публікації невідома · вперше побачено {ago} · востаннє бачили {ago}                                                 | Posted {ago} · Publication date unknown · first seen {ago} · last seen {ago}                                                    |
| triage                | На розгляд · Потребує ручної оцінки: роботодавця не вдалося підтвердити                                                                       | Needs triage · Needs manual review: employer could not be verified                                                              |
| flags                 | Оновлено · Можливий дублікат                                                                                                                  | Updated · Possible duplicate                                                                                                    |
| submit                | Подати · Подаємо… · Подано · {when} · Подано: {who} · {when}                                                                                  | Submit · Submitting… · Submitted · {when} · Submitted by {who} · {when}                                                         |
| submit aria           | Подати: {who}                                                                                                                                 | Submit: {who}                                                                                                                   |
| stop-list             | Виключено за стоп-листом: {n} · Усі збіги — за стоп-листом · Усіх збіжних сеньйорів виключено стоп-листом                                     | Excluded by stop-list: {n} · All matches are on stop-lists · All matching seniors are excluded by stop-lists                    |
| footer                | Відкрити оригінал · Приховати                                                                                                                 | Open original · Hide                                                                                                            |
| hide reasons          | Не релевантна · Спам · Мертве посилання                                                                                                       | Not relevant · Spam · Dead link                                                                                                 |
| hide scope            | Буде приховано для вашої команди / для всієї студії                                                                                           | Will be hidden for your team / for the whole studio                                                                             |
| undo / restore        | Приховано · Скасувати · Повернути                                                                                                             | Hidden · Undo · Restore                                                                                                         |
| infinite scroll       | Показати ще · Завантажуємо ще… · Усі вакансії показано: {n} · Не вдалося завантажити ще · Уже завантажені вакансії збережено. · Спробувати ще | Show more · Loading more… · All vacancies shown: {n} · Could not load more · The vacancies already loaded are kept. · Try again |
| shown                 | Показано {a} із {b}                                                                                                                           | Showing {a} of {b}                                                                                                              |
| empty                 | У черзі немає нових вакансій · Нові з’являться після наступного збору…                                                                        | No new vacancies in the queue · New ones appear after the next collection…                                                      |
| no team               | Вам не призначено жодної команди                                                                                                              | You are not assigned to any team                                                                                                |
| error                 | Не вдалося завантажити чергу · Це не вплинуло на ваші дані.                                                                                   | Could not load the queue · Your data is unaffected.                                                                             |
| stale                 | З’явилася новіша версія вакансії · Оновити картку                                                                                             | A newer version of the vacancy is available · Refresh card                                                                      |
| closed                | Вакансію закрито на джерелі · Нові подачі неможливі. Раніше подано вашою командою: {n}.                                                       | The vacancy is closed at the source · New submissions are not possible. Previously submitted by your team: {n}.                 |
| admin                 | Приховати для всіх… · Призначити команді… · Скасувати подачу… · Дії адміністратора                                                            | Hide for everyone… · Assign to a team… · Cancel submission… · Administrator actions                                             |
| sources               | see §7 and the HTML dictionary (`design.html`, `D.uk` / `D.en`)                                                                               | —                                                                                                                               |

The full dictionary with plurals is the `D` object in `design.html`; it is the source for `messages.po`. Terms follow
`CONTEXT.md`: «зовнішня вакансія», «джерело»; avoided: «парсер», «пост», «объявление».

## 7. ADMIN source block (Design Tier 2 — extends `SourceBudgetPanel`)

Placed on the queue page for ADMIN as a **collapsed** section «Джерела вакансій» with a one-line health summary
(«4 джерела · 1 призупинено · 1 заблоковано»); the existing placement inside `JobSuggestionDialog` stays. Each source:

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

| Role          | Token                                                                               | Used for                                                                                             |
| ------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Page          | `--background`                                                                      | canvas                                                                                               |
| Surfaces      | `--card`, `--popover`, `--surface`, `--accent`, `--secondary`, `--muted`, `--input` | rows/cards, menus, tinted notes, tab count pill, skeleton, field fill                                |
| Text          | `--foreground`, `--muted-foreground`                                                | primary / secondary text                                                                             |
| Brand         | `--primary`, `--primary-foreground`                                                 | the per-senior «Подати», tab underline, links, matched-stack chips (text), refresh flag              |
| Amber tints   | `--yellow-subtle`, `--yellow-muted`, `--avatar-text`                                | matched-stack chip fill, info note fill, triage dashed border, reserved-quota segment, senior avatar |
| Danger        | `--destructive`                                                                     | blocked/closed/stale/error text and outlines                                                         |
| Lines / focus | `--border`, `--ring`                                                                | dividers, outlines, focus ring                                                                       |
| Shape         | `--radius`, `--radius-sm/md/lg/xl`                                                  | chips `md`, buttons `md`, notes `lg`, cards/list `xl`                                                |
| Type          | `--font-sans` (Inter)                                                               | all text                                                                                             |

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
12:1 focus ring. Raise as a separate foundation item rather than patching it on one screen.

## 9. Components

**Existing (reuse as-is):** `Button` (default / outline / ghost; sizes `default` and `lg` for the 44 px mobile target),
`Badge` (outline / secondary), `Card`, `Dialog` + `CrmDialogContent/Header/Body/Footer` (card; `h-dvh` full-screen
below `sm`), `Sheet` (filters, <560), `Popover` (filters, ≥560), `Select` (team switcher), `Input`, `DropdownMenu`
(hide + admin menus), `AlertDialog` (suppress, cancel submission), `Switch`, `Skeleton`, `Alert`, `Avatar`, `ScrollArea`,
`Command` (assign-to-team picker), `Tabs` (Radix), `Tooltip` (supplementary only — nothing essential lives in a tooltip),
`sonner` toast, `StickyPageHeader`/`PageHeader`. Existing non-`ui`: `SourceBudgetPanel` (extended), `PostingMarkdown`
(extracted from `JobSuggestionDialog`), `openOriginalPosting`.

**New (named in the plan; composed from the above, not new primitives):**

| Component                            | Why existing does not fit                                    | API sketch                                                                                      |
| ------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `JobQueueStatusTabs`                 | `AnimatedTabs` has no count slot and no stacked-label layout | `{ value, counts: Record<Status,number\|null>, onChange }` over Radix `Tabs`                    |
| `JobQueueRow` / `JobQueueList`       | list semantics + the foot slot                               | `{ item, onOpen }`; list owns sentinel + foot slot                                              |
| `JobQueueFoot`                       | one slot for idle/appending/end/error                        | `{ state, shown, total, onLoadMore, onRetry }` (renders the live region)                        |
| `JobQueueCard`                       | dialog composition                                           | `{ opportunityId, teamId }`                                                                     |
| `MatchedSeniors` + `SeniorSubmitRow` | per-senior state machine                                     | `{ seniors, onSubmit, state }`; row state `todo \| submitting \| submitted \| blocked`          |
| `StopListNotice`                     | ban-icon explanatory note / all-excluded empty               | `{ excludedCount, allExcluded }`                                                                |
| `AlsoSeenOn`, `PossibleDuplicates`   | bounded lists with continuation                              | per plan                                                                                        |
| `JobQueueActions`, `DismissMenu`     | footer and reason menu                                       | per plan                                                                                        |
| `TeamSwitcher`                       | one validated team per request                               | `{ teams, value, onChange }`                                                                    |
| **`QueueNotice`**                    | `Alert` lacks the `info` (amber), `dashed`, `soft` variants  | add **variants to `Alert`**, not a new component                                                |
| **`StackChip`**                      | hit/neutral/more chip                                        | add **variants to `Badge`** (`stack-hit`, `stack`, `stack-more`, `triage` dashed) — tokens only |
| `QuotaBar`                           | three-segment hatched bar with legend                        | `{ used, reserved, uncertain, total, unit }`; `role="img"` + `aria-label`                       |
| `SourceStateChip`                    | three distinct states                                        | `{ state: 'running'\|'disabled'\|'paused'\|'blocked' }`                                         |

## 10. Responsive (class → what changes). Content width = viewport − sidebar 208 px (≥768) − page padding

| Class  | Viewport  | List                                                                                                                                                                            | Card                                                                       | Notes                                                            |
| ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Mobile | 320–639   | **Card stack** (each row a bordered card), toolbar: search + icon-only filters, tabs = label over count, foot button full width, nav is the burger/`Sheet`                      | **Full-screen**, footer stacked full-width, per-senior «Подати» full width | 44 px targets; no horizontal scroll (measured at 320 and 375)    |
| Tablet | 640–1023  | At 768 the content region is only ≈512 px, so it **still renders the card stack**; tabs keep the stacked layout. Content ≥560 switches to the dense bordered list with chevrons | Centered dialog, max-w-2xl                                                 | The breakpoint is on **content** width (container), not viewport |
| Laptop | 1024–1439 | Dense bordered list, two-column rows from content ≥720 (right column 230 px)                                                                                                    | same dialog                                                                | Primary operator target                                          |
| Large  | ≥1440     | Same as laptop; **list is capped at `max-w-5xl` (1024 px)** so lines never stretch; sidebar + whitespace                                                                        | same dialog (672 px)                                                       | Verified at 1440 and 1920                                        |

## 11. Accessibility (WCAG 2.2 AA)

- **Target size (2.5.8) / mobile 44 px:** every interactive element on the mobile frames measured ≥44×44 (rows, tabs, filter
  button, switches, source «open» icon buttons, «Чому збіг», «Подати», menu items). Measured by script at 320 and 375, uk and
  en, across 19 list/card/source states — 0 failures.
- **Focus (2.4.7 / 2.4.11):** rely on the `Button`/`Input` ring (`--ring`, 12.26:1 on card). Dialog traps focus and returns it
  to the originating row on close; Escape and the 44 px close button both close. In the duplicate confirm the **initial
  focus is «Скасувати»**.
- **Names:** icon-only buttons carry `aria-label` (filters, close, source open links with the source name, admin menu, per-senior
  cancel). The row button is named by its title + company; «Подати» is `aria-label="Подати: <ім'я>"` (visible label is a prefix).
- **Status without colour (1.4.1):** availability = dot shape + text; triage = dashed shape + icon + text; stop-list = ban
  icon + text; quota = hatch + numbers; blocked/paused/off = distinct icons + words.
- **Live regions:** refresh prompt `role="status"`; append error and conflicts `role="alert"`; infinite-scroll results in
  one polite region (`job-queue-live`). Skeleton lists set `aria-busy`.
- **Keyboard:** no behaviour requires a pointer; the infinite-scroll sentinel is backed by the visible «Показати ще» button
  that is a normal tab stop; menus are Radix (arrow keys, type-ahead, Escape, focus return).
- **Reflow (1.4.10):** no horizontal scroll at 320; text wraps (`overflow-wrap:anywhere`) — verified with a 200-character title.
- **Contrast:** §8. Disabled buttons (`opacity:.5`) are exempt, and the reason is always in adjacent text.

## 12. Motion

Quiet. Radix dialog fade/zoom ≤150 ms; tab underline move ≤200 ms (existing `AnimatedTabs` easing may be reused); skeleton
pulse 1.6 s; spinner 1 s; toast slide per `sonner`. **No scroll-linked or entrance animation on rows.** Under
`prefers-reduced-motion`: pulse and spinner stop, dialog uses opacity only. Row→card has no shared-element transition.

## 13. Edge cases

| Case                           | Behaviour (frame)                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Empty authorized queue**     | «У черзі немає нових вакансій» with the filters hint (`list-empty-*`); HR with no team gets the separate no-team empty (`list-noteam-320`) |
| **200-character title**        | List clamps to 2 lines with ellipsis; the card wraps it fully; company wraps in the card (`design.png`, `card-long-title-*`)               |
| **Zero matches**               | Row hides the line; card shows the plain empty (`card-zero-matches-320`)                                                                   |
| **All matches stop-listed**    | Distinct row line + empty with ban icon (`card-stoplist-all-320`, last list row)                                                           |
| **Triage item**                | Dashed badge + reason on row; dashed note + empty seniors in the card (`card-triage-320`)                                                  |
| **Unknown publication date**   | Calendar-off line in row and card (`card-unknown-date-320`)                                                                                |
| Very long company name         | Truncates on the row, wraps in the card                                                                                                    |
| Many stack chips               | 4 + «+K» on the row; all in the card                                                                                                       |
| ≥20 sources / ≥200 seniors     | Bounded previews with «Показати ще (N)» continuation and independent totals                                                                |
| Closed at source               | Status chip + blocking note; submits disabled (`card-closed-320`)                                                                          |
| Appending / end / append error | `list-appending-*`, `list-end-*`, `list-appenderr-*`                                                                                       |
| First-load error               | `list-error-*` with «Спробувати ще»                                                                                                        |
| Partial source health          | `list-partial-320`                                                                                                                         |
| Generation invalidated         | `list-refresh-320`                                                                                                                         |
| Permission change while open   | card closes, list refetches, no stale names                                                                                                |

## 14. Testids (E2E anchors are testids, not headings)

`job-queue-page`, `job-queue-list`, `job-queue-row-<id>`, `job-queue-tab-<status>`, `job-queue-load-more`,
`job-queue-appending`, `job-queue-end`, `job-queue-append-error`, `job-queue-live`, `job-queue-senior-<id>`,
`job-queue-submit-<seniorId>`, `job-queue-source-<id>`. Row figure slot: `data-slot="matched-count"`.

## 15. Assets (`docs/design/assets/vacancy-queue/`)

- `design.html` — the reference; `?s=list|card|sources&w=<px>&st=<state>&lang=uk|en[&admin=1]` renders one isolated frame,
  without params it renders a board of every frame. Fonts load from Google Fonts like the app; offline falls back to system-ui
  (widths then differ by a few %).
- `design.png` (list, 1440) · `design-320.png` · `design-768.png` · `design-1024.png` · `design-1920.png` — list default.
  **Fidelity references for Mode B: `design.png` (desktop) and `design-320.png` (mobile).**
- English: `list-320-en`, `list-768-en`, `list-1440-en`, `card-default-320-en`, `card-admin-teams-768` (en), `sources-320-en`,
  `list-appenderr-320-en`.
- States: `list-{empty,loading,error}-*`, `list-{appending,end,appenderr}-*`, `list-{refresh,partial,noteam,wip,hidden,multiteam}-320`,
  `list-admin-*`, `card-*` (default 320/768/1440, submitting, dup, dupconfirm, stoplist-all, triage, zero-matches, unknown-date,
  updated, stale, closed, long-title, hide-menu, admin-menu, hidden-toast, admin-teams), `sources-*`.

**For the coder:** build with **our** components and tokens per this spec; `design.html` is a visual reference — do **not**
copy its markup. Where the HTML and this document differ, this document wins (the HTML uses plain divs and a simplified switch).
