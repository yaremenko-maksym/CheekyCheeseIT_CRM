import { useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { wasRootPrerendered } from '@/lib/prerender-hint'

/**
 * Hero "live" code terminal (landing-redesign.md §2.4 `Terminal`, evolution
 * of the old inline `Terminal()` in `routes/index.tsx`). Character-level
 * typewriter + syntax tokenizer ported 1:1 from
 * docs/design/assets/landing-redesign/Terminal.dc.html (`tokenize()` /
 * `buildFlat()` — pure JS, not UI-framework-specific).
 *
 * `role="img"` + a whole-terminal `aria-label` — assistive tech must not
 * read the per-character typing animation (§9).
 *
 * Prerender-hydration flash fix (ui-ux-designer Mode B fidelity review,
 * PR #398 — HIGH): `scripts/prerender.mjs` captures `/` with the first
 * snippet already fully typed (its `preparePage()` emulates
 * `prefers-reduced-motion: reduce` for the capture, hitting the branch
 * below that sets `revealed` to the full length immediately), so a real
 * visitor's browser paints that complete snippet BEFORE any client JS
 * runs. Without special-casing that, this component's normal mount
 * behavior — reset `revealed` to 0 and type from scratch — would erase the
 * already-painted code and visibly retype it over ~2-3s on every load of
 * `/`. `terminalHasMountedOnce` (module-level, NOT component state — it
 * must survive this component unmounting/remounting on SPA navigation
 * within the SAME page load) + `wasRootPrerendered()` together identify
 * ONLY the genuine first mount of a prerendered load: that one starts from
 * the already-typed state and cycles straight to the next snippet: a
 * later home -> careers -> home SPA-navigation remount has no prerendered
 * DOM to preserve and types normally, exactly like before prerendering
 * existed.
 */
let terminalHasMountedOnce = false

interface Snippet {
  file: string
  code: string
}

// Exact copy from Terminal.dc.html — do not reformat/retype, the code IS the
// visual content of the hero.
const SNIPPETS: Snippet[] = [
  {
    file: 'ai-platform/serve.py',
    code: `# realtime multimodal inference · p95 < 80ms
import torch
from cheese.serve import Pipeline, batch

pipe = Pipeline.load("vision-xl", device="cuda")

@app.post("/v1/predict")
async def predict(req: Request):
    images = await preprocess(req.files)
    with torch.inference_mode():
        out = pipe(batch(images), top_k=5)
    return { "labels": out.labels, "ms": out.latency }`,
  },
  {
    file: 'edtech-platform/path.ts',
    code: `// adaptive learning path · per-learner curriculum
import { Learner, Lesson } from "@cheese/core";

export function nextLesson(learner: Learner): Lesson {
  const weak = learner.skills
    .filter((s) => s.confidence < 0.8)
    .sort((a, b) => a.confidence - b.confidence);

  return curriculum.recommend(weak[0], {
    difficulty: learner.streak > 5 ? "hard" : "adaptive",
  });
}`,
  },
  {
    file: 'commerce-storefront/checkout.ts',
    code: `// edge checkout · idempotent, zero-downtime
export const checkout = api.mutation(async ({ cart }) => {
  const stock = await inventory.reserve(cart.items);
  if (!stock.ok) throw new OutOfStock(stock.missing);

  const order = await payments.charge({
    amount: cart.total,
    currency: "USD",
    idempotencyKey: cart.id,
  });
  return { orderId: order.id, status: "confirmed" };
});`,
  },
]

const KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'function',
  'const',
  'let',
  'var',
  'async',
  'await',
  'with',
  'return',
  'if',
  'else',
  'throw',
  'new',
  'def',
  'class',
  'for',
  'in',
  'of',
  'as',
  'true',
  'false',
  'null',
  'None',
  'not',
])

type TokenClass =
  | 'tk-ws'
  | 'tk-str'
  | 'tk-com'
  | 'tk-num'
  | 'tk-key'
  | 'tk-fn'
  | 'tk-type'
  | 'tk-var'
  | 'tk-punc'

interface Token {
  t: string
  c: TokenClass
}

