/**
 * SmartRecruiters board lines (format and rules: ../manifest.boards.ts).
 *
 * Both boards were picked in task sources-04 and each one's capture under
 * `../sources/__fixtures__/smartrecruiters/` is the owner-approved single GET of the postings API
 * that the evidence check reads:
 *  - `ubisoft2` is the working board: a studio hiring senior engineers across Europe, 304 postings
 *    at the capture;
 *  - `smartrecruiters` is the vendor's own board: one posting, so it is the cheap control that
 *    proves the adapter against a board that does not move.
 */
export const SMARTRECRUITERS_BOARDS: readonly unknown[] = [
  {
    token: 'ubisoft2',
    employer: 'Ubisoft',
    domain: null,
    timeZone: 'Europe/Paris',
    addedBy: 'manual',
    evidence: ['ubisoft2-postings-list.json'],
  },
  {
    token: 'smartrecruiters',
    employer: 'SmartRecruiters Inc',
    domain: null,
    timeZone: 'America/Los_Angeles',
    addedBy: 'manual',
    evidence: ['postings-list.json'],
  },
]
