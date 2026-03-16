import type { ProviderApprovalRecord } from '@remote-agent-server/providers'
import type {
  ControlPlaneEventRecord,
  EventStreamHandle,
  ForwardedPortRecord,
  HostRecord,
  MobileConnectionSettings,
  MobileControlPlaneClient,
  SessionRecord,
} from './types.js'

interface EventConnector {
  connect(
    settings: MobileConnectionSettings,
    listener: (event: ControlPlaneEventRecord) => void,
    lastEventId?: string,
  ): EventStreamHandle
}

export interface MobileControlPlaneClientOptions extends MobileConnectionSettings {
  fetch?: typeof fetch
  eventConnector?: EventConnector
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
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
  settings: MobileConnectionSettings,
  path: string,
  options: RequestOptions,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(`${normalizeBaseUrl(settings.baseUrl)}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...createAuthorizedHeaders(settings.token),
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

function withQuery(basePath: string, query: Record<string, string | undefined>) {
  const searchParams = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`)

  return searchParams.length === 0 ? basePath : `${basePath}?${searchParams.join('&')}`
}

export function createMobileControlPlaneClient(
  options: MobileControlPlaneClientOptions,
): MobileControlPlaneClient {
  const fetchImpl = options.fetch ?? fetch
  const settings = {
    baseUrl: options.baseUrl,
    token: options.token,
  } satisfies MobileConnectionSettings
  const eventConnector =
    options.eventConnector ?? createFetchEventConnector(fetchImpl)

  return {
    async listHosts() {
      return await requestJson<HostRecord[]>(settings, '/api/hosts', {}, fetchImpl)
    },
    async listSessions() {
      return await requestJson<SessionRecord[]>(
        settings,
        '/api/sessions',
        {},
        fetchImpl,
      )
    },
    async listApprovals() {
      return await requestJson<ProviderApprovalRecord[]>(
        settings,
        '/api/approvals',
        {},
        fetchImpl,
      )
    },
    async listPorts() {
      return await requestJson<ForwardedPortRecord[]>(
        settings,
        withQuery('/api/ports', { includeInactive: 'true' }),
        {},
        fetchImpl,
      )
    },
    async decideApproval(approvalId, status) {
      return await requestJson<ProviderApprovalRecord>(
        settings,
        `/api/approvals/${approvalId}/decision`,
        {
          method: 'POST',
          body: { status },
        },
        fetchImpl,
      )
    },
    connectEvents(listener, lastEventId) {
      return eventConnector.connect(settings, listener, lastEventId)
    },
  }
}

export type { EventConnector }
