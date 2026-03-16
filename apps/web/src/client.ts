import type { ProviderApprovalRecord, ProviderApprovalStatus, ProviderKind } from '@remote-agent-server/providers'
import type { ManagedPort } from '@remote-agent-server/ports'
import type { ProtocolEnvelope } from '@remote-agent-server/protocol'
import type {
  SessionChangeSet,
  SessionDescriptor,
  SessionDiffPage,
  SessionLogEntry,
  SessionOutputEntry,
  SessionWorktreeMetadata,
} from '@remote-agent-server/sessions'

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

export interface SessionDiffRequest {
  path?: string
  page?: number
  pageSize?: number
}

export interface PortListRequest {
  hostId?: string
  workspaceId?: string
  sessionId?: string
  includeInactive?: boolean
  includeDetected?: boolean
}

export interface SessionReviewClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

export interface SessionReviewClient {
  listChangedFiles(sessionId: string): Promise<SessionChangeSet>
  viewDiff(sessionId: string, request?: SessionDiffRequest): Promise<SessionDiffPage>
}

export interface ApprovalClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

export interface ApprovalClient {
  listApprovals(): Promise<ProviderApprovalRecord[]>
  decideApproval(
    approvalId: string,
    status: Extract<ProviderApprovalStatus, 'approved' | 'rejected'>,
  ): Promise<ProviderApprovalRecord>
}

export interface ControlPlaneEventRecord<TPayload = unknown> {
  id: string
  timestamp: string
  envelope: ProtocolEnvelope<TPayload>
}

export interface ControlPlaneClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

export interface ControlPlaneClient {
  listHosts(): Promise<HostRecord[]>
  listWorkspaces(): Promise<WorkspaceRecord[]>
  listSessions(): Promise<SessionRecord[]>
  listApprovals(): Promise<ProviderApprovalRecord[]>
  listPorts(request?: PortListRequest): Promise<ForwardedPortRecord[]>
  listChangedFiles(sessionId: string): Promise<SessionChangeSet>
  viewDiff(sessionId: string, request?: SessionDiffRequest): Promise<SessionDiffPage>
  decideApproval(
    approvalId: string,
    status: Extract<ProviderApprovalStatus, 'approved' | 'rejected'>,
  ): Promise<ProviderApprovalRecord>
  connectEvents(listener: (event: ControlPlaneEventRecord) => void, lastEventId?: string): EventStreamHandle
}

export interface EventStreamHandle {
  close(): void
  done: Promise<void>
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

const providerLabels: Record<ProviderKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function createAuthorizedHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  }
}

