// Primitives v2, part 2: ResponsiveSheet on tablet/desktop, toasts, upload indicator, skeletons,
// chart theme, pull-to-refresh, page-transition storyboard.
import { icon, phone, safeBottom, segmented } from './base.mjs'
import {
  tabScreen,
  interviewsBody,
  txnList,
  txnRow,
  TXNS,
  topBar,
  largeTitle,
  tabBar,
  TABBAR_H,
  FLOAT_RIGHT,
} from './mobile.mjs'
import { skeletonList } from './mobile-overlays.mjs'
import { desktop } from './desktop.mjs'
import { tablet } from './tablet.mjs'

// ---------- ResponsiveSheet ≥ 640: right side panel; confirm = centred dialog ----------
const dField = (label, value, { suffix = '', ph = false } = {}) =>
  `<div class="field"><label style="font-size:13px">${label}</label><div class="input" style="height:40px;font-size:14px;border-radius:8px"><span class="grow trunc ${ph ? 'ph' : ''}">${value}</span>${suffix}</div></div>`

function sidePanel(width, { touch = false } = {}) {
  const fieldH = touch ? 'height:48px;font-size:16px' : ''
  const f = (l, v, o) =>
    dField(l, v, o).replace('height:40px;font-size:14px', fieldH || 'height:40px;font-size:14px')
  return `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.5);z-index:60"></div>
  <aside role="dialog" aria-modal="true" aria-labelledby="sp-t" style="position:absolute;top:0;right:0;bottom:0;width:${width}px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / 0.5);display:flex;flex-direction:column">
  <div class="row" style="height:60px;flex:none;padding:0 12px 0 24px;border-bottom:1px solid var(--border)"><div id="sp-t" class="grow t-head">Редагувати транзакцію</div><span class="kbdkey" style="margin-right:6px">Esc</span><span class="iconbtn" aria-label="Закрити">${icon('x', { size: 18 })}</span></div>
  <div class="col grow" style="gap:16px;padding:20px 24px;min-height:0">
    ${f('Опис', 'Оренда офісу')}
    <div class="row" style="gap:12px"><div class="grow">${f('Сума', '1 200,00', { suffix: '<span class="muted">USD</span>' })}</div><div style="width:42%">${f('Тип', 'Витрата', { suffix: `<span class="muted">${icon('chevron-down', { size: 16 })}</span>` })}</div></div>
    ${f('Проєкт', 'Проєкт «Альфа»', { suffix: `<span class="muted">${icon('chevron-down', { size: 16 })}</span>` })}
    ${f('Дата', '11.11.2026', { suffix: `<span class="muted">${icon('calendar', { size: 16 })}</span>` })}
    <div class="field"><label style="font-size:13px">Чек</label><div class="row" style="gap:12px;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--card)"><div style="width:40px;height:48px;border-radius:6px;background:linear-gradient(160deg,oklch(0.86 0 0),oklch(0.7 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px"></div><div class="grow"><div style="font-size:14px;font-weight:500">receipt-2026-11-11.jpg</div><div class="t-cap muted num">1,4 МБ · завантажено</div></div><span class="btn sm ghost">Замінити</span></div></div></div>
  <div class="row" style="gap:8px;justify-content:flex-end;padding:14px 24px;border-top:1px solid var(--border)"><span class="btn sm secondary" style="height:${touch ? 44 : 36}px;font-size:14px">Скасувати</span><span class="btn sm primary" style="height:${touch ? 44 : 36}px;font-size:14px">Зберегти<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">⌘↵</span></span></div></aside>`
}

export const panelDesktop = (w, h) => desktop({ w, h, overlay: sidePanel(w >= 1440 ? 480 : 420) })
export const panelTablet = (w, h) => tablet({ w, h, overlay: sidePanel(400, { touch: true }) })

