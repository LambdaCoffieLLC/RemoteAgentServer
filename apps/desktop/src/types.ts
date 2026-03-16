import type { ManagedPort } from '@remote-agent-server/ports'
import type { ProtocolEnvelope } from '@remote-agent-server/protocol'
import type {
  ProviderApprovalRecord,
  ProviderApprovalStatus,
  ProviderKind,
} from '@remote-agent-server/providers'
import type {
  SessionDescriptor,
  SessionLogEntry,
  SessionMode,
  SessionOutputEntry,
  SessionWorktreeMetadata,
} from '@remote-agent-server/sessions'

export const desktopIpcChannels = {
  clearConnectionSettings: 'desktop:settings:clear',
  loadConnectionSettings: 'desktop:settings:load',
  openExternalPreview: 'desktop:preview:open-external',
  saveConnectionSettings: 'desktop:settings:save',
} as const

export interface DesktopConnectionSettings {
  baseUrl: string
  token: string
}

export interface HostRecord {
  id: string
  name: string
  platform: string
  runtimeVersion: string
  hostMode: 'local' | 'remote'
  connectionMode: 'attached' | 'registered'
  status: 'online' | 'offline'
  health: 'healthy' | 'degraded' | 'unhealthy'
  connectivity: 'connected' | 'disconnected'
  registeredAt: string
  lastSeenAt: string
}

export interface WorkspaceRecord {
  id: string
  hostId: string
  path: string
  defaultBranch: string
  runtimeHostId: string
  createdAt: string
}

export interface SessionRecord extends SessionDescriptor {
  hostId: string
  runtimeHostId: string
  workspacePath: string
  executionPath: string
  allowDirtyWorkspace: boolean
  worktree?: SessionWorktreeMetadata
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  logs: SessionLogEntry[]
  output: SessionOutputEntry[]
}

export interface ForwardedPortRecord extends ManagedPort {
  hostId: string
  workspaceId?: string
  sessionId?: string
  label: string
  targetHost: string
  createdAt: string
  openedAt?: string
  closedAt?: string
}

export interface ControlPlaneEventRecord<TPayload = unknown> {
  id: string
  timestamp: string
  envelope: ProtocolEnvelope<TPayload>
}

export interface DesktopDashboardSnapshot {
  hosts: HostRecord[]
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  approvals: ProviderApprovalRecord[]
  forwardedPorts: ForwardedPortRecord[]
}

export interface EventStreamHandle {
  close(): void
  done: Promise<void>
}

export interface SessionStartRequest {
  id?: string
  mode?: SessionMode
  provider: ProviderKind
  workspaceId: string
}

export type SessionControlAction = 'pause' | 'resume' | 'cancel'

export interface DesktopControlPlaneClient {
  listApprovals(): Promise<ProviderApprovalRecord[]>
  listHosts(): Promise<HostRecord[]>
  listPorts(): Promise<ForwardedPortRecord[]>
  listSessions(): Promise<SessionRecord[]>
  listWorkspaces(): Promise<WorkspaceRecord[]>
  connectEvents(
    listener: (event: ControlPlaneEventRecord) => void,
    lastEventId?: string,
  ): EventStreamHandle
  controlSession(
    sessionId: string,
    action: SessionControlAction,
  ): Promise<SessionRecord>
  decideApproval(
    approvalId: string,
    status: Extract<ProviderApprovalStatus, 'approved' | 'rejected'>,
  ): Promise<ProviderApprovalRecord>
  startSession(request: SessionStartRequest): Promise<SessionRecord>
}

export interface ConnectionSettingsStore {
  clear(): Promise<void>
  load(): Promise<DesktopConnectionSettings | null>
  save(settings: DesktopConnectionSettings): Promise<void>
}

export interface PreviewOpener {
  open(url: string): Promise<void>
}

export interface DesktopBridge {
  connectionSettings: ConnectionSettingsStore
  preview: PreviewOpener
}

export type DesktopWorkspaceScope = 'local' | 'remote'

export type DesktopAppPhase = 'booting' | 'connecting' | 'ready' | 'signed-out'

export type LiveConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'

export interface DesktopOperatorState {
  phase: DesktopAppPhase
  liveConnection: LiveConnectionState
  connection?: DesktopConnectionSettings
  dashboard: DesktopDashboardSnapshot
  workspaceScope: DesktopWorkspaceScope
  selectedWorkspaceId?: string
  busyApprovalId?: string
  busySessionAction?: 'create' | SessionControlAction
  busySessionId?: string
  error?: string
  lastEventId?: string
  lastEventType?: string
}

