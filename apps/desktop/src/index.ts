import type { AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionRecovery, createSessionSummary, type SessionRecovery, type SessionSummary } from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

const actor: AuthenticatedActor = {
  id: 'user_desktop',
  kind: 'user',
  displayName: 'Desktop Operator',
  scopes: ['hosts:read', 'sessions:read', 'sessions:write', 'ports:read'],
}

const hostId = 'host_desktop' as HostId
const workspaceId = 'workspace_desktop' as WorkspaceId
const sessionId = 'session_desktop' as SessionId

export interface DesktopClientDashboard {
  sessions: SessionSummary[]
}

export interface DesktopControlPlaneClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

export interface SessionRecoveryQuery {
  limit?: number
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

/* eslint-disable no-unused-vars */
export interface DesktopControlPlaneClient {
  signIn: () => Promise<DesktopClientDashboard>
  recoverSession: (sessionId: SessionId, query?: SessionRecoveryQuery) => Promise<SessionRecovery>
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
    manifest: createManifest('desktop', 'Desktop client scaffolded in the monorepo.', [
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
        provider: 'opencode',
        requestedBy: {
          id: actor.id,
          displayName: actor.displayName,
        },
        status: 'completed',
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
        visibility: 'shared',
        label: 'Desktop preview',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Workspaces', href: '/workspaces', badgeTone: 'neutral' },
      { label: 'Diffs', href: '/diffs', badgeTone: 'success' },
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
      const response = await request<SessionSummary[]>('/v1/sessions')
      return {
        sessions: response.data.map((session) => createSessionSummary(session)),
      }
    },
    recoverSession: async (sessionIdToRead, query = {}) => {
      const response = await request<SessionRecovery>(
        withQuery(`/v1/sessions/${sessionIdToRead}/recovery`, {
          limit: query.limit,
        }),
      )
      return createSessionRecovery(response.data)
    },
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
