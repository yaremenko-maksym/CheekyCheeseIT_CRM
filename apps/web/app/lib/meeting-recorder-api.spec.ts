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
  mediaProvisioned: false,
  mediaTokenUpdatedAt: null,
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

  it('issues a one-time media token without caching it', async () => {
    const token = `mrmt_${'a'.repeat(43)}`
    vi.mocked(api.put).mockResolvedValue({ data: { token } })

    await expect(meetingRecorderApi.issueMediaToken(CONNECTION_ID)).resolves.toEqual({ token })
    expect(api.put).toHaveBeenCalledWith(
      `/integrations/meeting-recorder/connections/${CONNECTION_ID}/token`,
    )
  })

  it('lists ready recording media and requests scoped playback capabilities', async () => {
    const recordingId = '22222222-2222-4222-8222-222222222222'
    const artifactId = 'media_33333333-3333-4333-8333-333333333333'
    const media = {
      artifactId,
      role: 'tab-recording',
      filename: 'meeting.webm',
      mimeType: 'video/webm',
      bytes: 123,
    }
    vi.mocked(api.get).mockResolvedValue({ data: [media] })
    vi.mocked(api.post).mockResolvedValue({
      data: {
        url: 'https://media.example.test/object',
        expiresAt: '2026-10-09T12:00:00.000Z',
      },
    })

    await expect(meetingRecorderApi.listRecordingMedia(recordingId)).resolves.toEqual([media])
    await expect(
      meetingRecorderApi.prepareRecordingMediaPlayback(recordingId, artifactId),
    ).resolves.toEqual({
      url: 'https://media.example.test/object',
      expiresAt: '2026-10-09T12:00:00.000Z',
    })

    expect(api.get).toHaveBeenCalledWith(`/interview-recordings/${recordingId}/media`)
    expect(api.post).toHaveBeenCalledWith(
      `/interview-recordings/${recordingId}/media/${encodeURIComponent(artifactId)}/playback`,
    )
  })
})
