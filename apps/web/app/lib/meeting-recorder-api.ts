import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createMeetingRecorderConnectionSchema,
  linkMeetingRecorderRecordingSchema,
  meetingRecorderConnectionSchema,
  meetingRecorderRecordingDetailSchema,
  meetingRecorderRecordingSummarySchema,
  meetingRecorderUnmatchedRecordingSchema,
  setMeetingRecorderSecretSchema,
  updateMeetingRecorderConnectionSchema,
  type CreateMeetingRecorderConnectionDto,
  type LinkMeetingRecorderRecordingDto,
  type MeetingRecorderConnectionDto,
  type SetMeetingRecorderSecretDto,
  type UpdateMeetingRecorderConnectionDto,
} from '@crm/shared'
import { api } from '@/lib/axios'

export const MEETING_RECORDER_CONNECTIONS_QUERY_KEY = ['meeting-recorder-connections'] as const
export const UNMATCHED_INTERVIEW_RECORDINGS_QUERY_KEY = ['unmatched-interview-recordings'] as const

export const interviewRecordingsQueryKey = (interviewId: string) =>
  ['interview-recordings', interviewId] as const

export const interviewRecordingQueryKey = (recordingId: string) =>
  ['interview-recording', recordingId] as const

export const meetingRecorderApi = {
  async listConnections(): Promise<MeetingRecorderConnectionDto[]> {
    const response = await api.get('/integrations/meeting-recorder/connections')
    return meetingRecorderConnectionSchema.array().parse(response.data)
  },

  async createConnection(input: CreateMeetingRecorderConnectionDto) {
    const payload = createMeetingRecorderConnectionSchema.parse(input)
    const response = await api.post('/integrations/meeting-recorder/connections', payload)
    return meetingRecorderConnectionSchema.parse(response.data)
  },

  async updateConnection(id: string, input: UpdateMeetingRecorderConnectionDto) {
    const payload = updateMeetingRecorderConnectionSchema.parse(input)
    const response = await api.patch(`/integrations/meeting-recorder/connections/${id}`, payload)
    return meetingRecorderConnectionSchema.parse(response.data)
  },

  async setConnectionSecret(id: string, input: SetMeetingRecorderSecretDto) {
    const payload = setMeetingRecorderSecretSchema.parse(input)
    const response = await api.put(
      `/integrations/meeting-recorder/connections/${id}/secret`,
      payload,
    )
    return meetingRecorderConnectionSchema.parse(response.data)
  },

  async resetConnectionPairing(id: string) {
    const response = await api.post(
      `/integrations/meeting-recorder/connections/${id}/reset-pairing`,
    )
    return meetingRecorderConnectionSchema.parse(response.data)
  },

  async listInterviewRecordings(interviewId: string) {
    const response = await api.get(`/interviews/${interviewId}/recordings`)
    return meetingRecorderRecordingSummarySchema.array().parse(response.data)
  },

  async getRecording(recordingId: string) {
    const response = await api.get(`/interview-recordings/${recordingId}`)
    return meetingRecorderRecordingDetailSchema.parse(response.data)
  },

  async listUnmatchedRecordings() {
    const response = await api.get('/interview-recordings/unmatched')
    return meetingRecorderUnmatchedRecordingSchema.array().parse(response.data)
  },

  async linkRecording(recordingId: string, input: LinkMeetingRecorderRecordingDto) {
    const payload = linkMeetingRecorderRecordingSchema.parse(input)
    await api.patch(`/interview-recordings/${recordingId}/link`, payload)
  },
}

export function useMeetingRecorderConnections() {
  return useQuery({
    queryKey: MEETING_RECORDER_CONNECTIONS_QUERY_KEY,
    queryFn: meetingRecorderApi.listConnections,
  })
}

export function useInterviewRecordings(interviewId: string, enabled: boolean) {
  return useQuery({
    queryKey: interviewRecordingsQueryKey(interviewId),
    queryFn: () => meetingRecorderApi.listInterviewRecordings(interviewId),
    enabled: enabled && !!interviewId,
  })
}

export function useInterviewRecording(recordingId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: interviewRecordingQueryKey(recordingId ?? ''),
    queryFn: () => meetingRecorderApi.getRecording(recordingId ?? ''),
    enabled: enabled && !!recordingId,
    gcTime: 0,
  })
}

export function useUnmatchedInterviewRecordings(enabled: boolean) {
  return useQuery({
    queryKey: UNMATCHED_INTERVIEW_RECORDINGS_QUERY_KEY,
    queryFn: meetingRecorderApi.listUnmatchedRecordings,
    enabled,
  })
}

export function useLinkInterviewRecording() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      recordingId,
      interviewId,
    }: {
      recordingId: string
      interviewId: string | null
      previousInterviewId?: string | null
    }) => meetingRecorderApi.linkRecording(recordingId, { interviewId }),
    onSuccess: async (_data, variables) => {
      const invalidations: Promise<unknown>[] = [
        queryClient.invalidateQueries({ queryKey: UNMATCHED_INTERVIEW_RECORDINGS_QUERY_KEY }),
        queryClient.invalidateQueries({
          queryKey: interviewRecordingQueryKey(variables.recordingId),
        }),
      ]

      if (variables.previousInterviewId) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: interviewRecordingsQueryKey(variables.previousInterviewId),
          }),
        )
      }
      if (variables.interviewId) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: interviewRecordingsQueryKey(variables.interviewId),
          }),
        )
      }

      await Promise.all(invalidations)
    },
  })
}
