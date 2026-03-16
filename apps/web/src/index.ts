import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, type ProviderDescriptor } from '@remote-agent-server/providers'
import {
  createSessionDescriptor,
  type SessionChangeSet,
  type SessionDescriptor,
  type SessionDiffPage,
} from '@remote-agent-server/sessions'
import { createNavigationItem, createStatusBadge, type NavigationItem, type StatusBadge } from '@remote-agent-server/ui'

export interface WebManifest {
  id: string
  kind: 'web'
  auth: AuthPolicy
  session: SessionDescriptor
  provider: ProviderDescriptor
  previewPort: ManagedPort
  nav: NavigationItem[]
  status: StatusBadge
  stream: ProtocolEnvelope<{ sessionId: string }>
}

export interface SessionDiffRequest {
  path?: string
  page?: number
  pageSize?: number
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

export function createSessionReviewClient(options: SessionReviewClientOptions): SessionReviewClient {
  const fetchImpl = options.fetch ?? fetch

  return {
    async listChangedFiles(sessionId) {
      const response = await fetchImpl(`${options.baseUrl}/api/sessions/${sessionId}/changes`, {
        headers: createAuthorizedHeaders(options.token),
      })
      return await readResponseJson<SessionChangeSet>(response)
    },
    async viewDiff(sessionId, request = {}) {
      const url = new URL(`${options.baseUrl}/api/sessions/${sessionId}/diff`)
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
  }
}

export function createWebManifest(): WebManifest {
  const provider = createProviderDescriptor('codex', 'codex')
  const session = createSessionDescriptor({
    id: 'web-session-1',
    workspaceId: 'workspace-browser',
    provider: provider.kind,
    state: 'running',
  })

  return {
    id: createWorkspacePackageId('web'),
    kind: 'web',
    auth: createAuthPolicy(['operator-token']),
    session,
    provider,
    previewPort: createManagedPort({
      id: 'web-preview',
      port: 3001,
      protocol: 'http',
      visibility: 'shared',
      state: 'forwarded',
    }),
    nav: [
      createNavigationItem('hosts', 'Hosts', '/hosts'),
      createNavigationItem('sessions', 'Sessions', '/sessions'),
    ],
    status: createStatusBadge('Connected', 'success'),
    stream: createProtocolEnvelope('session.stream', 'web', {
      sessionId: session.id,
    }),
  }
}