export function confirmDialog(w, h) {
  const overlay = `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.55);z-index:60"></div>
  <div role="alertdialog" aria-modal="true" aria-labelledby="cd-t" aria-describedby="cd-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:420px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:22px 24px 18px">
  <div id="cd-t" class="t-head">Видалити транзакцію «Оренда офісу»?</div>
  <div id="cd-d" class="t-foot muted" style="margin-top:6px;font-size:14px;line-height:20px">−1 200,00 $ · 11.11.2026. Цю дію не можна скасувати; чек теж буде видалено.</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:36px;font-size:14px;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">Скасувати</span><span class="btn sm" style="height:36px;font-size:14px;background:var(--destructive);color:#fff">Видалити</span></div>
  <div class="t-cap muted" style="margin-top:10px;text-align:right">Фокус спершу на «Скасувати»</div></div>`
  return desktop({ w, h, overlay })
}

/** Desktop table row states: default / hover / selected / keyboard focus / pending. */
export function tableRows() {
  const r = (state, d, t, ty, a, pos = false, extra = '') => {
    const st = {
      default: '',
      hover: 'background:oklch(0.15 0.004 85)',
      selected: 'background:var(--raised);box-shadow:inset 2px 0 0 var(--primary)',
      focus: 'outline:2px solid var(--primary);outline-offset:-2px',
      pending: '',
    }[state]
    return `<div class="row" style="height:40px;padding:0 16px;gap:16px;font-size:14px;border-bottom:1px solid var(--separator);${st}"><span class="num muted" style="width:52px">${d}</span><span class="grow row" style="gap:8px">${t}${extra}</span><span class="muted" style="width:96px">${ty}</span><span class="num" style="width:120px;text-align:right;font-weight:600;${pos ? 'color:var(--positive)' : ''}">${a}</span><span class="t-cap" style="width:120px;color:oklch(0.64 0 0)">${state}</span></div>`
  }
  return `<div style="padding:24px;background:var(--bg);width:960px"><div style="border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden">
  <div class="row" style="height:36px;padding:0 16px;gap:16px;font-size:12px;font-weight:600;color:var(--muted-fg);border-bottom:1px solid var(--border)"><span style="width:52px">Дата</span><span class="grow">Опис</span><span style="width:96px">Тип</span><span style="width:120px;text-align:right">Сума</span><span style="width:120px">Стан рядка</span></div>
  ${r('default', '11.11', 'Оренда офісу', 'Витрата', '−1 200,00 $')}${r('hover', '11.11', 'Оплата від клієнта', 'Дохід', '+4 800,00 $', true)}${r('selected', '10.11', 'Зарплата · Розробник 4', 'Зарплата', '−2 150,00 $')}${r('focus', '10.11', 'Переказ на рахунок компанії', 'Переказ', '−3 000,00 $')}${r('pending', '09.11', 'Хмарний хостинг', 'Витрата', '−86,40 $', false, '<span class="pill warn" style="height:20px;font-size:11px">Очікує</span>')}</div></div>`
}

// ---------- Toasts ----------
export function toastUndo(w, h) {
  const t = `<div class="toast" role="status" style="right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16}px;min-height:56px;overflow:hidden"><span style="color:var(--positive)">${icon('archive', { size: 18 })}</span><span class="grow">Співбесіду архівовано</span><span class="btn ghost" style="color:var(--primary);height:44px;padding:0 10px;font-size:15px">Скасувати</span><i style="position:absolute;left:0;bottom:0;height:2px;width:62%;background:var(--primary);opacity:0.7"></i></div>`
  return tabScreen({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    title: 'Співбесіди',
    body: interviewsBody(),
    overlay: t,
    showFab: true,
  })
}

// Money create failed (spec §4.5b + Master ruling): definite = 4xx + app 500/503 (+ offline before send),
// unknown = 502/504/524, a drop after send, a client timeout. Drawn on the canonical money form.
export {
  failure422 as toastErrorDefinite,
  failureOffline as toastErrorOffline,
  failureUnknown as toastErrorUnknown,
  failureUnknownList as toastErrorUnknownList,
  uploadPillArmed,
} from './money-form.mjs'

