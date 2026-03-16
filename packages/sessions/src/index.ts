import type { AuthenticatedActor } from '@remote-agent/auth'
import type { HostId, IsoTimestamp, SessionId, WorkspaceId } from '@remote-agent/protocol'
import type { ProviderId } from '@remote-agent/providers'

export type SessionStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'
export type SessionEventId = `session_event_${string}`
export type SessionEventKind = 'status' | 'log' | 'output'
export type SessionLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type SessionOutputStream = 'stdout' | 'stderr'
export type SessionWorkspaceMode = 'direct' | 'worktree'

export interface SessionWorktreeMetadata {
  repositoryPath: string
  path: string
  branch: string
  baseBranch: string
  createdAt: IsoTimestamp
  dirtyWorkspaceAllowed: boolean
}

export interface SessionWorkspaceMetadata {
  mode: SessionWorkspaceMode
  repositoryPath: string
  path: string
  allowDirtyWorkspace: boolean
  worktree?: SessionWorktreeMetadata
}

export interface SessionSummary {
  id: SessionId
  hostId: HostId
  workspaceId: WorkspaceId
  provider: ProviderId
  requestedBy: Pick<AuthenticatedActor, 'id' | 'displayName'>
  status: SessionStatus
  startedAt: IsoTimestamp
  workspace?: SessionWorkspaceMetadata
}

export interface SessionEvent {
  id: SessionEventId
  sessionId: SessionId
  sequence: number
  kind: SessionEventKind
  createdAt: IsoTimestamp
  message: string
  status?: SessionStatus
  level?: SessionLogLevel
  stream?: SessionOutputStream
}

export function createSessionSummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    requestedBy: { ...summary.requestedBy },
    workspace: summary.workspace
      ? {
          ...summary.workspace,
          worktree: summary.workspace.worktree
            ? {
                ...summary.workspace.worktree,
              }
            : undefined,
        }
      : undefined,
  }
}

export function createSessionEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
  }
}
