import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer as createNodeServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createAuthorizationPolicy, type AuthScope, type AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort, type ForwardedPort } from '@remote-agent/ports'
import {
  createManifest,
  type HostId,
  type IsoTimestamp,
  type ProtocolEnvelope,
  type RuntimeConnectivityStatus,
  type RuntimeHealthStatus,
  type RuntimeId,
  type RuntimeStatusSnapshot,
  type SessionId,
  type WorkspaceId,
} from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import {
  createSessionEvent,
  createSessionSummary,
  type SessionEvent,
  type SessionEventKind,
  type SessionLogLevel,
  type SessionOutputStream,
  type SessionStatus,
  type SessionSummary,
  type SessionWorkspaceMetadata,
  type SessionWorkspaceMode,
  type SessionWorktreeMetadata,
} from '@remote-agent/sessions'

const hostId = 'host_control_plane' as HostId
const workspaceId = 'workspace_server' as WorkspaceId
const sessionId = 'session_server_bootstrap' as SessionId
const execFile = promisify(execFileCallback)

export type HostPlatform = 'linux' | 'macos' | 'windows'
export type HostRuntimeStatus = 'online' | 'offline' | 'degraded'
export type ApprovalId = `approval_${string}`
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'
export type NotificationId = `notification_${string}`
export type NotificationCategory = 'approval-required' | 'session-status' | 'port-exposed'

export interface HostRuntimeRecord extends RuntimeStatusSnapshot {
  label: string
  enrolledAt: IsoTimestamp
  enrollmentMethod: 'bootstrap-token'
}

export interface HostRecord {
  id: HostId
  label: string
  platform: HostPlatform
  runtimeStatus: HostRuntimeStatus
  enrolledAt: IsoTimestamp
  lastSeenAt: IsoTimestamp
  runtime?: HostRuntimeRecord
}

export interface WorkspaceRecord {
  id: WorkspaceId
  hostId: HostId
  name: string
  path: string
  repositoryPath: string
  defaultBranch: string
  runtimeLabel: string
  runtimeAssociation: WorkspaceRuntimeAssociation
}

export interface WorkspaceRuntimeAssociation {
  hostId: HostId
  runtimeId?: RuntimeId
  label: string
}

export interface ApprovalRecord {
  id: ApprovalId
  sessionId: SessionId
  action: string
  requestedBy: Pick<AuthenticatedActor, 'id' | 'displayName'>
  requestedAt: IsoTimestamp
  status: ApprovalStatus
  decidedAt?: IsoTimestamp
  decidedBy?: Pick<AuthenticatedActor, 'id' | 'displayName'>
}

export interface NotificationRecord {
  id: NotificationId
  category: NotificationCategory
  title: string
  message: string
  createdAt: IsoTimestamp
  sessionId?: SessionId
  approvalId?: ApprovalId
  portId?: ForwardedPort['id']
}

export interface ControlPlaneState {
  hosts: HostRecord[]
  workspaces: WorkspaceRecord[]
  sessions: SessionSummary[]
  sessionEvents: SessionEvent[]
  approvals: ApprovalRecord[]
  ports: ForwardedPort[]
  notifications: NotificationRecord[]
}

export interface ControlPlaneEvent<TType extends string = string, TPayload = unknown> extends ProtocolEnvelope<TType, TPayload> {
  issuedAt: IsoTimestamp
}

export interface ControlPlaneHttpHandle {
  controlPlane: ControlPlaneServer
  server: HttpServer
  origin: string
  close: () => Promise<void>
}

export interface ControlPlaneServerOptions {
  actors?: Record<string, AuthenticatedActor>
  bootstrapTokens?: readonly string[]
  clock?: () => IsoTimestamp
  storagePath?: string
  seedState?: Partial<ControlPlaneState>
}

interface CreateHostInput {
  id: HostId
  label: string
  platform: HostPlatform
  runtimeStatus: HostRuntimeStatus
  enrolledAt?: IsoTimestamp
  lastSeenAt?: IsoTimestamp
}

interface CreateWorkspaceInput {
  id: WorkspaceId
  hostId: HostId
  name?: string
  repositoryPath: string
  defaultBranch?: string
  runtimeLabel?: string
}

interface CreateSessionInput {
  id: SessionId
  hostId: HostId
  workspaceId: WorkspaceId
  provider: SessionSummary['provider']
  workspaceMode?: SessionWorkspaceMode
  allowDirtyWorkspace?: boolean
  requestedBy?: Pick<AuthenticatedActor, 'id' | 'displayName'>
  status?: SessionStatus
  startedAt?: IsoTimestamp
}

interface UpdateSessionInput {
  status: SessionStatus
}

interface CreateSessionEventInput {
  kind: Extract<SessionEventKind, 'log' | 'output'>
  message: string
  level?: SessionLogLevel
  stream?: SessionOutputStream
}

interface SessionLifecycleActionInput {
  action: 'pause' | 'resume' | 'cancel'
}

interface EnrollRuntimeInput {
  hostId: HostId
  label: string
  platform: HostPlatform
  runtimeId: RuntimeId
  runtimeLabel?: string
  version: string
  health: RuntimeHealthStatus
  connectivity: RuntimeConnectivityStatus
}

interface ReportRuntimeStatusInput {
  hostId: HostId
  runtimeId: RuntimeId
  version: string
  health: RuntimeHealthStatus
  connectivity: RuntimeConnectivityStatus
}

interface CreateApprovalInput {
  id: ApprovalId
  sessionId: SessionId
  action: string
  requestedBy?: Pick<AuthenticatedActor, 'id' | 'displayName'>
  requestedAt?: IsoTimestamp
}

interface DecideApprovalInput {
  status: Extract<ApprovalStatus, 'approved' | 'rejected'>
  decidedBy?: Pick<AuthenticatedActor, 'id' | 'displayName'>
}

interface CreateForwardedPortInput {
  id: ForwardedPort['id']
  hostId: HostId
  workspaceId?: WorkspaceId
  sessionId?: SessionId
  localPort: number
  targetPort: number
  visibility: ForwardedPort['visibility']
  label: string
}

