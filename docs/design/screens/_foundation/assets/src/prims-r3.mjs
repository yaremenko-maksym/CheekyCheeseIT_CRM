// Council r3 (owner decisions D-1, D-2): the restored form after a session expiry, and the sign-out loss check.
import { icon } from './base.mjs'
import { desktop } from './desktop.mjs'
import { moreSheet } from './mobile-overlays.mjs'
import {
  moneyForm,
  actionConfirm,
  overHome,
  AMOUNT,
  NB,
  DRAFT,
  pinnedRows,
  SAVED_OTHER,
  SENT_AT,
} from './money-form.mjs'
import { tablet } from './tablet.mjs'

// D-1: after sign-in the form returns with what the user had typed and the receipt; the armed draft stays armed.
// The note is a polite status, not an alert, and never moves focus; «Очистити» drops the restored input.
const restoreNote = `<div role="status" style="padding:12px 14px;border-radius:14px;background:var(--surface);border:1px solid var(--border)"><div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--primary);margin-top:1px">${icon('rotate-ccw', { size: 18 })}</span><div class="grow"><div style="font-size:15px;font-weight:600">Введене відновлено</div><div class="t-foot muted" style="margin-top:2px">Ми зберегли ці дані на цьому пристрої перед завершенням сесії. Перевірте поля й збережіть.</div></div><span class="btn ghost" role="button" aria-label="Очистити відновлене введене" style="height:44px;padding:0 8px;margin:-8px -6px -8px 0;font-size:15px;color:var(--primary)">Очистити</span></div></div>`
export const formRestored = (w, h) => moneyForm({ w, h, receipt: 'done', alert: restoreNote })

// D-2: sign-out and the impersonation return run the same loss check as a 401. The dialog lists what would be lost
// (an armed draft, a selected receipt); with nothing to lose there is no dialog. Focus lands on «Залишитися».
const LOSS = `Буде втрачено: чернетка −${NB(AMOUNT)} USD, що чекає на чек (62%).`
export const signOutConfirmPhone = (w, h) =>
  overHome(
    moreSheet('ADMIN', w, h),
    actionConfirm(w, {
      id: 'so',
      title: 'Вийти з акаунта?',
      desc: LOSS,
      action: 'Вийти',
      cancel: 'Залишитися',
      overSheet: true,
      focusCancel: true,
    }),
  )

// 440 px alert dialog: 44 px buttons under touch (tablet), 36 px under a fine pointer (desktop), as the page-kill dialog.
const box = (
  touch = false,
) => `<div style="position:absolute;inset:0;background:var(--scrim);z-index:60"></div>
  <div role="alertdialog" aria-modal="true" aria-labelledby="so-t" aria-describedby="so-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:22px 24px 18px">
  <div id="so-t" class="t-head">Вийти з акаунта?</div>
  <div id="so-d" class="t-foot muted" style="margin-top:6px;font-size:14px;line-height:20px">${LOSS}</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><button type="button" class="btn sm secondary" style="height:${touch ? 44 : 36}px;font-size:${touch ? 15 : 14}px;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">Залишитися</button><button type="button" class="btn sm" style="height:${touch ? 44 : 36}px;font-size:${touch ? 15 : 14}px;background:var(--destructive-solid);color:#fff">Вийти</button></div></div>`