const TOKEN_RE =
  /(\s+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\/[^\n]*)|(\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|([^\sA-Za-z0-9_$"'])/g

function tokenizeLine(line: string): Token[] {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return [{ t: line, c: 'tk-com' }]
  }
  const out: Token[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(line))) {
    const [, ws, str, comment, num, word, punct] = m
    if (ws !== undefined) {
      out.push({ t: ws, c: 'tk-ws' })
      continue
    }
    if (str !== undefined) {
      out.push({ t: str, c: 'tk-str' })
      continue
    }
    if (comment !== undefined) {
      out.push({ t: comment, c: 'tk-com' })
      continue
    }
    if (num !== undefined) {
      out.push({ t: num, c: 'tk-num' })
      continue
    }
    if (word !== undefined) {
      const rest = line.slice(TOKEN_RE.lastIndex)
      let c: TokenClass
      if (KEYWORDS.has(word)) c = 'tk-key'
      else if (/^\s*\(/.test(rest)) c = 'tk-fn'
      else if (/^[A-Z]/.test(word)) c = 'tk-type'
      else c = 'tk-var'
      out.push({ t: word, c })
      continue
    }
    if (punct !== undefined) {
      out.push({ t: punct, c: 'tk-punc' })
    }
  }
  return out
}

interface FlatChar {
  ch: string
  c: TokenClass | 'tk-nl'
  line: number
}

interface FlatCode {
  flat: FlatChar[]
  count: number
}

function buildFlat(code: string): FlatCode {
  const lines = code.split('\n')
  const flat: FlatChar[] = []
  lines.forEach((line, li) => {
    for (const tok of tokenizeLine(line)) {
      for (const ch of tok.t) flat.push({ ch, c: tok.c, line: li })
    }
    flat.push({ ch: '\n', c: 'tk-nl', line: li })
  })
  return { flat, count: lines.length }
}

interface RenderedLine {
  key: number
  segments: { t: string; c: TokenClass }[]
  showCursor: boolean
}

function buildLines(cur: FlatCode, revealed: number): RenderedLine[] {
  const { flat, count } = cur
  const lineMap = new Map<number, { t: string; c: TokenClass }[]>()
  let lastLine = 0
  for (let i = 0; i < revealed; i++) {
    const cell = flat[i]
    if (!cell || cell.c === 'tk-nl') continue
    lastLine = cell.line
    const arr = lineMap.get(cell.line) ?? []
    const last = arr[arr.length - 1]
    if (last && last.c === cell.c) last.t += cell.ch
    else arr.push({ t: cell.ch, c: cell.c })
    lineMap.set(cell.line, arr)
  }
  const maxLine = revealed >= flat.length ? count - 1 : lastLine
  const lines: RenderedLine[] = []
  for (let li = 0; li <= maxLine; li++) {
    lines.push({
      key: li,
      segments: lineMap.get(li) ?? [],
      showCursor: li === maxLine && revealed < flat.length,
    })
  }
  return lines
}

const SNIPPET_PAUSE_MS = 2400
const NEXT_SNIPPET_DELAY_MS = 400

export function Terminal({
  ariaLabel = 'Animated code editor previewing CheekyCheeseIT project source across AI, EdTech and E-Commerce',
}: {
  /** task-landing-i18n.md — localized per `Dictionary['home']['terminalAriaLabel']`; the code snippets themselves stay English (source code, not natural-language copy — task-landing-i18n.md "терминал-хинт не ломать"). */
  ariaLabel?: string
}) {
  const reducedMotion = useReducedMotion()
  const [snapIdx, setSnapIdx] = useState(0)
  const curRef = useRef<FlatCode>(buildFlat(SNIPPETS[0]!.code))
  // Lazy initializers below run during THIS render only (React guarantees a
  // `useState` lazy initializer runs exactly once for a given mount) — a
  // plain read of the module flag, no mutation during render (mutating it
  // here would double-fire under StrictMode's dev-only double-render).
  // `curRef` is declared above so its initial value is already set by the
  // time `revealed`'s initializer reads it.
  const [skipInitialTyping] = useState(() => !terminalHasMountedOnce && wasRootPrerendered())
  // Matches the DOM `scripts/prerender.mjs` already painted (or, for a
  // genuine first mount, the plain empty start) with ZERO intermediate
  // "reset to empty" render — not just an effect correcting it a tick
  // later — so a screenshot taken immediately post-hydration is pixel-for-
  // pixel identical to the pre-hydration prerendered screenshot.
  const [revealed, setRevealed] = useState(() =>
    skipInitialTyping ? curRef.current.flat.length : 0,
  )
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    // Commit-phase, not render-phase: guaranteed to run exactly once per
    // real mount in production (StrictMode's dev-only double-invoke of
    // effects doesn't apply outside development, see this component's
    // module doc), so this can safely be the one place that "spends" the
    // module flag.
    terminalHasMountedOnce = true

    if (reducedMotion) {
      curRef.current = buildFlat(SNIPPETS[0]!.code)
      setSnapIdx(0)
      setRevealed(curRef.current.flat.length)
      return
    }

    let cancelled = false
    let localSnap = 0

    const scheduleNext = () => {
      timerRef.current = setTimeout(() => {
        if (cancelled) return
        localSnap = (localSnap + 1) % SNIPPETS.length
        curRef.current = buildFlat(SNIPPETS[localSnap]!.code)
        setSnapIdx(localSnap)
        setRevealed(0)
        timerRef.current = setTimeout(tick, NEXT_SNIPPET_DELAY_MS)
      }, SNIPPET_PAUSE_MS)
    }

    const tick = () => {
      if (cancelled) return
      const { flat } = curRef.current
      setRevealed((prev) => {
        const next = prev + 1
        if (next >= flat.length) {
          scheduleNext()
          return flat.length
        }
        const ch = flat[prev]?.ch ?? ''
        let delay = 16 + Math.random() * 30
        if (ch === '\n') delay = 90 + Math.random() * 80
        else if (ch === ' ') delay = 22
        else if (',;{}()'.includes(ch)) delay = 55
        timerRef.current = setTimeout(tick, delay)
        return next
      })
    }

    if (skipInitialTyping) {
      // `revealed`'s lazy initializer above already rendered snippet 0
      // fully typed on this mount's first paint — do NOT reset it back to
      // 0 (that would be exactly the erase-and-retype flash this fix
      // exists to remove). Go straight to "pause, then type the next
      // snippet", same cadence as a normal end-of-snippet transition.
      scheduleNext()
    } else {
      curRef.current = buildFlat(SNIPPETS[0]!.code)
      setRevealed(0)
      timerRef.current = setTimeout(tick, 16)
    }

    return () => {
      cancelled = true
      clearTimeout(timerRef.current)
    }
  }, [reducedMotion])

  const lines = useMemo(() => buildLines(curRef.current, revealed), [revealed, snapIdx])
  const filename = SNIPPETS[snapIdx]!.file

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="relative overflow-hidden rounded-[14px] border border-border bg-[oklch(10%_0_0)] shadow-[0_40px_120px_-40px_var(--marketing-glow)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--marketing-line-soft)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-4 py-[13px]">
        <span className="size-[11px] rounded-full bg-[#ff5f57]" />
        <span className="size-[11px] rounded-full bg-[#febc2e]" />
        <span className="size-[11px] rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-[color-mix(in_oklch,var(--foreground)_55%,transparent)]">
          {filename}
        </span>
        <span className="ml-auto inline-flex items-center gap-[7px] font-mono text-[11px] text-[color-mix(in_oklch,var(--foreground)_40%,transparent)]">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]"
          />
          live
        </span>
      </div>
      <div className="min-h-[340px] p-[18px] pb-[22px] font-mono text-[12.5px] leading-[1.75] whitespace-pre-wrap [tab-size:2] md:min-h-[400px] md:p-6 md:pb-[26px] md:text-[13.5px]">
        {lines.map((line) => (
          <div key={line.key} className="min-h-[1.75em]">
            <span
              aria-hidden="true"
              className="mr-[1.2em] inline-block w-[2.2em] text-right text-[color-mix(in_oklch,var(--foreground)_26%,transparent)] select-none"
            >
              {String(line.key + 1).padStart(2, ' ')}
            </span>
            <span>
              {line.segments.length === 0 && !line.showCursor && ' '}
              {line.segments.map((seg, i) => (
                <span key={i} className={seg.c}>
                  {seg.t}
                </span>
              ))}
              {line.showCursor && <span aria-hidden="true" className="cc-cursor" />}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
