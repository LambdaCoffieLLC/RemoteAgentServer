import type { AuthenticatedActor } from '@remote-agent/auth'
import type { HostId, IsoTimestamp, SessionId, WorkspaceId } from '@remote-agent/protocol'
import type { ProviderId } from '@remote-agent/providers'

export type SessionStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed'

export interface SessionSummary {
  id: SessionId
  hostId: HostId
  workspaceId: WorkspaceId
  provider: ProviderId
  requestedBy: Pick<AuthenticatedActor, 'id' | 'displayName'>
  status: SessionStatus
  startedAt: IsoTimestamp
}

export function createSessionSummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    requestedBy: { ...summary.requestedBy },
  }
}
