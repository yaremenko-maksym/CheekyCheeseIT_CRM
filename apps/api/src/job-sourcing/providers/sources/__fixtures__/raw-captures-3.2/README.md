# Raw captures kept for Task 3.2

Only captures with no personal data and a spec or a provenance hash that depends on them are kept.
Anything carrying comments or other user-submitted text is not committed (the Hacker News threads
were, by mistake, and were removed: `fixture-provenance.spec.ts` now scans the whole tree).

| File                                               | What it proves                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `an-p1.raw.gz`, `an-p2.raw.gz` (+ `.hdr`)          | Arbeitnow pages 1 and 2 are 4209793 and 2311796 bytes decoded, past the 2 MiB cap; read by `arbeitnow.provider.spec.ts`                        |
| `an-p100.raw`, `an-p20.hdr`                        | The empty page past the end (source of `arbeitnow/empty-page.json`; the capture has no header file of its own, `an-p20.hdr` supplies the date) |
| `an-terms.html`                                    | Arbeitnow terms, section 11 (API, link back, revocable)                                                                                        |
| `jg-p1`, `jg-p10`, `jg-none`, `jg-depr` (+ `.hdr`) | Source of the four Jobgether fixtures; public listing data (titles, company names), no descriptions                                            |
| `robots-*.txt` (+ `.hdr`)                          | The robots.txt answers recorded in the provenance notes                                                                                        |

`fixture-provenance.spec.ts` checks that the sha256 of each retained raw capture equals the
`rawSha256` of the fixture built from it. Rebuild: `node ../trim-captures-3.2.mjs 2026-10-24T03:00:00.000Z`
(the argument is `termsCheckedAt`); sections whose raw capture is absent are skipped.
