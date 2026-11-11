// Primitives v2 frames. Rendered by `node render.mjs primitives [filter]` into ../primitives-v2/.
import { page } from './base.mjs'
import {
  sheetMedium,
  sheetLarge,
  sheetConfirm,
  listVariants,
  listSwipe,
  listSticky,
  sectionHeaders,
  formStates,
  formMoney,
  formKeyboard,
} from './prims-mobile.mjs'
import {
  panelDesktop,
  panelTablet,
  confirmDialog,
  tableRows,
  toastUndo,
  toastError,
  uploadStates,
  skeletonMobile,
  skeletonTable,
  chartMobile,
  chartDesktop,
  ptr,
  transitions,
} from './prims-viz.mjs'

const M = (name, w, h, body) => ({ name, w, h, dpr: 2, html: page(body, { width: w }) })
const D = (name, w, h, body, full = false) => ({ name, w, h, dpr: 1, full, html: page(body, { width: w }) })
const C = (name, w, h, body) => ({ name, w, h, dpr: 2, full: true, html: page(body, { width: w }) })

export function frames() {
  return [
    M('sheet-medium-375', 375, 812, sheetMedium(375, 812)),
    M('sheet-medium-320', 320, 568, sheetMedium(320, 568)),
    M('sheet-large-375', 375, 812, sheetLarge(375, 812)),
    M('sheet-confirm-375', 375, 812, sheetConfirm(375, 812)),
    M('listrow-variants-375', 375, 812, listVariants(375, 812)),
    M('listrow-swipe-375', 375, 812, listSwipe(375, 812)),
    M('listrow-sticky-320', 320, 568, listSticky(320, 568)),
    M('section-header-375', 375, 812, sectionHeaders(375, 812)),
    M('form-states-375', 375, 812, formStates(375, 812)),
    M('form-money-375', 375, 812, formMoney(375, 812)),
    M('form-keyboard-375', 375, 812, formKeyboard(375, 812)),
    D('sheet-panel-768', 768, 1024, panelTablet(768, 1024)),
    D('sheet-panel-1024', 1024, 768, panelDesktop(1024, 768)),
    D('sheet-panel-1440', 1440, 900, panelDesktop(1440, 900)),
    D('sheet-confirm-dialog-1024', 1024, 768, confirmDialog(1024, 768)),
    C('listrow-table-desktop', 960, 300, tableRows()),
    M('toast-undo-375', 375, 812, toastUndo(375, 812)),
    M('toast-error-375', 375, 812, toastError(375, 812)),
    M('upload-states-375', 375, 812, uploadStates(375, 812)),
    M('skeleton-mobile-375', 375, 812, skeletonMobile(375, 812)),
    C('skeleton-table-desktop', 960, 420, skeletonTable()),
    M('chart-mobile-375', 375, 812, chartMobile(375, 812)),
    M('chart-mobile-320', 320, 568, chartMobile(320, 568)),
    C('chart-desktop', 1200, 420, chartDesktop()),
    ...['pulling', 'armed', 'refreshing', 'done'].map((s) => M(`ptr-${s}-375`, 375, 480, ptr(375, 480, s))),
    D('transition-storyboard', 1560, 1200, transitions(), true),
  ]
}
