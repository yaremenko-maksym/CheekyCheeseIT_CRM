# How ATSs parse and rank resumes, which templates stay safe, and how to test it

**Date:** 2026-11-10 · **Why:** the base-resume ATS gate, the per-senior template catalog and the
dedicated ATS test suite of the tailored-resume feature
(`docs/superpowers/specs/2026-11-10-tailored-resume-design.md`).
**Shelf life:** recheck on a Typst bump (tagging and PDF standards move between minors), on a Workday
HiredScore or Greenhouse Talent Matching release note, and at the latest by 2027-05-10.

All links accessed 2026-11-10. **P** = primary (vendor docs, source code); **S** = secondary
(vendor-marketing survey, blog, forum), lower confidence.

## Short answer

An ATS first converts the file to plain text, and almost every failure happens there: columns,
sidebars, text in images, header/footer-only contacts, broken Unicode maps. Formatting-based
auto-rejection is mostly a myth; the real costs are a bad parse (invisible to literal keyword search
and AI grading) and employer knockout questions. Visual variety is safe if every template keeps one
single-column skeleton, the same standard headings and the same reading order, and differs only in
font, accent color, spacing, rules and header style. Test it by round-trip: render, extract the text
layer, parse it, compare to the source JSON, for every template x fixture.

## Facts: 1. How ATSs process resumes

- **Pipeline = file -> plain text -> fields.** Textkernel (ex-Sovren, an OEM parser behind many ATSs): "The vast majority of problems in parsing are not from processing the plain text, but from conversion to plain text"; "If the converted text is malformed, we cannot fix it." Designer resumes fail when they "use images instead of text, have text run diagonally ... use vertical text". OCR is capped at 10 pages / 120 s. **P** <https://developer.textkernel.com/tx-platform/v10/resume-parser/overview/getting-started/>
- **Multi-column is a known failure mode.** Textkernel: a naive top-down, left-to-right render mixes columns. About 15% of CVs use columns. Its new gap classifier raised well-rendered CVs from 62% to 90% (about 700 CVs). So even the best parser got 1 in 10 column CVs wrong. **P** (vendor blog, undated) <https://textkernel.com/learn-support/blog/improving-extraction-from-column-resumes>
- **Workday:** "Resume parsing results can vary based on resume format and order of words. For best results, use resumes that don't have images or image-based styles." Workday parsing does not auto-fill **Skills** or **Languages**. **P** <https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/candidates/set-up-prospects-and-candidates/hdc1552497830785.html>
- **Greenhouse:** accepts .doc, .docx, .pdf, .rtf, .txt. **P** <https://support.greenhouse.io/hc/en-us/articles/360052218132-Supported-file-types-for-resumes-and-cover-letters>. Import fails when the file "doesn't have enough information", is a non-standard type, or "includes characters that aren't recognized by our text parsing technology" (updated 2026-08-19). **P** <https://support.greenhouse.io/hc/en-us/articles/200721684-Why-didn-t-the-candidate-s-resume-import-correctly>
- **Lever:** profile fields are auto-populated from the resume, and manual entry is the fallback. **S** (help page did not render, search snippet only) <https://help.lever.co/hc/en-us/articles/20087345054749>
- **Which parser each ATS uses:** no vendor document names one for Greenhouse, Lever, Workday, iCIMS, SmartRecruiters or Ashby. Textkernel announces an Oracle Recruiting Cloud integration. **P** (marketing) <https://textkernel.com/learn-support/blog/oracle-recruiting-cloud-resume-parsing>
- **PDF vs DOCX:** Textkernel says "If you want to minimize conversion problems, don't use PDF documents ... PDF is a broken standard that often hides issues with the underlying text" (link above). All the ATSs above accept PDF. A clean, text-based PDF is fine. The risk is a bad text layer, not the PDF format itself.
- **Myth vs evidence.**
  - Formatting-based auto-rejection is mostly a myth. Enhancv interviewed 25 US recruiters (2025): 92% do not auto-reject on format or content. Knockout questions are the real automatic filter. **S** (small vendor survey) <https://betanews.com/2025/11/10/study-debunks-viral-claim-that-ai-filters-out-most-job-applicants/>
  - Real auto-rejection is employer-configured. In Greenhouse, auto-reject works only on Yes/No and select questions. **P** <https://support.greenhouse.io/hc/en-us/articles/203105595-Application-Rules-Overview>
  - Real harm from filtering exists, via employer "negative" filters (HBS/Accenture _Hidden Workers_, 2021). **S** (secondary coverage) <https://www.library.hbs.edu/working-knowledge/how-to-tap-the-talent-automated-hr-platforms-miss>
  - What actually costs us: (a) bad parsing makes the candidate invisible to keyword search and AI scoring; (b) knockout answers; (c) recruiter volume.

