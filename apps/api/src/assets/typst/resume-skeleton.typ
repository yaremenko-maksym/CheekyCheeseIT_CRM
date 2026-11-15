// =============================================================================
// Resume skeleton, shared by every catalog template (verified-base-resume §6).
// =============================================================================
//
// HOW IT IS ASSEMBLED. `loadCatalogTemplate(name)` returns
// `themes/<name>.typ` + this file as ONE source string. The theme defines a
// single `theme` dictionary; this file owns the structure and reads `theme` at
// the top level. One string keeps the render sandbox single-file, and the
// fingerprint covers the theme for free.
//
// THE CONTRACT. The template receives one dictionary: `displayName`, `email`,
// the resume `content` and the four `layout` switches. It reads nothing else:
// no file, no environment, no network.
//
// THE SKELETON RULES (ATS-safe; each one is a test in
// resume-typst.service.spec.ts):
//   - a single column: no grid, table, columns or column break;
//   - the fixed headings Summary / Experience / Skills / Education / Languages
//     / Links, as real headings, in `layout.sectionOrder`, absent when hidden;
//   - name and email as body text at the top of page one, never in a page
//     header or footer;
//   - no images, icons, floats or absolute placement;
//   - ligatures off, so extracted text spells words the way they were typed;
//   - the document title is "<name> - Resume" with an em dash, or "Resume"
//     when the name is empty;
//   - headings are not letter-spaced.
//
// A theme may change ONLY: font, accent colour, size and weight, rules,
// margins and spacing, and header style (name alignment). Anything else is a
// skeleton change and goes through the CI suite for every template.
//
// EVERY STRING HERE COMES FROM AN UNTRUSTED SOURCE (an uploaded document, then
// an LLM). Interpolating a `str` into content inserts it verbatim; markup in
// the string is NOT re-parsed. `eval()` is deliberately absent.
//
// Deterministic by construction: no date, no counter, no randomness.
//
// GLYPHS. Only the glyphs of the theme's embedded font can be drawn; there is
// no fallback font. Typst gives no warning for a missing glyph and drops the
// whole run of text around it, so type characters literally and let the
// renderer's check (resume-glyphs.ts) name what is unavailable.

// --- the layout switches -----------------------------------------------------
// Closed sets. The theme scales spacing and margins; it cannot add a switch.

#let densities = (
  compact: (leading: 0.52em, section-gap: 0.75em, item-gap: 0.35em, margin: 1.4cm),
  normal: (leading: 0.68em, section-gap: 1.1em, item-gap: 0.55em, margin: 1.8cm),
  relaxed: (leading: 0.85em, section-gap: 1.5em, item-gap: 0.8em, margin: 2.3cm),
)

#let font-sizes = (small: 9pt, normal: 10.5pt, large: 12pt)

#let section-titles = (
  summary: "Summary",
  experience: "Experience",
  skills: "Skills",
  education: "Education",
  languages: "Languages",
  links: "Links",
)

// --- building blocks ---------------------------------------------------------

// Role, company and period come before the bullets, each on its own line, or
// with the period right-aligned on the role line when the theme asks for it.
#let experience-item(item, gap) = {
  block(above: gap, breakable: true)[
    #if theme.date-on-role-line [
      #text(weight: "bold")[#item.role] #h(1fr) #text(fill: theme.muted)[#item.period] \
      #item.company
    ] else [
      #text(weight: "bold")[#item.role] \
      #item.company \
      #text(fill: theme.muted)[#item.period]
    ]
    #if item.bullets.len() > 0 {
      v(0.2em, weak: true)
      list(indent: 0.2em, spacing: 0.45em, tight: true, ..item.bullets.map(b => [#b]))
    }
  ]
}

#let education-item(item, gap) = {
  block(above: gap)[
    #text(weight: "bold")[#item.institution] \
    #if item.degree != "" [#item.degree \ ]
    #text(fill: theme.muted)[#item.period]
  ]
}

// --- sections ----------------------------------------------------------------
// Each returns `none` when it has nothing to say, so an empty section never
// leaves a heading over blank paper.

#let section-body(key, content, gap) = {
  if key == "summary" {
    if content.summary.trim() == "" { return none }
    return [#content.summary]
  }
  if key == "skills" {
    if content.skills.len() == 0 { return none }
    if theme.skills-one-per-line { return content.skills.map(s => [#s]).join(linebreak()) }
    return [#content.skills.join(" · ")]
  }
  if key == "experience" {
    if content.experience.len() == 0 { return none }
    return content.experience.map(item => experience-item(item, gap)).join()
  }
  if key == "education" {
    if content.education.len() == 0 { return none }
    return content.education.map(item => education-item(item, gap)).join()
  }
  if key == "languages" {
    if content.languages.len() == 0 { return none }
    return [#content.languages.map(l => l.name + " — " + l.level).join(" · ")]
  }
  if key == "links" {
    if content.links.len() == 0 { return none }
    // The URL was restricted to https:/mailto: by the shared schema on the way
    // in, so no `javascript:` can reach a PDF annotation here.
    return content.links.map(l => block(above: 0.3em)[#link(l.url)[#l.label]]).join()
  }
  none
}

// --- the document ------------------------------------------------------------

#let render(data) = {
  let content = data.content
  let layout = data.layout
  let density = densities.at(layout.density)
  let size = font-sizes.at(layout.fontScale)
  let gap = density.section-gap * theme.spacing-scale

  // `date: none`, or Typst stamps the compile date and renders stop being
  // byte-identical.
  // An empty name (the owner row is gone) titles the document plain "Resume".
  let title = if data.displayName.trim() == "" { "Resume" } else { data.displayName + " — Resume" }
  set document(title: title, author: data.displayName, date: none)
  set page(paper: "a4", margin: density.margin * theme.margin-scale)
  set text(font: theme.font, size: size, hyphenate: false, ligatures: false)
  set par(leading: density.leading * theme.spacing-scale, justify: false)

  show heading: it => {
    set text(size: theme.heading-size, weight: theme.heading-weight, fill: theme.accent, tracking: 0pt)
    block(above: gap, below: 0.35em, sticky: true)[#it.body]
    if theme.heading-rule != none {
      line(length: 100%, stroke: theme.heading-rule)
      v(0.2em, weak: true)
    }
  }

  align(theme.name-align)[
    #if data.displayName.trim() != "" [#text(size: theme.name-size, weight: "bold")[#data.displayName] \ ]
    #if data.email != "" [#data.email]
  ]

  for key in layout.sectionOrder {
    if layout.hiddenSections.contains(key) { continue }
    let body = section-body(key, content, density.item-gap * theme.spacing-scale)
    if body == none { continue }
    heading(level: 1, section-titles.at(key))
    body
  }
}
