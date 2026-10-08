import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'

import {
  InterviewMeetingRecordingsController,
  InterviewRecordingsController,
} from './interview-recordings.controller'
import type { MeetingRecorderService } from './meeting-recorder.service'

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
    const interviewController = new InterviewMeetingRecordingsController(typedService)
    const recordingsController = new InterviewRecordingsController(typedService)

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
    )

    expect(controller.link(RECORDING_ID, { interviewId: null }, user)).toBe('unlinked')
    expect(service.linkRecording).toHaveBeenCalledWith(RECORDING_ID, { interviewId: null }, user)
  })
})
