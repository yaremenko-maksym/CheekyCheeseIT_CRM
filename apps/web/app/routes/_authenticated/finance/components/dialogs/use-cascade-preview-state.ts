import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import { amountsDiffer, type TransactionDto } from '@crm/shared'
import { parseStrictAmount } from '@/lib/utils'
import { getAxiosStatus } from '@/lib/axios-utils'
import { financeApi } from '../../api'
import {
  canSaveCascadeEdit,
  CASCADE_PREVIEW_LEAD_IN_MESSAGE,
  cascadePreviewErrorMessage,
  needsCascadePreview,
} from '../../cascade-preview'

/**
 * Everything the admin edit dialog derives from the cascade preview of an
 * amount edit: the debounced figure, the query, the "plan on screen is the
 * plan for this figure" checks, the panel's sticky mount and the Save gate.
 * Moved verbatim out of `AdminEditTransactionDialog` (behaviour-preserving
 * split, QA-LOW-4); the comments below keep their original review ids.
 */
export function useCascadePreviewState(tx: TransactionDto | null, amount: string) {
  const { t, i18n } = useLingui()

  // Stryker disable next-line StringLiteral: unobservable — the mount effect below sets this from `tx` before any render can read it, the same shape as the documented `useState` default in SettleSeniorPayoutDialog
  const [debouncedAmount, setDebouncedAmount] = useState('')
  /**
   * COPY-M-7 (copy-review, MED, PR #613 round 3) — sticky mount for
   * `CascadeImpactPanel`. See the latch below (after `liveAmountNeedsPreview`)
   * for what sets this `true`; reset here, per-`tx`, alongside every other
   * per-row field.
   */
  // Stryker disable next-line BooleanLiteral: unobservable through any test that lets effects settle — the mount effect below sets this to `false` from `tx` before an assertion can read the raw default (same shape as the `debouncedAmount` suppression a few lines up). A direct-mutation check confirms this: replacing `false` with `true` here still passes CP-0 (added specifically to try to catch it) because `render()`'s own `act()` flushes the mount effect's `setCascadePanelEngaged(false)` before the test's first assertion ever runs
  const [cascadePanelEngaged, setCascadePanelEngaged] = useState(false)

  // Per-`tx` reset of the two states owned here (the dialog resets the rest).
  useEffect(() => {
    if (!tx) return
    setDebouncedAmount(parseFloat(tx.amount).toString())
    setCascadePanelEngaged(false)
  }, [tx])

  // task-cascade-preview-ui (task 5). Editing the amount of a PAID row drags
  // shares and obligations with it, and the server refuses such an edit unless
  // the operator has seen the plan and sends its version back. Everything below
  // is what makes that possible from the interface.
  //
  // 400 ms rather than per-keystroke: «10000» is five requests otherwise, four
  // of them describing a cascade for a number nobody meant («1», «10», …).
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(timer)
  }, [amount])

  const parsedPreviewAmount = parseStrictAmount(debouncedAmount)
  // `needsCascadePreview` (cascade-preview.ts) is the SAME six-decimal
  // comparison the server uses to decide whether an edit is a cascade edit at
  // all. A local copy would agree until the first rounding boundary and then
  // ask for a preview the server would not honour.
  const shouldPreview = needsCascadePreview(tx, parsedPreviewAmount)

  const previewQuery = useQuery({
    // Stryker disable next-line StringLiteral: the literal is a NAMESPACE, not a value — replacing it with '' keeps the key just as unique (id + amount still discriminate every entry), so no cache behaviour changes. What the key must actually do — give a different amount a different entry — is pinned by CP-18
    queryKey: ['cascade-preview', tx?.id, parsedPreviewAmount],
    queryFn: () => financeApi.getEditCascadePreview(tx!.id, parsedPreviewAmount),
    enabled: shouldPreview,
    // A refusal (`editable: false`) is a 200 with a reason, so retries have
    // nothing to do with it. What they DO affect is a real connection failure:
    // without this the panel would sit in «пересчитываем…» for seconds while
    // three doomed attempts run, dressing a network error up as work.
    retry: false,
  })

  const preview = shouldPreview ? previewQuery.data : undefined

  // UX-6 (design fidelity, HIGH) — THREE states, named, because conflating two
  // of them left a live Save button over an empty panel.
  //
  //   not asked   — `!shouldPreview`: an ordinary edit, no cascade, no panel
  //   in flight   — `previewIsRecomputing` below: skeleton, Save held
  //   FAILED      — here: banner + retry, Save held
  //
  // The old code only knew «network error» (`status === undefined`). A bare 500
  // with no body — what a dev proxy returns when the API is down, found by
  // stopping the process — has a status, so it fell through every branch: no
  // banner, and `canSaveCascadeEdit(undefined) === true` kept Save live. A
  // failed preview was literally indistinguishable from one never requested.
  const previewFailed = shouldPreview && previewQuery.isError

  // The TEXT still distinguishes the two kinds, which is what CP-19 protects:
  // sending someone to check their wifi over a message the server took the
  // trouble to write is its own defect. A request that never got an answer
  // keeps the panel's own short line.
  //
  // COPY-M-3 (copy-review, MED, PR #613 round 2): anything the server
  // actually answered used to be rendered by `getUserFacingErrorMessage` —
  // the project's GENERAL resolver (backend message → Russian text per
  // status → generic). Reusing it looked right — a genuine backend
  // explanation still comes through it verbatim, and it never surfaces
  // axios's raw English `.message` — but its status-derived FALLBACK is a
  // different register: full sentences with a closing period, sometimes two,
  // first person plural ("Мы уже знаем о проблеме"), landing in the exact
  // banner slot that otherwise carries this screen's own one-clause,
  // no-period, impersonal lines. `cascadePreviewErrorMessage`
  // (`cascade-preview.ts`) keeps the same priority — a real backend message
  // still wins first, verbatim — and gives only the fallback tail this
  // screen's own voice; see its own doc.
  const previewErrorMessage = !previewFailed
    ? null
    : getAxiosStatus(previewQuery.error) === undefined
      ? t`${i18n._(CASCADE_PREVIEW_LEAD_IN_MESSAGE)} — перевірте з’єднання`
      : cascadePreviewErrorMessage(previewQuery.error)

  // SR-H-1 (security-review, HIGH). Is the plan on screen the plan for the
  // figure currently in the field?
  //
  // The version token is `id` + `updatedAt` of the source and its derivatives
  // — it does NOT encode the amount. So a token proves «the world has not
  // moved», never «this is the plan you were shown». The server, holding a
  // valid token, recomputes the cascade for whatever amount arrived and
  // applies it. Between the 400 ms debounce and the live `amount` there was a
  // window where those two were different figures, and a save inside it
  // rewrote shares, reopened obligations and voided an invoice for a number
  // the operator had never seen a plan for. Measured, not argued: the probe
  // submitted 90 000 carrying the token of the 25 000 plan (CP-24).
  //
  // `amountsDiffer` — the same six-decimal comparison the server uses — so
  // this cannot disagree with it at a rounding boundary.
  //
  // SR-L-1 (security-review, for the record): none of this makes «the operator
  // saw a preview» a PROVABLE property. `computeCascadeVersion` concatenates
  // ids and `updatedAt`s that are already visible in ordinary API responses —
  // it is not a MAC — so a scripted ADMIN caller can assemble a token without
  // ever opening the panel. Acceptable under the current threat model (the
  // endpoint is ADMIN-only, and such a caller can request a real preview
  // anyway); written down so the guarantee is not over-read.
  const previewAmountIsCurrent =
    shouldPreview && !amountsDiffer(parsedPreviewAmount, parseStrictAmount(amount))

  // Backlog finding 107. `shouldPreview` above is built off the DEBOUNCED
  // figure, deliberately — the same lag that keeps five keystrokes from
  // firing five previews (CP-17). But the debounce (the effect above) is a
  // TRAILING one, restarted on every change to `amount` — so it is NOT a
  // bounded ~400 ms lag after the first edit (an earlier round of this fix
  // said so, and PR #613 round 2 corrected it): while the operator keeps
  // typing, `debouncedAmount` never catches up at all, and `shouldPreview`
  // stays false for the whole burst. Right after the FIRST keystroke
  // `debouncedAmount` still equals `tx.amount`, so `shouldPreview` read
  // false, no plan was ever asked for, and Save stayed enabled. A click
  // inside that window sent the new amount with no version token; the
  // server refused it pointing at a preview panel that was not even mounted
  // to open. `needsCascadePreview` run against the LIVE amount — the SAME
  // rule `shouldPreview` uses, just not lagged — answers "does the figure on
  // screen right now need a plan", independent of whether the debounce has
  // caught up to ask for one yet.
  const liveAmountNeedsPreview = needsCascadePreview(tx, parseStrictAmount(amount))

  // COPY-M-7 (copy-review, MED, PR #613 round 3) — the panel must not
  // UNMOUNT through a keystroke-level dip to a state that momentarily needs
  // no preview, on the two most common paths through a first edit:
  //
  //   1. erasing the old amount character-by-character passes through ""
  //      (`liveAmountNeedsPreview` false: `parseStrictAmount('')` is NaN) at
  //      the exact instant `debouncedAmount` — pinned at the ORIGINAL value
  //      for the whole burst, since no debounce has fired yet — also equals
  //      `tx.amount` (`shouldPreview` false too);
  //   2. typing the new figure passes back THROUGH the original digits
  //      before continuing past them (e.g. "5"→"50"→"500"→"5000"→"50000"
  //      when the stored amount is 5000) — at "5000" both flags are false
  //      for the same reason.
  //
  // Both are transient by construction — `shouldPreview` (debounced) or
  // `liveAmountNeedsPreview` (live) goes true again on the very next
  // keystroke — but a bare `(shouldPreview || liveAmountNeedsPreview)` mount
  // condition cannot tell "transient dip" from "operator settled back to the
  // original value and stopped", because both look identical at the instant
  // they happen: unmounts the panel, then remounts it a keystroke later.
  // Measured (manual QA, live-reproduced): ~40px layout jump, and the
  // aria-live status paragraph — which lives INSIDE the panel — is torn out
  // and reinserted with the SAME text, which a screen reader can announce
  // twice for one edit.
  //
  // Deliberately NOT folded into `shouldPreview`/`liveAmountNeedsPreview`
  // themselves, and deliberately NOT read by `cascadeSaveBlocked` or the
  // preview `enabled`/`isLoading` gates below — those answer "may I fetch /
  // may I save right now" and must stay keystroke-precise; narrowing them
  // for display would risk narrowing them for money too. This flag answers
  // a different question, purely for the panel's mount/unmount: has a PAID
  // row's amount genuinely needed a plan at least once during this edit.
  //
  // Set here (during render, not in a `useEffect`) so the FIRST render where
  // either flag goes true already has the flag latched for every render
  // after it — a dip can only occur on a LATER keystroke, by which point an
  // effect would already have committed too, but this has no extra render
  // to wait for. React's own docs describe exactly this pattern
  // ("adjusting state when a prop changes"/"storing information from
  // previous renders"): a guarded `setState` call in the render body that
  // bails out immediately if the value would not change.
  if ((shouldPreview || liveAmountNeedsPreview) && !cascadePanelEngaged) {
    setCascadePanelEngaged(true)
  }

  // CR-M-1 (code-review, MED) — the same window, its visible half. `isFetching`
  // only rises once a request is actually in flight, so during the debounce the
  // panel showed the PREVIOUS plan with nothing marking it stale — exactly the
  // moment a click looks safest. The recompute indicator now covers the whole
  // window, not just the request.
  const previewIsRecomputing = shouldPreview && (previewQuery.isFetching || !previewAmountIsCurrent)

  // `canSaveCascadeEdit(undefined)` is `true` on purpose — an ordinary,
  // non-cascade edit must never be blocked by this feature. That is why the
  // in-flight case needs its own clause: on a cascade edit with no answer yet,
  // a click used to send the amount with no token at all and earn a guaranteed
  // 400 (fail-closed, but it reads as a broken screen).
  // COPY-H-2 (copy-review, HIGH): the button and the note answer DIFFERENT
  // questions, and this line used to conflate them.
  //
  //   «may I press Save right now?»  — no, an answer is still in flight
  //   «why can this row never be saved?» — a property of data already written
  //
  // Only the second is something the operator can act on, and only the second
  // is what the note's text describes. Widening `cascadeSaveBlocked` to cover
  // the recompute window (correct for the BUTTON — that is CR-M-1/SR-H-1) also
  // dragged the note into two ordinary happy-path states: the first request in
  // flight (`preview === undefined`, and `undefined !== false` satisfied the
  // note's own guard) and the debounce window after every keystroke. In both
  // the screen said «Пересчитываем связанные выплаты…» above and «по отмеченным
  // строкам сумму не пересчитать, нужно ручное решение» below — simultaneously,
  // about the same moment, with nothing marked and nothing to decide.
  //
  // No extra «Сохранить можно после пересчёта» line is added in its place. The
  // reason is already on screen and already announced: `previewIsRecomputing`
  // implies `shouldPreview`, so the panel is mounted with `isLoading` set and
  // its `aria-live` status reads the recompute out loud. A second sentence at
  // the bottom would rebuild, in miniature, the very «two texts for one state»
  // that COPY-H-1 removed. (WCAG 1.4.13 is Content on Hover or Focus and says
  // nothing about disabled controls; no success criterion demands a visible
  // reason next to one.)
  //
  // COPY-H-1 (copy-review, HIGH), one round later: this premise held for
  // `previewIsRecomputing` but NOT for the term below,
  // `(liveAmountNeedsPreview && !previewAmountIsCurrent)` — finding 107's own
  // term, which widens the BUTTON's gate but, until this round, widened
  // nothing about the PANEL. In that term's own window `shouldPreview` is
  // false by construction (that is its entire point), so the panel — mounted
  // on `shouldPreview` alone — was not on screen at all: no skeleton, no
  // `aria-live`, nothing to read. Fixed at the panel's mount condition and
  // `isLoading` prop below (same live rule, `liveAmountNeedsPreview`, not a
  // new one), not by moving this comment — with that fix in place, mounting
  // the panel now tracks every disjunct of `cascadeSaveBlocked` below,
  // including this one, so the premise above is finally true for the whole
  // gate, not just its first two thirds.
  const cascadeSaveBlockedByData = !canSaveCascadeEdit(preview)
  // Finding 107's own term is intentionally NOT folded into
  // `cascadeSaveBlockedByData` — that flag also gates
  // `cascade-save-blocked-note` (below), and this window has nothing to name
  // yet: no plan was ever requested, so there is no reason to print. Held out
  // of the note's guard the same way `previewIsRecomputing` already is
  // (COPY-H-2) — it only widens the BUTTON's gate.
  const cascadeSaveBlocked =
    cascadeSaveBlockedByData ||
    previewIsRecomputing ||
    previewFailed ||
    (liveAmountNeedsPreview && !previewAmountIsCurrent)

  return {
    preview,
    shouldPreview,
    previewErrorMessage,
    previewAmountIsCurrent,
    previewIsRecomputing,
    liveAmountNeedsPreview,
    cascadePanelEngaged,
    cascadeSaveBlocked,
    cascadeSaveBlockedByData,
    refetchPreview: () => void previewQuery.refetch(),
  }
}
