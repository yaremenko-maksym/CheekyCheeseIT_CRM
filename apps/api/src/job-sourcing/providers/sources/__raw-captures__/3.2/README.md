# Raw captures kept for Task 3.2

A raw capture is kept only if a spec reads it or a provenance note cites it as evidence, and only if it
carries no other people's personal data. Anything carrying comments or other user-submitted text is not
committed: the Hacker News threads and the two Arbeitnow job pages were removed (see the Privacy record).
Two instruments, in `fixture-provenance.spec.ts`, establish what is true of the kept files (this prose
does not): a scan that reports every `@`-equivalent token and allow-lists each hit by reason (addresses,
not names, not phone numbers), and a zero-tolerance test for personal `linkedin.com/in/` profile links in
both scanned roots (decode-first, no allow-list; `/pub/` paths and `lnkd.in` are out of its scope).
`an-terms.html` is NOT the bytes received: one personal profile slug on Arbeitnow's own terms page was
replaced by a same-length run of x characters by hand (the terms text is unchanged).

| File                                               | What it proves                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `an-p1.hdr`, `an-p2.hdr`                           | Response headers of the two Arbeitnow pages (their bodies are removed); `an-p1.hdr` supplies `fetchedAt`                                       |
| `an-p100.raw`, `an-p20.hdr`                        | The empty page past the end (source of `arbeitnow/empty-page.json`; the capture has no header file of its own, `an-p20.hdr` supplies the date) |
| `an-terms.html`                                    | Arbeitnow terms, section 11 (API, link back, revocable)                                                                                        |
| `jg-p1`, `jg-p10`, `jg-none`, `jg-depr` (+ `.hdr`) | Source of the four Jobgether fixtures; public listing data (titles, company names), no descriptions                                            |
| `robots-*.txt` (+ `.hdr`)                          | The robots.txt answers recorded in the provenance notes                                                                                        |

`fixture-provenance.spec.ts` checks that the sha256 of each retained raw capture equals the
`rawSha256` of the fixture built from it. Rebuild: `node ../../__fixtures__/trim-captures-3.2.mjs 2026-10-24T03:00:00.000Z`
(the argument is `termsCheckedAt`); sections whose raw capture is absent are skipped.

## Privacy record

- The raw Hacker News thread captures (462 unique commenter e-mail addresses) were committed to this PR
  by mistake and removed in a later commit (`7fe61d663`).
- The raw Arbeitnow pages 1 and 2 (`an-p1`, `an-p2`) were also removed. They held other people's personal
  data of three kinds: two named individuals' e-mail addresses (one a `.gov.uk` address) percent-encoded
  inside Outlook Safelinks tracking parameters, which the first address scan missed; 12 distinct personal
  LinkedIn profile links (written with escaped slashes); and 4 mobile-shaped phone numbers of named
  recruiters. For a while `an-p1` was committed with the two addresses redacted; the owner then decided
  to delete both files, as for Hacker News. `arbeitnow/page-1` keeps the hash of the bytes as RECEIVED
  and the measured sizes (4209793 and 2311796 bytes) in its provenance; `arbeitnow.provider.spec.ts`
  generates bodies of exactly those sizes.
- **Residual, a decision and not a pending action (owner, 2026-10-24):** the following all remain
  reachable by sha and by commit path from this branch's history: the Hacker News raw captures; the
  pre-redaction and redacted `an-p1` and `an-p2`; and the pre-redaction LinkedIn profile slugs (three
  named people, one a full-name slug) in earlier commits of `an-terms.html` (first committed in
  `81aba17f6`, moved in `09eb1eb61`, redacted in `435be6415`) and of the two hn-hiring fixtures
  `thread-2026-10.json` and `thread-2019-05.json` (first committed in `4adb81b61`, redacted in
  `435be6415`); and the 24 original HN account names, in the earlier commits of the three thread fixtures
  (every commit up to `4592af268`; replaced in `abc12d1bf`). Deleting the branch after merge does not purge them; a squash merge keeps them out of
  `main` without deleting them. The owner decided NOT to ask GitHub to purge the history and judged that
  acceptable for this content. Two review bodies on this PR that quoted two of the addresses were
  redacted; their edit history stays, by the same decision. History is not rewritten.

- The guards are in `fixture-provenance.spec.ts` (see the top of this file): the token scan with its
  per-file allow-list, the profile-link test, and a test that fails if an `hn-*` or `an-p1`/`an-p2` raw is
  committed again.
- Two hn-hiring fixtures (`thread-2019-05`, `thread-2026-10`) and `an-terms.html` also had personal LinkedIn slugs replaced by hand (same-length
  x runs, `fileSha256` and notes updated for the two HN fixtures); see the residual bullet for where the
  originals live.
- HN account names are PSEUDONYMISED, not anonymised: the 24 human account names in the three hn-hiring
  thread fixtures (the `author` fields) were replaced by hand by `hnuser01`..`hnuser24`, one-to-one, so no
  real account name is committed (HN's moderator account included; no test needs a real name). The item
  ids (`id`, `parent_id`, `story_id`) are kept deliberately, because tests key on them, and anyone with an
  id can still resolve the original account at `news.ycombinator.com/item?id=<id>`. Two names are kept on
  purpose: `whoishiring`, HN's own posting bot, which is the query constant (`tags=story,author_whoishiring`)
  the adapter uses to find the monthly thread, and `Tessian`, a company whose name in the job text is what
  the employer-extraction tests assert. The adapter surfaces the account as `HN @<handle>`. Names inside
  post text (first names, a poster's sign-off) are not touched.
- `termsCheckedAt` is one value across every provenance file: the date (2026-10-24) is when the
  terms were read, the time of day is a single stand-in.
- Re-derivability: five provenance files are proven against `trim-captures-3.2.mjs` by a run, because
  their raw captures are committed and re-running the script leaves them byte for byte unchanged: the four
  Jobgether files and `arbeitnow/empty-page`. The other six (four HN notes, the Working Nomads note,
  `arbeitnow/page-1`) are produced by the script only when their raw captures are present, which they are
  not, so none was regenerated by a run. The HN and Working Nomads notes were patched by hand to match the
  script's text; `page-1` additionally carries a RAW REMOVED sentence the script does not write, and two HN
  notes carry a LATER HAND REDACTION sentence. Script and JSON agree by reading, not by a run, except on
  those sentences.
- Who read the third-party terms: an AI coding agent (the Working Nomads page also by a reviewing
  agent). This is not legal advice, and no review by a lawyer or the owner is recorded here.
