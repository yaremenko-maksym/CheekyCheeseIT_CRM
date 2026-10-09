import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'

import {
  InterviewMeetingRecordingsController,
  InterviewRecordingsController,
} from './interview-recordings.controller'
import type { MeetingRecorderService } from './meeting-recorder.service'
import type { RecordingMediaUploadService } from './media/recording-media-upload.service'

const INTERVIEW_ID = '11111111-1111-4111-8111-111111111111'
const RECORDING_ID = '22222222-2222-4222-8222-222222222222'
const user = { id: '33333333-3333-4333-8333-333333333333' } as SessionUser

describe('interview recording controllers', () => {
  it('delegates interview listing and recording administration to the service', () => {
    const service = {
      listInterviewRecordings: vi.fn().mockReturnValue('list'),
      listUnmatchedRecordings: vi.fn().mockReturnValue('unmatched'),
      getRecordingDetail: vi.fn().mockReturnValue('detail'),
      linkRecording: vi.fn().mockReturnValue('linked'),
    }
    const typedService = service as unknown as MeetingRecorderService
    const media = {
      listReadyForCrm: vi.fn(),
      playbackForCrm: vi.fn(),
    } as unknown as RecordingMediaUploadService
    const interviewController = new InterviewMeetingRecordingsController(typedService)
    const recordingsController = new InterviewRecordingsController(typedService, media)

    expect(interviewController.list(INTERVIEW_ID, user)).toBe('list')
    expect(service.listInterviewRecordings).toHaveBeenCalledWith(INTERVIEW_ID, user)

    expect(recordingsController.listUnmatched()).toBe('unmatched')
    expect(service.listUnmatchedRecordings).toHaveBeenCalledOnce()

    expect(recordingsController.detail(RECORDING_ID, user)).toBe('detail')
    expect(service.getRecordingDetail).toHaveBeenCalledWith(RECORDING_ID, user)

    expect(recordingsController.link(RECORDING_ID, { interviewId: INTERVIEW_ID }, user)).toBe(
      'linked',
    )
    expect(service.linkRecording).toHaveBeenCalledWith(
      RECORDING_ID,
      { interviewId: INTERVIEW_ID },
      user,
    )
  })

  it('accepts an explicit null interview id for administrator unlink', () => {
    const service = { linkRecording: vi.fn().mockReturnValue('unlinked') }
    const controller = new InterviewRecordingsController(
      service as unknown as MeetingRecorderService,
      {
        listReadyForCrm: vi.fn(),
        playbackForCrm: vi.fn(),
      } as unknown as RecordingMediaUploadService,
    )

    expect(controller.link(RECORDING_ID, { interviewId: null }, user)).toBe('unlinked')
    expect(service.linkRecording).toHaveBeenCalledWith(RECORDING_ID, { interviewId: null }, user)
  })

  it('requires recording-scoped CRM authorization before resolving a media capability', async () => {
    const media = {
      playbackForCrm: vi.fn().mockResolvedValue({ url: 'https://example.test/read' }),
    }
    const service = {
      getRecordingDetail: vi.fn().mockResolvedValue({
        connectionId: 'connection-a',
        externalRecordingId: 'recording-a',
      }),
    }
    const controller = new InterviewRecordingsController(
      service as unknown as MeetingRecorderService,
      media as unknown as RecordingMediaUploadService,
    )

    await expect(controller.mediaPlayback(RECORDING_ID, 'media_abc', user)).resolves.toEqual({
      url: 'https://example.test/read',
    })
    expect(service.getRecordingDetail).toHaveBeenCalledWith(RECORDING_ID, user)
    expect(media.playbackForCrm).toHaveBeenCalledWith('connection-a', 'recording-a', 'media_abc')

    service.getRecordingDetail.mockRejectedValueOnce(new Error('recording access denied'))
    await expect(controller.mediaPlayback(RECORDING_ID, 'media_abc', user)).rejects.toThrow(
      'recording access denied',
    )
    expect(media.playbackForCrm).toHaveBeenCalledOnce()
  })

  it('requires recording-scoped CRM authorization before listing ready media', async () => {
    const media = {
      listReadyForCrm: vi.fn().mockResolvedValue([{ artifactId: 'media_abc' }]),
      playbackForCrm: vi.fn(),
    }
    const service = {
      getRecordingDetail: vi.fn().mockResolvedValue({
        connectionId: 'connection-a',
        externalRecordingId: 'recording-a',
      }),
    }
    const controller = new InterviewRecordingsController(
      service as unknown as MeetingRecorderService,
      media as unknown as RecordingMediaUploadService,
    )

    await expect(controller.mediaList(RECORDING_ID, user)).resolves.toEqual([
      { artifactId: 'media_abc' },
    ])
    expect(service.getRecordingDetail).toHaveBeenCalledWith(RECORDING_ID, user)
    expect(media.listReadyForCrm).toHaveBeenCalledWith('connection-a', 'recording-a')

    service.getRecordingDetail.mockRejectedValueOnce(new Error('recording access denied'))
    await expect(controller.mediaList(RECORDING_ID, user)).rejects.toThrow(
      'recording access denied',
    )
    expect(media.listReadyForCrm).toHaveBeenCalledOnce()
  })
})