// ---------- Upload indicator ----------
const ring = (pct, size = 36) => {
  const c = 2 * Math.PI * 15
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Завантаження чека"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.14)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`
}
export function uploadStates(w, h) {
  const thumb = `<div style="width:44px;height:52px;border-radius:8px;background:linear-gradient(160deg,oklch(0.86 0 0),oklch(0.7 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px;flex:none"></div>`
  const row = (title, sub, trail, subStyle = '') =>
    `<div class="lrow two" style="--inset:72px">${thumb}<div class="grow col" style="gap:2px;min-width:0"><div class="t-body trunc" style="font-weight:500">${title}</div><div class="t-foot num ${subStyle ? '' : 'trunc'}" style="${subStyle || 'color:var(--muted-fg)'}">${sub}</div></div>${trail}</div>`
  const inner = `${topBar({ back: true, title: 'Чеки', bell: false, search: false })}<div class="content">
  <div class="sechead"><span class="t-over">Стани завантаження</span></div><div class="group">
  ${row('receipt-office.jpg', 'Завантаження · 62% · 0,9 з 1,4 МБ', `<span class="row" style="gap:6px">${ring(62)}<span class="iconbtn" aria-label="Скасувати завантаження">${icon('x', { size: 18 })}</span></span>`)}
  ${row('receipt-taxi.jpg', 'Стискаємо фото…', `<span class="row" style="gap:6px">${ring(8)}<span class="iconbtn" aria-label="Скасувати завантаження">${icon('x', { size: 18 })}</span></span>`)}
  ${row('receipt-hosting.pdf', 'Завантажено · 220 КБ', `<span class="row" style="gap:4px;color:var(--positive);font-size:14px;font-weight:500">${icon('circle-check', { size: 18 })}Готово</span>`)}
  ${row('receipt-monitor.jpg', 'Не вдалося завантажити: файл більший за 10 МБ', `<span class="btn sm secondary">Інший файл</span>`, 'color:var(--destructive)')}
  ${row('receipt-stationery.jpg', 'Зв’язок перервано на 45%', `<span class="btn sm secondary">${icon('rotate-cw', { size: 14 })}Повторити</span>`, 'color:var(--destructive)')}</div>
  <div class="sechead"><span class="t-over">Глобальний індикатор</span></div>
  <div style="padding:0 16px"><div class="t-foot muted">Поки є активні завантаження, над панеллю вкладок видно один компактний рядок. Навігація не блокується.</div></div></div>
  <div role="status" class="row" style="position:absolute;left:12px;right:12px;bottom:${TABBAR_H + safeBottom(w) + 10}px;z-index:40;gap:10px;height:52px;padding:0 4px 0 12px;border-radius:26px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.28 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5);font-size:14px">${ring(40, 26)}<span class="grow num">Завантаження 2 чеків · 40%</span><span class="iconbtn" aria-label="Показати завантаження">${icon('chevron-up', { size: 18 })}</span></div>
  ${tabBar('ADMIN', '/finance', { w })}`
  return phone({ w, h, inner })
}

// ---------- Skeletons ----------
export function skeletonMobile(w, h) {
  const kpi = `<div style="padding:12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="sk" style="height:11px;width:60%"></div><div class="sk" style="height:24px;width:80%;margin-top:12px"></div><div class="sk" style="height:10px;width:40%;margin-top:10px"></div></div>`
  const chart = `<div style="margin:16px;padding:14px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="sk" style="height:12px;width:45%"></div><div class="row" style="align-items:flex-end;gap:10px;height:120px;margin-top:16px">${[60, 85, 40, 95, 70, 55].map((p) => `<div class="sk grow" style="height:${p}%;border-radius:4px"></div>`).join('')}</div></div>`
  const body = `<div role="status" aria-label="Завантаження дашборда" style="display:contents"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:4px 16px 0">${kpi.repeat(4)}</div>${chart}${skeletonList(2)}</div>`
  return tabScreen({ w, h, role: 'ADMIN', active: '/', title: 'Дашборд', body })
}

