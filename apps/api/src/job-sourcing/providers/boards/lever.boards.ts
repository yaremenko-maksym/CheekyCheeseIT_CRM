/** Lever board lines (format and rules: ../manifest.boards.ts). `region: 'eu'` selects the EU API host. */
export const LEVER_BOARDS: readonly unknown[] = [
  {
    token: 'spotify',
    employer: 'Spotify',
    domain: null,
    timeZone: 'Europe/Stockholm',
    addedBy: 'manual',
    evidence: ['spotify-page1.json', 'spotify-page2.json'],
  },
  {
    token: 'siteimprove',
    employer: 'Siteimprove',
    domain: null,
    timeZone: 'Europe/Copenhagen',
    region: 'eu',
    addedBy: 'manual',
    evidence: ['siteimprove-eu-board.json'],
  },
  {
    token: 'quantco-',
    employer: 'QuantCo',
    domain: null,
    timeZone: 'Europe/Berlin',
    addedBy: 'manual',
    evidence: ['quantco-trailing-hyphen-board.json'],
  },
]
