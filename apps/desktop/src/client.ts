import type {
  ProviderApprovalRecord,
} from '@remote-agent-server/providers'
import type {
  ControlPlaneEventRecord,
  DesktopConnectionSettings,
  DesktopControlPlaneClient,
  EventStreamHandle,
  ForwardedPortRecord,
  HostRecord,
  SessionControlAction,
  SessionRecord,
  WorkspaceRecord,
} from './types.js'

interface EventConnector {
  connect(
    settings: DesktopConnectionSettings,
    listener: (event: ControlPlaneEventRecord) => void,
    lastEventId?: string,
  ): EventStreamHandle
}

export interface DesktopControlPlaneClientOptions
  extends DesktopConnectionSettings {
  eventConnector?: EventConnector
  fetch?: typeof fetch
}

interface RequestOptions {
  body?: unknown
  method?: 'GET' | 'POST'
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function createAuthorizedHeaders(token: string) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
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
  settings: DesktopConnectionSettings,
  path: string,
  options: RequestOptions,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(`${normalizeBaseUrl(settings.baseUrl)}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      ...createAuthorizedHeaders(settings.token),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method: options.method ?? 'GET',
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

function createFetchEventConnector(fetchImpl: typeof fetch): EventConnector {
  return {
    connect(settings, listener, lastEventId) {
      const controller = new AbortController()
      const done = (async () => {
        const response = await fetchImpl(
          `${normalizeBaseUrl(settings.baseUrl)}/api/events`,
          {
            headers: {
              ...createAuthorizedHeaders(settings.token),
              ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
            },
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

export function createDesktopControlPlaneClient(
  options: DesktopControlPlaneClientOptions,
): DesktopControlPlaneClient {
  const fetchImpl = options.fetch ?? fetch
  const settings = {
    baseUrl: options.baseUrl,
    token: options.token,
  } satisfies DesktopConnectionSettings
  const eventConnector =
    options.eventConnector ?? createFetchEventConnector(fetchImpl)

  return {
    async listApprovals() {
      return await requestJson<ProviderApprovalRecord[]>(
        settings,
        '/api/approvals',
        {},
        fetchImpl,
      )
    },
    async listHosts() {
      return await requestJson<HostRecord[]>(settings, '/api/hosts', {}, fetchImpl)
    },
    async listPorts() {
      return await requestJson<ForwardedPortRecord[]>(
        settings,
        '/api/ports?includeInactive=true',
        {},
        fetchImpl,
      )
    },
    async listSessions() {
      return await requestJson<SessionRecord[]>(
        settings,
        '/api/sessions',
        {},
        fetchImpl,
      )
    },
    async listWorkspaces() {
      return await requestJson<WorkspaceRecord[]>(
        settings,
        '/api/workspaces',
        {},
        fetchImpl,
      )
    },
    connectEvents(listener, lastEventId) {
      return eventConnector.connect(settings, listener, lastEventId)
    },
    async controlSession(sessionId, action) {
      return await requestJson<SessionRecord>(
        settings,
        `/api/sessions/${sessionId}/${action satisfies SessionControlAction}`,
        {
          method: 'POST',
        },
        fetchImpl,
      )
    },
    async decideApproval(approvalId, status) {
      return await requestJson<ProviderApprovalRecord>(
        settings,
        `/api/approvals/${approvalId}/decision`,
        {
          body: {
            status,
          },
          method: 'POST',
        },
        fetchImpl,
      )
    },
    async startSession(request) {
      return await requestJson<SessionRecord>(
        settings,
        '/api/sessions',
        {
          body: request,
          method: 'POST',
        },
        fetchImpl,
      )
    },
  }
}

export type { EventConnector }
