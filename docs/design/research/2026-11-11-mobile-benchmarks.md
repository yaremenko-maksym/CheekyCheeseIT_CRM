# Mobile + desktop benchmarks for the CRM redesign (2026-11-11)

Purpose: give designers and reviewers a short, sourced set of products to benchmark the redesign
against, a scoring rubric, and the iOS Safari / PWA constraints the mobile build must respect.

Scope: mobile (phone), tablet and desktop. Dark theme only. React SPA / PWA.

Owner's daily phone tasks, in priority order, which the picks map to:

1. Finance: add a transaction, often with a receipt photo.
2. Add a new employee / user.
3. Edit contracts.
4. Edit people profiles.
5. Stats: the balance between the two partners, and a monthly net-profit chart.

Other modules: teams, projects, vacancies + external job queue, interviews, documents, admin settings.

## How to read this file

- Each claim has a source link. **Vendor** means the company describes its own product, so treat
  it as a claim and not as a measurement.
- App Store ratings change over time. Each one has its source and the snapshot date the source gives.
- "Not verified" means the search did not confirm it. Do not treat it as true.

---

## Picks (10)

### 1. Ramp: receipt capture and expense completion

Benchmarks: **add transaction + receipt** (top priority), the vacancies / external job queue
(an inbox-style review), and approval-style lists.

Why it is the benchmark:

- iOS rating is 4.8 from 14.1K ratings ([App Store](https://apps.apple.com/us/app/ramp/id1628197245)).
  A tracker shows 4.9 from 35.2K, last updated 2026-03-01 ([AppPriceLab](https://apppricinglab.com/app/apple/1628197245)).
- Vendor: "Expenses get completed and submitted in under 15 seconds". Memo and accounting code are
  pre-filled or suggested from transaction details, past behaviour and calendar
  ([Ramp blog, 2025-12-04](https://ramp.com/blog/how-ramp-users-finish-expenses-in-15-seconds)).

Mobile patterns to copy:

- **Capture comes first, then the form.** Receipts arrive by camera, by the share extension, or
  by replying to an SMS with a photo. The text in the SMS becomes the memo
  ([Ramp support](https://support.ramp.com/hc/en-us/articles/360042588454-Submitting-receipts-memos-and-accounting-for-your-Ramp-transactions)).
  - For us: on "Add transaction", the receipt photo is one tap. A share target or "paste
    receipt" input is a later option.
- **Smart defaults.** Suggest the category, counterparty and project from the user's last similar
  transaction, so most saves need no typing beyond the amount.
- **Show why a check failed.** On iOS, when receipt verification fails, the app names the details
  that did not match ([Ramp mobile app support](https://support.ramp.com/hc/en-us/articles/5006739016211-Ramp-mobile-app)).
  - For us: show validation inline, per field. Never use a generic toast.

Desktop patterns to copy:

- **Inbox-style approvals.** One Inbox tab holds every pending item. Bulk approve works by checkbox
  or by a whole group ([Ramp support](https://support.ramp.com/expense-management/expense-review-and-approvals/);
  [Ramp blog](https://ramp.com/blog/simpler-more-efficient-expenses)).
  - For us: the external job queue and pending finance items.
- Ramp on desktop is a browser web app, with no native desktop app
  ([Ramp support](https://support.ramp.com/use-ramp-on-your-desktop)). This proves a top-rated
  finance product can run its whole desktop experience on the web.
- **Missing feature.** Users asked for keyboard shortcuts to approve on desktop
  ([Ramp community](https://community.ramp.com/t/reimbursement-approval-on-desktop-with-fewer-clicks/690)).
  We should add them; see Linear, pick 7.

### 2. Mercury: finance home, transactions table, team management

Benchmarks: finance list / detail, **add employee** (team invites on mobile), and the stats
dashboard on desktop.

Why it is the benchmark:

- iOS rating is 4.9 from 14K ratings ([App Store](https://apps.apple.com/us/app/mercury-powerful-banking/id1491984028)).

Mobile patterns to copy:

- **Home-screen widgets** for total balance, per-account balances and pending tasks
  ([Mercury, May 2025](https://mercury.com/blog/may-2025-product-updates)).
  - For us: a PWA cannot ship an iOS widget. Copy the idea instead: the partner balance is the
    first thing on the stats screen, readable at a glance.
- **Receipts from the Photos library, and drafts.** Receipts upload straight from Photos, and
  reimbursements save as drafts to finish later
  ([Mercury, Aug 2025](https://mercury.com/blog/august-2025-product-updates)).
  - For us: autosave a half-filled transaction as a draft. Losing input is the worst failure.
- **Add Admins and Employees from the mobile app**
  ([Mercury, Oct 2025](https://mercury.com/blog/october-2025-product-updates)). This is a direct
  benchmark for owner task 2.
- **Tap a merchant in transaction details** to see its other transactions
  ([App Store release notes](https://apps.apple.com/us/app/mercury-powerful-banking/id1491984028)).
  - For us: tap a counterparty or project chip to open a filtered list.

Desktop patterns to copy ([Mercury, transactions page](https://mercury.com/blog/updated-transactions-page)):

- One-click filters by date, keyword and amount, plus advanced filters.
- **Saved "Data Views".** The defaults are "My transactions", "Monthly money in" and
  "Monthly money out". (Not for us: saved views are out of scope, design §4.5b; URL-held
  filters only.)
- Group and sort from a Customize menu.
- **Bulk-edit** categories.
- **A cashflow chart that follows the table filters**, with a top-5 breakdown of money in and out.
  This is the pattern for our stats screen on desktop.
- Omnisearch has shortcuts ([Mercury, Feb 2024](https://mercury.com/blog/february-2024-product-updates)).
  The key bindings are not verified.

### 3. Copilot Money: charts and the stats screen in a dark theme

Benchmarks: **stats screen** (partner balance, monthly net-profit chart).

Why it is the benchmark:

- Apple Design Award finalist 2024 and Apple Editors' Choice
  ([App Store](https://apps.apple.com/us/app/id1447330651)).
- Apple published a developer article on how Copilot uses Swift Charts
  ([Apple Developer](https://developer.apple.com/articles/copilot-money)).

Patterns to copy:

- **A dark background so chart colours carry the meaning.** A third-party teardown says Copilot
  keeps income, spending and net in consistent colours, lets users tap a chart segment for a
  breakdown, and swipe between periods ([Blake Crosley teardown](https://blakecrosley.com/guides/design/copilot-money);
  third party).
  - For us: a month chart where tapping a bar opens that month's transactions, and a horizontal
    swipe or segmented control changes the period.
- **A palette safe for colourblind users.** Version 4.3 changed chart colours for red-green
  colourblindness ([Copilot](https://www.copilot.money/dispatch/accessible-charting)).
  - For us: never encode partner A vs partner B, or profit vs loss, by red/green alone.
    Add a sign, a label or a pattern.

Desktop:

- Not verified for Copilot. Use Mercury's chart-follows-filters pattern (pick 2) for the desktop
  stats layout.

### 4. Attio: CRM record pages, lists, and the desktop command layer

Benchmarks: **people profiles** (view and edit), teams / projects records, and the desktop
navigation model.

Why it is the benchmark:

- Attio is the reference for modern CRM data UI on desktop.
- 2026 mobile investment ([Attio changelog 2026](https://attio.com/changelog/2026)):
  - January: iOS redesign with Liquid Glass styling and record widgets.
  - April: full activity feed on mobile.
  - July: "Speed you feel on every tap".
- **Caveat: weak proof for mobile.** The iOS rating is 3.91 from only 23 reviews, and an analyst
  notes gaps on tablet ([Marlvel](https://marlvel.ai/apps/attio); third party). Copy Attio's
  desktop patterns. Use its mobile app as a record-page reference only.

Mobile patterns to copy:

- **The record page is the hub.** It shows the key attributes first, then the activity feed (the
  history of the record). The feed is how a phone user catches up before a meeting or a call.

Desktop patterns to copy ([Attio help, navigating](https://attio.com/help/reference/productivity-collaborating/navigating-your-workspace)):

- **Cmd/Ctrl+K quick actions from anywhere.** The list is contextual: the actions change with the
  current page. There are 30+ actions.
- **Single-key global shortcuts:** `n` note, `t` task, `c` compose email, `e` entry.
- **`?` opens the shortcut sheet.**
- Table-view shortcuts exist, but the bindings for inline cell edit are not verified.

### 5. HubSpot mobile (+ folk "Contacts"): proven mobile CRM and quick capture

Benchmarks: **add employee / user**, people profiles on the phone.

Why it is the benchmark:

- iOS rating about 4.7 from 14.5K–18.6K ratings, per trackers as of 2026-03
  ([AppPriceLab](https://apppricinglab.com/app/apple/1107711722); [App Store](https://apps.apple.com/app/id1107711722)).
- Vendor principle: the mobile app is "an extension of the web app, not a copy"
  ([HubSpot product blog](https://product.hubspot.com/blog/the-mobile-first-features-that-make-up-the-top-rated-hubspot-app)).

Patterns to copy:

- **Mobile-only capture.** Mobile adds capture that desktop does not need: a business-card scanner
  that creates a contact, and caller ID. A local cache makes data appear instantly (same source).
- **folk's mobile app (launched 2026-07-16)** shows the minimal quick-capture set
  ([folk changelog](https://www.folk.app/changelog/introducing-contacts-by-folk-our-mobile-app)):
  - one-tap add contact
  - card scanner
  - voice-to-text notes
  - a unified interaction log
  - fast search
- **For us: a short "Add person" form.** Ask only for name, email, role and team. Every other
  field is edited later on the profile. Do not copy the full desktop form to mobile.

Desktop:

- Not a benchmark. Use Attio (pick 4).

### 6. Ashby (+ Greenhouse mobile): recruiting

Benchmarks: **interviews**, vacancies, and the external job queue.

Why it is the benchmark:

- **Desktop:** G2 reviewers praise its pipeline view and Kanban. Dashboards are mentioned in 45
  reviews ([G2](https://www.g2.com/products/ashby-ashby)).
- **Mobile: proof that a web app is enough here.** Ashby ships its mobile experience as a mobile
  web app (`m.ashbyhq.com`), not a native app ([Ashby mobile guide](https://ashbyhq.notion.site/Ashby-Mobile-0d8445a37846416b9a4d5190b4799b28)).
- Native ATS apps are a weak benchmark. Teamtailor iOS has 2.8 from 8 ratings, and reviews
  report a job screen that keeps refreshing ([App Store](https://apps.apple.com/us/app/id1377551207)).
  Use it as an anti-pattern: a list that refreshes itself and steals the user's position.

Mobile patterns to copy:

- **A mobile home that is a task list, not a dashboard.** It shows upcoming interviews and overdue
  scorecards, each with a link to the briefing ([Ashby interviewer docs](https://docs.ashbyhq.com/getting-started-for-interviewers)).
- **Greenhouse mobile** uses the same idea. Its home shows interviews, scorecards due and pending
  approvals, with an Approvals panel and push prompts
  ([Greenhouse support](https://support.greenhouse.io/hc/en-us/articles/360000397992-Greenhouse-Recruiting-mobile-app)).
- **For us:** the mobile Interviews tab opens on "today / overdue feedback". A full pipeline board
  is desktop-only. Mobile changes the stage with a sheet, not by dragging.

Desktop patterns to copy:

- **A Kanban pipeline per vacancy.**
- **Dashboards for pipeline, conversion and source quality**
  ([Ashby analytics](https://ashbyhq.com/platform/recruiting/analytics); vendor).

### 7. Linear: interaction quality and speed (mobile and desktop)

Benchmarks: global navigation, teams / projects, and the "nothing ever blocks" rule for every screen.

Why it is the benchmark:

- Linear is the most-cited reference for software that "feels instant".
- Its mobile app is native Swift / Kotlin, redesigned in 2025
  ([Linear blog, Liquid Glass](https://linear.app/now/linear-liquid-glass)).

Mobile patterns to copy ([Linear blog](https://linear.app/now/linear-liquid-glass)):

- **A tab bar that can hold more than 5 items, adapted to the user's role.** Linear calls five
  "a sensible limit" for general apps but built its own bar for power users.
  - For us: 6 RBAC roles (ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP), so the tab set follows the role. Example: ACCOUNTANT gets Finance first,
    HR gets Vacancies and Interviews first.
- **Touch feedback.** A touched element "lifts" slightly, and over-dragging past an edge distorts
  the view slightly.
- **Variable edge blur** at the top and bottom of scroll views.
- **Solid outlines when Increase Contrast is on.**

Speed patterns to copy:

- **Local-first data and optimistic writes.** The UI updates locally first and syncs in the
  background ([performance.dev](https://performance.dev/what-makes-linear-feel-instant); third party).
- **For us:** TanStack Query optimistic mutations with rollback on error. Never use a full-screen
  spinner after a save.

Desktop patterns to copy ([Linear navigating guide](https://linear.app/enablement/guides/navigating-linear)):

- **Cmd/Ctrl+K command menu**: runs any action or jumps to any page by name.
- **`/` search** across the workspace.
- **`?` searchable shortcut help** ([Linear changelog](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help)).
- **Right-click context menus** that teach the shortcuts. Third-party source, not verified in
  official docs.

### 8. Things 3: the quick-entry pattern

Benchmarks: the **quick-add for transactions** and any "create" action on mobile.

Why it is the benchmark:

- Apple Design Award 2017 ([Cultured Code](https://culturedcode.com/things/blog/2017/06/back-from-wwdc/)).
- Still the canonical reference for low-friction capture.

Patterns to copy ([MacStories review](https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/);
[AppleInsider](https://appleinsider.com/articles/18/03/08/hands-on-things-34-for-mac-and-iphone-connects-apps-to-generate-to-do-tasks-faster)):

- **Ask for one field first.** "+" asks for the one essential field and saves. Other task
  managers open a full sheet.
- **Context sets the defaults.** Dragging the Magic Plus button chooses where the new item lands.
- **Haptic feedback on every action.**
- **For us:** one primary "+" in the thumb zone. In context it pre-fills: "+" on a project page
  creates a transaction with that project set. The first screen is amount + type + receipt,
  with everything else optional and collapsible.

Desktop:

- Things' Quick Entry hotkey works from anywhere. For us, a global `c` / Cmd+K "New transaction", shown only to roles that may create one.

### 9. Deel: onboarding and contracts

Benchmarks: **add employee** (onboarding), **edit contracts**, documents.

Why it is the benchmark:

- iOS rating 4.86 from 11.7K ratings ([AppGoblin](https://appgoblin.info/apps/6478083155);
  [App Store](https://apps.apple.com/app/id6478083155)).
- Capterra reviewers describe signing contracts on mobile, and some call mobile slower or missing
  features compared with desktop ([Capterra](https://capterra.com/p/205015/Deel/reviews/?page=2)).

Patterns to copy:

- **A contract is a document with a status.** Mobile handles review, sign and small edits
  (variables, dates). Heavy template editing stays on desktop.
- For our contract variables (`{{placeholders}}`), mobile edits **variable values in a form**,
  never raw template text.

HR directory:

- No strong benchmark found. Rippling reviews call the app slower for org-chart details
  ([SoftwareFinder](https://softwarefinder.com/hr/rippling/reviews?page=24)).
- HiBob iOS reviews complain that colleague search was removed
  ([App Store](https://apps.apple.com/us/app/id1297148884)).
- **For us:** the people directory copies Apple Contacts: an alphabetical list, a sticky search,
  and avatar + name + role rows.

### 10. Apple HIG + the web drawer (Vaul → Base UI Drawer): sheets, tab bars, and proof a web app can feel native

Benchmarks: every mobile modal / sheet, the tab bar, and admin settings (a grouped list, like
Settings).

Sources:

- **HIG sheets** ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/sheets)):
  - Sheets rest at detents (medium and large).
  - A grabber resizes the sheet.
  - Cancel is on the leading edge, Done on the trailing edge.
  - A full-screen modal is better for complex or long flows.
- **iOS 26** ([WWDC25 session 323](https://developer.apple.com/videos/play/wwdc2025/323/)):
  partial-height sheets are inset with a glass background and can morph out of the button that
  opens them.
- **HIG tab bars** ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/tab-bars)):
  - A tab bar is for navigation only, not for actions.
  - Each tab keeps its own navigation state.
- **Vaul** is the React drawer under shadcn/ui `Drawer`. It was built to bring the feel of Apple's
  sheet to the web: drag-to-dismiss, physics that slow down before stopping, and correct input
  handling ([Emil Kowalski](https://emilkowal.ski/ui/building-a-drawer-component);
  [GitHub](https://github.com/emilkowalski/vaul)).
  - Correction (2026-11-11): Vaul is not installed here, and shadcn's current `Drawer` is built on
    Base UI. The design doc (§3) picks Base UI `Drawer` (owner approved).

Proof that a web app can feel native:

- **Twitter Lite PWA** ([web.dev case study](https://web.dev/case-studies/twitter)):
  - +65% pages per session.
  - 250K daily users launch it from the home screen.
- **iOS 26:** every site added to the Home Screen opens as a web app by default
  ([WebKit, WWDC25](https://webkit.org/?p=16993);
  [heise](https://heise.de/-10749652)).

Patterns to copy:

- **Mobile:** a sheet with medium and large detents for create / edit on short forms.
  A full-screen route for long forms: contract, full profile.
- **Desktop:** the same component becomes a right-side panel (record preview) or a centred
  dialog. Esc always closes it.

---

## Scoring rubric (mobile + tablet + desktop)

Score each screen 0–10 on each criterion against the named benchmark, multiply by the weight, and
sum. The maximum is 100. Score mobile (< 640 px), tablet (640–1023 px) and desktop (≥ 1024 px)
separately; each class gets its own score. On tablet, apply the mobile rule for touch and the
desktop rule for layout. Where a criterion differs by device,
the column says how.

| #   | Criterion                     | Weight | 10 looks like (benchmark)                                                                                                                                            | Mobile vs desktop difference                                                                                                                                |
| --- | ----------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Time-to-task                  |     15 | Primary task in the fewest steps; smart defaults (Ramp, Things)                                                                                                      | Mobile: count taps, one thumb, primary action in bottom third. Desktop: count keystrokes, reachable without mouse (Cmd+K / single-key)                      |
| 2   | Never blocks (responsiveness) |     15 | Optimistic update, instant feedback < 100 ms, no blocking spinner, no input lost (Linear)                                                                            | Same on both. Mobile also: no layout jump when the keyboard opens                                                                                           |
| 3   | Navigation and wayfinding     |     10 | User always knows where they are and how to go back; role-aware sections (Linear, HIG)                                                                               | Mobile: bottom tab bar ≤ 5 + "More", in-app back control (standalone has none). Desktop: sidebar + Cmd+K + `?` shortcut sheet                               |
| 4   | Forms and input ergonomics    |     10 | Minimal required fields, correct keyboard types, inline validation, no input lost on error or accidental close (Mercury, HubSpot; persisted drafts are out of scope) | Mobile: inputs ≥ 16 px, `inputmode`, receipt via camera or library, keyboard never covers the focused field. Desktop: Tab order, Enter submits, inline edit |
| 5   | Lists and tables              |     10 | Scannable rows, key value right-aligned, URL-held filters (Mercury, Attio; saved views are out of scope, design §4.5b)                                               | Mobile: 2-line rows, swipe actions from the trailing edge only, sticky search. Desktop: dense table, inline edit, bulk select, column sort                  |
| 6   | Sheets, panels, gestures      |      8 | Right container for the job; drag-to-dismiss; no gesture conflicts (HIG, Base UI Drawer)                                                                             | Mobile: detented sheet for short forms, full screen for long ones, no left-edge swipe. Desktop: side panel for preview, dialog for confirm, Esc closes      |
| 7   | System states and feedback    |     10 | Skeletons not spinners, useful empty states with an action, recoverable errors, undo                                                                                 | Same on both. Mobile: progressive haptic tick on success (iOS 18 switch trick)                                                                              |
| 8   | Data visualisation (stats)    |      7 | Answer visible in 2 s; tap / hover drill-down; colour-blind-safe; sign not colour (Copilot)                                                                          | Mobile: one chart per screen, tap a bar for detail, swipe the period. Desktop: chart follows table filters (Mercury)                                        |
| 9   | Platform fit                  |      8 | Respects safe areas, viewport, standalone mode, dark-theme contrast (see constraints below)                                                                          | Mobile: the constraints section below. Desktop: works at 1024–2560 px, no stretched line length                                                             |
| 10  | Accessibility (WCAG 2.2 AA)   |      7 | Labels, focus order, contrast ≥ 4.5:1, reduced motion, zoom not disabled                                                                                             | Mobile: targets ≥ 44 px (HIG). Desktop: visible focus ring, full keyboard operation                                                                         |

Anchors for every criterion:

- **0** = the benchmark pattern is absent or broken.
- **5** = it works, but has friction a reviewer can name.
- **10** = it matches or beats the benchmark.

A score under 5 on criterion 2 or 4 blocks the screen, whatever the total.

---

## iOS Safari / PWA constraints

Every item has an action for us.

1. **Safe areas.**
   - Set `viewport-fit=cover` in the viewport meta tag.
   - Pad the fixed top bar, the bottom tab bar and sheet footers with `env(safe-area-inset-*)`
     ([MDN `env()`](https://developer.mozilla.org/en-US/docs/Web/CSS/env)).
   - With `viewport-fit=cover` and no padding, content sits under the notch and the home indicator.
2. **Viewport height.**
   - Use `100dvh` for the app shell, or `svh` for regions that must not jump.
   - Never use `100vh`: on iOS it measures the large viewport, so the bottom bar is hidden behind
     Safari's toolbar.
   - `dvh` / `svh` / `lvh` are Baseline in every current engine
     ([web.dev viewport units](https://web.dev/blog/viewport-units)).
3. **Keyboard covers inputs.**
   - iOS Safari resizes the visual viewport, not the layout viewport. Fixed footers and focused
     inputs can end up under the keyboard.
   - `interactive-widget=resizes-content` is **not** supported in Safari
     ([WebKit bug 259770](https://bugs.webkit.org/show_bug.cgi?id=259770); still open per an
     [Aug 2026 W3C list post](https://lists.w3.org/Archives/Public/public-webapps-github/2026Aug/0162.html)).
   - Use the `VisualViewport` API (`resize` / `scroll` events) to lift sheet footers and scroll
     the focused field into view ([MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)).
4. **Input zoom.**
   - iOS zooms into any input whose font size is under 16 px.
   - Set inputs, selects and textareas to ≥ 16 px (`1rem`)
     ([CSS-Tricks](https://css-tricks.com/?p=339455)).
   - Do **not** use `maximum-scale=1` / `user-scalable=no`. It blocks pinch-zoom and fails
     WCAG 1.4.4 ([HeroUI issue](https://github.com/heroui-inc/heroui/issues/5326)).
5. **Standalone mode.**
   - A Home Screen web app has no browser back button. Every pushed screen needs an in-app back
     control ([Netguru](https://www.netguru.com/blog/pwa-ios)).
   - VoiceOver users in standalone mode report they cannot reach any back function
     ([AppleVis, Nov 2025](https://www.applevis.com/forum/ios-ipados/pwa-accessibility-issue-inability-use-back-function-voiceover-iphone)).
   - Detect the mode with `@media (display-mode: standalone)`.
   - From iOS 26, every site added to the Home Screen opens as a web app by default (see pick 10).
   - EU: Apple reversed its iOS 17.4 plan to remove Home Screen web apps
     ([Tom's Guide](https://www.tomsguide.com/phones/iphones/apples-backtracking-on-plans-to-kill-iphone-home-screen-web-apps-in-the-eu-heres-why)).
6. **Back-swipe conflicts.**
   - Standalone PWAs support edge-swipe back since iOS 12.2 ([firt.dev](https://firt.dev/ios-12.2/)),
     but users call it finicky ([Discourse meta](https://meta.discourse.org/t/back-button-in-ios-pwa/93909)).
   - Never start a horizontal gesture (row swipe, carousel, chart period swipe) at the left screen
     edge.
   - Row swipe actions reveal from the trailing (right) edge only.
7. **Overscroll.**
   - `overscroll-behavior` is supported since Safari 16
     ([Safari 16 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-16-release-notes)).
     Use `contain` on sheets and scroll panels to stop scroll chaining to the page.
   - Known bugs:
     - it does not disable pull-to-refresh ([WebKit 275947](https://bugs.webkit.org/show_bug.cgi?id=275947));
     - it does nothing when the content does not overflow ([WebKit 243452](https://bugs.webkit.org/show_bug.cgi?id=243452)).
8. **File picker (receipts).**
   - `<input type="file" accept="image/*,application/pdf">` **without** `capture` lets iOS offer
     camera, photo library and Files.
   - `capture="environment"` forces the camera and removes the library
     ([MDN `capture`](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/capture)).
     Receipts are often screenshots or PDFs. Monzo users asked for exactly this
     ([Monzo community](https://community.monzo.com/t/add-receipt-needs-to-be-from-ios-file-locations-not-just-pictures/31236/2)).
   - Show a thumbnail immediately and upload in the background (optimistic).
9. **Haptics.**
   - Safari has no Vibration API.
   - Safari 18 gives haptic feedback for `<input type="checkbox" switch>`
     ([Safari 18 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes)).
     Libraries trigger it with a hidden switch ([ios-haptics](https://unpkg.com/ios-haptics@3.1.1/README.md)).
   - The attribute is non-standard and could change
     ([WebKit 285120](https://bugs.webkit.org/show_bug.cgi?id=285120)). Treat it as progressive
     enhancement only.
10. **Push and badges.**
    - Web Push and the Badging API work only for Home Screen web apps (iOS 16.4+).
    - The permission request must follow a direct user action
      ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
    - Ask from a settings toggle, never on app load.

---

## Not verified / gaps

- Attio table inline-edit key bindings.
- Mercury key bindings.
- Whether Copilot has a desktop app.
- Mobbin / Refero galleries were not reachable by search (Lazyweb has no Ramp screens yet), so no
  screen-level gallery links are included.
- No independent UX teardown was found for Ramp or Revolut Business. Their speed claims are vendor
  claims.
