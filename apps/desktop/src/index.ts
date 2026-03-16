import type { AuthenticatedActor } from '@remote-agent/auth'
import { createDetectedPort, createForwardedPort, type DetectedPort, type ForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type IsoTimestamp, type ProtocolEnvelope, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import {
  attachLocalRuntime,
  registerLocalRuntime,
} from '@remote-agent/runtime'
import type {
  AttachLocalRuntimeOptions,
  LocalRuntimeAttachment,
  RegisterLocalRuntimeOptions,
  RuntimeControlPlaneHost,
  RuntimeControlPlaneWorkspace,
} from '@remote-agent/runtime'
import { createSessionEvent, createSessionRecovery, createSessionSummary, type SessionEvent, type SessionRecovery, type SessionStatus, type SessionSummary } from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

export { createRuntimeProviderRegistry, RuntimeSessionManager } from '@remote-agent/runtime'
export type {
  AttachLocalRuntimeOptions,
  LocalRuntimeAttachment,
  LocalRuntimeRegistrationResult,
  RegisterLocalRuntimeOptions,
  RuntimeControlPlaneHost,
  RuntimeControlPlaneWorkspace,
} from '@remote-agent/runtime'

const actor: AuthenticatedActor = {
  id: 'user_desktop',
  kind: 'user',
  displayName: 'Desktop Operator',
  scopes: [
    'hosts:read',
    'workspaces:read',
    'sessions:read',
    'sessions:write',
    'approvals:read',
    'approvals:write',
    'ports:read',
  ],
}

const hostId = 'host_desktop' as HostId
const workspaceId = 'workspace_desktop' as WorkspaceId
const sessionId = 'session_desktop' as SessionId

export type DesktopClientHostRecord = RuntimeControlPlaneHost
export type DesktopClientWorkspaceRecord = RuntimeControlPlaneWorkspace
export type DesktopApprovalId = `approval_${string}`
export type DesktopApprovalStatus = 'pending' | 'approved' | 'rejected'
export type DesktopSessionAction = 'pause' | 'resume' | 'cancel'
export type DesktopWorkspaceSource = 'control-plane' | 'development-attach'

export interface DesktopClientApprovalRecord {
  id: DesktopApprovalId
  sessionId: SessionId
  action: string
  requestedBy: {
    id: string
    displayName: string
  }
  requestedAt: IsoTimestamp
  status: DesktopApprovalStatus
  decidedAt?: IsoTimestamp
  decidedBy?: {
    id: string
    displayName: string
  }
}

export interface DesktopClientDashboard {
  hosts: DesktopClientHostRecord[]
  workspaces: DesktopClientWorkspaceRecord[]
  sessions: SessionSummary[]
  approvals: DesktopClientApprovalRecord[]
  ports: ForwardedPort[]
  detectedPorts: DetectedPort[]
}

export interface DesktopControlPlaneEvent<TType extends string = string, TPayload = unknown>
  extends ProtocolEnvelope<TType, TPayload> {
  issuedAt: IsoTimestamp
}

export interface DesktopControlPlaneClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

export interface DesktopCreateSessionInput {
  id: SessionId
  hostId: HostId
  workspaceId: WorkspaceId
  provider: SessionSummary['provider']
  workspaceMode?: 'direct' | 'worktree'
  allowDirtyWorkspace?: boolean
}

export interface SessionRecoveryQuery {
  limit?: number
}

export interface DesktopWorkspaceTarget {
  id: string
  workspaceId: WorkspaceId
  hostId: HostId
  source: DesktopWorkspaceSource
  connectionMode: 'local' | 'remote'
  name: string
  path: string
  repositoryPath: string
  runtimeLabel: string
  activeSessionCount: number
  activeSessionIds: SessionId[]
  selected: boolean
}

export interface DesktopWorkspaceTargetOptions {
  dashboard?: DesktopClientDashboard
  localAttachments?: Array<Pick<LocalRuntimeAttachment, 'host' | 'workspace'>>
  selectedWorkspaceId?: WorkspaceId
}

interface JsonSuccessResponse<TData> {
  data: TData
}

interface JsonErrorResponse {
  error?: {
    code?: string
    message?: string
  }
}

interface ControlPlaneSnapshotPayload {
  hosts?: DesktopClientHostRecord[]
  workspaces?: DesktopClientWorkspaceRecord[]
  sessions?: SessionSummary[]
  approvals?: DesktopClientApprovalRecord[]
  ports?: ForwardedPort[]
  detectedPorts?: DetectedPort[]
}

/* eslint-disable no-unused-vars */
export interface DesktopControlPlaneClient {
  signIn: () => Promise<DesktopClientDashboard>
  createSession: (input: DesktopCreateSessionInput) => Promise<SessionSummary>
  applySessionAction: (sessionId: SessionId, action: DesktopSessionAction) => Promise<SessionSummary>
  listSessionEvents: (sessionId: SessionId) => Promise<SessionEvent[]>
  recoverSession: (sessionId: SessionId, query?: SessionRecoveryQuery) => Promise<SessionRecovery>
  decideApproval: (
    approvalId: DesktopApprovalId,
    status: Extract<DesktopApprovalStatus, 'approved' | 'rejected'>,
  ) => Promise<DesktopClientApprovalRecord>
  streamEvents: (options?: { signal?: AbortSignal }) => AsyncIterable<DesktopControlPlaneEvent>
}
/* eslint-enable no-unused-vars */

export class DesktopClientRequestError extends Error {
  readonly statusCode: number

  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

type DesktopRequestInit = globalThis.RequestInit
type DesktopHeadersInit = globalThis.HeadersInit

export function describeDesktopApp() {
  return createSurfaceSummary({
    manifest: createManifest(
      'desktop',
      'Desktop control surface for switching between remote control-plane workspaces and direct local runtime flows.',
      [
        '@remote-agent/protocol',
        '@remote-agent/auth',
        '@remote-agent/runtime',
        '@remote-agent/sessions',
        '@remote-agent/ports',
        '@remote-agent/providers',
        '@remote-agent/ui',
      ],
    ),
    actor: {
      displayName: actor.displayName,
    },
    sessions: [
      createSessionSummary({
        id: sessionId,
        hostId,
        workspaceId,
        provider: 'opencode',
        requestedBy: {
          id: actor.id,
          displayName: actor.displayName,
        },
        status: 'running',
        startedAt: '2026-03-16T00:00:00.000Z',
      }),
    ],
    ports: [
      createForwardedPort({
        id: 'port_desktop_preview',
        hostId,
        workspaceId,
        sessionId,
        localPort: 6006,
        targetPort: 6006,
        protocol: 'http',
        visibility: 'shared',
        label: 'Desktop preview',
        managedUrl: 'http://shared-port_desktop_preview.ports.remote-agent.local',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Workspaces', href: '/workspaces', badgeTone: 'info' },
      { label: 'Local Runtime', href: '/local', badgeTone: 'warning' },
      { label: 'Sessions', href: '/sessions', badgeTone: 'success' },
    ],
  })
}

export function createDesktopControlPlaneClient(options: DesktopControlPlaneClientOptions): DesktopControlPlaneClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch

  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required to use the desktop control-plane client.')
  }

  const request = async <TData>(path: string, init: DesktopRequestInit = {}) => {
    const response = await fetchImplementation(toAbsoluteUrl(options.baseUrl, path), {
      ...init,
      headers: mergeHeaders(init.headers, {
        authorization: `Bearer ${options.token}`,
      }),
    })

    if (!response.ok) {
      throw await toDesktopClientRequestError(response)
    }

    return (await response.json()) as JsonSuccessResponse<TData>
  }

  return {
    signIn: async () => {
      const [hosts, workspaces, sessions, approvals, ports, detectedPorts] = await Promise.all([
        request<DesktopClientHostRecord[]>('/v1/hosts'),
        request<DesktopClientWorkspaceRecord[]>('/v1/workspaces'),
        request<SessionSummary[]>('/v1/sessions'),
        request<DesktopClientApprovalRecord[]>('/v1/approvals'),
        request<ForwardedPort[]>('/v1/ports'),
        request<DetectedPort[]>('/v1/detected-ports'),
      ])

      return {
        hosts: cloneHosts(hosts.data),
        workspaces: cloneWorkspaces(workspaces.data),
        sessions: cloneSessions(sessions.data),
        approvals: cloneApprovals(approvals.data),
        ports: clonePorts(ports.data),
        detectedPorts: cloneDetectedPorts(detectedPorts.data),
      }
    },
    createSession: async (input) => {
      const response = await request<SessionSummary>('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: {
          'content-type': 'application/json',
        },
      })

      return createSessionSummary(response.data)
    },
    applySessionAction: async (sessionIdToUpdate, action) => {
      const response = await request<SessionSummary>(`/v1/sessions/${sessionIdToUpdate}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
        headers: {
          'content-type': 'application/json',
        },
      })

      return createSessionSummary(response.data)
    },
    listSessionEvents: async (sessionIdToRead) => {
      const response = await request<SessionEvent[]>(`/v1/sessions/${sessionIdToRead}/events`)
      return response.data.map((event) => createSessionEvent(event))
    },
    recoverSession: async (sessionIdToRead, query = {}) => {
      const response = await request<SessionRecovery>(
        withQuery(`/v1/sessions/${sessionIdToRead}/recovery`, {
          limit: query.limit,
        }),
      )
      return createSessionRecovery(response.data)
    },
    decideApproval: async (approvalId, status) => {
      const response = await request<DesktopClientApprovalRecord>(`/v1/approvals/${approvalId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        headers: {
          'content-type': 'application/json',
        },
      })

      return cloneApproval(response.data)
    },
    streamEvents: (streamOptions = {}) =>
      streamControlPlaneEvents({
        baseUrl: options.baseUrl,
        token: options.token,
        fetchImplementation,
        signal: streamOptions.signal,
      }),
  }
}

