// =============================================================================
// Default senior-resume template (task-resume-template).
// =============================================================================
//
// THE CONTRACT. This file is the LAYOUT half of the "layout + data" split. It
// receives one dictionary — the resume fields plus the four layout switches —
// and returns a page. It reads nothing else: no file, no environment, no
// network. That is what makes the split physical rather than a promise: when a
// model later tailors a resume to a vacancy it is handed the fields and returns
// the fields, and this file is not part of the conversation at all.
//
// Personal templates are drawn by the designer as a separate task; this is the
// one shipped fallback for every senior who has none.
//
// EVERY STRING HERE COMES FROM AN UNTRUSTED SOURCE (an uploaded document, then
// an LLM). Interpolating a `str` into content in Typst inserts it verbatim —
// markup in the string is NOT re-parsed — so `#pagebreak()` or `*bold*` typed
// into a job title renders as those characters. The one place that would break
// the rule is `eval()`, which is deliberately absent, and the renderer pins
// this with a test.
//
// Deterministic by construction: no date, no counter, no randomness. The same
// dictionary always produces the same bytes (see ResumeTypstService, which also
// pins the creation timestamp and forbids system fonts).

#let muted = rgb("#5b616b")
#let rule-colour = rgb("#c9ccd1")

// --- the layout switches -----------------------------------------------------
// Only these four knobs exist, and each maps to a closed set of values. HR can
// reorder, hide, tighten and resize; nothing else about the typesetting is
// reachable from outside this file.

#let densities = (
  compact: (leading: 0.52em, section-gap: 0.75em, item-gap: 0.35em, margin: 1.4cm),
  normal: (leading: 0.68em, section-gap: 1.1em, item-gap: 0.55em, margin: 1.8cm),
  relaxed: (leading: 0.85em, section-gap: 1.5em, item-gap: 0.8em, margin: 2.3cm),
)

#let font-sizes = (small: 9pt, normal: 10.5pt, large: 12pt)

#let section-titles = (
  summary: "О СЕБЕ",
  skills: "НАВЫКИ",
  experience: "ОПЫТ РАБОТЫ",
  education: "ОБРАЗОВАНИЕ",
  languages: "ЯЗЫКИ",
  links: "ССЫЛКИ",
)

// --- building blocks ---------------------------------------------------------

#let section-heading(title) = {
  text(weight: "bold", size: 0.86em, tracking: 0.09em, fill: muted)[#title]
  v(0.25em, weak: true)
  line(length: 100%, stroke: 0.6pt + rule-colour)
  v(0.35em, weak: true)
}

#let experience-item(item, gap) = {
  block(above: gap, breakable: true)[
    #grid(
      columns: (1fr, auto),
      gutter: 0.8em,
      text(weight: "bold")[#item.company],
      text(fill: muted, size: 0.9em)[#item.period],
    )
    #text(style: "italic", fill: muted)[#item.role]
    #if item.bullets.len() > 0 {
      v(0.2em, weak: true)
      list(indent: 0.2em, spacing: 0.45em, tight: true, ..item.bullets.map(b => [#b]))
    }
  ]
}

#let two-line-item(primary, secondary, trailing, gap) = {
  block(above: gap)[
    #grid(
      columns: (1fr, auto),
      gutter: 0.8em,
      text(weight: "bold")[#primary],
      text(fill: muted, size: 0.9em)[#trailing],
    )
    #if secondary != "" { text(fill: muted)[#secondary] }
  ]
}

// --- sections ----------------------------------------------------------------
// Each returns `none` when it has nothing to say, so an empty section never
// leaves a heading hanging over blank paper.

#let section-body(key, content, gap) = {
  if key == "summary" {
    if content.summary.trim() == "" { return none }
    return [#content.summary]
  }
  if key == "skills" {
    if content.skills.len() == 0 { return none }
    return [#content.skills.join(" · ")]
  }
  if key == "experience" {
    if content.experience.len() == 0 { return none }
    return content.experience.map(item => experience-item(item, gap)).join()
  }
  if key == "education" {
    if content.education.len() == 0 { return none }
    return content
      .education
      .map(item => two-line-item(item.institution, item.degree, item.period, gap))
      .join()
  }
  if key == "languages" {
    if content.languages.len() == 0 { return none }
    return [#content.languages.map(l => l.name + " — " + l.level).join(" · ")]
  }
  if key == "links" {
    if content.links.len() == 0 { return none }
    // `link()` keeps the label clickable. The URL was already restricted to
    // https:/mailto: by the shared schema on the way in, so no `javascript:`
    // can reach a PDF annotation here.
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

  // `date: none` — otherwise Typst stamps the compile date into the PDF
  // metadata and two renders of the same resume stop being byte-identical.
  set document(title: data.displayName, author: data.displayName, date: none)
  set page(paper: "a4", margin: density.margin)
  set text(font: "Roboto", size: size, lang: "ru", hyphenate: false)
  set par(leading: density.leading, justify: false)

  block(below: density.section-gap)[
    #text(size: 1.7em, weight: "bold")[#data.displayName]
  ]

  for key in layout.sectionOrder {
    if layout.hiddenSections.contains(key) { continue }
    let body = section-body(key, content, density.item-gap)
    if body == none { continue }
    block(above: density.section-gap, breakable: true)[
      #section-heading(section-titles.at(key))
      #body
    ]
  }
}
