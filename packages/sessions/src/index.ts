import type { AuthenticatedActor } from '@remote-agent/auth'
import type { HostId, IsoTimestamp, SessionId, WorkspaceId } from '@remote-agent/protocol'
import type { ProviderId } from '@remote-agent/providers'

export type SessionStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'
export type SessionEventId = `session_event_${string}`
export type SessionEventKind = 'status' | 'log' | 'output'
export type SessionLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type SessionOutputStream = 'stdout' | 'stderr'
export type SessionWorkspaceMode = 'direct' | 'worktree'
export type SessionChangeType = 'added' | 'modified' | 'renamed' | 'removed'

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
  updatedAt?: IsoTimestamp
  lastActivityAt?: IsoTimestamp
  endedAt?: IsoTimestamp
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

export interface SessionRecovery {
  session: SessionSummary
  recentEvents: SessionEvent[]
  recoveredAt: IsoTimestamp
}

export interface SessionChangedFile {
  path: string
  previousPath?: string
  changeType: SessionChangeType
  status: string
  staged: boolean
  unstaged: boolean
}

export interface SessionChangeSummary {
  totalFiles: number
  added: number
  modified: number
  renamed: number
  removed: number
}

export interface SessionPatchSummary {
  additions: number
  deletions: number
}

export interface SessionChangesPage {
  cursor: number
  limit: number
  total: number
  nextCursor?: number
}

export interface SessionChangeList {
  sessionId: SessionId
  items: SessionChangedFile[]
  page: SessionChangesPage
  summary: SessionChangeSummary
}

export interface SessionDiffEntry extends SessionChangedFile {
  patch: string
  patchTruncated: boolean
  additions: number
  deletions: number
}

export interface SessionDiff {
  sessionId: SessionId
  items: SessionDiffEntry[]
  page: SessionChangesPage & {
    maxBytes: number
  }
  summary: SessionChangeSummary
  patchSummary: SessionPatchSummary
  truncated: boolean
}

export function createSessionSummary(summary: SessionSummary): SessionSummary {
  const updatedAt = summary.updatedAt ?? summary.startedAt
  const lastActivityAt = summary.lastActivityAt ?? updatedAt
  const endedAt = summary.endedAt ?? (isTerminalStatus(summary.status) ? updatedAt : undefined)

  return {
    ...summary,
    requestedBy: { ...summary.requestedBy },
    updatedAt,
    lastActivityAt,
    endedAt,
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

export function createSessionRecovery(recovery: SessionRecovery): SessionRecovery {
  return {
    session: createSessionSummary(recovery.session),
    recentEvents: recovery.recentEvents.map((event) => createSessionEvent(event)),
    recoveredAt: recovery.recoveredAt,
  }
}

function isTerminalStatus(status: SessionStatus) {
  return ['completed', 'failed', 'canceled'].includes(status)
}