export async function attachDesktopLocalRuntime(options: AttachLocalRuntimeOptions) {
  return await attachLocalRuntime(options)
}

export async function registerDesktopLocalRuntime(options: RegisterLocalRuntimeOptions) {
  return await registerLocalRuntime(options)
}

export function parseControlPlaneSseFrame(frame: string): DesktopControlPlaneEvent | undefined {
  const lines = frame.split('\n')
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim()
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())

  if (!eventName || dataLines.length === 0) {
    return undefined
  }

  return JSON.parse(dataLines.join('\n')) as DesktopControlPlaneEvent
}

export function applyDesktopControlPlaneEvent(
  current: DesktopClientDashboard | undefined,
  event: DesktopControlPlaneEvent,
): DesktopClientDashboard | undefined {
  if (event.type === 'control-plane.snapshot') {
    return toDesktopDashboard(event.payload as ControlPlaneSnapshotPayload)
  }

  if (!current) {
    return current
  }

  if (event.type === 'session.upserted' || event.type === 'session.updated') {
    const session = (event.payload as { session?: SessionSummary }).session

    if (!session) {
      return current
    }

    return {
      ...current,
      sessions: upsertById(current.sessions, createSessionSummary(session)),
    }
  }

  if (event.type === 'session.event.created') {
    const sessionEvent = (event.payload as { sessionEvent?: SessionEvent }).sessionEvent

    if (!sessionEvent?.status) {
      return current
    }

    return {
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === sessionEvent.sessionId
          ? createSessionSummary({
              ...session,
              status: sessionEvent.status as SessionStatus,
            })
          : session,
      ),
    }
  }

  if (event.type === 'approval.requested' || event.type === 'approval.decided') {
    const approval = (event.payload as { approval?: DesktopClientApprovalRecord }).approval

    if (!approval) {
      return current
    }

    return {
      ...current,
      approvals: upsertById(current.approvals, cloneApproval(approval)),
    }
  }

  if (event.type === 'port.forwarded' || event.type === 'port.updated') {
    const port = (event.payload as { port?: ForwardedPort }).port

    if (!port) {
      return current
    }

    return {
      ...current,
      ports: upsertById(current.ports, createForwardedPort(port)),
    }
  }

  if (event.type === 'detected-port.upserted') {
    const detectedPort = (event.payload as { detectedPort?: DetectedPort }).detectedPort

    if (!detectedPort) {
      return current
    }

    return {
      ...current,
      detectedPorts: upsertById(current.detectedPorts, createDetectedPort(detectedPort)),
    }
  }

  if (event.type === 'detected-port.promoted') {
    const { detectedPort, forwardedPort } = event.payload as {
      detectedPort?: DetectedPort
      forwardedPort?: ForwardedPort
    }

    if (!detectedPort || !forwardedPort) {
      return current
    }

    return {
      ...current,
      detectedPorts: upsertById(current.detectedPorts, createDetectedPort(detectedPort)),
      ports: upsertById(current.ports, createForwardedPort(forwardedPort)),
    }
  }

  return current
}

