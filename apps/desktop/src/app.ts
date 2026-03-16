import { getProviderDisplayName, providerKinds } from '@remote-agent-server/providers'
import type { ProviderKind } from '@remote-agent-server/providers'
import { isTerminalSessionState } from '@remote-agent-server/sessions'
import { createDesktopControlPlaneClient } from './client.js'
import {
  DesktopOperatorController,
  filterWorkspacesByScope,
} from './controller.js'
import type {
  DesktopBridge,
  DesktopOperatorState,
  DesktopWorkspaceScope,
  HostRecord,
  SessionControlAction,
  SessionRecord,
} from './types.js'

const maxVisibleEvents = 12
const styleTagId = 'remote-agent-server-desktop-styles'

const desktopStyles = `
:root {
  color-scheme: dark;
  font-family: 'SF Pro Text', 'Segoe UI', sans-serif;
  background: #111827;
  color: #e5eef7;
}
body {
  margin: 0;
  background:
    radial-gradient(circle at top left, rgba(56, 189, 248, 0.28), transparent 28rem),
    radial-gradient(circle at top right, rgba(249, 115, 22, 0.22), transparent 24rem),
    linear-gradient(180deg, #08111f 0%, #101827 100%);
}
[data-desktop-shell] {
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
}
.desktop-shell {
  display: grid;
  gap: 20px;
}
.hero-card,
.surface-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(15, 23, 42, 0.8);
  border-radius: 20px;
  box-shadow: 0 22px 60px rgba(8, 15, 31, 0.35);
  backdrop-filter: blur(16px);
}
.hero-card {
  display: grid;
  gap: 18px;
  padding: 24px;
}
.hero-row,
.content-grid,
.session-grid,
.inventory-grid,
.port-grid,
.approval-grid {
  display: grid;
  gap: 16px;
}
.hero-row {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}
.content-grid {
  grid-template-columns: 1.2fr 1fr;
}
.section-stack {
  display: grid;
  gap: 16px;
}
.surface-card {
  padding: 18px;
}
.eyebrow {
  color: #7dd3fc;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
  margin: 0 0 8px;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  font-size: 2rem;
}
h2 {
  font-size: 1.15rem;
}
h3 {
  font-size: 1rem;
}
.support-copy,
.meta-copy,
.empty-state {
  color: #94a3b8;
  line-height: 1.5;
}
.metric-card {
  padding: 14px;
  border-radius: 16px;
  background: rgba(30, 41, 59, 0.72);
}
.metric-value {
  font-size: 1.6rem;
  font-weight: 700;
  margin-top: 6px;
}
.connection-form,
.session-form {
  display: grid;
  gap: 12px;
}
.field-row {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
label {
  display: grid;
  gap: 6px;
  color: #cbd5e1;
  font-size: 0.92rem;
}
input,
select,
button {
  font: inherit;
}
input,
select {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(15, 23, 42, 0.7);
  color: inherit;
}
.button-row,
.workspace-scope-switch,
.session-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
button {
  border: none;
  cursor: pointer;
  border-radius: 999px;
  padding: 10px 16px;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.accent-button {
  background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  color: #082f49;
  font-weight: 700;
}
.secondary-button {
  background: rgba(59, 130, 246, 0.18);
  color: #bfdbfe;
}
.ghost-button {
  background: rgba(148, 163, 184, 0.12);
  color: #e2e8f0;
}
.danger-button {
  background: rgba(248, 113, 113, 0.18);
  color: #fecaca;
}
.scope-button-active {
  background: linear-gradient(135deg, #f97316, #fb923c);
  color: #431407;
  font-weight: 700;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: rgba(148, 163, 184, 0.14);
  color: #e2e8f0;
}
.status-pill.running,
.status-pill.completed,
.status-pill.live,
.status-pill.online,
.status-pill.healthy,
.status-pill.connected {
  background: rgba(74, 222, 128, 0.16);
  color: #bbf7d0;
}
.status-pill.blocked,
.status-pill.paused,
.status-pill.connecting,
.status-pill.reconnecting,
.status-pill.pending {
  background: rgba(250, 204, 21, 0.16);
  color: #fde68a;
}
.status-pill.failed,
.status-pill.canceled,
.status-pill.rejected,
.status-pill.error,
.status-pill.unhealthy,
.status-pill.disconnected,
.status-pill.offline {
  background: rgba(248, 113, 113, 0.16);
  color: #fecaca;
}
.inventory-card,
.session-card,
.approval-card,
.port-card,
.event-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.72);
}
.inventory-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.meta-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}
.meta-grid dt {
  color: #7dd3fc;
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.meta-grid dd {
  margin: 4px 0 0;
  color: #e2e8f0;
}
.code-path {
  overflow-wrap: anywhere;
  color: #bfdbfe;
  font-family: 'SFMono-Regular', 'Menlo', monospace;
  font-size: 0.88rem;
}
.session-card-active {
  border: 1px solid rgba(56, 189, 248, 0.35);
}
.error-text {
  color: #fda4af;
}
@media (max-width: 980px) {
  .content-grid {
    grid-template-columns: 1fr;
  }
}
`

