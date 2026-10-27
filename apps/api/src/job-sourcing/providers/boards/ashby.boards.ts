/** Ashby board lines (format and rules: ../manifest.boards.ts). Both under 5 MB, so the ordinary profile. */
export const ASHBY_BOARDS: readonly unknown[] = [
  {
    token: 'linear',
    employer: 'Linear',
    domain: null,
    timeZone: 'America/Los_Angeles',
    addedBy: 'manual',
    evidence: ['linear-board.json'],
  },
  {
    token: 'supabase',
    employer: 'Supabase',
    domain: null,
    timeZone: 'America/Los_Angeles',
    addedBy: 'manual',
    evidence: ['supabase-board.json'],
  },
]
