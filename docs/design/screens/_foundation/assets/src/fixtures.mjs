// Council r8 (R7-11): negative fixtures for measure.mjs. Never part of the shell / primitives sets, never rendered.
// Usage: node measure.mjs fixtures   — must exit 1 and print `hit 1` (the overlap below) and nothing else.
//   fixture-hit-overlap: two 24 px text buttons whose visuals are 12 px apart (no visual overlap), each declaring a
//   44 px hit box (`data-hit="44"`); the two extended boxes overlap by 8 px, so a tap there has two owners.
//   fixture-hit-clear:   the same pair 44 px apart centre to centre: the boxes touch and never overlap (must pass).
import { page } from './base.mjs'

const pair = (gap) =>
  page(
    `<div style="position:absolute;left:100px;top:100px;display:flex;gap:${gap}px">` +
      `<button type="button" data-hit="44" style="width:24px;height:24px">A</button>` +
      `<button type="button" data-hit="44" style="width:24px;height:24px">B</button></div>`,
    { width: 375 },
  )

export const frames = () => [
  { name: 'fixture-hit-overlap', w: 375, h: 300, html: pair(12) },
  { name: 'fixture-hit-clear', w: 375, h: 300, html: pair(20) },
]