export interface RenderDesktopAppOptions {
  bridge?: DesktopBridge
  fetch?: typeof fetch
}

declare global {
  interface Window {
    remoteAgentDesktopBridge?: DesktopBridge
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

function formatTimestamp(value?: string) {
  if (!value) {
    return 'Awaiting update'
  }

  return new Date(value).toLocaleString()
}

function formatHostLocation(host: HostRecord) {
  return host.hostMode === 'local' ? 'Local runtime' : 'Remote runtime'
}

function formatHostConnection(host: HostRecord) {
  return host.connectionMode === 'attached' ? 'Attached' : 'Registered'
}

function renderMetric(label: string, value: number) {
  return `
    <article class="metric-card">
      <p class="eyebrow">${escapeHtml(label)}</p>
      <p class="metric-value">${value}</p>
    </article>
  `
}

function getVisibleWorkspaces(state: DesktopOperatorState) {
  return filterWorkspacesByScope(
    state.dashboard.workspaces,
    state.dashboard.hosts,
    state.workspaceScope,
  )
}

function getHostsById(state: DesktopOperatorState) {
  return new Map(state.dashboard.hosts.map((host) => [host.id, host]))
}

function getSelectedWorkspaceLabel(state: DesktopOperatorState) {
  const selectedWorkspace = state.dashboard.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  )
  if (!selectedWorkspace) {
    return undefined
  }

  const host = getHostsById(state).get(selectedWorkspace.hostId)
  return host ? `${selectedWorkspace.id} (${formatHostLocation(host)})` : selectedWorkspace.id
}

function getSessionScope(session: SessionRecord, hostsById: Map<string, HostRecord>) {
  const host = hostsById.get(session.hostId)
  return host?.hostMode === 'local' ? 'Local' : 'Remote'
}

function renderHosts(state: DesktopOperatorState) {
  if (state.dashboard.hosts.length === 0) {
    return '<p class="empty-state">No runtimes are enrolled yet.</p>'
  }

  return state.dashboard.hosts
    .map(
      (host) => `
        <article class="inventory-card">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(host.name)}</h3>
              <p class="meta-copy">${escapeHtml(formatHostLocation(host))} • ${escapeHtml(formatHostConnection(host))}</p>
            </div>
            <span class="status-pill ${escapeHtml(host.status)}">${escapeHtml(host.status)}</span>
          </header>
          <dl class="meta-grid">
            <div><dt>Platform</dt><dd>${escapeHtml(host.platform)}</dd></div>
            <div><dt>Runtime</dt><dd>${escapeHtml(host.runtimeVersion)}</dd></div>
            <div><dt>Health</dt><dd>${escapeHtml(host.health)}</dd></div>
            <div><dt>Seen</dt><dd>${escapeHtml(formatTimestamp(host.lastSeenAt))}</dd></div>
          </dl>
        </article>
      `,
    )
    .join('')
}

function renderWorkspaces(state: DesktopOperatorState) {
  const hostsById = getHostsById(state)
  const visibleWorkspaces = getVisibleWorkspaces(state)

  if (visibleWorkspaces.length === 0) {
    return `<p class="empty-state">No ${escapeHtml(state.workspaceScope)} workspaces are registered yet.</p>`
  }

  return visibleWorkspaces
    .map((workspace) => {
      const host = hostsById.get(workspace.hostId)
      return `
        <article class="inventory-card ${state.selectedWorkspaceId === workspace.id ? 'session-card-active' : ''}">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(workspace.id)}</h3>
              <p class="meta-copy">${escapeHtml(host ? formatHostLocation(host) : workspace.hostId)}</p>
            </div>
            <span class="status-pill">${escapeHtml(workspace.defaultBranch)}</span>
          </header>
          <p class="code-path">${escapeHtml(workspace.path)}</p>
          <div class="button-row">
            <button
              class="${state.selectedWorkspaceId === workspace.id ? 'secondary-button' : 'ghost-button'}"
              data-action="select-workspace"
              data-workspace-id="${escapeHtml(workspace.id)}"
              type="button"
            >
              ${state.selectedWorkspaceId === workspace.id ? 'Selected' : 'Use this workspace'}
            </button>
          </div>
        </article>
      `
    })
    .join('')
}

function renderSessionActions(state: DesktopOperatorState, session: SessionRecord) {
  const busy = state.busySessionId === session.id ? state.busySessionAction : undefined

  if (isTerminalSessionState(session.state)) {
    return '<p class="meta-copy">No session controls are available after completion.</p>'
  }

  const actions: Array<{
    action: SessionControlAction
    className: string
    label: string
  }> = []

  if (session.state === 'running') {
    actions.push({ action: 'pause', className: 'secondary-button', label: 'Pause' })
    actions.push({ action: 'cancel', className: 'danger-button', label: 'Cancel' })
  } else if (session.state === 'paused') {
    actions.push({ action: 'resume', className: 'accent-button', label: 'Resume' })
    actions.push({ action: 'cancel', className: 'danger-button', label: 'Cancel' })
  } else if (session.state === 'blocked' || session.state === 'queued') {
    actions.push({ action: 'cancel', className: 'danger-button', label: 'Cancel' })
  }

  if (actions.length === 0) {
    return '<p class="meta-copy">Live events will update this session automatically.</p>'
  }

  return `
    <div class="session-actions">
      ${actions
        .map(
          (entry) => `
            <button
              class="${entry.className}"
              data-action="session-control"
              data-session-action="${entry.action}"
              data-session-id="${escapeHtml(session.id)}"
              type="button"
              ${busy === entry.action ? 'disabled' : ''}
            >
              ${busy === entry.action ? 'Working…' : entry.label}
            </button>
          `,
        )
        .join('')}
    </div>
  `
}

function renderSessions(state: DesktopOperatorState) {
  if (state.dashboard.sessions.length === 0) {
    return '<p class="empty-state">Start a session from the workspace panel to begin operator work.</p>'
  }

  const hostsById = getHostsById(state)

  return state.dashboard.sessions
    .map((session) => `
      <article class="session-card">
        <header class="inventory-header">
          <div>
            <h3>${escapeHtml(session.id)}</h3>
            <p class="meta-copy">${escapeHtml(getProviderDisplayName(session.provider as ProviderKind))} • ${escapeHtml(getSessionScope(session, hostsById))}</p>
          </div>
          <span class="status-pill ${escapeHtml(session.state)}">${escapeHtml(session.state)}</span>
        </header>
        <dl class="meta-grid">
          <div><dt>Workspace</dt><dd>${escapeHtml(session.workspaceId)}</dd></div>
          <div><dt>Mode</dt><dd>${escapeHtml(session.mode)}</dd></div>
          <div><dt>Updated</dt><dd>${escapeHtml(formatTimestamp(session.updatedAt))}</dd></div>
          <div><dt>Output</dt><dd>${session.output.length}</dd></div>
        </dl>
        <p class="code-path">${escapeHtml(session.executionPath)}</p>
        ${renderSessionActions(state, session)}
      </article>
    `)
    .join('')
}

function renderApprovals(state: DesktopOperatorState) {
  if (state.dashboard.approvals.length === 0) {
    return '<p class="empty-state">No privileged actions are waiting for operator review.</p>'
  }

  return state.dashboard.approvals
    .map((approval) => {
      const pending = approval.status === 'pending'
      const busy = state.busyApprovalId === approval.id

      return `
        <article class="approval-card">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(approval.action)}</h3>
              <p class="meta-copy">${escapeHtml(approval.sessionId)} • ${escapeHtml(getProviderDisplayName(approval.provider))}</p>
            </div>
            <span class="status-pill ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
          </header>
          <p>${escapeHtml(approval.message)}</p>
          <p class="meta-copy">Requested ${escapeHtml(formatTimestamp(approval.requestedAt))}</p>
          ${
            pending
              ? `
                <div class="button-row">
                  <button
                    class="accent-button"
                    data-action="approval-decision"
                    data-approval-id="${escapeHtml(approval.id)}"
                    data-status="approved"
                    type="button"
                    ${busy ? 'disabled' : ''}
                  >
                    ${busy ? 'Working…' : 'Approve'}
                  </button>
                  <button
                    class="danger-button"
                    data-action="approval-decision"
                    data-approval-id="${escapeHtml(approval.id)}"
                    data-status="rejected"
                    type="button"
                    ${busy ? 'disabled' : ''}
                  >
                    Reject
                  </button>
                </div>
              `
              : `<p class="meta-copy">Decided ${escapeHtml(formatTimestamp(approval.decidedAt))}</p>`
          }
        </article>
      `
    })
    .join('')
}

function renderPorts(state: DesktopOperatorState) {
  if (state.dashboard.forwardedPorts.length === 0) {
    return '<p class="empty-state">No forwarded HTTP previews are open yet.</p>'
  }

  return state.dashboard.forwardedPorts
    .map((port) => `
      <article class="port-card">
        <header class="inventory-header">
          <div>
            <h3>${escapeHtml(port.label)}</h3>
            <p class="meta-copy">${escapeHtml(port.targetHost)}:${port.port}</p>
          </div>
          <span class="status-pill ${escapeHtml(port.forwardingState ?? port.state)}">${escapeHtml(port.forwardingState ?? port.state)}</span>
        </header>
        <p class="meta-copy">Scope ${escapeHtml(port.sessionId ?? port.workspaceId ?? port.hostId)}</p>
        <div class="button-row">
          <button
            class="secondary-button"
            data-action="open-preview"
            data-port-id="${escapeHtml(port.id)}"
            type="button"
            ${port.managedUrl ? '' : 'disabled'}
          >
            Open preview
          </button>
        </div>
      </article>
    `)
    .join('')
}

function renderEvents(state: DesktopOperatorState) {
  if (!state.lastEventType) {
    return '<p class="empty-state">Connect to a control plane to start the desktop live stream.</p>'
  }

  return `
    <article class="event-card">
      <p class="eyebrow">Most recent control-plane event</p>
      <h3>${escapeHtml(state.lastEventType)}</h3>
      <p class="meta-copy">Event ID ${escapeHtml(state.lastEventId ?? 'n/a')}</p>
    </article>
  `
}

function renderWorkspaceScopeButtons(scope: DesktopWorkspaceScope) {
  return `
    <div class="workspace-scope-switch">
      <button
        class="${scope === 'remote' ? 'scope-button-active' : 'ghost-button'}"
        data-action="set-scope"
        data-scope="remote"
        type="button"
      >
        Remote workspaces
      </button>
      <button
        class="${scope === 'local' ? 'scope-button-active' : 'ghost-button'}"
        data-action="set-scope"
        data-scope="local"
        type="button"
      >
        Local workspaces
      </button>
    </div>
  `
}

function renderDesktopShell(state: DesktopOperatorState) {
  const visibleWorkspaces = getVisibleWorkspaces(state)
  const pendingApprovals = state.dashboard.approvals.filter(
    (approval) => approval.status === 'pending',
  )

  return `
    <div class="desktop-shell">
      <section class="hero-card">
        <div>
          <p class="eyebrow">RemoteAgentServer</p>
          <h1>Desktop Console</h1>
          <p class="support-copy">
            A primary desktop control surface for local and remote operator work, with session controls, live updates, approvals, and forwarded previews in one app.
          </p>
        </div>
        <div class="hero-row">
          ${renderMetric('Hosts', state.dashboard.hosts.length)}
          ${renderMetric('Workspaces', state.dashboard.workspaces.length)}
          ${renderMetric('Sessions', state.dashboard.sessions.length)}
          ${renderMetric('Pending approvals', pendingApprovals.length)}
        </div>
      </section>

      <section class="content-grid">
        <article class="section-stack">
          <section class="surface-card">
            <p class="eyebrow">Connection</p>
            <h2>Desktop sign-in</h2>
            <p class="support-copy">
              The Electron app saves the control-plane URL and operator token in the app data directory with Electron safeStorage when the OS supports it.
            </p>
            <form class="connection-form" data-role="connect-form">
              <div class="field-row">
                <label>
                  <span>Server URL</span>
                  <input
                    name="baseUrl"
                    type="url"
                    value="${escapeHtml(state.connection?.baseUrl ?? '')}"
                    placeholder="http://127.0.0.1:4318"
                    required
                  />
                </label>
                <label>
                  <span>Operator token</span>
                  <input
                    name="token"
                    type="password"
                    value="${escapeHtml(state.connection?.token ?? '')}"
                    required
                  />
                </label>
              </div>
              <div class="button-row">
                <button class="accent-button" type="submit">
                  ${state.phase === 'connecting' ? 'Connecting…' : state.connection ? 'Reconnect' : 'Connect'}
                </button>
                <button class="secondary-button" data-action="refresh" type="button" ${state.phase === 'ready' ? '' : 'disabled'}>
                  Refresh
                </button>
                <button class="ghost-button" data-action="forget-connection" type="button" ${state.connection ? '' : 'disabled'}>
                  Sign out
                </button>
              </div>
            </form>
            <div class="button-row">
              <span class="status-pill ${escapeHtml(state.liveConnection)}">${escapeHtml(state.liveConnection)}</span>
              ${state.error ? `<p class="error-text">${escapeHtml(state.error)}</p>` : ''}
            </div>
          </section>

          <section class="surface-card">
            <p class="eyebrow">Workspaces</p>
            <h2>Switch local and remote repos</h2>
            <p class="support-copy">
              The desktop app keeps local and remote workspaces in one inventory. Change the scope, pick a workspace, then start a session from this panel.
            </p>
            ${renderWorkspaceScopeButtons(state.workspaceScope)}
            <p class="meta-copy">Current target ${escapeHtml(getSelectedWorkspaceLabel(state) ?? 'No workspace selected')}</p>
            <form class="session-form" data-role="start-session-form">
              <div class="field-row">
                <label>
                  <span>Workspace</span>
                  <select name="workspaceId" ${visibleWorkspaces.length === 0 ? 'disabled' : ''}>
                    ${visibleWorkspaces
                      .map(
                        (workspace) => `
                          <option value="${escapeHtml(workspace.id)}" ${workspace.id === state.selectedWorkspaceId ? 'selected' : ''}>
                            ${escapeHtml(workspace.id)}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <label>
                  <span>Provider</span>
                  <select name="provider">
                    ${providerKinds
                      .map(
                        (provider) => `
                          <option value="${escapeHtml(provider)}" ${provider === 'codex' ? 'selected' : ''}>
                            ${escapeHtml(getProviderDisplayName(provider))}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <label>
                  <span>Execution mode</span>
                  <select name="mode">
                    <option value="workspace" selected>Direct workspace</option>
                    <option value="worktree">Isolated worktree</option>
                  </select>
                </label>
              </div>
              <div class="button-row">
                <button
                  class="accent-button"
                  type="submit"
                  ${visibleWorkspaces.length === 0 ? 'disabled' : ''}
                >
                  ${
                    state.busySessionAction === 'create'
                      ? 'Starting…'
                      : `Start ${escapeHtml(state.workspaceScope)} session`
                  }
                </button>
              </div>
            </form>
            <div class="inventory-grid">${renderWorkspaces(state)}</div>
          </section>
        </article>

        <article class="section-stack">
          <section class="surface-card">
            <p class="eyebrow">Hosts</p>
            <h2>Connected runtimes</h2>
            <div class="inventory-grid">${renderHosts(state)}</div>
          </section>

          <section class="surface-card">
            <p class="eyebrow">Events</p>
            <h2>Live session stream</h2>
            ${renderEvents(state)}
          </section>
        </article>
      </section>

      <section class="content-grid">
        <section class="surface-card">
          <p class="eyebrow">Sessions</p>
          <h2>Manage active runs</h2>
          <div class="session-grid">${renderSessions(state)}</div>
        </section>

        <section class="section-stack">
          <section class="surface-card">
            <p class="eyebrow">Approvals</p>
            <h2>Privileged actions</h2>
            <div class="approval-grid">${renderApprovals(state)}</div>
          </section>
          <section class="surface-card">
            <p class="eyebrow">Previews</p>
            <h2>Forwarded HTTP services</h2>
            <div class="port-grid">${renderPorts(state)}</div>
          </section>
        </section>
      </section>
    </div>
  `
}

function ensureStyles(document: Document) {
  if (document.getElementById(styleTagId)) {
    return
  }

  const styleTag = document.createElement('style')
  styleTag.id = styleTagId
  styleTag.textContent = desktopStyles
  document.head.append(styleTag)
}

function resolveBridge(options?: RenderDesktopAppOptions) {
  const bridge = options?.bridge ?? globalThis.window?.remoteAgentDesktopBridge
  if (!bridge) {
    throw new Error('Desktop bridge is unavailable in this renderer context.')
  }

  return bridge
}

export function renderDesktopApp(
  container: HTMLElement,
  options?: RenderDesktopAppOptions,
) {
  ensureStyles(container.ownerDocument)

  const bridge = resolveBridge(options)
  const controller = new DesktopOperatorController({
    createClient: (settings) =>
      createDesktopControlPlaneClient({
        ...settings,
        fetch: options?.fetch,
      }),
    previewOpener: bridge.preview,
    settingsStore: bridge.connectionSettings,
  })
  let destroyed = false
  const recentEvents: string[] = []

  function render() {
    const state = controller.getState()
    const eventState = {
      ...state,
      lastEventType: recentEvents[0] ?? state.lastEventType,
    } satisfies DesktopOperatorState

    container.dataset.desktopShell = 'true'
    container.innerHTML = renderDesktopShell(eventState)
  }

  const unsubscribe = controller.subscribe(() => {
    if (destroyed) {
      return
    }

    const eventType = controller.getState().lastEventType
    if (eventType) {
      recentEvents.unshift(eventType)
      recentEvents.splice(maxVisibleEvents)
    }
    render()
  })

  container.addEventListener('submit', (event) => {
    const target = event.target
    if (!(target instanceof HTMLFormElement)) {
      return
    }

    if (target.dataset.role === 'connect-form') {
      event.preventDefault()
      const formData = new FormData(target)
      const baseUrl = formData.get('baseUrl')
      const token = formData.get('token')
      if (typeof baseUrl === 'string' && typeof token === 'string') {
        void controller.connect({ baseUrl, token })
      }
      return
    }

    if (target.dataset.role === 'start-session-form') {
      event.preventDefault()
      const formData = new FormData(target)
      const workspaceId = formData.get('workspaceId')
      const provider = formData.get('provider')
      const mode = formData.get('mode')
      if (
        typeof workspaceId === 'string' &&
        typeof provider === 'string' &&
        typeof mode === 'string'
      ) {
        void controller.startSession({
          mode: mode === 'worktree' ? 'worktree' : 'workspace',
          provider: provider as (typeof providerKinds)[number],
          workspaceId,
        })
      }
    }
  })

  container.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLSelectElement)) {
      return
    }

    if (target.name === 'workspaceId') {
      controller.selectWorkspace(target.value)
    }
  })

  container.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) {
      return
    }

    const actionButton = target.closest<HTMLElement>('[data-action]')
    if (!actionButton) {
      return
    }

    const action = actionButton.dataset.action
    if (action === 'approval-decision') {
      const approvalId = actionButton.dataset.approvalId
      const status = actionButton.dataset.status
      if (
        approvalId &&
        (status === 'approved' || status === 'rejected')
      ) {
        void controller.decideApproval(approvalId, status)
      }
      return
    }

    if (action === 'forget-connection') {
      void controller.forgetConnection()
      return
    }

    if (action === 'open-preview') {
      const portId = actionButton.dataset.portId
      if (portId) {
        void controller.openPreview(portId)
      }
      return
    }

    if (action === 'refresh') {
      void controller.refresh()
      return
    }

    if (action === 'select-workspace') {
      const workspaceId = actionButton.dataset.workspaceId
      if (workspaceId) {
        controller.selectWorkspace(workspaceId)
      }
      return
    }

    if (action === 'session-control') {
      const sessionAction = actionButton.dataset.sessionAction
      const sessionId = actionButton.dataset.sessionId
      if (
        sessionId &&
        (sessionAction === 'pause' ||
          sessionAction === 'resume' ||
          sessionAction === 'cancel')
      ) {
        void controller.controlSession(sessionId, sessionAction)
      }
      return
    }

    if (action === 'set-scope') {
      const scope = actionButton.dataset.scope
      if (scope === 'local' || scope === 'remote') {
        controller.setWorkspaceScope(scope)
      }
    }
  })

  render()
  void controller.bootstrap()

  return {
    destroy() {
      destroyed = true
      unsubscribe()
      controller.destroy()
      container.innerHTML = ''
    },
  }
}
