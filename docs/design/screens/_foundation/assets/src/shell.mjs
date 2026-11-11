// Shell v2 frames: role tab bars, More sheet, quick-add, states, tablet rail, desktop sidebar, Cmd+K, `?`.
import { page } from './base.mjs'
import { tabScreen, financeBody, peopleList } from './mobile.mjs'
import {
  moreSheet,
  quickAddSheet,
  txnQuickStep,
  loadingScreen,
  offlineBanner,
  impersonationBanner,
} from './mobile-overlays.mjs'
import { tablet } from './tablet.mjs'
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
    const body = active === '/interviews' ? peopleList() : financeBody()
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
    out.push(M('quick-add-txn-keyboard-375', 375, 812, txnQuickStep(375, 812)))
    out.push(M('state-loading-375', 375, 812, loadingScreen('ADMIN', 375, 812)))
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
          fabDim: true,
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
    out.push(D('tablet-rail-more-768', 768, 1024, tablet({ w: 768, h: 1024, more: true })))
  }
  if (typeof desktop === 'function') {
    out.push(D('desktop-sidebar-1024', 1024, 768, desktop({ w: 1024, h: 768 })))
    out.push(
      D('desktop-sidebar-collapsed-1024', 1024, 768, desktop({ w: 1024, h: 768, collapsed: true })),
    )
    out.push(D('desktop-sidebar-1440', 1440, 900, desktop({ w: 1440, h: 900 })))
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
