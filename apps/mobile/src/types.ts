import type { ManagedPort } from '@remote-agent-server/ports'
import type { ProtocolEnvelope } from '@remote-agent-server/protocol'
import type { ProviderApprovalRecord, ProviderApprovalStatus } from '@remote-agent-server/providers'
import type {
  SessionDescriptor,
  SessionLogEntry,
  SessionOutputEntry,
  SessionWorktreeMetadata,
} from '@remote-agent-server/sessions'

export interface MobileConnectionSettings {
  baseUrl: string
  token: string
}

export interface HostRecord {
  id: string
  name: string
  platform: string
  runtimeVersion: string
  status: 'online' | 'offline'
  health: 'healthy' | 'degraded' | 'unhealthy'
  connectivity: 'connected' | 'disconnected'
  registeredAt: string
  lastSeenAt: string
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

export interface MobileDashboardSnapshot {
  hosts: HostRecord[]
  sessions: SessionRecord[]
  approvals: ProviderApprovalRecord[]
  forwardedPorts: ForwardedPortRecord[]
}

export interface EventStreamHandle {
  close(): void
  done: Promise<void>
}

export interface MobileControlPlaneClient {
  listHosts(): Promise<HostRecord[]>
  listSessions(): Promise<SessionRecord[]>
  listApprovals(): Promise<ProviderApprovalRecord[]>
  listPorts(): Promise<ForwardedPortRecord[]>
  decideApproval(
    approvalId: string,
    status: Extract<ProviderApprovalStatus, 'approved' | 'rejected'>,
  ): Promise<ProviderApprovalRecord>
  connectEvents(
    listener: (event: ControlPlaneEventRecord) => void,
    lastEventId?: string,
  ): EventStreamHandle
}

export interface ConnectionSettingsStore {
  load(): Promise<MobileConnectionSettings | null>
  save(settings: MobileConnectionSettings): Promise<void>
  clear(): Promise<void>
}

export type PreviewOpenMode = 'in-app' | 'browser'

export interface PreviewOpener {
  open(port: ForwardedPortRecord, mode: PreviewOpenMode): Promise<void>
}

export type MobileAppPhase =
  | 'booting'
  | 'signed-out'
  | 'connecting'
  | 'ready'

export type LiveConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'

export interface MobileOperatorState {
  phase: MobileAppPhase
  liveConnection: LiveConnectionState
  connection?: MobileConnectionSettings
  dashboard: MobileDashboardSnapshot
  busyApprovalId?: string
  error?: string
  lastEventId?: string
  lastEventType?: string
}