## Facts: 2. Ranking and matching

- **Keyword search is literal.** Greenhouse full-text resume search: a keyword must match the application text **exactly**. **P** <https://support.greenhouse.io/hc/en-us/articles/115004600186-Search-resumes-for-keywords>, <https://support.greenhouse.io/hc/en-us/articles/202360199-Search-candidates-using-Boolean-queries>
  - Write both forms: "Amazon Web Services (AWS)", "Kubernetes (K8s)".
  - Spell skills exactly as the JD does: "Node.js", not "NodeJS".
- **Greenhouse Talent Matching (AI).** It reads the resume plus application answers. It extracts "skills, job titles, years of experience, start/end dates of employment, and company names", then scores against recruiter-weighted requirements. Unscorable candidates are flagged for manual review. **P** <https://support.greenhouse.io/hc/en-us/articles/41396009937307-Talent-Matching>, <https://support.greenhouse.io/hc/en-us/articles/41131616864283-Talent-Matching-Data-Processing-FAQ>
- **Workday HiredScore.** Grades A–D on how well the resume matches the JD's skills and qualifications. Since the August 2026 release:
  - basic qualifications decide the A/B vs C/D band;
  - preferred qualifications decide the grade inside each band;
  - there is **no grade** if there is no resume or the format is unsupported. **P** <https://doc.workday.com/hiredscore/en-us/workday-hiredscore/recruiter-productivity-/reference--candidate-grades.html>, <https://doc.workday.com/hiredscore/en-us/workday-hiredscore/hiredscore-release-notes/2026/august/wednesday--5th-august.html>
- **Synonym normalization exists in some engines.** Textkernel maps synonyms and acronyms onto 12k+ skill concepts. **P** <https://www.textkernel.com/skills>. Do not rely on it: Greenhouse search is exact.
- **Job title.** Jobscan: a resume title matching the target title correlates with a 10.6x interview rate (earlier figure 3.5x). This is correlation only. **S** <https://www.jobscan.co/blog/interview-rates-study>
- **Signals that follow from the above:**
  - parseable employer, title, and start/end dates (per role, one consistent format, e.g. `Jan 2022 – Mar 2025`);
  - years of experience computable from those dates;
  - a skills list in JD spelling;
  - contact info as plain text in the body;
  - location as text. Lever may override the parsed location with the job board's location question (Lever snippet above).

## Facts: 3. Visual variety without breaking parsing

These rules are derived from sections 1 and 2. No vendor publishes a design whitelist.

- **Safe:**
  - accent color on headings and rules;
  - font choice (any embedded font with a correct Unicode map);
  - font size and weight hierarchy;
  - horizontal rules and section dividers;
  - margins and spacing;
  - name and title header block in the body;
  - bold or caps headings;
  - right-aligned dates _on the same line_ as the title (verify by test).
- **Unsafe:**
  - multi-column or sidebar layout (Textkernel: about 10% mis-render even after its fix; OpenResume assumes a single column);
  - text in images or icons instead of words (Workday, Textkernel);
  - rotated or vertical text;
  - skill bars or ratings;
  - contact data only in the page header or footer (inference: Typst tags these as artifacts, and some extractors drop them);
  - tables or grids for prose;
  - creative section names. Use standard headings: Summary, Experience, Skills, Education, Certifications, Languages.
