import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
  },
}))

import { api } from '@/lib/axios'
import { meetingRecorderApi } from './meeting-recorder-api'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

const connection = {
  id: CONNECTION_ID,
  name: 'Recruiting recorder',
  enabled: true,
  secretSet: false,
  expectedSource: null,
  signingSecretUpdatedAt: null,
  lastVerifiedAt: null,
  lastEventAt: null,
  createdAt: '2026-10-07T18:00:00.000Z',
  updatedAt: '2026-10-07T18:00:00.000Z',
  webhookPath: `/api/public/integrations/meeting-recorder/${CONNECTION_ID}/events`,
}

describe('meetingRecorderApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists connections through the integration endpoint and validates the response contract', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [connection] })

    await expect(meetingRecorderApi.listConnections()).resolves.toEqual([connection])
    expect(api.get).toHaveBeenCalledWith('/integrations/meeting-recorder/connections')
  })
})
