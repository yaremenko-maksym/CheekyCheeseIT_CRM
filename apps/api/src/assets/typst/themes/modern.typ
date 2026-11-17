// Theme `modern`: sans, accent rule under headings. Prepended to resume-skeleton.typ.
// A theme may set ONLY these keys; the skeleton owns structure (spec §6).
#let theme = (
  font: "Roboto",
  accent: rgb("#1d5fa8"),
  muted: rgb("#5b616b"),
  name-size: 1.8em,
  name-align: left,
  heading-size: 1.05em,
  heading-weight: "bold",
  heading-rule: 1.2pt + rgb("#1d5fa8"),
  margin-scale: 1,
  spacing-scale: 1,
  date-on-role-line: false,
  skills-one-per-line: false,
)