- **Template families that fit:**
  - "Classic" (serif, centered name);
  - "Modern" (sans, accent rule under headings);
  - "Compact" (denser spacing, dates right-aligned);
  - "Technical" (skills grouped by category on one line each).
  - All four are single-column, with the same reading order and the same headings.

## Facts: 4. Automated testing

| Tool                                                                                                                                                                                      | Use                                                                                                           | License                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| OpenResume parser (pdf.js, feature scoring; headings = alone on line + bold + uppercase; "designed to parse single column resume in English") <https://www.open-resume.com/resume-parser> | field round-trip: name, email, phone, location, link, company, title, date, school, degree                    | AGPL-3.0 <https://github.com/xitanggg/open-resume> (fine for internal CI, do not ship) |
| pdfminer.six (layout analysis) <https://github.com/pdfminer/pdfminer.six>                                                                                                                 | text-layer and reading-order check; Resume-Matcher's "ATS check" uses it                                      | MIT                                                                                    |
| Resume-Matcher (deterministic ATS score: keywords, skills, title, sections, dates; no LLM for scoring) <https://github.com/srbhr/Resume-Matcher>                                          | keyword coverage vs a JD; reference logic                                                                     | Apache-2.0                                                                             |
| pyresparser (spaCy/NLTK; name, email, phone, skills, experience, degree, designation, companies) <https://github.com/OmkarPathak/pyresparser>                                             | second, crude parser                                                                                          | GPL-3.0; appears unmaintained (no releases)                                            |
| veraPDF <https://github.com/veraPDF/veraPDF-library>                                                                                                                                      | PDF/A (and PDF/UA) validation                                                                                 | GPLv3+ / MPLv2+                                                                        |
| Affinda (commercial) <https://affinda.com/recruitment-ai-pricing>                                                                                                                         | closest to a real ATS parser; 14 days / 1,000 docs free, then US$0.10/doc; also a free self-hosted evaluation | commercial                                                                             |

Strategy (render -> extract -> parse -> compare to source JSON):

1. **Text layer:** extracted text contains every source string verbatim. Count: missing tokens = 0. No `U+FFFD`. No ligature code points (U+FB00–FB06).
2. **Reading order:** the section headings appear in the source order. Inside each role, title, company and dates come before its bullets. No two roles interleave.
3. **Headings:** the parser assigns lines to the expected sections.
4. **Fields:** name, email, phone, location and links equal the JSON values. Each role's company, title and start/end dates parse back (normalize to YYYY-MM).
5. **Keywords:** for each JD, the coverage of required skills (exact plus acronym form) is reported as a number.
6. **Hygiene:**
   - fonts embedded (`pdffonts`);
   - no image-only pages;
   - file size under 2 MB;
   - at most 2–3 pages;
   - document title set.
7. **Coverage:** run every template against the same fixture set. Assert the extracted field set is identical across templates, so visual variety is proven not to change semantics.

## Facts: 5. Typst specifics

- 0.14 (2025-10-24) writes **Tagged PDF by default**, with opt-in PDF/UA-1. **P** <https://typst.app/docs/changelog/0.14.0/>, <https://typst.app/blog/2025/typst-0.14>
- 0.15.0 (2026-06-15) can target several standards at once, e.g. PDF/UA-1 + PDF/A-2a. It also fixed tagging order for inline content outside paragraphs. 0.15.1 came out 2026-07-17. **P** <https://www.typst.app/docs/changelog/0.15.0/>, <https://typst.app/docs/changelog/0.15.1/>
- Supported PDF/A profiles: 1b/1a/2b/2u/2a/3b/3u/3a/4/4f/4e. PDF/UA-2 is not supported. **P** <https://typst.app/docs/reference/pdf/>
- The accessibility guide says:
  - markup implies a single reading order, but `place`/`move`/floats can diverge from it;
  - headers and footers are tagged as artifacts automatically;
  - PDF/UA-1 needs a document title and image alt text, and export fails on a violation;
  - use `table`, not `grid`, for tabular data. **P** <https://typst.app/docs/guides/accessibility/>