export function skeletonTable() {
  const row = (i) =>
    `<div class="row" style="height:40px;padding:0 16px;gap:16px;border-bottom:1px solid var(--separator)"><div class="sk" style="width:44px;height:11px"></div><div class="sk" style="width:${[46, 32, 54, 38, 42, 28, 50, 36][i % 8]}%;height:12px"></div><div class="grow"></div><div class="sk" style="width:70px;height:11px"></div><div class="sk" style="width:90px;height:12px"></div></div>`
  return `<div style="padding:24px;background:var(--bg);width:960px" role="status" aria-label="Завантаження транзакцій"><div class="row" style="gap:8px;margin-bottom:14px"><div class="sk" style="width:260px;height:32px;border-radius:8px"></div><div class="sk" style="width:70px;height:32px;border-radius:8px"></div><div class="sk" style="width:84px;height:32px;border-radius:8px"></div></div>
  <div style="border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden"><div class="row" style="height:36px;padding:0 16px;gap:16px;font-size:12px;font-weight:600;color:var(--muted-fg);border-bottom:1px solid var(--border)"><span style="width:44px">Дата</span><span class="grow">Опис</span><span style="width:70px">Тип</span><span style="width:90px;text-align:right">Сума</span></div>${Array.from({ length: 8 }, (_, i) => row(i)).join('')}</div></div>`
}

// ---------- Chart theme ----------
const MONTHS = ['черв', 'лип', 'серп', 'вер', 'жовт', 'лист']
const NET = [4.2, 6.8, -1.4, 5.1, 7.9, 3.3] // k USD, invented
const PART = [
  [3.1, 2.4],
  [2.2, 3.6],
  [4.0, 1.8],
  [2.8, 3.0],
] // partner A / B, k USD, invented

function netBars(W, H, { labelSize = 11, pad = 28 } = {}) {
  const max = 8,
    min = -3.2,
    top = 18,
    bottom = H - 22
  const y = (v) => top + ((max - v) / (max - min)) * (bottom - top)
  const bw = (W - pad * 2) / NET.length
  const grid = [8, 4, 0]
    .map(
      (g) =>
        `<line x1="${pad}" x2="${W - 4}" y1="${y(g)}" y2="${y(g)}" stroke="var(--chart-grid)" ${g ? 'stroke-dasharray="2 4"' : ''}/><text x="${pad - 6}" y="${y(g) + 4}" text-anchor="end" font-size="${labelSize}" fill="var(--muted-fg)">${g ? g + 'k' : '0'}</text>`,
    )
    .join('')
  const bars = NET.map((v, i) => {
    const x = pad + i * bw + bw * 0.2,
      w = bw * 0.6,
      y0 = y(0),
      y1 = y(v)
    const neg = v < 0
    return `<rect x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.abs(y1 - y0)}" rx="3" fill="${neg ? 'url(#hatch)' : 'var(--chart-1)'}" ${neg ? 'stroke="var(--chart-1)" stroke-width="1.2"' : ''}/>
    <text x="${x + w / 2}" y="${neg ? y1 + 13 : y1 - 5}" text-anchor="middle" font-size="${labelSize}" font-weight="600" fill="var(--fg)" style="font-variant-numeric:tabular-nums">${neg ? '−' : '+'}${Math.abs(v).toFixed(1).replace('.', ',')}k</text>
    <text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" font-size="${labelSize}" fill="var(--muted-fg)">${MONTHS[i]}</text>`
  }).join('')
  return `<svg width="${W}" height="${H}" role="img" aria-label="Чистий прибуток за 6 місяців: найбільший у жовтні, +7,9 тис. $; збиток у серпні, −1,4 тис. $"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="oklch(0.84 0.183 85.3 / 0.12)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-1)" stroke-width="1.4"/></pattern></defs>${grid}${bars}</svg>`
}