export function buildDesktopWorkspaceTargets(options: DesktopWorkspaceTargetOptions): DesktopWorkspaceTarget[] {
  const dashboard = options.dashboard
  const activeSessionIdsByWorkspace = new Map<WorkspaceId, SessionId[]>()

  for (const session of dashboard?.sessions ?? []) {
    const activeSessionIds = activeSessionIdsByWorkspace.get(session.workspaceId) ?? []
    activeSessionIds.push(session.id)
    activeSessionIdsByWorkspace.set(session.workspaceId, activeSessionIds)
  }

  const targets: DesktopWorkspaceTarget[] = [
    ...(dashboard?.workspaces ?? []).map((workspace) =>
      createDesktopWorkspaceTarget({
        hostId: workspace.hostId,
        workspaceId: workspace.id,
        source: 'control-plane',
        connectionMode: workspace.hostConnectionMode,
        name: workspace.name,
        path: workspace.path,
        repositoryPath: workspace.repositoryPath,
        runtimeLabel: workspace.runtimeLabel,
        selectedWorkspaceId: options.selectedWorkspaceId,
        activeSessionIds: activeSessionIdsByWorkspace.get(workspace.id) ?? [],
      }),
    ),
    ...(options.localAttachments ?? []).map((attachment) =>
      createDesktopWorkspaceTarget({
        hostId: attachment.host.id,
        workspaceId: attachment.workspace.id,
        source: 'development-attach',
        connectionMode: attachment.workspace.hostConnectionMode,
        name: attachment.workspace.name,
        path: attachment.workspace.path,
        repositoryPath: attachment.workspace.repositoryPath,
        runtimeLabel: attachment.workspace.runtimeLabel,
        selectedWorkspaceId: options.selectedWorkspaceId,
        activeSessionIds: activeSessionIdsByWorkspace.get(attachment.workspace.id) ?? [],
      }),
    ),
  ]

  return targets.sort((left, right) => {
    if (left.connectionMode !== right.connectionMode) {
      return left.connectionMode === 'local' ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })
}

function createDesktopWorkspaceTarget(options: {
  hostId: HostId
  workspaceId: WorkspaceId
  source: DesktopWorkspaceSource
  connectionMode: 'local' | 'remote'
  name: string
  path: string
  repositoryPath: string
  runtimeLabel: string
  selectedWorkspaceId?: WorkspaceId
  activeSessionIds: SessionId[]
}): DesktopWorkspaceTarget {
  return {
    id: `${options.source}:${options.workspaceId}`,
    workspaceId: options.workspaceId,
    hostId: options.hostId,
    source: options.source,
    connectionMode: options.connectionMode,
    name: options.name,
    path: options.path,
    repositoryPath: options.repositoryPath,
    runtimeLabel: options.runtimeLabel,
    activeSessionCount: options.activeSessionIds.length,
    activeSessionIds: [...options.activeSessionIds],
    selected: options.selectedWorkspaceId === options.workspaceId,
  }
}

function withQuery(path: string, query: Record<string, string | number | undefined>) {
  const url = new URL(path, 'http://127.0.0.1')

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }

  return `${url.pathname}${url.search}`
}

