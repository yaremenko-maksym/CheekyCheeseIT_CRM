// Stats screen mockups (council fix round 1). Built only from the foundation helpers and tokens; every
// figure and name is an invented fixture. `node render.mjs [filter]` writes ../stats/<frame>.png.
import { page } from '../../../_foundation/assets/src/base.mjs'
import { BALANCED, LONG, ONE, ZERO } from './data.mjs'
import {
  stats375,
  loadingPhone,
  seriesSheet,
  monthSheet,
  hintSheet,
  offlineStrip,
} from './phone.mjs'
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
    P('scrub-12m-375', 375, 812, stats375({ showFab: false, chart: { period: 1, sel: 8 } })),
    // ---- Phone: states ----
    P('loading-375', 375, 812, loadingPhone(375, 812)),
    P('loading-320', 320, 568, loadingPhone(320, 568)),
    Pfit('empty-375', 375, { partners: ZERO, summary: 'empty', compliance: { state: 'empty' } }),
    Pfit('error-375', 375, { summary: 'error' }),
    Pfit('error-320', 320, { summary: 'error' }),
    Pfit('partial-375', 375, { company: 'error', compliance: { state: 'error' } }),
    P('stale-375', 375, 812, stats375({ showFab: false, stale: true })),
    P('offline-375', 375, 812, stats375({ showFab: false, banner: offlineStrip() })),
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
    // ---- Tablet ----
    T('default-768', 768, {}),
    T('select-768', 768, { chart: { period: 1, sel: 9 } }),
    T('error-768', 768, { summary: 'error' }),
    T('long-768', 768, { partners: LONG }),
    frame('loading-768', 768, 1500, tabletFrame(768, 1500, { loading: true }), { fit: WD }),
    // ---- Desktop ----
    D('default-1024', 1024, {}),
    D('default-1280', 1280, {}),
    D('default-1440', 1440, {}),
    D('default-1920', 1920, {}),
    D('touch-1024', 1024, { touch: true }),
    D('all-1280', 1280, { chart: { period: 2, sel: 17 } }),
    D('hover-1440', 1440, { chart: { sel: 3, hover: true } }),
    D('loading-1440', 1440, { loading: true }),
    D('empty-1440', 1440, { partners: ZERO, summary: 'empty', compliance: { state: 'empty' } }),
    D('error-1440', 1440, { summary: 'error' }),
    D('partial-1440', 1440, { company: 'error', compliance: { state: 'error' } }),
    D('stale-1440', 1440, { stale: true }),
    D('offline-1440', 1440, { banner: offlineStrip() }),
    D('balanced-1440', 1440, { partners: BALANCED }),
    D('long-1440', 1440, { partners: LONG }),
    D('accountant-1440', 1440, { role: 'ACCOUNTANT', company: 'nowallet' }),
  ]
}