function partnerBars(W, H, { labelSize = 11, pad = 8 } = {}) {
  const max = 4.5,
    top = 14,
    bottom = H - 38
  const y = (v) => top + ((max - v) / max) * (bottom - top)
  const gw = (W - pad * 2) / PART.length
  const q = ['I кв', 'II кв', 'III кв', 'IV кв']
  return `<svg width="${W}" height="${H}" role="img" aria-label="Виплати партнерам A і B по кварталах"><line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--chart-grid)"/>${PART.map(
    ([a, b], i) => {
      const x = pad + i * gw + gw * 0.16,
        bw = gw * 0.32
      const one = (v, xx, c) =>
        `<rect x="${xx}" y="${y(v)}" width="${bw - 2}" height="${y(0) - y(v)}" rx="3" fill="${c}"/><text x="${xx + (bw - 2) / 2}" y="${y(v) - 4}" text-anchor="middle" font-size="${labelSize - 1}" font-weight="600" fill="var(--fg)">${v.toFixed(1).replace('.', ',')}</text>`
      // Series named directly under each bar: no legend lookup.
      const ab = (t, xx) =>
        `<text x="${xx + (bw - 2) / 2}" y="${H - 24}" text-anchor="middle" font-size="${labelSize - 1}" font-weight="600" fill="var(--fg)">${t}</text>`
      return `${one(a, x, 'var(--chart-1)')}${one(b, x + bw, 'var(--chart-2)')}${ab('A', x)}${ab('B', x + bw)}<text x="${x + bw}" y="${H - 6}" text-anchor="middle" font-size="${labelSize}" fill="var(--muted-fg)">${q[i]}</text>`
    },
  ).join('')}</svg>`
}

const legend = (items) =>
  `<div class="row" style="gap:14px;font-size:13px">${items.map(([c, t, shape]) => `<span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:${shape === 'hatch' ? '2px' : '2px'};background:${c};${shape === 'hatch' ? 'background:repeating-linear-gradient(45deg,var(--chart-1) 0 1.5px,transparent 1.5px 4px);outline:1px solid var(--chart-1)' : ''}"></i>${t}</span>`).join('')}</div>`

export function chartMobile(w, h, { scrolled = 0 } = {}) {
  const card = (title, value, sub, chart, leg) =>
    `<div style="margin:0 16px 12px;padding:14px 14px 10px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-foot muted">${title}</div><div class="row" style="gap:8px;align-items:baseline;margin-top:2px"><span class="num" style="font-size:24px;font-weight:700;letter-spacing:-0.02em">${value}</span><span class="t-foot num" style="color:var(--positive)">${sub}</span></div><div style="margin-top:8px">${chart}</div>${leg}</div>`
  const body = `<div style="padding:0 16px 10px">${segmented(['3 міс', '6 міс', 'Рік'], 1, { fit: true })}</div>
  ${card(
    'Чистий прибуток · 6 міс',
    '+25,9k $',
    '▲ 12% до попер.',
    netBars(w - 60, w <= 320 ? 200 : 300),
    legend([
      ['var(--chart-1)', 'Прибуток'],
      ['', 'Збиток', 'hatch'],
    ]),
  )}
  ${card('Виплати партнерам · 2026', '24,9k $', '', partnerBars(w - 60, 150), '')}`
  // FAB hidden at 320 only so the static frame shows the chart; the live screen scrolls under it.
  return tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/stats',
    title: 'Статистика',
    body,
    showFab: w > 320,
  })
    .replace(
      '<div class="content">',
      `<div class="content"><div style="transform:translateY(-${scrolled}px)">`,
    )
    .replace('</div><nav class="tabbar"', '</div></div><nav class="tabbar"')
}

