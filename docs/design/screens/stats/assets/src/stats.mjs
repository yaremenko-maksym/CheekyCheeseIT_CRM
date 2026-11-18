// Stats screen mockups (council fix round 2). Built only from the foundation helpers and tokens; every
// figure and name is an invented fixture. `node render.mjs [filter]` writes ../stats/<frame>.png.
import { page } from '../../../_foundation/assets/src/base.mjs'
import {
  BALANCED,
  LONG,
  ONE,
  ZERO,
  WHEN_OLD,
  WHEN_TODAY,
  PARTNER_HINT,
  RECEIVER_VARIANTS,
} from './data.mjs'
import { stats375, loadingPhone, seriesSheet, monthSheet, hintSheet } from './phone.mjs'
import { deskFrame, tabletFrame } from './wide.mjs'

const TALL = 6000
// Phone: fit = bottom room under the last block (tab bar 50 + home indicator 34 + FAB clearance 80).
const PH = 164
const WD = 28

const frame = (name, w, h, body, o = {}) => ({
  name,
  w,
  h,
  dpr: o.dpr ?? 2,
  full: o.full ?? false,
  fit: o.fit,
  html: page(body, { width: w }),
})
// Tablet hint popover (R2-M1 keeps popover for hints): anchored under the 44 px info button of the partner
// card (right edge 737 px at 768), the shell's own popover surface (tablet.mjs «Ще»), non-modal: no scrim.
const hintPopover = `<div role="dialog" aria-label="Пояснення: Баланси партнерів" style="position:absolute;left:397px;top:151px;width:340px;z-index:70;background:var(--popover);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px oklch(0 0 0 / 0.6);padding:12px 16px 14px"><div class="t-body" style="font-weight:600;margin-bottom:6px">Баланси партнерів</div><div class="t-body muted">${PARTNER_HINT}</div></div>`

const P = (name, w, h, body) => frame(name, w, h, body)
const Pfit = (name, w, opts) => frame(name, w, TALL, stats375({ w, h: TALL, ...opts }), { fit: PH })
const T = (name, w, opts) => frame(name, w, TALL, tabletFrame(w, TALL, opts), { fit: WD })
const D = (name, w, opts) => frame(name, w, TALL, deskFrame(w, TALL, opts), { dpr: 1, fit: WD })

export function frames() {
  return [
    // ---- Phone: first viewport (FAB hidden by the screen rule, M8) and the full scroll ----
    P('default-320', 320, 568, stats375({ w: 320, h: 568, showFab: false })),
    P('default-375', 375, 812, stats375({ showFab: false })),
    Pfit('full-320', 320, {}),
    Pfit('full-375', 375, {}),
    P('all-320', 320, 1000, stats375({ w: 320, h: 1000, showFab: false, chart: { period: 2 } })),
    P('all-375', 375, 812, stats375({ showFab: false, chart: { period: 2 } })),
    P(
      'scrub-12m-375',
      375,
      812,
      stats375({ showFab: false, chart: { period: 1, sel: 8, scrub: true } }),
    ),
    // ---- Phone: states ----
    P('loading-375', 375, 812, loadingPhone(375, 812)),
    P('loading-320', 320, 568, loadingPhone(320, 568)),
    Pfit('empty-375', 375, { partners: ZERO, summary: 'empty', compliance: { state: 'empty' } }),
    Pfit('error-375', 375, { summary: 'error' }),
    Pfit('error-320', 320, { summary: 'error' }),
    Pfit('partial-375', 375, { company: 'error', compliance: { state: 'error' } }),
    P(
      'stale-375',
      375,
      812,
      stats375({ showFab: false, strip: { kind: 'stale', when: WHEN_TODAY } }),
    ),
    P(
      'stale-yesterday-375',
      375,
      812,
      stats375({ showFab: false, strip: { kind: 'stale', when: WHEN_OLD } }),
    ),
    P(
      'stale-scrolled-375',
      375,
      812,
      stats375({ showFab: false, scroll: 520, strip: { kind: 'stale', when: WHEN_TODAY } }),
    ),
    P(
      'stale-yesterday-320',
      320,
      568,
      stats375({ w: 320, h: 568, showFab: false, strip: { kind: 'stale', when: WHEN_OLD } }),
    ),
    P(
      'retry-busy-375',
      375,
      812,
      stats375({ showFab: false, strip: { kind: 'stale', when: WHEN_TODAY, busy: true } }),
    ),
    P(
      'offline-375',
      375,
      812,
      stats375({ showFab: false, strip: { kind: 'offline', when: WHEN_TODAY } }),
    ),
    Pfit('cold-375', 375, {
      summary: 'cold',
      company: 'error',
      compliance: { state: 'error' },
      strip: { kind: 'cold' },
    }),
    Pfit('nowallet-375', 375, { company: 'nowallet' }),
    P('balanced-375', 375, 812, stats375({ showFab: false, partners: BALANCED })),
    P('onepartner-375', 375, 812, stats375({ showFab: false, partners: ONE })),
    P('long-375', 375, 812, stats375({ showFab: false, partners: LONG })),
    Pfit('long-320', 320, { partners: LONG }),
    Pfit('accountant-375', 375, { role: 'ACCOUNTANT', company: 'nowallet' }),
    // ---- Phone: interaction ----
    P('series-sheet-375', 375, 812, seriesSheet(375, 812)),
    P('month-sheet-375', 375, 812, monthSheet(375, 812)),
    P('hint-sheet-375', 375, 812, hintSheet(375, 812)),
    P('hint-partner-375', 375, 812, hintSheet(375, 812, 'partner')),
    Pfit('compliance-expanded-375', 375, { compliance: { expanded: 0 } }),
    Pfit('compliance-variants-375', 375, {
      compliance: { expanded: 'all', list: RECEIVER_VARIANTS },
    }),
    // ---- Tablet ----
    T('default-768', 768, {}),
    frame('hint-popover-768', 768, 1024, tabletFrame(768, 1024, { overlay: hintPopover })),
    T('select-768', 768, { chart: { period: 1, sel: 9 } }),
    T('error-768', 768, { summary: 'error' }),
    T('long-768', 768, { partners: LONG }),
    T('loading-768', 768, { loading: true }),
    T('default-1000', 1000, {}),
    T('select-1000', 1000, { chart: { period: 1, sel: 9 } }),
    // ---- Desktop ----
    D('default-1024', 1024, {}),
    D('default-1280', 1280, {}),
    D('default-1440', 1440, {}),
    D('default-1920', 1920, {}),
    D('touch-1024', 1024, { touch: true }),
    D('all-1280', 1280, { chart: { period: 2, sel: 17 } }),
    D('hover-1440', 1440, { chart: { sel: 3, hover: 1 } }),
    D('loading-1440', 1440, { loading: true }),
    D('empty-1440', 1440, { partners: ZERO, summary: 'empty', compliance: { state: 'empty' } }),
    D('error-1440', 1440, { summary: 'error' }),
    D('partial-1440', 1440, { company: 'error', compliance: { state: 'error' } }),
    D('stale-1440', 1440, { strip: { kind: 'stale', when: WHEN_TODAY } }),
    D('offline-1440', 1440, { strip: { kind: 'offline', when: WHEN_TODAY } }),
    D('balanced-1440', 1440, { partners: BALANCED }),
    D('long-1440', 1440, { partners: LONG }),
    D('accountant-1440', 1440, { role: 'ACCOUNTANT', company: 'nowallet' }),
    D('compliance-variants-1440', 1440, {
      compliance: { expanded: 'all', list: RECEIVER_VARIANTS },
    }),
  ]
}
