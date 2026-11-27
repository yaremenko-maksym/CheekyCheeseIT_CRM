// Council r3 (owner decisions D-1, D-2): the restored form after a session expiry, and the sign-out loss check.
import { icon } from './base.mjs'
import { desktop } from './desktop.mjs'
import { moreSheet } from './mobile-overlays.mjs'
import { moneyForm, actionConfirm, overHome, AMOUNT, NB } from './money-form.mjs'
import { tablet } from './tablet.mjs'

// D-1: after sign-in the form returns with what the user had typed and the receipt; the armed draft stays armed.
// The note is a polite status, not an alert, and never moves focus; «Очистити» drops the restored input.
const restoreNote = `<div role="status" style="padding:12px 14px;border-radius:14px;background:var(--surface);border:1px solid var(--border)"><div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--primary);margin-top:1px">${icon('rotate-ccw', { size: 18 })}</span><div class="grow"><div style="font-size:15px;font-weight:600">Введене відновлено</div><div class="t-foot muted" style="margin-top:2px">З цього пристрою, збережене перед завершенням сесії. Перевірте поля й збережіть.</div></div><span class="btn ghost" role="button" aria-label="Очистити відновлене введене" style="height:44px;padding:0 8px;margin:-8px -6px -8px 0;font-size:15px;color:var(--primary)">Очистити</span></div></div>`
export const formRestored = (w, h) => moneyForm({ w, h, receipt: 'done', alert: restoreNote })

// D-2: sign-out and the impersonation return run the same loss check as a 401. The dialog lists what would be lost
// (an armed draft, a selected receipt); with nothing to lose there is no dialog. Focus lands on «Залишитися».
const LOSS = `Буде втрачено: чернетку −${NB(AMOUNT)} USD, що чекає на чек (62%).`
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
) => `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.55);z-index:60"></div>
  <div role="alertdialog" aria-modal="true" aria-labelledby="so-t" aria-describedby="so-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:22px 24px 18px">
  <div id="so-t" class="t-head">Вийти з акаунта?</div>
  <div id="so-d" class="t-foot muted" style="margin-top:6px;font-size:14px;line-height:20px">${LOSS} Введене в цій сесії не повернеться.</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><button type="button" class="btn sm secondary" style="height:${touch ? 44 : 36}px;font-size:${touch ? 15 : 14}px;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">Залишитися</button><button type="button" class="btn sm" style="height:${touch ? 44 : 36}px;font-size:${touch ? 15 : 14}px;background:var(--destructive-solid);color:#fff">Вийти</button></div></div>`
export const signOutConfirmDesktop = (w, h) => desktop({ w, h, overlay: box() })
export const signOutConfirmTablet = (w, h) => tablet({ w, h, overlay: box(true) })
