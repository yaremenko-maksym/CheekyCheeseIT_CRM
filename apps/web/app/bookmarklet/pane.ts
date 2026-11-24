import { nodeText, type Visible } from './text'

/** A section heading of a job text (en/uk/ru/pl/de/fr/nl): a cluster of them marks the vacancy pane. */
const CUE =
  /requirement|responsibilit|qualification|what you.?ll (be )?(do|bring|need)|what we (offer|look|need)|ways to stand out|benefits|about (the|this) (role|job|position|team)|your (role|mission|impact)|who you are|nice to have|must have|we.?re looking|you will|key skills|required skills|perks|вимоги|необхідні навички|обов.язки|ми пропонуємо|пропонуємо|що потрібно|очікуємо|умови|про проєкт|про проект|требования|необходимые навыки|требуемые навыки|обязанности|мы предлагаем|условия|ожидаем|wymagania|obowiązki|oferujemy|zakres|aufgaben|anforderungen|dein profil|wir bieten|missions|profil recherch|functieomschrijving|functie-eisen|wat bieden wij/i
/** What a block after the pane says when it is the same job's pay or benefits. */
const EXTRA =
  /salary|compensation|pay range|base pay|benefits|perks|we offer|\$\s?\d|€\s?\d|£\s?\d|\d\s?(usd|eur|uah|pln|грн)|зарплат|заробітн|wynagrodzenie|ми пропонуємо|мы предлагаем/i
/** A pay or benefits heading opening a block further from the pane (en, and the uk/ru/pl forms of EXTRA). */
const PAY_HEAD =
  /^((salary|compensation|pay|base pay|benefits|perks|what we offer)\b|зарплат|заробітн|wynagrodzenie|ми пропонуємо|мы предлагаем)/i
/** An amount of money: a currency sign before a digit, or a digit before a currency code. */
const MONEY = /[$€£]\s?\d|\d\s?(usd|eur|uah|pln|грн|czk|chf|gbp)/i
/** A heading that names a section, not the job. */
const GENERIC =
  /^(description|summary|overview|job details|details|beschrijving.*|опис.*|role overview|share this job|apply.*)$/i
/** A heading that names the board or the careers site, not the job. */
const BOARDS =
  /linkedin|indeed|djinni|dou\b|glassdoor|workday|greenhouse|lever|smartrecruiters|workable|ashby|recruitee|teamtailor|personio|careers?$|^jobs?$|search for jobs|job application|^job id/i

/** Over this share of its text in links, a block is a list of other pages, not a job text. */
const LINKS_MAX = 0.35
/** A pane shorter than this likely misses its intro: it grows to its parent. */
const PANE_MIN = 600

/**
 * The block of the page holding the vacancy text; `cue` says it was found by its section headings.
 * `more` holds pay or benefit blocks after the pane's ancestors, for any description source.
 */
export type Pane = { el: Element; text: string; cue: boolean; more: string[] }

const letters = (el: Element): number => (el.textContent ?? '').replace(/\s/g, '').length

function linkDensity(el: Element): number {
  let links = 0
  el.querySelectorAll('a').forEach((a) => (links += letters(a)))
  return links / (letters(el) || 1)
}

/** The predicate alone sees one element; a hidden ancestor hides it too. */
function shownUp(el: Element, visible: Visible): boolean {
  for (let a: Element | null = el; a; a = a.parentElement) {
    if (!visible(a)) return false
  }
  return true
}

/** The text of up to 3 shown blocks after `start` that pass `pay`, each short and not links. */
function following(
  start: Element,
  visible: Visible,
  pay: (text: string, el: Element) => boolean,
): string[] {
  const out: string[] = []
  let el = start.nextElementSibling
  for (let i = 0; el && i < 3; el = el.nextElementSibling, i++) {
    const text = nodeText(el, visible)
    if (visible(el) && text.length <= 3000 && pay(text, el) && linkDensity(el) <= LINKS_MAX) {
      out.push(text)
    }
  }
  return out
}

/** The job's pay or benefits a cue pane often stops before: its own next blocks, any pay word. */
const extras = (pane: Element, visible: Visible): string[] =>
  following(pane, visible, (text) => EXTRA.test(text))

/** Pay blocks after the pane's ancestors (3 levels): only one opening with a pay heading or naming an amount. */
function farExtras(pane: Element, visible: Visible): string[] {
  const out: string[] = []
  for (let a = pane.parentElement, level = 0; a && level < 3; a = a.parentElement, level++) {
    out.push(
      ...following(
        a,
        visible,
        (text, el) =>
          (PAY_HEAD.test(text) || MONEY.test(text)) && !el.closest('nav,footer,aside,header'),
      ),
    )
  }
  return out
}

/** The deepest shown block holding most section-cue headings, not a list of links. */
function cuePane(doc: Document, visible: Visible): Element | null {
  const found = Array.from(
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,dt,p,div,span,li'),
  ).filter((el) => {
    // The cheap element checks first: most elements fail them before any text is read.
    if (el.children.length > 2 || el.closest('a,button,nav,header,footer')) return false
    const t = (el.textContent ?? '').trim()
    // Every cue word is over 2 characters, so no lower bound is needed.
    return t.length < 70 && CUE.test(t) && shownUp(el, visible)
  })
  // Only the innermost: `<h3><strong>Requirements</strong></h3>` is one cue, not two.
  const cues = found.filter((c) => !found.some((o) => o !== c && c.contains(o)))
  const need = Math.max(2, Math.ceil(cues.length * 0.6))
  const counts = new Map<Element, number>()
  for (const cue of cues) {
    for (let a = cue.parentElement; a; a = a.parentElement) {
      counts.set(a, (counts.get(a) ?? 0) + 1)
    }
  }
  // The qualifying blocks nest (each holds over half the cues), so the last one contained is the deepest.
  let best: Element | null = null
  for (const [el, n] of counts) {
    if (n >= need && (!best || best.contains(el)) && linkDensity(el) <= LINKS_MAX) best = el
  }
  while (
    best?.parentElement &&
    best.parentElement !== doc.body &&
    nodeText(best, visible).length < PANE_MIN &&
    // A parent that is mostly links adds a related-jobs list, not the intro.
    linkDensity(best.parentElement) <= LINKS_MAX
  ) {
    best = best.parentElement
  }
  return best
}

