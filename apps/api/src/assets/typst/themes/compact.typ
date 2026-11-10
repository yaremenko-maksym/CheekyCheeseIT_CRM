// Theme `compact`: denser spacing, dates right-aligned on the role line.
// Prepended to resume-skeleton.typ. A theme may set ONLY these keys (spec §6).
#let theme = (
  font: "Roboto",
  accent: rgb("#2b2f36"),
  muted: rgb("#5b616b"),
  name-size: 1.5em,
  name-align: left,
  heading-size: 1em,
  heading-weight: "bold",
  heading-rule: 0.5pt + rgb("#c9ccd1"),
  margin-scale: 0.8,
  spacing-scale: 0.7,
  date-on-role-line: true,
  skills-one-per-line: false,
)