- Ligatures: a forum reply says Typst uses the ToUnicode map "as much as possible ... supported by default ... there can always be bugs". **S** <https://forum.typst.app/t/is-there-an-equivalent-to-latexs-pdfgentounicode-1-in-typst/7533>. Test it instead of assuming. To be safe, set `text(ligatures: false)` for body text.
- Caveat (inference): ATS parsers extract by glyph position (pdf.js, pdfminer), not by PDF tags. Tags help accessibility, not the ATS. Physical layout order is what counts.

## Recommended rules + test plan for us

1. Use one single-column layout skeleton. Templates differ only in font, accent color, spacing, rules and the header style.
2. Fix the headings: Summary / Experience / Skills / Education / Certifications / Languages. Each heading stands alone on its line, bold.
3. Put contact info, location and links as body text near the top. Never put them only in the header or footer, and never as icon-only.
4. Each role: title, company, location and `Mon YYYY – Mon YYYY` (or `Present`), one consistent format.
5. Skills are plain comma lists spelled as the JD spells them. Put acronym and full form once. A per-vacancy summary line mirrors the JD title, if truthful.
6. No images, no skill bars, no `place`/floats for content. Set `ligatures: false`. Set the document title. Export with `--pdf-standard ua-1` so Typst refuses broken output.
7. Expected-pass gates in CI per template x fixture:
   - pdfminer text contains every JSON string (0 missing);
   - order assertions;
   - OpenResume parse equals the JSON fields;
   - `pdffonts` shows everything embedded;
   - veraPDF passes;
   - size and page limits hold.
     One-time: manually spot-check the templates through the Affinda free trial.
8. Tell HR about knockout questions. They are the real auto-reject path, and they are answered in the form, not in the PDF.

## Applicability to us

- Our pipeline already matches the "structured JSON -> one renderer" shape: `ResumeContent` is the
  source, Typst 0.15.1 (pinned) the renderer, `unpdf` (pdf.js) the text extractor. The round-trip
  test therefore needs no new runtime dependency: `unpdf` is the same extractor family (pdf.js) the
  OpenResume parser uses.
- Typst 0.15.1 supports multi-standard export (PDF/UA-1 + PDF/A-2a), so "refuse broken output" is a
  renderer flag, not our code. The exact CLI flag spelling was not checked against 0.15.1: verify
  before relying on it.
- Python tools (pdfminer.six, pyresparser) would add a Python runtime to CI; our CI is Node. Use them,
  if at all, as a one-off oracle, not a gate.
- OpenResume's parser is AGPL-3.0. Running it as a separate CI tool is fine; copying its code into
  this repository is not. That is an owner decision before adoption.
- veraPDF is a Java tool; a CI job can run it from its published image without touching the app.
- Affinda's free trial is the closest to a real ATS parser and fits a one-time manual check of each
  new template, not CI (it is an external send of resume text: personal data, owner "go" required).
- Knockout questions are answered in the application form, not in the PDF. The CRM records
  submissions but does not send them, so this is HR guidance, not a gate.

## What could not be established

- Which parsing engine Greenhouse, Lever, Workday, iCIMS, SmartRecruiters and Ashby use. No primary source found.
- Official per-ATS file-size and page limits. The Greenhouse "2.5 MB parse limit" is unverified. Workday limits are tenant-configured.
- Lever's official parsed-field list (the help page did not render).
- Whether any ATS parser reads PDF structure tags.
- A Typst-specific ligature or ToUnicode bug report.
- Peer-reviewed accuracy studies of commercial parsers on PDF vs DOCX.
