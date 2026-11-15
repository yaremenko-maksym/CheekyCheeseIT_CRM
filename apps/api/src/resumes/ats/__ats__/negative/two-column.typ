// NEGATIVE CONTROL for the ATS suite (spec §7): deliberately NOT ATS-safe.
// The experience section is a two-column grid, every header in the left
// column and every company with its bullets in the right one, the layout of a
// "sidebar" resume. Read in either column order or line by line, the items
// interleave, so the checker must report ITEM_ORDER or MISSING_TEXT.

#let titles = (
  summary: "Summary",
  experience: "Experience",
  skills: "Skills",
  education: "Education",
  languages: "Languages",
  links: "Links",
)

#let body(key, content) = {
  if key == "summary" { return [#content.summary] }
  if key == "skills" { return [#content.skills.join(" · ")] }
  if key == "experience" {
    return grid(
      columns: (1fr, 2fr),
      column-gutter: 1em,
      content.experience.map(item => [#text(weight: "bold")[#item.role] \ #item.period \ ]).join(),
      content.experience.map(item => [
        #item.company
        #list(..item.bullets.map(b => [#b]))
      ]).join(),
    )
  }
  if key == "education" {
    return content.education.map(item => [#item.institution \ #item.degree \ #item.period \ ]).join()
  }
  if key == "languages" { return [#content.languages.map(l => l.name + " — " + l.level).join(" · ")] }
  if key == "links" { return content.links.map(l => [#link(l.url)[#l.label] \ ]).join() }
  none
}

#let render(data) = {
  set document(title: data.displayName + " — Resume", date: none)
  set page(paper: "a4", margin: 1.8cm)
  set text(font: "Roboto", size: 10.5pt, ligatures: false)
  show heading: it => block(above: 1.2em, below: 0.5em)[#it.body]
  [#text(weight: "bold", size: 18pt)[#data.displayName] \ #data.email]
  for key in data.layout.sectionOrder {
    heading(level: 1, titles.at(key))
    body(key, data.content)
  }
}
