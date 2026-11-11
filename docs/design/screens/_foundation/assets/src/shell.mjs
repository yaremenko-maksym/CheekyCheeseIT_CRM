// Shell v2 frames: role tab bars, More sheet, quick-add, states, tablet rail, desktop sidebar, Cmd+K, `?`.
import { page } from './base.mjs'
import { tabScreen, financeBody, peopleList } from './mobile.mjs'
import {
  moreSheet,
  quickAddSheet,
  loadingScreen,
  emptyScreen,
  errorScreen,
  offlineBanner,
  impersonationBanner,
} from './mobile-overlays.mjs'
import { tablet } from './tablet.mjs'
import { moneyForm, primaryBtn, armedBtn } from './money-form.mjs'
import { desktop, cmdk, shortcuts } from './desktop.mjs'

const M = (name, w, h, body) => ({ name, w, h, dpr: 2, html: page(body, { width: w }) })
const D = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })

const ROLE_FRAMES = [
  ['admin', 'ADMIN', '/finance', 'Фінанси'],
  ['senior', 'SENIOR', '/finance', 'Фінанси'],
  ['senior-teamless', 'SENIOR_TEAMLESS', '/finance', 'Фінанси'],
  ['junior', 'JUNIOR', '/finance', 'Фінанси'],
  ['hr', 'HR', '/interviews', 'Співбесіди'],
  ['accountant', 'ACCOUNTANT', '/finance', 'Фінанси'],
  ['drop', 'DROP', '/finance', 'Фінанси'],
]

export function frames() {
  const out = []
  for (const [slug, role, active, title] of ROLE_FRAMES) {
    const body = active === '/interviews' ? peopleList() : financeBody(role)
    out.push(M(`tabbar-${slug}-375`, 375, 812, tabScreen({ role, active, title, body })))
  }
  out.push(
    M(
      'tabbar-admin-320',
      320,
      568,
      tabScreen({
        w: 320,
        h: 568,
        role: 'ADMIN',
        active: '/finance',
        title: 'Фінанси',
        body: financeBody(),
      }),
    ),
  )
  out.push(
    M(
      'tabbar-hr-320',
      320,
      568,
      tabScreen({
        w: 320,
        h: 568,
        role: 'HR',
        active: '/interviews',
        title: 'Співбесіди',
        body: peopleList(),
      }),
    ),
  )
  if (typeof moreSheet === 'function') {
    out.push(M('more-sheet-admin-375', 375, 812, moreSheet('ADMIN', 375, 812)))
    out.push(M('more-sheet-junior-375', 375, 812, moreSheet('JUNIOR', 375, 812)))
    out.push(M('more-sheet-admin-320', 320, 568, moreSheet('ADMIN', 320, 568)))
    out.push(M('quick-add-admin-375', 375, 812, quickAddSheet('ADMIN', 375, 812)))
    out.push(M('quick-add-hr-320', 320, 568, quickAddSheet('HR', 320, 568)))
    // Save during upload: an active button that says what a tap does; the armed state freezes the payload.
    out.push(
      M(
        'quick-add-txn-keyboard-375',
        375,
        812,
        moneyForm({
          keyboard: 'decimal',
          focus: 'amount',
          footer: primaryBtn('Зберегти після завантаження чека'),
        }),
      ),
    )
    out.push(
      M('quick-add-txn-armed-375', 375, 812, moneyForm({ lead: 'Згорнути', footer: armedBtn() })),
    )
    // 320, the longest plausible amount: the amount never truncates, the armed label wraps, the title truncates.
    const big = { amount: '1 250 000,50', cur: 'UAH' }
    out.push(
      M(
        'quick-add-txn-armed-320',
        320,
        568,
        moneyForm({ w: 320, h: 568, lead: 'Згорнути', ...big, footer: armedBtn(big) }),
      ),
    )
    out.push(M('state-loading-375', 375, 812, loadingScreen('ADMIN', 375, 812)))
    // Scrolling down: the FAB slides out (transform only), so the amount sitting under its slot is visible.
    out.push(
      M(
        'state-scrolled-375',
        375,
        812,
        tabScreen({
          w: 375,
          h: 812,
          role: 'ADMIN',
          active: '/finance',
          title: 'Фінанси',
          body: financeBody(),
          showFab: false,
          scrolled: true,
        })
          .replace(
            '<div class="content">',
            '<div class="content"><div style="transform:translateY(-72px)">',
          )
          .replace('</div><nav class="tabbar"', '</div></div><nav class="tabbar"'),
      ),
    )
    out.push(M('state-empty-375', 375, 812, emptyScreen(375, 812)))
    out.push(M('state-error-375', 375, 812, errorScreen(375, 812)))
    out.push(
      M(
        'state-offline-375',
        375,
        812,
        tabScreen({
          role: 'ADMIN',
          active: '/finance',
          title: 'Фінанси',
          body: financeBody(),
          banner: offlineBanner(),
        }),
      ),
    )
    out.push(
      M(
        'state-impersonation-375',
        375,
        812,
        tabScreen({
          role: 'HR',
          active: '/interviews',
          title: 'Співбесіди',
          body: peopleList(),
          banner: impersonationBanner(),
        }),
      ),
    )
  }
  if (typeof tablet === 'function') {
    out.push(D('tablet-rail-768', 768, 1024, tablet({ w: 768, h: 1024 })))
    // A 768 × 700 window (Stage Manager / Split View): the destinations no longer fit, so «Ще» appears.
    out.push(D('tablet-rail-more-768', 768, 700, tablet({ w: 768, h: 700, more: true })))
    // >= 900: rail 80 + list 360 + detail (560 at 1000); the selected row is marked only here.
    out.push(D('tablet-two-pane-1000', 1000, 768, tablet({ w: 1000, h: 768 })))
  }
  if (typeof desktop === 'function') {
    out.push(D('desktop-sidebar-1024', 1024, 768, desktop({ w: 1024, h: 768 })))
    out.push(
      D('desktop-sidebar-collapsed-1024', 1024, 768, desktop({ w: 1024, h: 768, collapsed: true })),
    )
    out.push(D('desktop-sidebar-1440', 1440, 900, desktop({ w: 1440, h: 900 })))
    // iPad landscape: desktop layout by width, touch density by pointer (44 rows, 48 inputs, 16 px text).
    out.push(D('shell-touch-1180', 1180, 820, desktop({ w: 1180, h: 820, touch: true })))
    out.push(D('desktop-cmdk-1440', 1440, 900, desktop({ w: 1440, h: 900, overlay: cmdk() })))
    out.push(
      D('desktop-shortcuts-1440', 1440, 900, desktop({ w: 1440, h: 900, overlay: shortcuts() })),
    )
    out.push(
      D(
        'desktop-cmdk-1024',
        1024,
        768,
        desktop({ w: 1024, h: 768, overlay: cmdk({ compact: true }) }),
      ),
    )
  }
  return out
}