const defaultActors: Record<string, AuthenticatedActor> = {
  'control-plane-operator': {
    id: 'user_operator',
    kind: 'user',
    displayName: 'Control Plane Operator',
    scopes: [
      'hosts:read',
      'hosts:write',
      'workspaces:read',
      'workspaces:write',
      'sessions:read',
      'sessions:write',
      'approvals:read',
      'approvals:write',
      'notifications:read',
      'ports:read',
      'ports:write',
    ],
  },
  'control-plane-viewer': {
    id: 'user_viewer',
    kind: 'user',
    displayName: 'Control Plane Viewer',
    scopes: ['hosts:read', 'workspaces:read', 'sessions:read', 'approvals:read', 'notifications:read', 'ports:read'],
  },
}

const emptyState: ControlPlaneState = {
  hosts: [],
  workspaces: [],
  sessions: [],
  sessionEvents: [],
  approvals: [],
  ports: [],
  notifications: [],
}

const defaultBootstrapTokens = ['bootstrap-development-runtime']

export function describeServerApp() {
  const provider = coreProviderDescriptors.find(({ id }) => id === 'codex') ?? coreProviderDescriptors[0]

  return {
    manifest: createManifest('server', 'Control plane entrypoint scaffolded in the monorepo.', [
      '@remote-agent/protocol',
      '@remote-agent/auth',
      '@remote-agent/sessions',
      '@remote-agent/ports',
      '@remote-agent/providers',
    ]),
    authorization: createAuthorizationPolicy('control-plane', [
      'hosts:read',
      'hosts:write',
      'workspaces:read',
      'workspaces:write',
      'sessions:read',
      'sessions:write',
      'approvals:read',
      'approvals:write',
      'notifications:read',
      'ports:read',
      'ports:write',
    ]),
    session: createSessionSummary({
      id: sessionId,
      hostId,
      workspaceId,
      provider: provider.id,
      requestedBy: {
        id: 'system',
        displayName: 'RemoteAgentServer',
      },
      status: 'running',
      startedAt: '2026-03-16T00:00:00.000Z',
    }),
    forwardedPort: createForwardedPort({
      id: 'port_server_preview',
      hostId,
      workspaceId,
      sessionId,
      localPort: 3000,
      targetPort: 3000,
      visibility: 'private',
      label: 'Server preview',
    }),
    provider,
  }
}

export class ControlPlaneServer {
  readonly actors: ReadonlyMap<string, AuthenticatedActor>

  readonly bootstrapTokens: ReadonlySet<string>

  private readonly clock: () => IsoTimestamp

  private readonly storagePath?: string

  // eslint-disable-next-line no-unused-vars
  private readonly listeners = new Set<(...args: [ControlPlaneEvent]) => void>()

  private readonly eventStreams = new Set<ServerResponse<IncomingMessage>>()

  private state: ControlPlaneState

  private constructor(options: ControlPlaneServerOptions = {}) {
    this.actors = new Map(Object.entries(options.actors ?? defaultActors))
    this.bootstrapTokens = new Set(options.bootstrapTokens ?? defaultBootstrapTokens)
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.storagePath = options.storagePath
    this.state = mergeState(options.seedState)
  }

  static async create(options: ControlPlaneServerOptions = {}) {
    const server = new ControlPlaneServer(options)
    await server.loadState()
    return server
  }

  snapshot(): ControlPlaneState {
    return cloneState(this.state)
  }

