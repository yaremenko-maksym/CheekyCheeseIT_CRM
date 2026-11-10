// Theme `classic`: serif, centered name. Prepended to resume-skeleton.typ.
// A theme may set ONLY these keys; the skeleton owns structure (spec §6).
#let theme = (
  font: "PT Serif",
  accent: rgb("#1f2933"),
  muted: rgb("#52575e"),
  name-size: 1.9em,
  name-align: center,
  heading-size: 1.08em,
  heading-weight: "bold",
  heading-rule: 0.5pt + rgb("#9aa0a6"),
  margin-scale: 1,
  spacing-scale: 1,
  date-on-role-line: false,
  skills-one-per-line: false,
)
