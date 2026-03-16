import type { AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort, type ForwardedPort } from '@remote-agent/ports'
import {
  createManifest,
  type HostId,
  type IsoTimestamp,
  type ProtocolEnvelope,
  type RuntimeConnectivityStatus,
  type RuntimeHealthStatus,
  type RuntimeId,
  type SessionId,
  type WorkspaceId,
} from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary, type SessionEvent, type SessionStatus, type SessionSummary } from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

const actor: AuthenticatedActor = {
  id: 'user_mobile',
  kind: 'user',
  displayName: 'Mobile Operator',
  scopes: ['hosts:read', 'workspaces:read', 'sessions:read', 'approvals:read', 'approvals:write', 'ports:read'],
}

const hostId = 'host_mobile' as HostId
const workspaceId = 'workspace_mobile' as WorkspaceId
const sessionId = 'session_mobile' as SessionId

export type MobileHostPlatform = 'linux' | 'macos' | 'windows'
export type MobileHostRuntimeStatus = 'online' | 'offline' | 'degraded'
export type MobileApprovalId = `approval_${string}`
export type MobileApprovalStatus = 'pending' | 'approved' | 'rejected'
export type MobileBrowseTarget = 'hosts' | 'sessions'
export type MobilePreviewOpenMode = 'in-app' | 'system'

export interface MobileClientHostRecord {
  id: HostId
  label: string
  platform: MobileHostPlatform
  runtimeStatus: MobileHostRuntimeStatus
  enrolledAt: IsoTimestamp
  lastSeenAt: IsoTimestamp
  runtime?: {
    runtimeId: RuntimeId
    label: string
    version: string
    health: RuntimeHealthStatus
    connectivity: RuntimeConnectivityStatus
    enrolledAt: IsoTimestamp
    reportedAt: IsoTimestamp
    enrollmentMethod: 'bootstrap-token'
  }
}

export interface MobileClientWorkspaceRecord {
  id: WorkspaceId
  hostId: HostId
  name: string
  path: string
  repositoryPath: string
  defaultBranch: string
  runtimeLabel: string
  runtimeAssociation: {
    hostId: HostId
    runtimeId?: RuntimeId
    label: string
  }
}

export interface MobileClientApprovalRecord {
  id: MobileApprovalId
  sessionId: SessionId
  action: string
  requestedBy: {
    id: string
    displayName: string
  }
  requestedAt: IsoTimestamp
  status: MobileApprovalStatus
  decidedAt?: IsoTimestamp
  decidedBy?: {
    id: string
    displayName: string
  }
}

export interface MobileClientDashboard {
  hosts: MobileClientHostRecord[]
  workspaces: MobileClientWorkspaceRecord[]
  sessions: SessionSummary[]
  approvals: MobileClientApprovalRecord[]
  ports: ForwardedPort[]
}

export interface MobileControlPlaneEvent<TType extends string = string, TPayload = unknown>
  extends ProtocolEnvelope<TType, TPayload> {
  issuedAt: IsoTimestamp
}

export interface MobileBrowseItem {
  id: string
  title: string
  subtitle: string
  detail: string
  badge: string
}

export interface MobileControlPlaneClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
  previewOpeners?: MobilePreviewOpeners
}

/* eslint-disable no-unused-vars */
export interface MobilePreviewOpeners {
  openInAppBrowser(url: string): Promise<unknown>
  openSystemBrowser(url: string): Promise<unknown>
}
/* eslint-enable no-unused-vars */

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
  hosts?: MobileClientHostRecord[]
  workspaces?: MobileClientWorkspaceRecord[]
  sessions?: SessionSummary[]
  approvals?: MobileClientApprovalRecord[]
  ports?: ForwardedPort[]
}

/* eslint-disable no-unused-vars */
export interface MobileControlPlaneClient {
  signIn: () => Promise<MobileClientDashboard>
  listSessionEvents: (sessionId: SessionId) => Promise<SessionEvent[]>
  decideApproval: (
    approvalId: MobileApprovalId,
    status: Extract<MobileApprovalStatus, 'approved' | 'rejected'>,
  ) => Promise<MobileClientApprovalRecord>
  streamEvents: (options?: { signal?: AbortSignal }) => AsyncIterable<MobileControlPlaneEvent>
  openForwardedPreview: (
    port: Pick<ForwardedPort, 'status' | 'protocol' | 'managedUrl'>,
    options?: {
      mode?: MobilePreviewOpenMode
      previewOpeners?: MobilePreviewOpeners
    },
  ) => Promise<string>
}
/* eslint-enable no-unused-vars */