async function readResponseJson<T>(response: Response) {
  const payload = (await response.json()) as { data?: T; error?: string }
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}.`)
  }

  return payload.data
}

async function requestJson<T>(
  baseUrl: string,
  token: string,
  path: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...createAuthorizedHeaders(token),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  return await readResponseJson<T>(response)
}

function parseEventBlock(block: string) {
  const lines = block.split('\n')
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) {
    return undefined
  }

  return JSON.parse(dataLines.join('\n')) as ControlPlaneEventRecord
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  listener: (event: ControlPlaneEventRecord) => void,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')

    let separatorIndex = buffer.indexOf('\n\n')
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex).trim()
      buffer = buffer.slice(separatorIndex + 2)

      if (block.length > 0) {
        const parsed = parseEventBlock(block)
        if (parsed) {
          listener(parsed)
        }
      }

      separatorIndex = buffer.indexOf('\n\n')
    }

    if (done) {
      const trailingBlock = buffer.trim()
      if (trailingBlock.length > 0) {
        const parsed = parseEventBlock(trailingBlock)
        if (parsed) {
          listener(parsed)
        }
      }
      return
    }
  }
}

export function createSessionReviewClient(
  options: SessionReviewClientOptions,
): SessionReviewClient {
  const client = createControlPlaneClient(options)

  return {
    async listChangedFiles(sessionId) {
      return await client.listChangedFiles(sessionId)
    },
    async viewDiff(sessionId, request = {}) {
      return await client.viewDiff(sessionId, request)
    },
  }
}

export function createApprovalClient(options: ApprovalClientOptions): ApprovalClient {
  const client = createControlPlaneClient(options)

  return {
    async listApprovals() {
      return await client.listApprovals()
    },
    async decideApproval(approvalId, status) {
      return await client.decideApproval(approvalId, status)
    },
  }
}

export function createControlPlaneClient(
  options: ControlPlaneClientOptions,
): ControlPlaneClient {
  const fetchImpl = options.fetch ?? fetch

  return {
    async listHosts() {
      return await requestJson<HostRecord[]>(
        options.baseUrl,
        options.token,
        '/api/hosts',
        {},
        fetchImpl,
      )
    },
    async listWorkspaces() {
      return await requestJson<WorkspaceRecord[]>(
        options.baseUrl,
        options.token,
        '/api/workspaces',
        {},
        fetchImpl,
      )
    },
    async listSessions() {
      return await requestJson<SessionRecord[]>(
        options.baseUrl,
        options.token,
        '/api/sessions',
        {},
        fetchImpl,
      )
    },
    async listApprovals() {
      return await requestJson<ProviderApprovalRecord[]>(
        options.baseUrl,
        options.token,
        '/api/approvals',
        {},
        fetchImpl,
      )
    },
    async listPorts(request = {}) {
      const url = new URL(`${normalizeBaseUrl(options.baseUrl)}/api/ports`)
      if (request.hostId) {
        url.searchParams.set('hostId', request.hostId)
      }
      if (request.workspaceId) {
        url.searchParams.set('workspaceId', request.workspaceId)
      }
      if (request.sessionId) {
        url.searchParams.set('sessionId', request.sessionId)
      }
      if (request.includeInactive) {
        url.searchParams.set('includeInactive', 'true')
      }
      if (request.includeDetected) {
        url.searchParams.set('includeDetected', 'true')
      }

      const response = await fetchImpl(url, {
        headers: createAuthorizedHeaders(options.token),
      })
      return await readResponseJson<ForwardedPortRecord[]>(response)
    },
    async listChangedFiles(sessionId) {
      return await requestJson<SessionChangeSet>(
        options.baseUrl,
        options.token,
        `/api/sessions/${sessionId}/changes`,
        {},
        fetchImpl,
      )
    },
    async viewDiff(sessionId, request = {}) {
      const url = new URL(`${normalizeBaseUrl(options.baseUrl)}/api/sessions/${sessionId}/diff`)
      if (request.path) {
        url.searchParams.set('path', request.path)
      }
      if (request.page !== undefined) {
        url.searchParams.set('page', String(request.page))
      }
      if (request.pageSize !== undefined) {
        url.searchParams.set('pageSize', String(request.pageSize))
      }

      const response = await fetchImpl(url, {
        headers: createAuthorizedHeaders(options.token),
      })
      return await readResponseJson<SessionDiffPage>(response)
    },
    async decideApproval(approvalId, status) {
      return await requestJson<ProviderApprovalRecord>(
        options.baseUrl,
        options.token,
        `/api/approvals/${approvalId}/decision`,
        {
          method: 'POST',
          body: { status },
        },
        fetchImpl,
      )
    },
    connectEvents(listener, lastEventId) {
      const controller = new AbortController()
      const done = (async () => {
        const headers = {
          ...createAuthorizedHeaders(options.token),
          ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        }
        const response = await fetchImpl(
          `${normalizeBaseUrl(options.baseUrl)}/api/events`,
          {
            headers,
            signal: controller.signal,
          },
        )

        if (!response.ok || !response.body) {
          throw new Error(
            `Event stream request failed with status ${response.status}.`,
          )
        }

        await readEventStream(response.body, listener)
      })()

      return {
        close() {
          controller.abort()
        },
        done,
      }
    },
  }
}

export function getProviderLabel(kind: ProviderKind) {
  return providerLabels[kind]
}