  // eslint-disable-next-line no-unused-vars
  subscribe(listener: (...args: [ControlPlaneEvent]) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async listHosts() {
    return [...this.state.hosts]
  }

  async upsertHost(input: CreateHostInput) {
    const timestamp = this.clock()
    const current = this.state.hosts.find((host) => host.id === input.id)
    const host: HostRecord = {
      id: input.id,
      label: input.label,
      platform: input.platform,
      runtimeStatus: input.runtimeStatus,
      enrolledAt: input.enrolledAt ?? current?.enrolledAt ?? timestamp,
      lastSeenAt: input.lastSeenAt ?? timestamp,
      runtime: current?.runtime ? { ...current.runtime } : undefined,
    }

    this.state.hosts = upsertRecord(this.state.hosts, host)
    await this.persistState()
    this.publishEvent('host.registered', { host })
    return host
  }

  async enrollRuntime(input: EnrollRuntimeInput) {
    const timestamp = this.clock()
    const currentHost = this.state.hosts.find((host) => host.id === input.hostId)
    const currentRuntime = currentHost?.runtime
    const runtime: HostRuntimeRecord = {
      runtimeId: input.runtimeId,
      label: input.runtimeLabel ?? currentRuntime?.label ?? `${input.label} Runtime`,
      version: input.version,
      health: input.health,
      connectivity: input.connectivity,
      enrolledAt: currentRuntime?.enrolledAt ?? timestamp,
      reportedAt: timestamp,
      enrollmentMethod: 'bootstrap-token',
    }
    const host: HostRecord = {
      id: input.hostId,
      label: input.label,
      platform: input.platform,
      runtimeStatus: deriveRuntimeStatus(runtime),
      enrolledAt: currentHost?.enrolledAt ?? timestamp,
      lastSeenAt: timestamp,
      runtime,
    }

    this.state.hosts = upsertRecord(this.state.hosts, host)
    await this.persistState()
    this.publishEvent('runtime.enrolled', { host })
    return host
  }

  async reportRuntimeStatus(input: ReportRuntimeStatusInput) {
    const currentHost = this.getHost(input.hostId)
    const currentRuntime = currentHost.runtime

    if (!currentRuntime || currentRuntime.runtimeId !== input.runtimeId) {
      throw new ControlPlaneRequestError(404, 'runtime_not_found', `Runtime ${input.runtimeId} is not enrolled on host ${input.hostId}.`)
    }

    const timestamp = this.clock()
    const runtime: HostRuntimeRecord = {
      ...currentRuntime,
      version: input.version,
      health: input.health,
      connectivity: input.connectivity,
      reportedAt: timestamp,
    }
    const host: HostRecord = {
      ...currentHost,
      runtimeStatus: deriveRuntimeStatus(runtime),
      lastSeenAt: timestamp,
      runtime,
    }

    this.state.hosts = upsertRecord(this.state.hosts, host)
    await this.persistState()
    this.publishEvent('runtime.status.reported', { host })
    return host
  }

  async listWorkspaces() {
    return [...this.state.workspaces]
  }

  async inspectWorkspace(id: WorkspaceId) {
    return this.getWorkspace(id)
  }

  async upsertWorkspace(input: CreateWorkspaceInput) {
    const host = this.getHost(input.hostId)
    const repository = await resolveWorkspaceRepository(input.repositoryPath, host.id)
    const runtimeLabel = input.runtimeLabel ?? host.runtime?.label ?? `${host.label} Runtime`

    const workspace: WorkspaceRecord = {
      id: input.id,
      hostId: host.id,
      name: input.name?.trim() || basename(repository.path),
      path: repository.path,
      repositoryPath: repository.path,
      defaultBranch: input.defaultBranch ?? repository.defaultBranch,
      runtimeLabel,
      runtimeAssociation: {
        hostId: host.id,
        runtimeId: host.runtime?.runtimeId,
        label: runtimeLabel,
      },
    }

    this.state.workspaces = upsertRecord(this.state.workspaces, workspace)
    await this.persistState()
    this.publishEvent('workspace.registered', { workspace })
    return workspace
  }

  async removeWorkspace(id: WorkspaceId) {
    const workspace = this.getWorkspace(id)
    this.state.workspaces = this.state.workspaces.filter((entry) => entry.id !== id)
    await this.persistState()
    this.publishEvent('workspace.removed', { workspace })
    return workspace
  }

  async listSessions() {
    return [...this.state.sessions]
  }

  async inspectSession(id: SessionId) {
    return this.getSession(id)
  }

  async listSessionEvents(sessionId: SessionId) {
    this.getSession(sessionId)
    return this.state.sessionEvents.filter((event) => event.sessionId === sessionId).sort((left, right) => left.sequence - right.sequence)
  }

  async createSession(input: CreateSessionInput, actor?: AuthenticatedActor) {
    this.assertHostExists(input.hostId)
    const workspace = this.getWorkspace(input.workspaceId)

    if (workspace.hostId !== input.hostId) {
      throw new ControlPlaneRequestError(
        400,
        'invalid_session_workspace',
        `Workspace ${input.workspaceId} is registered on host ${workspace.hostId}, not ${input.hostId}.`,
      )
    }

    if (!coreProviderDescriptors.some((descriptor) => descriptor.id === input.provider)) {
      throw new ControlPlaneRequestError(400, 'invalid_provider', `Provider ${input.provider} is not supported.`)
    }

    const sessionWorkspace = await prepareSessionWorkspace({
      sessionId: input.id,
      workspace,
      workspaceMode: input.workspaceMode,
      allowDirtyWorkspace: input.allowDirtyWorkspace,
      clock: this.clock,
    })

    const session = createSessionSummary({
      id: input.id,
      hostId: input.hostId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      requestedBy: input.requestedBy ?? pickActorIdentity(actor),
      status: input.status ?? 'running',
      startedAt: input.startedAt ?? this.clock(),
      workspace: sessionWorkspace,
    })

    this.state.sessions = upsertRecord(this.state.sessions, session)
    const sessionEvent = this.buildStatusSessionEvent(session.id, session.status, undefined, session.provider)
    this.state.sessionEvents = [...this.state.sessionEvents, sessionEvent]
    await this.persistState()
    this.publishEvent('session.upserted', { session })
    this.publishEvent('session.event.created', { sessionEvent })
    await this.maybeCreateSessionNotification(session)
    return session
  }

  async updateSession(id: SessionId, input: UpdateSessionInput) {
    const current = this.getSession(id)

    if (current.status === input.status) {
      return current
    }

    assertSessionStatusTransition(current.status, input.status)
    const updated = createSessionSummary({
      ...current,
      status: input.status,
    })

    this.state.sessions = upsertRecord(this.state.sessions, updated)
    const sessionEvent = this.buildStatusSessionEvent(updated.id, updated.status, current.status)
    this.state.sessionEvents = [...this.state.sessionEvents, sessionEvent]
    await this.persistState()
    this.publishEvent('session.updated', { session: updated })
    this.publishEvent('session.event.created', { sessionEvent })
    await this.maybeCreateSessionNotification(updated)
    return updated
  }

  async applySessionAction(id: SessionId, input: SessionLifecycleActionInput) {
    const current = this.getSession(id)
    const nextStatus = mapLifecycleActionToStatus(input.action, current.status)
    return this.updateSession(id, { status: nextStatus })
  }

  async createSessionEvent(sessionId: SessionId, input: CreateSessionEventInput) {
    this.getSession(sessionId)

    if (input.message.trim().length === 0) {
      throw new ControlPlaneRequestError(400, 'invalid_session_event', 'Session events require a non-empty message.')
    }

    const sessionEvent = this.buildSessionEvent(sessionId, input)
    this.state.sessionEvents = [...this.state.sessionEvents, sessionEvent]
    await this.persistState()
    this.publishEvent('session.event.created', { sessionEvent })
    return sessionEvent
  }

  async listApprovals() {
    return [...this.state.approvals]
  }

  async createApproval(input: CreateApprovalInput, actor?: AuthenticatedActor) {
    this.getSession(input.sessionId)

    const approval: ApprovalRecord = {
      id: input.id,
      sessionId: input.sessionId,
      action: input.action,
      requestedBy: input.requestedBy ?? pickActorIdentity(actor),
      requestedAt: input.requestedAt ?? this.clock(),
      status: 'pending',
    }

    this.state.approvals = upsertRecord(this.state.approvals, approval)
    await this.persistState()
    this.publishEvent('approval.requested', { approval })
    await this.createNotification({
      id: toNotificationId(input.id),
      category: 'approval-required',
      title: 'Approval required',
      message: `${approval.action} requires review for ${approval.sessionId}.`,
      sessionId: approval.sessionId,
      approvalId: approval.id,
    })
    return approval
  }

  async decideApproval(id: ApprovalId, input: DecideApprovalInput, actor?: AuthenticatedActor) {
    const current = this.getApproval(id)
    const updated: ApprovalRecord = {
      ...current,
      status: input.status,
      decidedAt: this.clock(),
      decidedBy: input.decidedBy ?? pickActorIdentity(actor),
    }

    this.state.approvals = upsertRecord(this.state.approvals, updated)
    await this.persistState()
    this.publishEvent('approval.decided', { approval: updated })
    return updated
  }

  async listPorts() {
    return [...this.state.ports]
  }

  async createForwardedPort(input: CreateForwardedPortInput) {
    this.assertHostExists(input.hostId)

    if (input.workspaceId) {
      this.assertWorkspaceExists(input.workspaceId)
    }

    if (input.sessionId) {
      this.getSession(input.sessionId)
    }

    const port = createForwardedPort({
      id: input.id,
      hostId: input.hostId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      localPort: input.localPort,
      targetPort: input.targetPort,
      visibility: input.visibility,
      label: input.label,
    })

    this.state.ports = upsertRecord(this.state.ports, port)
    await this.persistState()
    this.publishEvent('port.forwarded', { port })
    await this.createNotification({
      id: toNotificationId(port.id),
      category: 'port-exposed',
      title: 'Port forwarded',
      message: `${port.label} is available on ${port.targetPort}.`,
      sessionId: port.sessionId,
      portId: port.id,
    })
    return port
  }

  async listNotifications() {
    return [...this.state.notifications]
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse<IncomingMessage>) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathSegments = url.pathname.split('/').filter(Boolean)

    try {
      if (request.method === 'POST' && url.pathname === '/v1/runtime/enroll') {
        if (!this.authorizeBootstrapToken(request, response)) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<EnrollRuntimeInput>

        if (
          !input.hostId ||
          !input.label ||
          !input.platform ||
          !input.runtimeId ||
          !input.version ||
          !input.health ||
          !input.connectivity
        ) {
          this.writeError(
            response,
            400,
            'invalid_runtime_enrollment',
            'Runtime enrollment requires hostId, label, platform, runtimeId, version, health, and connectivity.',
          )
          return
        }

        const alreadyEnrolled = this.state.hosts.some((host) => host.id === input.hostId)
        const host = await this.enrollRuntime(input as EnrollRuntimeInput)
        this.writeJson(response, alreadyEnrolled ? 200 : 201, { data: host })
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/runtime/status') {
        if (!this.authorizeBootstrapToken(request, response)) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<ReportRuntimeStatusInput>

        if (!input.hostId || !input.runtimeId || !input.version || !input.health || !input.connectivity) {
          this.writeError(
            response,
            400,
            'invalid_runtime_status',
            'Runtime status reports require hostId, runtimeId, version, health, and connectivity.',
          )
          return
        }

        this.writeJson(response, 200, { data: await this.reportRuntimeStatus(input as ReportRuntimeStatusInput) })
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/events') {
        const actor = this.authorizeRequest(request, response, 'sessions:read')

        if (!actor) {
          return
        }

        this.openEventStream(response)
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/hosts') {
        if (!this.authorizeRequest(request, response, 'hosts:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listHosts() })
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/hosts') {
        if (!this.authorizeRequest(request, response, 'hosts:write')) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<CreateHostInput>

        if (!input.id || !input.label || !input.platform || !input.runtimeStatus) {
          this.writeError(response, 400, 'invalid_host', 'Host registration requires id, label, platform, and runtimeStatus.')
          return
        }

        this.writeJson(response, 201, { data: await this.upsertHost(input as CreateHostInput) })
        return
      }

      if (request.method === 'GET' && pathSegments[0] === 'v1' && pathSegments[1] === 'workspaces' && pathSegments[2]) {
        if (!this.authorizeRequest(request, response, 'workspaces:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.inspectWorkspace(pathSegments[2] as WorkspaceId) })
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/workspaces') {
        if (!this.authorizeRequest(request, response, 'workspaces:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listWorkspaces() })
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/workspaces') {
        if (!this.authorizeRequest(request, response, 'workspaces:write')) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<CreateWorkspaceInput>

        if (!input.id || !input.hostId || !input.repositoryPath) {
          this.writeError(
            response,
            400,
            'invalid_workspace',
            'Workspace registration requires id, hostId, and repositoryPath.',
          )
          return
        }

        this.writeJson(response, 201, { data: await this.upsertWorkspace(input as CreateWorkspaceInput) })
        return
      }

      if (request.method === 'DELETE' && pathSegments[0] === 'v1' && pathSegments[1] === 'workspaces' && pathSegments[2]) {
        if (!this.authorizeRequest(request, response, 'workspaces:write')) {
          return
        }

        this.writeJson(response, 200, { data: await this.removeWorkspace(pathSegments[2] as WorkspaceId) })
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        if (!this.authorizeRequest(request, response, 'sessions:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listSessions() })
        return
      }

      if (request.method === 'GET' && pathSegments[0] === 'v1' && pathSegments[1] === 'sessions' && pathSegments[2] && !pathSegments[3]) {
        if (!this.authorizeRequest(request, response, 'sessions:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.inspectSession(pathSegments[2] as SessionId) })
        return
      }

      if (
        request.method === 'GET' &&
        pathSegments[0] === 'v1' &&
        pathSegments[1] === 'sessions' &&
        pathSegments[2] &&
        pathSegments[3] === 'events'
      ) {
        if (!this.authorizeRequest(request, response, 'sessions:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listSessionEvents(pathSegments[2] as SessionId) })
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const actor = this.authorizeRequest(request, response, 'sessions:write')

        if (!actor) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<CreateSessionInput>

        if (!input.id || !input.hostId || !input.workspaceId || !input.provider) {
          this.writeError(response, 400, 'invalid_session', 'Session creation requires id, hostId, workspaceId, and provider.')
          return
        }

        if (input.workspaceMode && !['direct', 'worktree'].includes(input.workspaceMode)) {
          this.writeError(response, 400, 'invalid_session', 'Session workspaceMode must be direct or worktree.')
          return
        }

        if (input.allowDirtyWorkspace !== undefined && typeof input.allowDirtyWorkspace !== 'boolean') {
          this.writeError(response, 400, 'invalid_session', 'Session allowDirtyWorkspace must be a boolean when provided.')
          return
        }

        this.writeJson(response, 201, { data: await this.createSession(input as CreateSessionInput, actor) })
        return
      }

      if (
        request.method === 'POST' &&
        pathSegments[0] === 'v1' &&
        pathSegments[1] === 'sessions' &&
        pathSegments[2] &&
        pathSegments[3] === 'events'
      ) {
        if (!this.authorizeRequest(request, response, 'sessions:write')) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<CreateSessionEventInput>

        if (!input.kind || !['log', 'output'].includes(input.kind) || !input.message) {
          this.writeError(
            response,
            400,
            'invalid_session_event',
            'Session event creation requires kind=log|output and a message.',
          )
          return
        }

        this.writeJson(response, 201, {
          data: await this.createSessionEvent(pathSegments[2] as SessionId, input as CreateSessionEventInput),
        })
        return
      }

      if (
        request.method === 'POST' &&
        pathSegments[0] === 'v1' &&
        pathSegments[1] === 'sessions' &&
        pathSegments[2] &&
        pathSegments[3] === 'actions'
      ) {
        if (!this.authorizeRequest(request, response, 'sessions:write')) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<SessionLifecycleActionInput>

        if (!input.action || !['pause', 'resume', 'cancel'].includes(input.action)) {
          this.writeError(
            response,
            400,
            'invalid_session_action',
            'Session actions require action=pause|resume|cancel.',
          )
          return
        }

        this.writeJson(response, 200, {
          data: await this.applySessionAction(pathSegments[2] as SessionId, input as SessionLifecycleActionInput),
        })
        return
      }

      if (request.method === 'PATCH' && pathSegments[0] === 'v1' && pathSegments[1] === 'sessions' && pathSegments[2]) {
        if (!this.authorizeRequest(request, response, 'sessions:write')) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<UpdateSessionInput>

        if (!input.status) {
          this.writeError(response, 400, 'invalid_session_update', 'Session updates require a status.')
          return
        }

        this.writeJson(response, 200, { data: await this.updateSession(pathSegments[2] as SessionId, input as UpdateSessionInput) })
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/approvals') {
        if (!this.authorizeRequest(request, response, 'approvals:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listApprovals() })
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/approvals') {
        const actor = this.authorizeRequest(request, response, 'approvals:write')

        if (!actor) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<CreateApprovalInput>

        if (!input.id || !input.sessionId || !input.action) {
          this.writeError(response, 400, 'invalid_approval', 'Approval creation requires id, sessionId, and action.')
          return
        }

        this.writeJson(response, 201, { data: await this.createApproval(input as CreateApprovalInput, actor) })
        return
      }

      if (request.method === 'PATCH' && pathSegments[0] === 'v1' && pathSegments[1] === 'approvals' && pathSegments[2]) {
        const actor = this.authorizeRequest(request, response, 'approvals:write')

        if (!actor) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<DecideApprovalInput>

        if (!input.status || !['approved', 'rejected'].includes(input.status)) {
          this.writeError(response, 400, 'invalid_approval_decision', 'Approval decisions must set status to approved or rejected.')
          return
        }

        this.writeJson(response, 200, {
          data: await this.decideApproval(pathSegments[2] as ApprovalId, input as DecideApprovalInput, actor),
        })
        return
      }

      if (request.method === 'GET' && (url.pathname === '/v1/ports' || url.pathname === '/v1/forwarded-ports')) {
        if (!this.authorizeRequest(request, response, 'ports:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listPorts() })
        return
      }

      if (request.method === 'POST' && (url.pathname === '/v1/ports' || url.pathname === '/v1/forwarded-ports')) {
        if (!this.authorizeRequest(request, response, 'ports:write')) {
          return
        }

        const input = (await readJsonBody(request)) as Partial<CreateForwardedPortInput>

        if (
          !input.id ||
          !input.hostId ||
          input.localPort === undefined ||
          input.targetPort === undefined ||
          !input.visibility ||
          !input.label
        ) {
          this.writeError(
            response,
            400,
            'invalid_port',
            'Forwarded port creation requires id, hostId, localPort, targetPort, visibility, and label.',
          )
          return
        }

        this.writeJson(response, 201, { data: await this.createForwardedPort(input as CreateForwardedPortInput) })
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/notifications') {
        if (!this.authorizeRequest(request, response, 'notifications:read')) {
          return
        }

        this.writeJson(response, 200, { data: await this.listNotifications() })
        return
      }

      this.writeError(response, 404, 'not_found', 'The requested control-plane endpoint was not found.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected control-plane failure.'
      const statusCode = error instanceof ControlPlaneRequestError ? error.statusCode : 500
      const code = error instanceof ControlPlaneRequestError ? error.code : 'internal_error'
      this.writeError(response, statusCode, code, message)
    }
  }

  createHttpServer() {
    return createNodeServer((request, response) => {
      void this.handleRequest(request, response)
    })
  }

  private async loadState() {
    if (!this.storagePath) {
      return
    }

    try {
      const rawState = await readFile(this.storagePath, 'utf8')
      this.state = mergeState(JSON.parse(rawState) as Partial<ControlPlaneState>)
    } catch (error) {
      const missingFile = error instanceof Error && 'code' in error && error.code === 'ENOENT'

      if (!missingFile) {
        throw error
      }

      await this.persistState()
    }
  }

  private async persistState() {
    if (!this.storagePath) {
      return
    }

    await mkdir(dirname(this.storagePath), { recursive: true })
    await writeFile(this.storagePath, JSON.stringify(this.state, null, 2))
  }

  private publishEvent<TType extends string, TPayload>(type: TType, payload: TPayload) {
    const event: ControlPlaneEvent<TType, TPayload> = {
      type,
      payload,
      issuedAt: this.clock(),
    }

    for (const listener of this.listeners) {
      listener(event)
    }

    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

    for (const stream of this.eventStreams) {
      stream.write(frame)
    }
  }

  private openEventStream(response: ServerResponse<IncomingMessage>) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    response.write(`event: control-plane.snapshot\ndata: ${JSON.stringify({ type: 'control-plane.snapshot', payload: this.snapshot(), issuedAt: this.clock() })}\n\n`)
    this.eventStreams.add(response)

    response.on('close', () => {
      this.eventStreams.delete(response)
    })
  }

  private authorizeRequest(request: IncomingMessage, response: ServerResponse<IncomingMessage>, scope: AuthScope) {
    const authorizationHeader = request.headers.authorization

    if (!authorizationHeader?.startsWith('Bearer ')) {
      this.writeError(response, 401, 'unauthorized', 'A bearer token is required.')
      return undefined
    }

    const token = authorizationHeader.slice('Bearer '.length)
    const actor = this.actors.get(token)

    if (!actor) {
      this.writeError(response, 401, 'unauthorized', 'The provided bearer token is not recognized.')
      return undefined
    }

    if (!actor.scopes.includes(scope)) {
      this.writeError(response, 403, 'forbidden', `Missing required scope: ${scope}.`)
      return undefined
    }

    return actor
  }

  private authorizeBootstrapToken(request: IncomingMessage, response: ServerResponse<IncomingMessage>) {
    const bootstrapToken = request.headers['x-bootstrap-token']

    if (typeof bootstrapToken !== 'string' || bootstrapToken.length === 0) {
      this.writeError(response, 401, 'unauthorized', 'A bootstrap token is required.')
      return undefined
    }

    if (!this.bootstrapTokens.has(bootstrapToken)) {
      this.writeError(response, 401, 'unauthorized', 'The provided bootstrap token is not recognized.')
      return undefined
    }

    return bootstrapToken
  }

  private assertHostExists(id: HostId) {
    if (!this.state.hosts.some((host) => host.id === id)) {
      throw new ControlPlaneRequestError(404, 'host_not_found', `Host ${id} is not registered.`)
    }
  }

  private getHost(id: HostId) {
    const host = this.state.hosts.find((entry) => entry.id === id)

    if (!host) {
      throw new ControlPlaneRequestError(404, 'host_not_found', `Host ${id} is not registered.`)
    }

    return host
  }

  private assertWorkspaceExists(id: WorkspaceId) {
    this.getWorkspace(id)
  }

  private getWorkspace(id: WorkspaceId) {
    const workspace = this.state.workspaces.find((entry) => entry.id === id)

    if (!workspace) {
      throw new ControlPlaneRequestError(404, 'workspace_not_found', `Workspace ${id} is not registered.`)
    }

    return workspace
  }

  private getSession(id: SessionId) {
    const session = this.state.sessions.find((entry) => entry.id === id)

    if (!session) {
      throw new ControlPlaneRequestError(404, 'session_not_found', `Session ${id} is not registered.`)
    }

    return session
  }

  private getApproval(id: ApprovalId) {
    const approval = this.state.approvals.find((entry) => entry.id === id)

    if (!approval) {
      throw new ControlPlaneRequestError(404, 'approval_not_found', `Approval ${id} is not registered.`)
    }

    return approval
  }

  private buildSessionEvent(sessionId: SessionId, input: CreateSessionEventInput) {
    const nextSequence = this.nextSessionEventSequence(sessionId)
    return createSessionEvent({
      id: toSessionEventId(sessionId, nextSequence),
      sessionId,
      sequence: nextSequence,
      kind: input.kind,
      createdAt: this.clock(),
      message: input.message.trim(),
      level: input.kind === 'log' ? input.level ?? 'info' : undefined,
      stream: input.kind === 'output' ? input.stream ?? 'stdout' : undefined,
    })
  }

  private buildStatusSessionEvent(
    sessionId: SessionId,
    status: SessionStatus,
    previousStatus?: SessionStatus,
    provider?: SessionSummary['provider'],
  ) {
    const nextSequence = this.nextSessionEventSequence(sessionId)
    return createSessionEvent({
      id: toSessionEventId(sessionId, nextSequence),
      sessionId,
      sequence: nextSequence,
      kind: 'status',
      createdAt: this.clock(),
      message: describeSessionStatusMessage(status, previousStatus, provider),
      status,
    })
  }

  private nextSessionEventSequence(sessionId: SessionId) {
    const sequence = this.state.sessionEvents
      .filter((event) => event.sessionId === sessionId)
      .reduce((maxSequence, event) => Math.max(maxSequence, event.sequence), 0)

    return sequence + 1
  }

  private async maybeCreateSessionNotification(session: SessionSummary) {
    if (!['completed', 'failed'].includes(session.status)) {
      return
    }

    await this.createNotification({
      id: toNotificationId(session.id),
      category: 'session-status',
      title: `Session ${session.status}`,
      message: `${session.id} is now ${session.status}.`,
      sessionId: session.id,
    })
  }

  private async createNotification(notification: Omit<NotificationRecord, 'createdAt'> & { createdAt?: IsoTimestamp }) {
    const persistedNotification: NotificationRecord = {
      ...notification,
      createdAt: notification.createdAt ?? this.clock(),
    }

    this.state.notifications = upsertRecord(this.state.notifications, persistedNotification)
    await this.persistState()
    this.publishEvent('notification.created', { notification: persistedNotification })
    return persistedNotification
  }

  private writeJson(response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(payload))
  }

  private writeError(response: ServerResponse<IncomingMessage>, statusCode: number, code: string, message: string) {
    this.writeJson(response, statusCode, {
      error: {
        code,
        message,
      },
    })
  }
}

export async function createControlPlaneServer(options: ControlPlaneServerOptions = {}) {
  return ControlPlaneServer.create(options)
}

export async function startControlPlaneHttpServer(options: ControlPlaneServerOptions = {}): Promise<ControlPlaneHttpHandle> {
  const controlPlane = await createControlPlaneServer(options)
  const server = controlPlane.createHttpServer()

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Control plane failed to bind to a TCP address.')
  }

  return {
    controlPlane,
    server,
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    },
  }
}

class ControlPlaneRequestError extends Error {
  readonly statusCode: number

  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function mergeState(seedState?: Partial<ControlPlaneState>): ControlPlaneState {
  return {
    hosts: [...(seedState?.hosts ?? emptyState.hosts)],
    workspaces: (seedState?.workspaces ?? emptyState.workspaces).map((workspace) => normalizeWorkspaceRecord(workspace)),
    sessions: (seedState?.sessions ?? emptyState.sessions).map((session) => createSessionSummary(session)),
    sessionEvents: (seedState?.sessionEvents ?? emptyState.sessionEvents).map((event) => createSessionEvent(event)),
    approvals: [...(seedState?.approvals ?? emptyState.approvals)],
    ports: [...(seedState?.ports ?? emptyState.ports)],
    notifications: [...(seedState?.notifications ?? emptyState.notifications)],
  }
}

function cloneState(state: ControlPlaneState): ControlPlaneState {
  return {
    hosts: state.hosts.map((host) => ({
      ...host,
      runtime: host.runtime
        ? {
            ...host.runtime,
          }
        : undefined,
    })),
    workspaces: state.workspaces.map((workspace) => normalizeWorkspaceRecord(workspace)),
    sessions: state.sessions.map((session) => createSessionSummary(session)),
    sessionEvents: state.sessionEvents.map((event) => createSessionEvent(event)),
    approvals: state.approvals.map((approval) => ({
      ...approval,
      requestedBy: { ...approval.requestedBy },
      decidedBy: approval.decidedBy ? { ...approval.decidedBy } : undefined,
    })),
    ports: state.ports.map((port) => createForwardedPort(port)),
    notifications: state.notifications.map((notification) => ({ ...notification })),
  }
}

function upsertRecord<TRecord extends { id: string }>(records: readonly TRecord[], nextRecord: TRecord) {
  return [...records.filter((record) => record.id !== nextRecord.id), nextRecord]
}

function pickActorIdentity(actor?: AuthenticatedActor) {
  return actor
    ? {
        id: actor.id,
        displayName: actor.displayName,
      }
    : {
        id: 'system',
        displayName: 'RemoteAgentServer',
      }
}

function toNotificationId(id: string): NotificationId {
  return `notification_${id.replace(/^[^_]+_/, '')}`
}

function toSessionEventId(sessionId: SessionId, sequence: number) {
  return `session_event_${sessionId.replace(/^session_/, '')}_${sequence}` as SessionEvent['id']
}

function mapLifecycleActionToStatus(action: SessionLifecycleActionInput['action'], currentStatus: SessionStatus): SessionStatus {
  if (action === 'pause') {
    if (currentStatus !== 'running') {
      throw new ControlPlaneRequestError(409, 'invalid_session_transition', `Session ${currentStatus} cannot be paused.`)
    }

    return 'paused'
  }

  if (action === 'resume') {
    if (currentStatus !== 'paused') {
      throw new ControlPlaneRequestError(409, 'invalid_session_transition', `Session ${currentStatus} cannot be resumed.`)
    }

    return 'running'
  }

  if (!['queued', 'running', 'paused'].includes(currentStatus)) {
    throw new ControlPlaneRequestError(409, 'invalid_session_transition', `Session ${currentStatus} cannot be canceled.`)
  }

  return 'canceled'
}

function assertSessionStatusTransition(currentStatus: SessionStatus, nextStatus: SessionStatus) {
  const allowedTransitions: Record<SessionStatus, SessionStatus[]> = {
    queued: ['running', 'failed', 'canceled'],
    running: ['paused', 'completed', 'failed', 'canceled'],
    paused: ['running', 'failed', 'canceled'],
    completed: [],
    failed: [],
    canceled: [],
  }

  if (!allowedTransitions[currentStatus].includes(nextStatus)) {
    throw new ControlPlaneRequestError(
      409,
      'invalid_session_transition',
      `Session ${currentStatus} cannot transition to ${nextStatus}.`,
    )
  }
}

function describeSessionStatusMessage(
  status: SessionStatus,
  previousStatus?: SessionStatus,
  provider?: SessionSummary['provider'],
) {
  if (status === 'running' && previousStatus === 'paused') {
    return 'Session resumed.'
  }

  if (status === 'running') {
    return provider ? `Session started with provider ${provider}.` : 'Session started.'
  }

  if (status === 'paused') {
    return 'Session paused.'
  }

  if (status === 'completed') {
    return 'Session completed.'
  }

  if (status === 'failed') {
    return 'Session failed.'
  }

  if (status === 'canceled') {
    return 'Session canceled.'
  }

  return 'Session queued.'
}

function deriveRuntimeStatus(runtime: Pick<HostRuntimeRecord, 'connectivity' | 'health'>): HostRuntimeStatus {
  if (runtime.connectivity === 'disconnected') {
    return 'offline'
  }

  return runtime.health === 'healthy' ? 'online' : 'degraded'
}

function normalizeWorkspaceRecord(workspace: WorkspaceRecord) {
  const path = workspace.path ?? workspace.repositoryPath
  const runtimeLabel = workspace.runtimeLabel ?? workspace.runtimeAssociation?.label ?? 'Unspecified Runtime'

  return {
    ...workspace,
    path,
    repositoryPath: workspace.repositoryPath ?? path,
    runtimeLabel,
    runtimeAssociation: workspace.runtimeAssociation ?? {
      hostId: workspace.hostId,
      runtimeId: undefined,
      label: runtimeLabel,
    },
  }
}

interface PrepareSessionWorkspaceOptions {
  sessionId: SessionId
  workspace: WorkspaceRecord
  workspaceMode?: SessionWorkspaceMode
  allowDirtyWorkspace?: boolean
  clock: () => IsoTimestamp
}

async function prepareSessionWorkspace(options: PrepareSessionWorkspaceOptions): Promise<SessionWorkspaceMetadata> {
  const workspaceMode = options.workspaceMode ?? 'direct'
  const allowDirtyWorkspace = options.allowDirtyWorkspace ?? false

  if (workspaceMode === 'direct') {
    return {
      mode: 'direct',
      repositoryPath: options.workspace.repositoryPath,
      path: options.workspace.path,
      allowDirtyWorkspace,
    }
  }

  if (!allowDirtyWorkspace) {
    await assertRepositoryIsClean(options.workspace.repositoryPath, options.workspace.hostId)
  }

  const worktree = await createSessionWorktree({
    sessionId: options.sessionId,
    workspace: options.workspace,
    allowDirtyWorkspace,
    createdAt: options.clock(),
  })

  return {
    mode: 'worktree',
    repositoryPath: options.workspace.repositoryPath,
    path: worktree.path,
    allowDirtyWorkspace,
    worktree,
  }
}

async function resolveWorkspaceRepository(repositoryPath: string, hostId: HostId) {
  const normalizedPath = resolve(repositoryPath)
  await assertAccessibleWorkspacePath(normalizedPath, hostId)

  let repositoryRoot: string

  try {
    const result = await execFile('git', ['-C', normalizedPath, 'rev-parse', '--show-toplevel'])
    repositoryRoot = result.stdout.trim()
  } catch {
    throw new ControlPlaneRequestError(
      400,
      'invalid_workspace_path',
      `Repository path ${normalizedPath} is not a git repository on host ${hostId}.`,
    )
  }

  const defaultBranch = await detectDefaultBranch(repositoryRoot, hostId)

  return {
    path: repositoryRoot,
    defaultBranch,
  }
}

async function assertAccessibleWorkspacePath(repositoryPath: string, hostId: HostId) {
  try {
    await access(repositoryPath, constants.R_OK | constants.X_OK)
  } catch {
    throw new ControlPlaneRequestError(
      400,
      'invalid_workspace_path',
      `Repository path ${repositoryPath} is not accessible on host ${hostId}.`,
    )
  }

  const repositoryStats = await stat(repositoryPath)

  if (!repositoryStats.isDirectory()) {
    throw new ControlPlaneRequestError(
      400,
      'invalid_workspace_path',
      `Repository path ${repositoryPath} is not a directory on host ${hostId}.`,
    )
  }
}

async function detectDefaultBranch(repositoryPath: string, hostId: HostId) {
  const originHeadBranch = await tryReadGitOutput(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])

  if (originHeadBranch) {
    return originHeadBranch.replace(/^origin\//, '')
  }

  const currentBranch = await tryReadGitOutput(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])

  if (currentBranch) {
    return currentBranch
  }

  throw new ControlPlaneRequestError(
    400,
    'invalid_workspace_path',
    `Repository path ${repositoryPath} is missing a detectable default branch on host ${hostId}.`,
  )
}

async function assertRepositoryIsClean(repositoryPath: string, hostId: HostId) {
  const status = await tryReadGitOutput(repositoryPath, ['status', '--porcelain', '--untracked-files=normal'])

  if (status && status.trim().length > 0) {
    throw new ControlPlaneRequestError(
      409,
      'dirty_workspace',
      `Workspace ${repositoryPath} has uncommitted changes on host ${hostId}. Set allowDirtyWorkspace=true to continue.`,
    )
  }
}

interface CreateSessionWorktreeOptions {
  sessionId: SessionId
  workspace: WorkspaceRecord
  allowDirtyWorkspace: boolean
  createdAt: IsoTimestamp
}

async function createSessionWorktree(options: CreateSessionWorktreeOptions): Promise<SessionWorktreeMetadata> {
  const branch = toSessionWorktreeBranchName(options.sessionId)
  const worktreePath = resolve(
    dirname(options.workspace.repositoryPath),
    '.remote-agent-worktrees',
    basename(options.workspace.repositoryPath),
    toFilesystemSafeSegment(options.sessionId),
  )

  if (await gitRefExists(options.workspace.repositoryPath, `refs/heads/${branch}`)) {
    throw new ControlPlaneRequestError(
      409,
      'session_worktree_conflict',
      `Session worktree branch ${branch} already exists for ${options.sessionId}.`,
    )
  }

  if (await pathExists(worktreePath)) {
    throw new ControlPlaneRequestError(
      409,
      'session_worktree_conflict',
      `Session worktree path ${worktreePath} already exists for ${options.sessionId}.`,
    )
  }

  await mkdir(dirname(worktreePath), { recursive: true })

  try {
    await execFile('git', ['-C', options.workspace.repositoryPath, 'worktree', 'add', '-b', branch, worktreePath, options.workspace.defaultBranch])
  } catch (error) {
    throw new ControlPlaneRequestError(
      500,
      'session_worktree_failed',
      `Failed to create a worktree for ${options.sessionId}: ${toErrorMessage(error)}`,
    )
  }

  return {
    repositoryPath: options.workspace.repositoryPath,
    path: worktreePath,
    branch,
    baseBranch: options.workspace.defaultBranch,
    createdAt: options.createdAt,
    dirtyWorkspaceAllowed: options.allowDirtyWorkspace,
  }
}

async function tryReadGitOutput(repositoryPath: string, args: string[]) {
  try {
    const result = await execFile('git', ['-C', repositoryPath, ...args])
    return result.stdout.trim()
  } catch {
    return undefined
  }
}

async function gitRefExists(repositoryPath: string, ref: string) {
  try {
    await execFile('git', ['-C', repositoryPath, 'show-ref', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    const missingPath = error instanceof Error && 'code' in error && error.code === 'ENOENT'

    if (!missingPath) {
      throw error
    }

    return false
  }
}

function toSessionWorktreeBranchName(sessionId: SessionId) {
  return `session/${toFilesystemSafeSegment(sessionId)}`
}

function toFilesystemSafeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return 'Unknown git error.'
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Uint8Array[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