function mergeHeaders(first: DesktopHeadersInit | undefined, second: DesktopHeadersInit | undefined) {
  const headers = new Headers(first)

  if (second) {
    for (const [key, value] of new Headers(second).entries()) {
      headers.set(key, value)
    }
  }

  return headers
}

function toAbsoluteUrl(baseUrl: string, path: string) {
  return new URL(path, ensureTrailingSlash(baseUrl)).toString()
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`
}

async function toDesktopClientRequestError(response: Response) {
  let message = `Request failed with status ${response.status}.`
  let code = 'request_failed'

  try {
    const payload = (await response.json()) as JsonErrorResponse
    message = payload.error?.message ?? message
    code = payload.error?.code ?? code
  } catch {
    // Fall back to the default error.
  }

  return new DesktopClientRequestError(response.status, code, message)
}

async function* streamControlPlaneEvents(options: {
  baseUrl: string
  token: string
  fetchImplementation: typeof globalThis.fetch
  signal?: AbortSignal
}): AsyncIterable<DesktopControlPlaneEvent> {
  const response = await options.fetchImplementation(toAbsoluteUrl(options.baseUrl, '/v1/events'), {
    headers: {
      authorization: `Bearer ${options.token}`,
    },
    signal: options.signal,
  })

  if (!response.ok) {
    throw await toDesktopClientRequestError(response)
  }

  if (!response.body) {
    throw new Error('The control-plane event stream did not provide a readable body.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      let done = false
      let value: Uint8Array | undefined

      try {
        const nextChunk = await reader.read()
        done = nextChunk.done
        value = nextChunk.value
      } catch (error) {
        if (isAbortError(error)) {
          break
        }

        throw error
      }

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      while (buffer.includes('\n\n')) {
        const boundaryIndex = buffer.indexOf('\n\n')
        const frame = buffer.slice(0, boundaryIndex)
        buffer = buffer.slice(boundaryIndex + 2)

        const event = parseControlPlaneSseFrame(frame)

        if (event) {
          yield event
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError'
}

function toDesktopDashboard(payload: ControlPlaneSnapshotPayload): DesktopClientDashboard {
  return {
    hosts: cloneHosts(payload.hosts ?? []),
    workspaces: cloneWorkspaces(payload.workspaces ?? []),
    sessions: cloneSessions(payload.sessions ?? []),
    approvals: cloneApprovals(payload.approvals ?? []),
    ports: clonePorts(payload.ports ?? []),
    detectedPorts: cloneDetectedPorts(payload.detectedPorts ?? []),
  }
}

function cloneHosts(hosts: DesktopClientHostRecord[]) {
  return hosts.map((host) => ({
    ...host,
    runtime: host.runtime ? { ...host.runtime } : undefined,
  }))
}

function cloneWorkspaces(workspaces: DesktopClientWorkspaceRecord[]) {
  return workspaces.map((workspace) => ({
    ...workspace,
    runtimeAssociation: { ...workspace.runtimeAssociation },
  }))
}

function cloneSessions(sessions: SessionSummary[]) {
  return sessions.map((session) => createSessionSummary(session))
}

function cloneApprovals(approvals: DesktopClientApprovalRecord[]) {
  return approvals.map(cloneApproval)
}

function cloneApproval(approval: DesktopClientApprovalRecord) {
  return {
    ...approval,
    requestedBy: { ...approval.requestedBy },
    decidedBy: approval.decidedBy ? { ...approval.decidedBy } : undefined,
  }
}

function clonePorts(ports: ForwardedPort[]) {
  return ports.map((port) => createForwardedPort(port))
}

function cloneDetectedPorts(ports: DetectedPort[]) {
  return ports.map((port) => createDetectedPort(port))
}

function upsertById<TRecord extends { id: string }>(records: TRecord[], nextRecord: TRecord) {
  const nextRecords = [...records]
  const currentIndex = nextRecords.findIndex((record) => record.id === nextRecord.id)

  if (currentIndex === -1) {
    nextRecords.push(nextRecord)
    return nextRecords
  }

  nextRecords[currentIndex] = nextRecord
  return nextRecords
}
