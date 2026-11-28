// Council r6: generator asserts. frames() runs them, so render, measure and strings all refuse a frame that
// breaks a money-safety rule before anything is drawn (contrast.mjs reads tokens only and never calls frames()).
//
// close-weight (R5-01, foundation §11): «Є в списку — закрити чернетку» is the filled primary only when the frame
// draws a «збіг» row. With «схожа» rows only (or none) both exits of the unknown-outcome chooser stay neutral.
// r7 (R6-01, the mirror): with a «збіг» or a warning «схожа» row, «Створити ще раз» in the recreate confirm
// (`cr-t`) is neutral — no `primary` class, no brand-yellow ink — and never takes the initial focus.
const CLOSE = 'Є в списку — закрити чернетку'
const RECREATE = 'Створити ще раз</button>'
const MATCH = '>збіг</span>'
const LIKELY = /color:var\(--warning\);font-weight:600">схожа|>збіг<\/span>|У списку є (збіг|схожа)/

const tagOf = (html, i) => {
  const open = html.lastIndexOf('<button', i)
  return html.slice(open, html.indexOf('>', open) + 1)
}

export function closeWeight(html) {
  const bad = []
  let i = html.indexOf(CLOSE)
  while (i !== -1) {
    const open = html.lastIndexOf('class="btn', i)
    const cls = html.slice(open, html.indexOf('"', open + 7) + 1)
    if (/\bprimary\b/.test(cls) && !html.includes(MATCH))
      bad.push(`filled «${CLOSE}» without a «збіг» row`)
    i = html.indexOf(CLOSE, i + CLOSE.length)
  }
  const cr = html.indexOf('aria-labelledby="cr-t"')
  if (cr !== -1 && LIKELY.test(html)) {
    let j = html.indexOf(RECREATE, cr)
    while (j !== -1) {
      const tag = tagOf(html, j)
      if (/class="[^"]*\bprimary\b/.test(tag) || /color:var\(--primary\)/.test(tag))
        bad.push('filled «Створити ще раз» in the recreate confirm over a «збіг» / «схожа» row')
      if (/data-initial-focus/.test(tag)) bad.push('«Створити ще раз» takes the initial focus')
      j = html.indexOf(RECREATE, j + RECREATE.length)
    }
  }
  return bad
}

export function assertFrames(frames) {
  const errors = frames.flatMap((f) => closeWeight(f.html).map((e) => `${f.name}: ${e}`))
  if (errors.length) throw new Error(`generator asserts failed:\n  ${errors.join('\n  ')}`)
  return frames
}