// R3-31: the page behind the dialog shows the draft it names: the upload pill at 62 %, the pinned armed row
// and the dot on «+» (shell-v2 §4 «Money drafts per size»).
const RING = `<svg width="26" height="26" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.14)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="35.8" transform="rotate(-90 18 18)"/></svg>`
// R5-08: at >= 640 the money pill is the same pill as on a phone (foundation §5: the plain «Завантаження» pill
// only without a money draft), in the one floating corner. R5-34: the pill body is one button; a ✕ (saved only)
// is its sibling, never nested.
const PILL = {
  armed: () => [RING, `Збережеться −${NB(AMOUNT)} USD`, '62% · Відкрити чернетку', 'oklch(0.42 0.09 85)', `Збережеться −${AMOUNT} USD після завантаження чека, 62%. Відкрити чернетку`],
  failed: () => [`<span style="color:var(--destructive);display:grid">${icon('circle-alert', { size: 22 })}</span>`, `Не збережено −${NB(AMOUNT)} USD`, `${SENT_AT} · Відкрити`, 'oklch(0.42 0.12 22)', `Не збережено −${AMOUNT} USD, о ${SENT_AT}. Відкрити`],
  saved: () => [`<span style="color:var(--positive);display:grid">${icon('circle-check', { size: 22 })}</span>`, `Збережено −${NB(SAVED_OTHER)} USD`, 'Відкрити', 'oklch(0.4 0.08 150)', `Збережено −${SAVED_OTHER} USD. Відкрити`],
}
export const widePill = (kind, touch, bottom = 24, more = 0) => {
  const [ic, a, b, edge, label] = PILL[kind]()
  const hgt = touch ? 52 : 44
  // R6-02: the persistent count of queued unacknowledged results (foundation §11 «Money results queue»).
  const q = more
    ? `<button type="button" aria-haspopup="dialog" aria-label="Ще ${more}: усі результати збереження" style="appearance:none;border:0;font:inherit;color:inherit;flex:none;height:${touch ? 44 : 32}px;padding:0 10px;border-radius:10px;background:oklch(0.27 0.01 85);font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer">Ще ${more}</button>`
    : ''
  const x =
    kind === 'saved'
      ? q + `<button type="button" class="iconbtn" aria-label="Закрити" style="flex:none;width:${touch ? 44 : 32}px;height:${touch ? 44 : 32}px;color:var(--muted-fg)">${icon('x', { size: 16 })}</button>`
      : ''
  return `<div class="row" style="position:absolute;right:24px;bottom:${bottom}px;z-index:50;width:320px;min-height:${hgt}px;gap:4px;padding:0 6px 0 0;border-radius:14px;background:oklch(0.2 0.006 85);border:1px solid ${edge};box-shadow:0 10px 30px oklch(0 0 0 / 0.5)"><div role="button" aria-label="${label}" class="row grow" style="gap:10px;min-width:0;min-height:${hgt}px;padding:0 6px 0 12px">${ic}<span class="grow col" style="gap:1px;min-width:0"><span class="num" style="font-size:13px;font-weight:600;white-space:nowrap">${a}</span><span class="t-cap muted num" style="white-space:nowrap">${b}</span></span></div>${x}</div>`
}
const DOT_I =
  '<i aria-hidden="true" style="position:absolute;top:-4px;right:-4px;width:10px;height:10px;border-radius:50%;background:var(--destructive);box-shadow:0 0 0 2px var(--bg)"></i>'
const deskRow = `<tr><td colspan="7" style="padding:0;max-width:none;background:var(--raised);box-shadow:inset 2px 0 0 var(--primary)"><div class="row" style="gap:10px;height:40px;padding:0 12px"><span style="color:var(--primary);display:grid">${icon('file-pen', { size: 16 })}</span><span class="num" style="font-weight:600;white-space:nowrap">−${NB(AMOUNT)} USD</span><span class="grow muted" style="white-space:nowrap;overflow:hidden">Збережеться після завантаження чека · Витрата</span></div></td></tr>`
export const signOutConfirmDesktop = (w, h) =>
  desktop({ w, h, overlay: widePill('armed', false) + box() })
    .replace('<tbody>', `<tbody>${deskRow}`)
    .replace(
      '<span class="btn primary" style="height:36px',
      '<span class="btn primary" style="position:relative;height:36px',
    )
    .replace('C</span></span></header>', `C</span>${DOT_I}</span></header>`)
export const signOutConfirmTablet = (w, h) =>
  tablet({ w, h, overlay: widePill('armed', true) + box(true) })
    .replace(
      '<div class="sechead"><span class="t-over">Сьогодні</span></div>',
      `${pinnedRows([DRAFT.armed2])}<div class="sechead"><span class="t-over">Сьогодні</span></div>`,
    )
    .replace(/style="width:52px;height:52px;/, 'style="position:relative;width:52px;height:52px;')
    .replace(/(style="position:relative;width:52px[^>]*><svg[\s\S]*?<\/svg>)/, `$1${DOT_I}`)

/** R6-02: two unacknowledged successes + a failed draft at >= 640: the newest saved pill carries «Ще 1». */
export const savedQueueTablet = (w, h) =>
  tablet({ w, h, overlay: widePill('failed', true) + widePill('saved', true, 24 + 52 + 8, 1) }).replace(
    '<div class="sechead"><span class="t-over">Сьогодні</span></div>',
    `${pinnedRows([DRAFT.failed])}<div class="sechead"><span class="t-over">Сьогодні</span></div>`,
  )
/** R5-08: a create success while a failed draft owns the corner at >= 640: the saved pill stacks 8 px above, with
 * its own amount (another transaction); the failed pill keeps the slot (precedence), its row stays pinned. */
export const savedOverFailedTablet = (w, h) =>
  tablet({ w, h, overlay: widePill('failed', true) + widePill('saved', true, 24 + 52 + 8) }).replace(
    '<div class="sechead"><span class="t-over">Сьогодні</span></div>',
    `${pinnedRows([DRAFT.failed])}<div class="sechead"><span class="t-over">Сьогодні</span></div>`,
  )