export function chartDesktop() {
  const tooltip = `<div style="position:absolute;left:600px;top:70px;padding:8px 10px;border-radius:10px;background:var(--popover);border:1px solid oklch(0.28 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5);font-size:13px;min-width:170px"><div style="font-weight:600">Жовтень 2026</div><div class="row" style="justify-content:space-between;margin-top:4px"><span class="muted">Дохід</span><span class="num">18 400,00 $</span></div><div class="row" style="justify-content:space-between"><span class="muted">Витрати</span><span class="num">10 500,00 $</span></div><div class="row" style="justify-content:space-between;margin-top:2px;font-weight:600"><span>Чистий</span><span class="num">+7 900,00 $</span></div></div>`
  return `<div style="padding:24px;background:var(--bg);width:1200px"><div class="row" style="gap:16px;align-items:stretch">
  <div style="position:relative;flex:2;padding:18px 20px 12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="row"><div class="grow"><div class="t-foot muted" style="font-size:13px">Чистий прибуток</div><div class="num" style="font-size:26px;font-weight:700;letter-spacing:-0.02em">+25 900,00 $</div></div>${legend(
    [
      ['var(--chart-1)', 'Прибуток'],
      ['', 'Збиток', 'hatch'],
    ],
  )}</div><div style="margin-top:10px">${netBars(720, 260, { labelSize: 12, pad: 34 })}</div>${tooltip}</div>
  <div style="flex:1;padding:18px 20px 12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-foot muted" style="font-size:13px">Виплати партнерам</div><div class="num" style="font-size:26px;font-weight:700;letter-spacing:-0.02em">24 900,00 $</div><div style="margin:10px 0 8px">${partnerBars(330, 252, { labelSize: 12 })}</div><div class="t-cap muted">A, B — партнери</div></div></div>
  <div class="row" style="gap:10px;margin-top:16px;flex-wrap:wrap">${[
    ['--chart-1', 'chart-1 · primary'],
    ['--chart-2', 'chart-2'],
    ['--chart-3', 'chart-3'],
    ['--chart-4', 'chart-4'],
    ['--chart-5', 'chart-5 · нейтральний'],
    ['--positive', 'positive'],
    ['--warning', 'warning'],
    ['--destructive', 'destructive'],
  ]
    .map(
      ([v, t]) =>
        `<span class="row" style="gap:8px;height:32px;padding:0 12px 0 6px;border-radius:8px;background:var(--card);border:1px solid var(--border);font-size:12px"><i style="width:20px;height:20px;border-radius:5px;background:var(${v})"></i>${t}</span>`,
    )
    .join('')}</div></div>`
}

// ---------- Pull-to-refresh ----------
export function ptr(w, h, stage) {
  const off = { pulling: 40, armed: 76, refreshing: 56, done: 0 }[stage]
  const spinner =
    stage === 'refreshing'
      ? `<svg width="26" height="26" viewBox="0 0 24 24" role="progressbar" aria-label="Оновлення"><g stroke="var(--fg)" stroke-width="2.2" stroke-linecap="round">${Array.from({ length: 8 }, (_, i) => `<line x1="12" y1="3" x2="12" y2="7" opacity="${0.2 + i * 0.1}" transform="rotate(${i * 45} 12 12)"/>`).join('')}</g></svg>`
      : `<span style="display:inline-block;transform:rotate(${stage === 'armed' ? 180 : 0}deg);color:${stage === 'armed' ? 'var(--primary)' : 'var(--muted-fg)'}">${icon('arrow-down', { size: 22, stroke: 2.2 })}</span>`
  const ind =
    stage === 'done'
      ? ''
      : `<div style="position:absolute;left:0;right:0;top:${50 + off / 2 - 13}px;display:grid;place-items:center;z-index:2">${spinner}</div>`
  const doneNote =
    stage === 'done'
      ? `<div role="status" class="t-cap muted" style="text-align:center;margin-top:-4px;margin-bottom:4px">Оновлено щойно</div>`
      : ''
  const inner = `${topBar()}<div class="content">${largeTitle('Фінанси')}${ind}<div style="transform:translateY(${off}px)">${doneNote}${txnList(TXNS.slice(0, 3))}</div></div>${tabBar('ADMIN', '/finance', { w })}`
  return phone({ w, h, inner })
}

// ---------- Page transition storyboard ----------
const mini = (inner, cap, { x = 0, op = 1, scale = 1, extra = '' } = {}) =>
  `<div class="col" style="gap:8px;align-items:center"><div style="width:188px;height:406px;border-radius:22px;overflow:hidden;border:1px solid oklch(0.25 0 0);position:relative;background:var(--bg)"><div style="zoom:0.5;width:375px;height:812px;position:relative">${inner(x, op, scale)}${extra}</div></div><div class="t-cap muted" style="text-align:center;max-width:188px">${cap}</div></div>`