export class MobileClientRequestError extends Error {
  readonly statusCode: number

  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

type MobileRequestInit = globalThis.RequestInit
type MobileHeadersInit = globalThis.HeadersInit

export function describeMobileApp() {
  return createSurfaceSummary({
    manifest: createManifest('mobile', 'Expo and React Native control surface for mobile session supervision.', [
      '@remote-agent/protocol',
      '@remote-agent/auth',
      '@remote-agent/sessions',
      '@remote-agent/ports',
      '@remote-agent/providers',
      '@remote-agent/ui',
    ]),
    actor: {
      displayName: actor.displayName,
    },
    sessions: [
      createSessionSummary({
        id: sessionId,
        hostId,
        workspaceId,
        provider: 'claude-code',
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
        id: 'port_mobile_preview',
        hostId,
        workspaceId,
        sessionId,
        localPort: 8081,
        targetPort: 8081,
        protocol: 'http',
        visibility: 'shared',
        label: 'Mobile preview',
        managedUrl: 'http://shared-port_mobile_preview.ports.remote-agent.local',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Hosts', href: '/hosts', badgeTone: 'info' },
      { label: 'Sessions', href: '/sessions', badgeTone: 'info' },
      { label: 'Approvals', href: '/approvals', badgeTone: 'warning' },
      { label: 'Previews', href: '/previews', badgeTone: 'success' },
    ],
  })
}

export function createMobileControlPlaneClient(options: MobileControlPlaneClientOptions): MobileControlPlaneClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch

  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required to use the mobile control-plane client.')
  }

  const request = async <TData>(path: string, init: MobileRequestInit = {}) => {
    const response = await fetchImplementation(toAbsoluteUrl(options.baseUrl, path), {
      ...init,
      headers: mergeHeaders(init.headers, {
        authorization: `Bearer ${options.token}`,
      }),
    })

    if (!response.ok) {
      throw await toMobileClientRequestError(response)
    }

    return (await response.json()) as JsonSuccessResponse<TData>
  }

  return {
    signIn: async () => {
      const [hosts, workspaces, sessions, approvals, ports] = await Promise.all([
        request<MobileClientHostRecord[]>('/v1/hosts'),
        request<MobileClientWorkspaceRecord[]>('/v1/workspaces'),
        request<SessionSummary[]>('/v1/sessions'),
        request<MobileClientApprovalRecord[]>('/v1/approvals'),
        request<ForwardedPort[]>('/v1/ports'),
      ])

      return {
        hosts: cloneHosts(hosts.data),
        workspaces: cloneWorkspaces(workspaces.data),
        sessions: cloneSessions(sessions.data),
        approvals: cloneApprovals(approvals.data),
        ports: clonePorts(ports.data),
      }
    },
    listSessionEvents: async (sessionIdToRead) => {
      const response = await request<SessionEvent[]>(`/v1/sessions/${sessionIdToRead}/events`)
      return response.data.map((event) => ({ ...event }))
    },
    decideApproval: async (approvalId, status) => {
      const response = await request<MobileClientApprovalRecord>(`/v1/approvals/${approvalId}`, {
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
    openForwardedPreview: async (port, previewOptions = {}) => {
      const previewOpeners = previewOptions.previewOpeners ?? options.previewOpeners
      return openForwardedPreview(port, previewOptions.mode ?? 'in-app', previewOpeners)
    },
  }
}

export function parseControlPlaneSseFrame(frame: string): MobileControlPlaneEvent | undefined {
  const lines = frame.split('\n')
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim()
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())

  if (!eventName || dataLines.length === 0) {
    return undefined
  }

  return JSON.parse(dataLines.join('\n')) as MobileControlPlaneEvent
}

export function resolveForwardedPreviewUrl(port: Pick<ForwardedPort, 'status' | 'protocol' | 'managedUrl'>) {
  if (port.status !== 'open') {
    return undefined
  }

  if ((port.protocol === 'http' || port.protocol === 'https') && port.managedUrl) {
    return port.managedUrl
  }

  return undefined
}

export async function openForwardedPreview(
  port: Pick<ForwardedPort, 'status' | 'protocol' | 'managedUrl'>,
  mode: MobilePreviewOpenMode,
  previewOpeners?: MobilePreviewOpeners,
) {
  const url = resolveForwardedPreviewUrl(port)

  if (!url) {
    throw new Error('Only open forwarded HTTP previews with a managed URL can be opened from the mobile app.')
  }

  if (!previewOpeners) {
    throw new Error('Preview openers are required to open a forwarded preview from the mobile app.')
  }

  if (mode === 'system') {
    await previewOpeners.openSystemBrowser(url)
  } else {
    await previewOpeners.openInAppBrowser(url)
  }

  return url
}

export function applyMobileControlPlaneEvent(
  current: MobileClientDashboard | undefined,
  event: MobileControlPlaneEvent,
): MobileClientDashboard | undefined {
  if (event.type === 'control-plane.snapshot') {
    return toMobileDashboard(event.payload as ControlPlaneSnapshotPayload)
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
    const approval = (event.payload as { approval?: MobileClientApprovalRecord }).approval

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

  return current
}

export function buildMobileBrowseItems(dashboard: MobileClientDashboard, target: MobileBrowseTarget): MobileBrowseItem[] {
  if (target === 'hosts') {
    return dashboard.hosts.map((host) => ({
      id: host.id,
      title: host.label,
      subtitle: `${host.platform} host`,
      detail: host.runtime ? `${host.runtime.version} • ${host.runtime.health}` : host.runtimeStatus,
      badge: host.runtimeStatus,
    }))
  }

  const workspaceById = new Map(dashboard.workspaces.map((workspace) => [workspace.id, workspace]))

  return dashboard.sessions.map((session) => {
    const workspace = workspaceById.get(session.workspaceId)

    return {
      id: session.id,
      title: session.id,
      subtitle: `${session.provider} on ${workspace?.name ?? session.workspaceId}`,
      detail: workspace?.path ?? session.workspace?.path ?? session.workspaceId,
      badge: session.status,
    }
  })
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

function mergeHeaders(first: MobileHeadersInit | undefined, second: MobileHeadersInit | undefined) {
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

async function toMobileClientRequestError(response: Response) {
  let message = `Request failed with status ${response.status}.`
  let code = 'request_failed'

  try {
    const payload = (await response.json()) as JsonErrorResponse
    message = payload.error?.message ?? message
    code = payload.error?.code ?? code
  } catch {
    // Fall back to the default error.
  }

  return new MobileClientRequestError(response.status, code, message)
}

async function* streamControlPlaneEvents(options: {
  baseUrl: string
  token: string
  fetchImplementation: typeof globalThis.fetch
  signal?: AbortSignal
}): AsyncIterable<MobileControlPlaneEvent> {
  const response = await options.fetchImplementation(toAbsoluteUrl(options.baseUrl, withQuery('/v1/events', {})), {
    headers: {
      authorization: `Bearer ${options.token}`,
    },
    signal: options.signal,
  })

  if (!response.ok) {
    throw await toMobileClientRequestError(response)
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

function toMobileDashboard(payload: ControlPlaneSnapshotPayload): MobileClientDashboard {
  return {
    hosts: cloneHosts(payload.hosts ?? []),
    workspaces: cloneWorkspaces(payload.workspaces ?? []),
    sessions: cloneSessions(payload.sessions ?? []),
    approvals: cloneApprovals(payload.approvals ?? []),
    ports: clonePorts(payload.ports ?? []),
  }
}

function cloneHosts(hosts: MobileClientHostRecord[]) {
  return hosts.map((host) => ({
    ...host,
    runtime: host.runtime ? { ...host.runtime } : undefined,
  }))
}

function cloneWorkspaces(workspaces: MobileClientWorkspaceRecord[]) {
  return workspaces.map((workspace) => ({
    ...workspace,
    runtimeAssociation: { ...workspace.runtimeAssociation },
  }))
}

function cloneSessions(sessions: SessionSummary[]) {
  return sessions.map((session) => createSessionSummary(session))
}

function cloneApprovals(approvals: MobileClientApprovalRecord[]) {
  return approvals.map(cloneApproval)
}

function cloneApproval(approval: MobileClientApprovalRecord) {
  return {
    ...approval,
    requestedBy: { ...approval.requestedBy },
    decidedBy: approval.decidedBy ? { ...approval.decidedBy } : undefined,
  }
}

function clonePorts(ports: ForwardedPort[]) {
  return ports.map((port) => createForwardedPort(port))
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