/** No cue cluster: the largest shown block whose text is its own (not one child's) and not links. */
function fallbackPane(doc: Document, visible: Visible): Element | null {
  let best: Element | null = null
  let score = 0
  doc.querySelectorAll('article,section,div,main').forEach((el) => {
    const len = (el.textContent ?? '').length
    if (len < 500) return
    const child = Array.from(el.children).reduce(
      (m, c) => Math.max(m, (c.textContent ?? '').length),
      0,
    )
    const own = len - child * 0.9
    // A perf skip only: the score never exceeds `own`, so a block skipped here could not win.
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: equivalent, the check below rejects the same blocks
    if (own <= score) return
    const s = own * (1 - linkDensity(el)) ** 2
    if (s > score && shownUp(el, visible)) [best, score] = [el, s]
  })
  return best
}

/**
 * The vacancy pane of a page no JSON-LD or profile read in full: the section-cue cluster with its
 * pay/benefit siblings, else the largest text block. Visibility only through `visible`: a parsed
 * document has no layout, and `checkVisibility()` is false for all of it there.
 */
export function findPane(doc: Document, visible: Visible): Pane | null {
  const cued = cuePane(doc, visible)
  const el = cued ?? fallbackPane(doc, visible)
  if (!el) return null
  const text = [nodeText(el, visible), ...extras(el, visible)].filter(Boolean).join('\n\n')
  return { el, text, cue: cued !== null, more: farExtras(el, visible) }
}

const norm = (t: string | null | undefined): string =>
  // Stryker disable next-line MethodExpression,StringLiteral: upper case works the same, every comparison norms both sides; an absent text never equals a shown heading
  (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * The job title from the page's headings, walking up from the pane (a two-pane board's list h1 sits
 * higher). In order, each over the whole walk: the heading the tab title or og:title leads with, then
 * one that opens it (a whole-word prefix of at least half; both read `lead`, which may show a page
 * <header>), then an h1 they name, then any heading they name, then the first tab-title segment as a bare element, then
 * the nearest h1, then the nearest h2 (only h1 and h2 are read). Section names and board brands are
 * skipped.
 */
export function guessTitle(
  doc: Document,
  from: Element | null,
  visible: Visible,
  lead: Visible = visible,
): string {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')
  const named = norm(`${doc.title} ${og ?? ''}`)
  const candidates = Array.from(doc.querySelectorAll('h1,h2')).filter((h) => {
    const t = (h.textContent ?? '').trim()
    return (
      t.length > 2 && t.length < 160 && !CUE.test(t) && !GENERIC.test(t) && !h.closest('nav,footer')
    )
  })
  const heads = candidates.filter((h) => shownUp(h, visible))
  // A page's hero <header> often holds the job h1: it counts on the leading rung only.
  const leadHeads = candidates.filter((h) => shownUp(h, lead))
  const h1 = (h: Element): boolean => h.tagName === 'H1'
  const isNamed = (h: Element): boolean =>
    named.includes(norm(h.textContent)) && !BOARDS.test(h.textContent ?? '')
  const up = (list: Element[], ...prefer: ((h: Element) => boolean)[]): Element | undefined => {
    for (let a: Element | null = from ?? doc.body; a; a = a.parentElement) {
      for (const test of prefer) {
        const hit = list.find((h) => a.contains(h) && test(h))
        if (hit) return hit
      }
    }
    return undefined
  }
  // Obfuscated markup with no heading tag: an element showing exactly the first tab-title segment.
  const segment = (): Element | undefined => {
    const first = norm(doc.title.split(/\s[|·–—-]\s/)[0])
    if (first.length <= 3 || BOARDS.test(first)) return undefined
    return Array.from(doc.querySelectorAll('p,strong,span,div,a')).find(
      (el) => el.children.length === 0 && norm(el.textContent) === first && shownUp(el, visible),
    )
  }
  // The job leads the tab title or og:title ("Data Engineer | Acme"); a spaced hyphen stays, job titles hold it.
  const leads = [doc.title, og].map((t) => norm(t?.split(/\s[|·–—]\s/)[0]))
  const leading = (h: Element): boolean => leads.includes(norm(h.textContent)) && isNamed(h)
  // "Senior Java Engineer" for "Senior Java Engineer в Acme": a whole-word prefix of at least half.
  const opening = (h: Element): boolean => {
    const t = norm(h.textContent)
    return leads.some((l) => l.startsWith(`${t} `) && t.length * 2 >= l.length) && isNamed(h)
  }
  // Then a named h1 anywhere up the walk beats a named h2 nearer the pane (`Acme` in a pane under `Engineer`).
  const hit =
    up(leadHeads, leading) ??
    up(leadHeads, opening) ??
    up(heads, (h) => h1(h) && isNamed(h)) ??
    up(heads, isNamed) ??
    segment() ??
    up(heads, h1, Boolean)
  return nodeText(hit, visible)
}