const listScr = () =>
  `<div style="position:absolute;inset:0">${phone({ w: 375, h: 812, inner: `${topBar()}<div class="content">${largeTitle('Фінанси')}${txnList(TXNS.slice(0, 5))}</div>${tabBar('ADMIN', '/finance')}` })}</div>`
const detailScr = (x, op) =>
  `<div style="position:absolute;inset:0;transform:translateX(${x}%);opacity:${op};box-shadow:-20px 0 40px oklch(0 0 0 / 0.5)">${phone({ w: 375, h: 812, inner: `${topBar({ back: true, title: '', bell: false, search: false })}<div class="content" style="padding:8px 20px"><div class="t-title">Оренда офісу</div><div class="num" style="font-size:40px;font-weight:700;margin-top:6px">−1 200,00 $</div><div class="t-foot muted" style="margin-top:4px">Витрата · сьогодні, 14:20</div></div>` })}</div>`
const sheetScr = (y, op) =>
  `<div style="position:absolute;inset:0;background:oklch(0 0 0 / ${0.6 * op});z-index:5"></div><div style="position:absolute;left:0;right:0;bottom:0;height:420px;transform:translateY(${y}%);z-index:6;background:var(--popover);border-radius:20px 20px 0 0;border-top:1px solid var(--border)"><div class="grabber"></div><div class="t-head" style="text-align:center;margin-top:16px">Фільтри</div></div>`

export function transitions() {
  const arrow = `<div style="align-self:center;color:var(--muted-fg);margin-top:-30px">${icon('arrow-right', { size: 22 })}</div>`
  const rowOf = (title, spec, cells) =>
    `<div class="col" style="gap:12px;width:100%"><div class="row" style="gap:12px;align-items:baseline"><span class="t-head">${title}</span><span class="t-foot muted">${spec}</span></div><div class="row" style="gap:18px;align-items:flex-start">${cells.join(arrow)}</div></div>`
  const push = (x, cap) => mini((xx) => listScr() + detailScr(xx, 1), cap, { x })
  const tabCell = (active, cap) =>
    mini(
      () =>
        `<div style="position:absolute;inset:0">${phone({ w: 375, h: 812, inner: `${topBar()}<div class="content">${largeTitle(active === '/finance' ? 'Фінанси' : 'Статистика')}${active === '/finance' ? txnList(TXNS.slice(0, 5)) : ''}</div>${tabBar('ADMIN', active)}` })}</div>`,
      cap,
    )
  const sh = (y, op, cap) => mini(() => listScr() + sheetScr(y, op), cap)
  return `<div class="board" style="width:900px;gap:28px">
  <h2>Переходи між сторінками · мобільні</h2>
  ${rowOf('Push: список → деталі', 'View Transitions · 280 мс · cubic-bezier(0.2, 0, 0, 1) · попередній екран зсувається на −30%', [push(100, '0 мс'), push(45, '140 мс'), push(0, '280 мс · фокус на заголовок')])}
  ${rowOf('Назад: кнопка або свайп від краю', 'та сама крива у зворотний бік · 240 мс · свайп керує прогресом, відпускання — пружина', [push(0, 'палець біля лівого краю'), push(55, 'жест 55% · напівпрозорий список'), push(100, 'відпущено → повернення')])}
  ${rowOf('Вкладки', 'без анімації: миттєве перемикання, позиція прокрутки кожної вкладки зберігається', [tabCell('/finance', 'Фінанси'), tabCell('/stats', 'Статистика · 0 мс')])}
  ${rowOf('Аркуш', 'scrim 0→60% 200 мс + translateY 100%→0 280 мс · закриття 150 мс · drag-to-dismiss — m.* spring', [sh(100, 0, '0 мс'), sh(35, 0.6, '160 мс'), sh(0, 1, '280 мс · фокус у аркуші')])}
  <div class="t-foot muted" style="width:100%">prefers-reduced-motion: усі зсуви замінено на crossfade 120 мс; пружини вимкнено. Десктоп: зміна маршруту — crossfade вмісту 150 мс, бічна панель і заголовок нерухомі.</div></div>`
}
