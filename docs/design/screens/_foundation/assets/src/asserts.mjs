// Council r6: generator asserts. frames() runs them, so render, measure, contrast and strings all refuse a frame
// that breaks a money-safety rule before anything is drawn.
//
// close-weight (R5-01, foundation §11): «Є в списку — закрити чернетку» is the filled primary only when the frame
// draws a «збіг» row. With «схожа» rows only (or none) both exits of the unknown-outcome chooser stay neutral.
const CLOSE = 'Є в списку — закрити чернетку'
const MATCH = '>збіг</span>'

export function closeWeight(html) {
  const bad = []
  let i = html.indexOf(CLOSE)
  while (i !== -1) {
    const open = html.lastIndexOf('class="btn', i)
    const cls = html.slice(open, html.indexOf('"', open + 7) + 1)
    if (/\bprimary\b/.test(cls) && !html.includes(MATCH)) bad.push(cls)
    i = html.indexOf(CLOSE, i + CLOSE.length)
  }
  return bad
}

export function assertFrames(frames) {
  const errors = frames.flatMap((f) =>
    closeWeight(f.html).map(() => `${f.name}: filled «${CLOSE}» without a «збіг» row`),
  )
  if (errors.length) throw new Error(`generator asserts failed:\n  ${errors.join('\n  ')}`)
  return frames
}
