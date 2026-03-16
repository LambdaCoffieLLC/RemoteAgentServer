import type { AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort, type ForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type IsoTimestamp, type ProtocolEnvelope, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import {
  createSessionSummary,
  type SessionChangeList,
  type SessionDiff,
  type SessionEvent,
  type SessionSummary,
} from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

const actor: AuthenticatedActor = {
  id: 'user_web',
  kind: 'user',
  displayName: 'Browser Operator',
  scopes: ['hosts:read', 'workspaces:read', 'sessions:read', 'approvals:read', 'ports:read'],
}

const hostId = 'host_web' as HostId
const workspaceId = 'workspace_web' as WorkspaceId
const sessionId = 'session_web' as SessionId
const browserTitle = 'Remote Agent Console'

export interface WebClientHostRecord {
  id: HostId
  label: string
  platform: 'linux' | 'macos' | 'windows'
  runtimeStatus: 'online' | 'offline' | 'degraded'
  enrolledAt: IsoTimestamp
  lastSeenAt: IsoTimestamp
  runtime?: {
    runtimeId: string
    label: string
    version: string
    health: 'healthy' | 'degraded' | 'unhealthy'
    connectivity: 'connected' | 'disconnected'
    enrolledAt: IsoTimestamp
    reportedAt: IsoTimestamp
    enrollmentMethod: 'bootstrap-token'
  }
}

export interface WebClientWorkspaceRecord {
  id: WorkspaceId
  hostId: HostId
  name: string
  path: string
  repositoryPath: string
  defaultBranch: string
  runtimeLabel: string
  runtimeAssociation: {
    hostId: HostId
    runtimeId?: string
    label: string
  }
}

export type WebClientApprovalId = `approval_${string}`
export type WebClientApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface WebClientApprovalRecord {
  id: WebClientApprovalId
  sessionId: SessionId
  action: string
  requestedBy: {
    id: string
    displayName: string
  }
  requestedAt: IsoTimestamp
  status: WebClientApprovalStatus
  decidedAt?: IsoTimestamp
  decidedBy?: {
    id: string
    displayName: string
  }
}

export interface WebClientDashboard {
  hosts: WebClientHostRecord[]
  workspaces: WebClientWorkspaceRecord[]
  sessions: SessionSummary[]
  approvals: WebClientApprovalRecord[]
  ports: ForwardedPort[]
}

export interface WebControlPlaneEvent<TType extends string = string, TPayload = unknown>
  extends ProtocolEnvelope<TType, TPayload> {
  issuedAt: IsoTimestamp
}

export interface WebControlPlaneClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

export interface SessionChangeQuery {
  cursor?: number
  limit?: number
  path?: string
}

export interface SessionDiffQuery extends SessionChangeQuery {
  maxBytes?: number
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

export class WebClientRequestError extends Error {
  readonly statusCode: number

  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

type WebRequestInit = globalThis.RequestInit
type WebHeadersInit = globalThis.HeadersInit

/* eslint-disable no-unused-vars */
export interface WebControlPlaneClient {
  signIn: () => Promise<WebClientDashboard>
  listSessionEvents: (sessionId: SessionId) => Promise<SessionEvent[]>
  listSessionChanges: (sessionId: SessionId, query?: SessionChangeQuery) => Promise<SessionChangeList>
  readSessionDiff: (sessionId: SessionId, query?: SessionDiffQuery) => Promise<SessionDiff>
  decideApproval: (
    approvalId: WebClientApprovalId,
    status: Extract<WebClientApprovalStatus, 'approved' | 'rejected'>,
  ) => Promise<WebClientApprovalRecord>
  streamEvents: (options?: { signal?: AbortSignal }) => AsyncIterable<WebControlPlaneEvent>
}
/* eslint-enable no-unused-vars */

export function describeWebApp() {
  return createSurfaceSummary({
    manifest: createManifest('web', 'Browser client for remote sessions, approvals, ports, previews, and diff review.', [
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
        provider: 'codex',
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
        id: 'port_web_preview',
        hostId,
        workspaceId,
        sessionId,
        localPort: 4173,
        targetPort: 4173,
        protocol: 'http',
        visibility: 'shared',
        label: 'Web preview',
        managedUrl: 'http://shared-port_web_preview.ports.remote-agent.local',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Sessions', href: '#sessions', badgeTone: 'info' },
      { label: 'Approvals', href: '#approvals', badgeTone: 'warning' },
      { label: 'Ports', href: '#ports', badgeTone: 'neutral' },
      { label: 'Previews', href: '#preview', badgeTone: 'success' },
    ],
  })
}

export function createWebControlPlaneClient(options: WebControlPlaneClientOptions): WebControlPlaneClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch

  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required to use the web control-plane client.')
  }

  const request = async <TData>(path: string, init: WebRequestInit = {}) => {
    const response = await fetchImplementation(toAbsoluteUrl(options.baseUrl, path), {
      ...init,
      headers: mergeHeaders(init.headers, {
        authorization: `Bearer ${options.token}`,
      }),
    })

    if (!response.ok) {
      throw await toWebClientRequestError(response)
    }

    return (await response.json()) as JsonSuccessResponse<TData>
  }

  return {
    signIn: async () => {
      const [hosts, workspaces, sessions, approvals, ports] = await Promise.all([
        request<WebClientHostRecord[]>('/v1/hosts'),
        request<WebClientWorkspaceRecord[]>('/v1/workspaces'),
        request<SessionSummary[]>('/v1/sessions'),
        request<WebClientApprovalRecord[]>('/v1/approvals'),
        request<ForwardedPort[]>('/v1/ports'),
      ])

      return {
        hosts: hosts.data,
        workspaces: workspaces.data,
        sessions: sessions.data,
        approvals: approvals.data,
        ports: ports.data,
      }
    },
    listSessionEvents: async (sessionId) => {
      const response = await request<SessionEvent[]>(`/v1/sessions/${sessionId}/events`)
      return response.data
    },
    listSessionChanges: async (sessionId, query = {}) => {
      const response = await request<SessionChangeList>(
        withQuery(`/v1/sessions/${sessionId}/changes`, {
          cursor: query.cursor,
          limit: query.limit,
          path: query.path,
        }),
      )
      return response.data
    },
    readSessionDiff: async (sessionId, query = {}) => {
      const response = await request<SessionDiff>(
        withQuery(`/v1/sessions/${sessionId}/changes/patch`, {
          cursor: query.cursor,
          limit: query.limit,
          maxBytes: query.maxBytes,
          path: query.path,
        }),
      )
      return response.data
    },
    decideApproval: async (approvalId, status) => {
      const response = await request<WebClientApprovalRecord>(`/v1/approvals/${approvalId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        headers: {
          'content-type': 'application/json',
        },
      })
      return response.data
    },
    streamEvents: (streamOptions = {}) => streamControlPlaneEvents({
      baseUrl: options.baseUrl,
      token: options.token,
      fetchImplementation,
      signal: streamOptions.signal,
    }),
  }
}

export function parseControlPlaneSseFrame(frame: string): WebControlPlaneEvent | undefined {
  const lines = frame.split('\n')
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim()
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())

  if (!eventName || dataLines.length === 0) {
    return undefined
  }

  return JSON.parse(dataLines.join('\n')) as WebControlPlaneEvent
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

export function renderWebClientDocument(title = browserTitle) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
${WEB_CLIENT_STYLES}
    </style>
  </head>
  <body>
    <div class="chrome">
      <header class="hero">
        <div>
          <p class="eyebrow">Browser control surface</p>
          <h1>${escapeHtml(title)}</h1>
          <p class="lede">Sign in with a bearer token, watch live session events, review diffs, answer approvals, and open forwarded previews from one page.</p>
        </div>
        <div class="hero-panel">
          <p>Quick tokens</p>
          <div class="hero-actions">
            <button type="button" data-fill-token="control-plane-viewer">Viewer</button>
            <button type="button" data-fill-token="control-plane-operator">Operator</button>
          </div>
        </div>
      </header>

      <main class="layout">
        <section class="card sign-in-card">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Access</p>
              <h2>Token sign-in</h2>
            </div>
            <button type="button" class="ghost" data-sign-out>Sign out</button>
          </div>
          <form data-sign-in-form>
            <label for="token-input">Bearer token</label>
            <div class="token-row">
              <input id="token-input" name="token" autocomplete="off" spellcheck="false" placeholder="control-plane-operator" />
              <button type="submit" data-sign-in>Connect</button>
            </div>
          </form>
          <p class="status-line" data-auth-status>Signed out.</p>
        </section>

        <section class="card summary-card">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Inventory</p>
              <h2>Hosts, workspaces, sessions, ports</h2>
            </div>
            <p class="stream-pill" data-stream-state>Stream idle</p>
          </div>
          <div class="stats" data-stats></div>
        </section>

        <section class="card" id="hosts">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Topology</p>
              <h2>Hosts</h2>
            </div>
          </div>
          <div class="stack" data-hosts-list></div>
        </section>

        <section class="card" id="workspaces">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Repositories</p>
              <h2>Workspaces</h2>
            </div>
          </div>
          <div class="stack" data-workspaces-list></div>
        </section>

        <section class="card" id="sessions">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Execution</p>
              <h2>Sessions</h2>
            </div>
          </div>
          <div class="stack" data-sessions-list></div>
        </section>

        <section class="card" id="approvals">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Risk gates</p>
              <h2>Approvals</h2>
            </div>
          </div>
          <div class="stack" data-approvals-list></div>
        </section>

        <section class="card" id="ports">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Connectivity</p>
              <h2>Forwarded Ports</h2>
            </div>
          </div>
          <div class="stack" data-ports-list></div>
        </section>

        <section class="card diff-card" id="diffs">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Code review</p>
              <h2>Diff review</h2>
            </div>
            <button type="button" class="ghost" data-refresh-diff>Refresh diff</button>
          </div>
          <p class="status-line" data-diff-status>Select a session to inspect changes.</p>
          <div class="stack diff-stack" data-diff-list></div>
        </section>

        <section class="card events-card" id="events">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Live feed</p>
              <h2>Session events</h2>
            </div>
          </div>
          <div class="stack events-stack" data-events-list></div>
        </section>

        <section class="card preview-card" id="preview">
          <div class="section-heading">
            <div>
              <p class="section-kicker">HTTP preview</p>
              <h2>Forwarded preview</h2>
            </div>
            <a class="ghost anchor-button" href="" target="_blank" rel="noreferrer" data-preview-link>Open in tab</a>
          </div>
          <p class="status-line" data-preview-status>Select an HTTP forwarded port to load the preview frame.</p>
          <iframe title="Forwarded preview" class="preview-frame" data-preview-frame loading="lazy"></iframe>
        </section>
      </main>
    </div>

    <script type="module">
${WEB_CLIENT_SCRIPT}
    </script>
  </body>
</html>`
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

function mergeHeaders(first: WebHeadersInit | undefined, second: WebHeadersInit | undefined) {
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

async function toWebClientRequestError(response: Response) {
  let message = `Request failed with status ${response.status}.`
  let code = 'request_failed'

  try {
    const payload = (await response.json()) as JsonErrorResponse
    message = payload.error?.message ?? message
    code = payload.error?.code ?? code
  } catch {
    // Fall back to the default error.
  }

  return new WebClientRequestError(response.status, code, message)
}

async function* streamControlPlaneEvents(options: {
  baseUrl: string
  token: string
  fetchImplementation: typeof globalThis.fetch
  signal?: AbortSignal
}): AsyncIterable<WebControlPlaneEvent> {
  const response = await options.fetchImplementation(toAbsoluteUrl(options.baseUrl, '/v1/events'), {
    headers: {
      authorization: `Bearer ${options.token}`,
    },
    signal: options.signal,
  })

  if (!response.ok) {
    throw await toWebClientRequestError(response)
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isAbortError(error: unknown) {
  return error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError'
}

const WEB_CLIENT_STYLES = `
      :root {
        color-scheme: dark;
        --bg: #101214;
        --bg-soft: rgba(255, 255, 255, 0.05);
        --panel: rgba(15, 20, 23, 0.84);
        --panel-strong: rgba(22, 29, 33, 0.96);
        --line: rgba(255, 248, 231, 0.12);
        --text: #f5eddc;
        --muted: #b8b2a4;
        --accent: #ef9f49;
        --accent-strong: #ffd39a;
        --good: #79d29c;
        --warn: #ffcf66;
        --bad: #ff8570;
        --mono: "IBM Plex Mono", "SFMono-Regular", "Menlo", monospace;
        --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        --sans: "Avenir Next", "Segoe UI", sans-serif;
        --shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        min-height: 100%;
        background:
          radial-gradient(circle at top left, rgba(239, 159, 73, 0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(97, 164, 255, 0.14), transparent 25%),
          linear-gradient(180deg, #181b1e 0%, #0f1113 100%);
        color: var(--text);
        font-family: var(--sans);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
        background-size: 32px 32px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.9));
      }

      button, input, a {
        font: inherit;
      }

      .chrome {
        width: min(1440px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.8fr);
        gap: 20px;
        align-items: stretch;
        margin-bottom: 20px;
      }

      .hero h1,
      .section-heading h2 {
        margin: 0;
        font-family: var(--serif);
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      .hero h1 {
        font-size: clamp(2.4rem, 6vw, 4.8rem);
        line-height: 0.92;
        max-width: 10ch;
      }

      .eyebrow,
      .section-kicker {
        margin: 0 0 10px;
        color: var(--accent-strong);
        text-transform: uppercase;
        letter-spacing: 0.24em;
        font-size: 0.74rem;
        font-family: var(--mono);
      }

      .lede,
      .status-line {
        margin: 12px 0 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .hero-panel,
      .card {
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .hero-panel {
        padding: 24px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }

      .hero-actions,
      .token-row,
      .approval-actions,
      .port-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      .layout {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 16px;
      }

      .card {
        padding: 22px;
        background-color: var(--panel);
      }

      .sign-in-card,
      .summary-card,
      .preview-card {
        grid-column: span 12;
      }

      .summary-card .stats {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 12px;
      }

      #hosts,
      #workspaces,
      #sessions,
      #approvals,
      #ports {
        grid-column: span 6;
      }

      .diff-card,
      .events-card {
        grid-column: span 6;
      }

      .preview-card {
        min-height: 520px;
      }

      .section-heading {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
        margin-bottom: 18px;
      }

      .stream-pill,
      .badge,
      .stat-card span {
        font-family: var(--mono);
      }

      .stream-pill,
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--bg-soft);
        padding: 6px 10px;
        color: var(--accent-strong);
        font-size: 0.78rem;
      }

      .badge.good { color: var(--good); }
      .badge.warn { color: var(--warn); }
      .badge.bad { color: var(--bad); }

      .stack {
        display: grid;
        gap: 12px;
      }

      .record,
      .stat-card,
      .diff-entry {
        padding: 14px 16px;
        border-radius: 16px;
        background: var(--panel-strong);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .record-header,
      .diff-meta,
      .event-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
      }

      .record h3,
      .diff-entry h3,
      .stat-card strong {
        margin: 0;
      }

      .record h3,
      .diff-entry h3 {
        font-size: 1rem;
      }

      .record p,
      .diff-entry p,
      .event-line {
        margin: 8px 0 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .meta-line {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 10px;
        color: var(--muted);
        font-family: var(--mono);
        font-size: 0.8rem;
      }

      .stat-card {
        min-height: 112px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }

      .stat-card span {
        color: var(--muted);
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.18em;
      }

      .stat-card strong {
        font-size: 2.3rem;
        font-family: var(--serif);
      }

      label {
        display: block;
        margin-bottom: 8px;
        color: var(--muted);
      }

      input {
        flex: 1 1 220px;
        min-width: 0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.04);
        color: var(--text);
        padding: 14px 16px;
      }

      button,
      .anchor-button {
        border: 1px solid rgba(239, 159, 73, 0.35);
        background: linear-gradient(180deg, rgba(239, 159, 73, 0.25), rgba(239, 159, 73, 0.12));
        color: var(--text);
        border-radius: 14px;
        padding: 12px 16px;
        text-decoration: none;
        cursor: pointer;
        transition: transform 150ms ease, border-color 150ms ease, background 150ms ease;
      }

      button:hover,
      .anchor-button:hover {
        transform: translateY(-1px);
        border-color: rgba(255, 211, 154, 0.7);
      }

      .ghost {
        background: rgba(255, 255, 255, 0.04);
        border-color: rgba(255, 255, 255, 0.1);
      }

      .empty {
        padding: 18px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px dashed rgba(255, 255, 255, 0.12);
        color: var(--muted);
      }

      .diff-stack,
      .events-stack {
        max-height: 640px;
        overflow: auto;
        padding-right: 4px;
      }

      pre {
        margin: 14px 0 0;
        padding: 14px;
        overflow: auto;
        border-radius: 14px;
        background: #0b0d0f;
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #d3f2c7;
        font-family: var(--mono);
        font-size: 0.82rem;
        line-height: 1.5;
      }

      .preview-frame {
        width: 100%;
        min-height: 420px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 18px;
        background: #0c0e10;
      }

      @media (max-width: 1120px) {
        .hero,
        .summary-card .stats {
          grid-template-columns: 1fr;
        }

        #hosts,
        #workspaces,
        #sessions,
        #approvals,
        #ports,
        .diff-card,
        .events-card {
          grid-column: span 12;
        }
      }

      @media (max-width: 720px) {
        .chrome {
          width: min(100vw - 20px, 100%);
          padding-top: 18px;
        }

        .card,
        .hero-panel {
          padding: 18px;
        }

        .section-heading,
        .record-header,
        .diff-meta,
        .event-meta {
          flex-direction: column;
        }

        .preview-card {
          min-height: 420px;
        }
      }
`

const WEB_CLIENT_SCRIPT = `
      const tokenStorageKey = 'remote-agent.web.token'
      const state = {
        token: localStorage.getItem(tokenStorageKey) || '',
        dashboard: null,
        diff: null,
        selectedSessionId: '',
        previewUrl: '',
        events: [],
        streamState: 'idle',
        streamController: null,
        refreshTimer: undefined,
      }

      const refs = {
        form: document.querySelector('[data-sign-in-form]'),
        tokenInput: document.querySelector('#token-input'),
        authStatus: document.querySelector('[data-auth-status]'),
        streamState: document.querySelector('[data-stream-state]'),
        stats: document.querySelector('[data-stats]'),
        hosts: document.querySelector('[data-hosts-list]'),
        workspaces: document.querySelector('[data-workspaces-list]'),
        sessions: document.querySelector('[data-sessions-list]'),
        approvals: document.querySelector('[data-approvals-list]'),
        ports: document.querySelector('[data-ports-list]'),
        diffStatus: document.querySelector('[data-diff-status]'),
        diffList: document.querySelector('[data-diff-list]'),
        events: document.querySelector('[data-events-list]'),
        previewLink: document.querySelector('[data-preview-link]'),
        previewStatus: document.querySelector('[data-preview-status]'),
        previewFrame: document.querySelector('[data-preview-frame]'),
      }

      if (refs.tokenInput && state.token) {
        refs.tokenInput.value = state.token
      }

      document.querySelectorAll('[data-fill-token]').forEach((button) => {
        button.addEventListener('click', () => {
          const token = button.getAttribute('data-fill-token') || ''

          if (refs.tokenInput) {
            refs.tokenInput.value = token
            refs.tokenInput.focus()
          }
        })
      })

      document.querySelector('[data-sign-out]')?.addEventListener('click', () => {
        state.token = ''
        state.dashboard = null
        state.diff = null
        state.selectedSessionId = ''
        state.previewUrl = ''
        state.events = []
        localStorage.removeItem(tokenStorageKey)
        stopStream()

        if (refs.tokenInput) {
          refs.tokenInput.value = ''
        }

        render()
      })

      document.querySelector('[data-refresh-diff]')?.addEventListener('click', () => {
        if (state.selectedSessionId) {
          void loadDiff(state.selectedSessionId)
        }
      })

      refs.form?.addEventListener('submit', async (event) => {
        event.preventDefault()
        const nextToken = refs.tokenInput?.value.trim() || ''

        if (!nextToken) {
          refs.authStatus.textContent = 'Enter a bearer token to sign in.'
          return
        }

        state.token = nextToken
        localStorage.setItem(tokenStorageKey, nextToken)
        refs.authStatus.textContent = 'Connecting...'

        try {
          await refreshDashboard()
          startStream()
          refs.authStatus.textContent = 'Connected.'
        } catch (error) {
          refs.authStatus.textContent = formatError(error)
        }
      })

      document.addEventListener('click', (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null

        if (!target) {
          return
        }

        const approvalStatus = target.getAttribute('data-approval-status')
        const approvalId = target.getAttribute('data-approval-id')

        if (approvalStatus && approvalId) {
          void decideApproval(approvalId, approvalStatus)
          return
        }

        const sessionId = target.getAttribute('data-session-id')

        if (sessionId) {
          void loadDiff(sessionId)
          return
        }

        const previewUrl = target.getAttribute('data-preview-url')

        if (previewUrl) {
          setPreview(previewUrl)
        }
      })

      if (state.token) {
        refs.authStatus.textContent = 'Reconnecting...'
        void refreshDashboard()
          .then(() => {
            refs.authStatus.textContent = 'Connected.'
            startStream()
          })
          .catch((error) => {
            refs.authStatus.textContent = formatError(error)
          })
      } else {
        render()
      }

      async function refreshDashboard() {
        const headers = buildAuthHeaders()
        const [hosts, workspaces, sessions, approvals, ports] = await Promise.all([
          requestJson('/v1/hosts', { headers }),
          requestJson('/v1/workspaces', { headers }),
          requestJson('/v1/sessions', { headers }),
          requestJson('/v1/approvals', { headers }),
          requestJson('/v1/ports', { headers }),
        ])

        state.dashboard = {
          hosts: hosts.data,
          workspaces: workspaces.data,
          sessions: sessions.data,
          approvals: approvals.data,
          ports: ports.data,
        }

        if (!state.selectedSessionId && sessions.data[0]) {
          state.selectedSessionId = sessions.data[0].id
          await loadDiff(state.selectedSessionId)
          return
        }

        if (!state.previewUrl) {
          const previewablePort = ports.data.find((port) => resolvePreviewUrl(port))

          if (previewablePort) {
            state.previewUrl = resolvePreviewUrl(previewablePort)
          }
        }

        render()
      }

      async function loadDiff(sessionId) {
        if (!sessionId) {
          return
        }

        state.selectedSessionId = sessionId
        refs.diffStatus.textContent = 'Loading diff...'

        try {
          const response = await requestJson('/v1/sessions/' + sessionId + '/changes/patch?limit=20&maxBytes=8192', {
            headers: buildAuthHeaders(),
          })
          state.diff = response.data
          render()
        } catch (error) {
          state.diff = null
          refs.diffStatus.textContent = formatError(error)
        }
      }

      async function decideApproval(approvalId, status) {
        try {
          await requestJson('/v1/approvals/' + approvalId, {
            method: 'PATCH',
            headers: buildAuthHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ status }),
          })
          await refreshDashboard()
        } catch (error) {
          refs.authStatus.textContent = formatError(error)
        }
      }

      function buildAuthHeaders(extraHeaders) {
        return Object.assign({ authorization: 'Bearer ' + state.token }, extraHeaders || {})
      }

      async function requestJson(path, options) {
        const response = await fetch(path, options)
        const payload = await response.json()

        if (!response.ok) {
          throw new Error(payload.error && payload.error.message ? payload.error.message : 'Request failed.')
        }

        return payload
      }

      function startStream() {
        stopStream()
        state.streamController = new AbortController()
        state.streamState = 'connecting'
        render()

        void readEventStream(state.streamController.signal)
      }

      function stopStream() {
        if (state.streamController) {
          state.streamController.abort()
          state.streamController = null
        }

        state.streamState = state.token ? 'idle' : 'signed-out'
      }

      async function readEventStream(signal) {
        try {
          const response = await fetch('/v1/events', {
            headers: buildAuthHeaders(),
            signal,
          })

          if (!response.ok || !response.body) {
            throw new Error('Failed to open the event stream.')
          }

          state.streamState = 'live'
          render()

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          while (true) {
            const result = await reader.read()

            if (result.done) {
              break
            }

            buffer += decoder.decode(result.value, { stream: true })

            while (buffer.includes('\\n\\n')) {
              const boundary = buffer.indexOf('\\n\\n')
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const event = parseEventFrame(frame)

              if (!event) {
                continue
              }

              state.events = [event].concat(state.events).slice(0, 50)
              render()

              if (event.type !== 'control-plane.snapshot') {
                queueDashboardRefresh()
              }
            }
          }
        } catch (error) {
          if (signal.aborted) {
            return
          }

          state.streamState = 'error'
          refs.authStatus.textContent = formatError(error)
          render()
        }
      }

      function queueDashboardRefresh() {
        if (state.refreshTimer !== undefined) {
          clearTimeout(state.refreshTimer)
        }

        state.refreshTimer = window.setTimeout(() => {
          state.refreshTimer = undefined

          if (state.token) {
            void refreshDashboard().catch((error) => {
              refs.authStatus.textContent = formatError(error)
            })
          }
        }, 120)
      }

      function parseEventFrame(frame) {
        const lines = frame.split('\\n')
        const eventNameLine = lines.find((line) => line.startsWith('event:'))
        const dataLine = lines.find((line) => line.startsWith('data:'))

        if (!eventNameLine || !dataLine) {
          return undefined
        }

        return JSON.parse(dataLine.slice('data:'.length).trim())
      }

      function resolvePreviewUrl(port) {
        if (!port || port.status !== 'open') {
          return ''
        }

        if ((port.protocol === 'http' || port.protocol === 'https') && port.managedUrl) {
          return port.managedUrl
        }

        return ''
      }

      function setPreview(nextUrl) {
        state.previewUrl = nextUrl
        render()
      }

      function render() {
        renderStats()
        renderHosts()
        renderWorkspaces()
        renderSessions()
        renderApprovals()
        renderPorts()
        renderDiff()
        renderEvents()
        renderPreview()
        renderStreamState()

        if (!state.token) {
          refs.authStatus.textContent = 'Signed out.'
        }
      }

      function renderStats() {
        if (!state.dashboard) {
          refs.stats.innerHTML = renderEmpty('Sign in to load the control-plane inventory.')
          return
        }

        refs.stats.innerHTML = [
          statCard('Hosts', state.dashboard.hosts.length),
          statCard('Workspaces', state.dashboard.workspaces.length),
          statCard('Sessions', state.dashboard.sessions.length),
          statCard('Approvals', state.dashboard.approvals.filter((approval) => approval.status === 'pending').length),
          statCard('Ports', state.dashboard.ports.length),
        ].join('')
      }

      function renderHosts() {
        if (!state.dashboard || state.dashboard.hosts.length === 0) {
          refs.hosts.innerHTML = renderEmpty('No hosts visible for this token.')
          return
        }

        refs.hosts.innerHTML = state.dashboard.hosts
          .map((host) => {
            const statusTone = host.runtimeStatus === 'online' ? 'good' : host.runtimeStatus === 'degraded' ? 'warn' : 'bad'
            const runtime = host.runtime
              ? '<p>Runtime ' + escapeHtml(host.runtime.label) + ' · ' + escapeHtml(host.runtime.version) + '</p>'
              : '<p>No enrolled runtime.</p>'

            return '<article class="record">' +
              '<div class="record-header">' +
                '<div><h3>' + escapeHtml(host.label) + '</h3><p>' + escapeHtml(host.id) + '</p></div>' +
                '<span class="badge ' + statusTone + '">' + escapeHtml(host.runtimeStatus) + '</span>' +
              '</div>' +
              runtime +
              '<div class="meta-line"><span>' + escapeHtml(host.platform) + '</span><span>Last seen ' + escapeHtml(formatTimestamp(host.lastSeenAt)) + '</span></div>' +
            '</article>'
          })
          .join('')
      }

      function renderWorkspaces() {
        if (!state.dashboard || state.dashboard.workspaces.length === 0) {
          refs.workspaces.innerHTML = renderEmpty('No registered workspaces.')
          return
        }

        refs.workspaces.innerHTML = state.dashboard.workspaces
          .map((workspace) => {
            return '<article class="record">' +
              '<div class="record-header">' +
                '<div><h3>' + escapeHtml(workspace.name) + '</h3><p>' + escapeHtml(workspace.id) + '</p></div>' +
                '<span class="badge">' + escapeHtml(workspace.defaultBranch) + '</span>' +
              '</div>' +
              '<p>' + escapeHtml(workspace.path) + '</p>' +
              '<div class="meta-line"><span>Host ' + escapeHtml(workspace.hostId) + '</span><span>' + escapeHtml(workspace.runtimeLabel) + '</span></div>' +
            '</article>'
          })
          .join('')
      }

      function renderSessions() {
        if (!state.dashboard || state.dashboard.sessions.length === 0) {
          refs.sessions.innerHTML = renderEmpty('No sessions are available.')
          return
        }

        refs.sessions.innerHTML = state.dashboard.sessions
          .map((session) => {
            const selectedClass = state.selectedSessionId === session.id ? ' good' : ''

            return '<article class="record">' +
              '<div class="record-header">' +
                '<div><h3>' + escapeHtml(session.id) + '</h3><p>' + escapeHtml(session.provider) + ' on ' + escapeHtml(session.workspaceId) + '</p></div>' +
                '<span class="badge' + selectedClass + '">' + escapeHtml(session.status) + '</span>' +
              '</div>' +
              '<div class="meta-line"><span>Requested by ' + escapeHtml(session.requestedBy.displayName) + '</span><span>' + escapeHtml(formatTimestamp(session.startedAt)) + '</span></div>' +
              '<div class="approval-actions"><button type="button" class="ghost" data-session-id="' + escapeHtml(session.id) + '">Review diff</button></div>' +
            '</article>'
          })
          .join('')
      }

      function renderApprovals() {
        if (!state.dashboard || state.dashboard.approvals.length === 0) {
          refs.approvals.innerHTML = renderEmpty('No approvals require attention.')
          return
        }

        refs.approvals.innerHTML = state.dashboard.approvals
          .map((approval) => {
            const actions = approval.status === 'pending'
              ? '<div class="approval-actions">' +
                  '<button type="button" data-approval-id="' + escapeHtml(approval.id) + '" data-approval-status="approved">Approve</button>' +
                  '<button type="button" class="ghost" data-approval-id="' + escapeHtml(approval.id) + '" data-approval-status="rejected">Reject</button>' +
                '</div>'
              : ''

            return '<article class="record">' +
              '<div class="record-header">' +
                '<div><h3>' + escapeHtml(approval.action) + '</h3><p>' + escapeHtml(approval.id) + '</p></div>' +
                '<span class="badge">' + escapeHtml(approval.status) + '</span>' +
              '</div>' +
              '<p>Session ' + escapeHtml(approval.sessionId) + ' · requested by ' + escapeHtml(approval.requestedBy.displayName) + '</p>' +
              '<div class="meta-line"><span>' + escapeHtml(formatTimestamp(approval.requestedAt)) + '</span></div>' +
              actions +
            '</article>'
          })
          .join('')
      }

      function renderPorts() {
        if (!state.dashboard || state.dashboard.ports.length === 0) {
          refs.ports.innerHTML = renderEmpty('No forwarded ports are active.')
          return
        }

        refs.ports.innerHTML = state.dashboard.ports
          .map((port) => {
            const previewUrl = resolvePreviewUrl(port)
            const previewAction = previewUrl
              ? '<div class="port-actions"><button type="button" class="ghost" data-preview-url="' + escapeHtml(previewUrl) + '">Open Preview</button></div>'
              : ''

            return '<article class="record">' +
              '<div class="record-header">' +
                '<div><h3>' + escapeHtml(port.label) + '</h3><p>' + escapeHtml(port.id) + '</p></div>' +
                '<span class="badge">' + escapeHtml(port.status) + '</span>' +
              '</div>' +
              '<p>' + escapeHtml(port.protocol.toUpperCase()) + ' ' + escapeHtml(String(port.targetPort)) + ' · ' + escapeHtml(port.visibility) + '</p>' +
              '<div class="meta-line"><span>Host ' + escapeHtml(port.hostId) + '</span><span>Session ' + escapeHtml(port.sessionId || 'n/a') + '</span></div>' +
              previewAction +
            '</article>'
          })
          .join('')
      }

      function renderDiff() {
        if (!state.selectedSessionId) {
          refs.diffStatus.textContent = 'Select a session to inspect changes.'
          refs.diffList.innerHTML = renderEmpty('No session selected.')
          return
        }

        if (!state.diff) {
          refs.diffStatus.textContent = 'No diff loaded for ' + state.selectedSessionId + '.'
          refs.diffList.innerHTML = renderEmpty('Use Review diff on a session to load patch details.')
          return
        }

        const summary = state.diff.summary
        refs.diffStatus.textContent = 'Reviewing ' + state.selectedSessionId + ': ' + summary.totalFiles + ' changed files, ' + state.diff.patchSummary.additions + ' additions, ' + state.diff.patchSummary.deletions + ' deletions.'

        if (state.diff.items.length === 0) {
          refs.diffList.innerHTML = renderEmpty('This session has no current file changes.')
          return
        }

        refs.diffList.innerHTML = state.diff.items
          .map((entry) => {
            const previousPath = entry.previousPath ? '<p>Renamed from ' + escapeHtml(entry.previousPath) + '</p>' : ''
            const patchSuffix = entry.patchTruncated ? ' · truncated' : ''

            return '<article class="diff-entry">' +
              '<div class="diff-meta">' +
                '<div><h3>' + escapeHtml(entry.path) + '</h3>' + previousPath + '</div>' +
                '<span class="badge">' + escapeHtml(entry.changeType + patchSuffix) + '</span>' +
              '</div>' +
              '<div class="meta-line"><span>+' + escapeHtml(String(entry.additions)) + '</span><span>-' + escapeHtml(String(entry.deletions)) + '</span></div>' +
              '<pre>' + escapeHtml(entry.patch || 'No textual patch available.') + '</pre>' +
            '</article>'
          })
          .join('')
      }

      function renderEvents() {
        if (state.events.length === 0) {
          refs.events.innerHTML = renderEmpty('Live session events will appear here after the stream connects.')
          return
        }

        refs.events.innerHTML = state.events
          .map((event) => {
            return '<article class="record">' +
              '<div class="event-meta"><strong>' + escapeHtml(event.type) + '</strong><span class="badge">' + escapeHtml(formatTimestamp(event.issuedAt)) + '</span></div>' +
              '<p class="event-line">' + escapeHtml(summarizeEvent(event)) + '</p>' +
            '</article>'
          })
          .join('')
      }

      function renderPreview() {
        if (!state.previewUrl) {
          refs.previewStatus.textContent = 'Select an HTTP forwarded port to load the preview frame.'
          refs.previewFrame.removeAttribute('src')
          refs.previewLink.removeAttribute('href')
          refs.previewLink.setAttribute('aria-disabled', 'true')
          return
        }

        refs.previewStatus.textContent = 'Preview loaded from ' + state.previewUrl
        refs.previewFrame.src = state.previewUrl
        refs.previewLink.href = state.previewUrl
        refs.previewLink.removeAttribute('aria-disabled')
      }

      function renderStreamState() {
        const label = state.streamState === 'live'
          ? 'Live stream connected'
          : state.streamState === 'connecting'
            ? 'Connecting stream'
            : state.streamState === 'error'
              ? 'Stream error'
              : 'Stream idle'

        refs.streamState.textContent = label
      }

      function summarizeEvent(event) {
        if (event.type === 'control-plane.snapshot') {
          return 'Snapshot received.'
        }

        if (event.payload && event.payload.sessionEvent && event.payload.sessionEvent.message) {
          return event.payload.sessionEvent.message
        }

        if (event.payload && event.payload.session && event.payload.session.id) {
          return event.payload.session.id + ' updated.'
        }

        if (event.payload && event.payload.approval && event.payload.approval.action) {
          return event.payload.approval.action
        }

        if (event.payload && event.payload.port && event.payload.port.label) {
          return event.payload.port.label
        }

        return 'Control-plane update.'
      }

      function statCard(label, value) {
        return '<article class="stat-card"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></article>'
      }

      function renderEmpty(message) {
        return '<div class="empty">' + escapeHtml(message) + '</div>'
      }

      function formatTimestamp(value) {
        try {
          return new Date(value).toLocaleString()
        } catch {
          return value
        }
      }

      function formatError(error) {
        if (error instanceof Error && error.message) {
          return error.message
        }

        return 'Unexpected client error.'
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;')
      }
`
