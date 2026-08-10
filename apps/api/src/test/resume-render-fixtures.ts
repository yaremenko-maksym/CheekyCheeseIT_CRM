/**
 * Shared fixtures for the resume-render specs.
 *
 * A plain module rather than an export from one spec file: importing a `.spec`
 * from another `.spec` registers the imported file's tests in the importer's
 * run too, so the same suite executes twice and any failure is reported against
 * the wrong file.
 */

/**
 * A legitimate but expensive Typst template.
 *
 * Calibrated on the development machine (Apple silicon, Typst 0.15.1):
 *
 *   items    wall clock
 *   1 500      0.26 s
 *   4 000      1.42 s
 *   30 000    72.0 s
 *
 * Markedly superlinear — which is precisely why a render may never share a
 * thread with the API. A normal one-page resume renders in about 11 ms; this
 * exists so the deadline and the responsiveness measurement have a real window
 * to observe rather than a millisecond.
 */
export function slowTemplate(items: number): string {
  return [
    '#let render(data) = {',
    '  set page(paper: "a4")',
    '  set text(font: "Roboto", size: 10pt)',
    `  for i in range(${items}) [`,
    '    Рядок #i — текст резюме, який займає місце і потребує верстки. #h(0.3em)',
    '  ]',
    '}',
  ].join('\n')
}
