/** Greenhouse board lines (format and rules: ../manifest.boards.ts). A new line enters with `evidence: null`. */
export const GREENHOUSE_BOARDS: readonly unknown[] = [
  {
    token: 'stripe',
    employer: 'Stripe',
    domain: 'stripe.com',
    timeZone: 'America/Los_Angeles',
    addedBy: 'manual',
    evidence: ['stripe-board.json'],
  },
  {
    token: 'airbnb',
    employer: 'Airbnb',
    domain: null,
    timeZone: 'America/Los_Angeles',
    addedBy: 'manual',
    evidence: ['airbnb-board.json'],
  },
  {
    token: 'cloudflare',
    employer: 'Cloudflare',
    domain: null,
    timeZone: 'America/Los_Angeles',
    addedBy: 'manual',
    evidence: ['cloudflare-board.json'],
  },
]
