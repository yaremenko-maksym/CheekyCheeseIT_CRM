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

## Privacy record

- The raw Hacker News thread captures (462 unique commenter e-mail addresses) were committed to
  this PR by mistake and removed in a later commit. **The blobs stay reachable through the PR's
  refs (`refs/pull/<n>/head`) and any fork or clone made meanwhile until the platform purges
  them. Purging is the repository owner's action (GitHub support); no commit on this branch can
  do it.** A squash merge keeps them out of `main`.
- The guard is `fixture-provenance.spec.ts`: it walks the whole `__fixtures__` tree and fails on
  any e-mail address not on its per-file allow-list.
- HN author handles are kept verbatim in the trimmed fixtures: they are public pseudonyms and the
  adapter uses them as the posting account (`HN @<handle>`).
- `termsCheckedAt` is one value across every provenance file: the date (2026-10-24) is when the
  terms were read, the time of day is a single stand-in.
- Re-derivability: only the four Jobgether provenance files are proven against `trim-captures-3.2.mjs`
  by a run (their raw captures are committed, and re-running the script leaves them byte for byte
  unchanged). The four HN notes and the Working Nomads note are produced by the script only when
  their raw captures are present, which they are not, so those five were patched by hand to match
  the script's text; script and JSON agree by reading, not by a run.
- Who read the third-party terms: an AI coding agent (the Working Nomads page also by a reviewing
  agent). This is not legal advice, and no review by a lawyer or the owner is recorded here.
