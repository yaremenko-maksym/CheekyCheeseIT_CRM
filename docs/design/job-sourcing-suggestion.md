# job-sourcing-suggestion — design spec (degraded, retroactive gate closure)

**Status:** the design-gate is being closed after the fact — PR #493 (`feature/job-sourcing-slice1`) implemented
the screen without going through the designer BEFORE layout (the task had no `## Design tier:` set, the default
Tier 1 did not trigger). This spec is Mode A text documentation + a Mode B fidelity audit of the live
screen, retroactively closing the gate per `.claude/rules/common/design-gate.md`.
**Design tier:** 1 (new component/flow), actually handled as **degraded** — there is no mockup in
Claude Design (`fidelity: degraded`, see the PR comment).
**Components:** `apps/web/app/components/job-sourcing/JobSuggestionDialog.tsx`,
`apps/web/app/routes/_authenticated/interviews/index.tsx` (entry point — the «Подбор вакансий» button).

## 1. Direction (frontend-design-direction)

- **Purpose:** HR/ADMIN pick external vacancies (DOU RSS) for a specific senior and advance the
  queue one card at a time: look → open the original → mark the outcome. The same screen is used by the senior
  for their own queue — without the right to see anyone else's.
- **Audience:** HR — several times a week per person on their team, scans title/company/
  date, the decision is made in seconds («fits / doesn't fit»). SENIOR — occasionally, the same pattern
  for themselves. Both are already familiar with the interviews kanban — the dialog opens from the same toolbar.
- **Tone:** `dense / quiet / scannable` — identical to the rest of the CRM (dark theme, a dialog card rather than
  a separate page; the vacancy markdown text is the only «reading» block, everything else is
  metadata and three actions).
- **Memorable detail:** «one vacancy at a time» instead of a list/table — the same queue pattern as the
  kanban columns next to it; an answer («Откликнулись»/«Не подходит») immediately pulls up the next one, without
  an intermediate list. The «Осталось: N» counter in the header is the only navigation hint.
- **Constraints:** Tailwind v4, shadcn/ui/`CrmDialogContent`, Russian UI, WCAG 2.2 AA,
  responsive 320/375/768/1024/1280/1440/1920, zero new npm packages beyond the already used
  `react-markdown` (added by this PR deliberately — the only safe way to render a vacancy from a
  public board without `dangerouslySetInnerHTML`).

## 2. Component mapping (reused 1:1, NO new primitives introduced)

| Screen element            | `apps/web` component                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dialog container          | `Dialog` + `CrmDialogContent` (`maxWidth="sm:max-w-2xl"`) (`@/components/ui/crm-dialog`)                              |
| Dialog title/description  | `CrmDialogHeader` + `DialogTitle` + `DialogDescription` (`sr-only`)                                                   |
| Scrolling body            | `CrmDialogBody`                                                                                                       |
| Fixed footer with actions | `CrmDialogFooter` (mobile `flex-col-reverse`, inherited from the primitive)                                           |
| Three actions             | `Button` `variant="outline"` × 2 + `Button` default (primary action «Откликнулись»)                                   |
| Add-exclusion field       | `Input` (`@/components/ui/input`)                                                                                     |
| Icons                     | `lucide-react`: `Search`, `ExternalLink`, `Loader2`, `ThumbsUp`, `ThumbsDown`, `X`                                    |
| Vacancy text              | `react-markdown` with custom `urlTransform`/`components` (see §5 — this is a security layer, not a decorative choice) |

NO new components were created — the whole screen is assembled from existing `ui/` primitives. This matches the
`dense/quiet` direction: no standalone «vacancy card» outside the already established
`CrmDialogContent`.

## 3. Token map (only existing `globals.css` tokens, no raw values)

Verified by reading `JobSuggestionDialog.tsx` — only semantic Tailwind classes are used,
resolving to the CSS variables of `@theme inline` (`apps/web/app/styles/globals.css`):

| Class in code                                              | Token                                            |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `bg-card` / `border-border` (via `CrmDialogContent`)       | `--color-card`, `--color-border`                 |
| `text-foreground` / `text-muted-foreground`                | `--color-foreground`, `--color-muted-foreground` |
| `text-destructive` (load error)                            | `--color-destructive`                            |
| `bg-muted` (hover of chips/delete button)                  | `--color-muted`                                  |
| `rounded-full` / `sm:rounded-xl` (via the primitive)       | `--radius` family                                |
| `ring`/`focus:ring-ring` (inherited from `Button`/`Input`) | `--color-ring`                                   |

There is not a single hex/rgb/arbitrary gradient in the file — confirmed by reading the source. The theme is dark
only (the app has no light/dark toggle in either `nav-sidebar` or `ThemeProvider`), so
dark/light parity does not apply — the whole CRM is single-theme.

## 4. States

| State                    | What is shown                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue loading            | `Loader2` (spinner) + «Загрузка вакансий…», `data-testid="job-suggestion-error"` is not rendered                                                            |
| Load error               | «Не удалось загрузить вакансии. Попробуйте позже.» — `text-destructive`, no retry button (deliberate: reopening the dialog refetches)                       |
| Empty (no suitable ones) | «Подходящих вакансий нет» + hint «Новые появятся после следующего сбора — или ослабьте исключения ниже» — the exclusions panel stays visible and functional |
| Vacancy present          | Title → company/location/date → markdown description → exclusions panel                                                                                     |
| Exclusions loading       | «Загрузка…» as text inside the panel (does not block the rest of the dialog)                                                                                |
| Long description         | Internal scroll of `CrmDialogBody` (`flex-1 overflow-y-auto`) — the title and the footer with buttons are pinned                                            |

## 5. Markdown / security hardening (affects visuals, hence recorded in the spec)

`descriptionMd` is an untrusted source (a public job board). The render deliberately does NOT show
images (`img: () => null`) and does NOT trust arbitrary hosts in links (`urlTransform` /
custom `a` component, https-only, `rel="noopener noreferrer nofollow"`). This is both a
security requirement (see security-review rounds 1-3 in the PR) and a design decision: a vacancy must not pull
external images into our authenticated origin. This does not violate the design system — `prose prose-sm
dark:prose-invert` is already used as the pattern for markdown content elsewhere in the CRM.

## 6. Responsive behavior (4 device classes)

Verified live on a real dev stack (not a mock), Playwright, 07.08.2026 — see §8 (fidelity audit).

| Class        | Tested widths | Behavior                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile       | 320, 375, 393 | Dialog = 100% of viewport width (`w-full`, the `sm:` breakpoint does not apply yet). Footer `flex-col-reverse`: «Открыть оригинал» (`order-last`) is visually FIRST from the top, then «Не подходит», then «Откликнулись» — all three full-width, `min-h-[44px]`. Exclusions panel — the input field and the «Добавить» button stacked (`flex-col`). |
| Tablet       | 768           | `sm:` is active → `maxWidth="sm:max-w-2xl"` not yet reached (768 < 672? no, 672<768 — in fact at 768 the dialog already hits the `672px` cap and is centered) — measured: dialog width 672px, footer — a regular row (`sm:flex-row`), buttons `sm:w-auto`.                                                                                           |
| Laptop       | 1024, 1280    | Dialog is stably 672px centered, unchanged relative to tablet.                                                                                                                                                                                                                                                                                       |
| Large screen | 1440, 1920    | Dialog stays 672px (does not stretch to full width — a readable text column for the vacancy), centered.                                                                                                                                                                                                                                              |

No horizontal overflow (`document.documentElement.scrollWidth > clientWidth`) was detected at any
of the 7 tested widths — neither in the empty state nor with a realistic long description
(a long URL, an unbreakable «hashtag» token, a long vacancy title).

## 7. Accessibility (WCAG 2.2 AA)

| Criterion                            | Status                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC 2.4.11 Focus visible / focus trap | Inherited from the Radix `Dialog` (the same primitive as across the CRM) — focus is trapped inside the dialog, Escape closes it. Not overridden in this component.                                                                                                                                                    |
| SC 1.4.3 Contrast                    | Inherited from the `text-foreground`/`text-muted-foreground` tokens on `bg-card` — the same pattern as everywhere in the CRM, not separately overridden.                                                                                                                                                              |
| SC 2.5.8 Target size (24×24 min.)    | The three main actions — `min-h-[44px]` (mobile threshold, see `responsive-design.md`). The «Закрыть» button (X, inherited from `CrmDialogContent`) — 24×24, system, not specific to this screen. The manual-exclusion delete button — **was 20×20 (violation), fixed in this pass to 24×24** (see §8, cosmetic fix). |
| aria-label on icon-only              | The «Закрыть» button — `aria-label="Закрыть"` (primitive). The exclusion delete button — `aria-label="Удалить исключение {компания}"`. The three main actions — icon+text, not icon-only, a separate aria-label is not required.                                                                                      |
| `DialogTitle`/`DialogDescription`    | Present (`DialogDescription` — `sr-only`), conforms to the `CrmDialogContent` contract.                                                                                                                                                                                                                               |

## 8. Fidelity audit (Mode B, live stack, 07.08.2026)

There is no `design.png` reference (Claude Design was not run for this task) → the audit is against this spec
and `docs/design/foundation.md` (`fidelity: degraded`, reason: the task went into implementation without the design-tier
gate). The full report with numbers and screenshots is a comment in PR #493. In brief:

- **A specific suspicion from the code reviewer was checked** («dialog 858px in a 393px viewport», incompatible with
  the green test at 320) — measuring the live (unmutated) component at 320/375/393/768/1024/1280/1440/1920
  showed **no overflow at all eight widths** (dialog width == viewport width on mobile,
  672px at ≥768). The 858px figure comes from the code reviewer's PR comment: it was obtained by **mutation testing**
  (a `className="min-w-[900px]"` injection into `CrmDialogContent`) to prove that the assert
  `documentElement.scrollWidth > clientWidth` in `job-sourcing-mobile.spec.ts:253-260` does not catch the overflow
  of a `position: fixed` element — this is a finding about **test quality** (AutoTest/Coder zone, not about a real
  visual defect). There is no such overflow in the current code.
- **Found and fixed (cosmetic, within this pass):** the manual-exclusion delete button was
  20×20px — below the WCAG 2.5.8 minimum. The fix: `h-5 w-5 min-h-[20px] min-w-[20px]` →
  `h-6 w-6 min-h-[24px] min-w-[24px]` (`JobSuggestionDialog.tsx`, a single line). Verified:
  ESLint clean, visually — the fix does not break the chip layout.
- **Found and NOT fixed (a functional bug, not cosmetics — left to the coder):** a SENIOR, opening
  their own queue, cannot add a manual exclusion via «Добавить» — the button is visually
  active, but `ExclusionsPanel.submit()` (`JobSuggestionDialog.tsx:116`) silently returns on
  `!seniorId`, and for self-view the `seniorId` prop is intentionally `undefined` (see
  `interviews/index.tsx`: `seniorId={isSenior ? undefined : effectiveSeniorId}`). No error, no toast —
  the request does not reach the backend at all (confirmed by the API log: 0 POST requests on click). For HR/ADMIN
  (who pass an explicit `seniorId`) the button works normally — reproduced. «Удалить» on a manual exclusion
  works for SENIOR (not tied to `seniorId` on the client) — the asymmetry reinforces the impression of a bug rather than
  an intentional restriction.

## 9. Edge cases

- A long vacancy title — wraps by words (`h2` with no extra class, the browser by default
  wraps on spaces), verified at 320px with an 80-character title.
- A long continuous string in the description (a URL with query parameters, a «hashtag» without spaces) — wraps
  inside the `prose` block (`break-words` on the container), creates no overflow.
- Company/location without a publication date — the optional `·` segments in the paragraph render conditionally,
  the layout does not break (verified by the JSX structure, `current.posting.location &&` / `publishedAt &&`).
- An empty queue with the exclusions panel active — both blocks coexist, scrolling works.

## 10. Known limitations (outside the designer's zone)

- The functional bug of §8 (SENIOR self-create exclusion) — requires a fix to how `seniorId` is passed down in
  `apps/web/app/routes/_authenticated/interviews/index.tsx` / `use-job-sourcing.ts`, Coder zone.
- The test gate of §8 (a dead assert in `job-sourcing-mobile.spec.ts:253-260`) — AutoTest/Coder zone,
  described in detail in the code reviewer's PR comment, not duplicated here.
