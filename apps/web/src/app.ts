import type { ProviderApprovalRecord } from '@remote-agent-server/providers'
import type { SessionChangeSet, SessionDiffPage } from '@remote-agent-server/sessions'
import {
  createControlPlaneClient,
  getProviderLabel,
  type ControlPlaneClient,
  type ControlPlaneClientOptions,
  type ControlPlaneEventRecord,
  type EventStreamHandle,
  type ForwardedPortRecord,
  type HostRecord,
  type SessionRecord,
  type WorkspaceRecord,
} from './client.js'

const storageKey = 'remote-agent-server-web-connection-v1'
const notificationPreferencesStorageKey =
  'remote-agent-server-web-notifications-v1'
const maxVisibleEvents = 16
const diffPageSize = 28
const reconnectDelayMs = 1500
const recentHistoryLimit = 4
const notificationCategories = [
  'approval-required',
  'session-failed',
  'session-completed',
] as const

type WebNotificationCategory = (typeof notificationCategories)[number]

interface BrowserNotificationPayload {
  deepLink?: string
  sessionId?: string
}

interface BrowserNotificationOptions {
  body: string
  data?: BrowserNotificationPayload
  tag?: string
}

interface BrowserNotificationHandle {
  close?: () => void
  onclick: ((event?: Event) => void) | null
}

export interface BrowserNotificationApi {
  getPermission(): NotificationPermission | 'unsupported'
  isSupported(): boolean
  requestPermission(): Promise<NotificationPermission>
  show(
    title: string,
    options: BrowserNotificationOptions,
  ): BrowserNotificationHandle | undefined
}

interface ConnectionSettings {
  baseUrl: string
  token: string
}

interface DashboardData {
  hosts: HostRecord[]
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  approvals: ProviderApprovalRecord[]
  forwardedPorts: ForwardedPortRecord[]
  detectedPorts: ForwardedPortRecord[]
}

interface ReviewState {
  sessionId: string
  selectedPath?: string
  changes?: SessionChangeSet
  diff?: SessionDiffPage
  loading: boolean
  error?: string
}

interface NotificationPreferences {
  enabled: boolean
  categories: Record<WebNotificationCategory, boolean>
}

interface AttentionNotification {
  body: string
  category: WebNotificationCategory
  deepLink?: string
  sessionId?: string
  tag: string
  title: string
}

interface WebClientState {
  connection?: ConnectionSettings
  dashboard?: DashboardData
  selectedSessionId?: string
  events: ControlPlaneEventRecord[]
  lastEventId?: string
  loading: boolean
  streamStatus: 'disconnected' | 'connecting' | 'live' | 'error'
  error?: string
  review?: ReviewState
  approvalBusyId?: string
  portBusyId?: string
  notificationPermission: NotificationPermission | 'unsupported'
  notificationPreferences: NotificationPreferences
}

export interface RenderWebClientOptions {
  fetch?: typeof fetch
  notifications?: BrowserNotificationApi
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

function sortByNewest<T extends { updatedAt?: string; createdAt?: string; requestedAt?: string; timestamp?: string }>(
  records: T[],
) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(
      left.updatedAt ?? left.createdAt ?? left.requestedAt ?? left.timestamp ?? '',
    )
    const rightTime = Date.parse(
      right.updatedAt ?? right.createdAt ?? right.requestedAt ?? right.timestamp ?? '',
    )
    return rightTime - leftTime
  })
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
    return 'N/A'
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return value
  }

  return new Date(parsed).toLocaleString()
}

function formatSessionMode(session: SessionRecord) {
  return session.mode === 'worktree' ? 'Isolated worktree' : 'Direct workspace'
}

function formatHostLocation(host: HostRecord) {
  return host.hostMode === 'local' ? 'Local' : 'Remote'
}

function formatHostConnection(host: HostRecord) {
  return host.connectionMode === 'attached' ? 'Attached runtime' : 'Registered runtime'
}

function formatOutputPreview(text: string) {
  return text.trim().replaceAll('\n', ' ')
}

function createDefaultNotificationPreferences(): NotificationPreferences {
  return {
    enabled: false,
    categories: {
      'approval-required': true,
      'session-completed': true,
      'session-failed': true,
    },
  }
}

function getNotificationCategoryLabel(category: WebNotificationCategory) {
  switch (category) {
    case 'approval-required':
      return 'Approval required'
    case 'session-completed':
      return 'Completed sessions'
    case 'session-failed':
      return 'Failed sessions'
  }
}

function getNotificationCategoryDescription(category: WebNotificationCategory) {
  switch (category) {
    case 'approval-required':
      return 'Alert when a privileged action needs a decision.'
    case 'session-completed':
      return 'Alert when an agent run finishes successfully.'
    case 'session-failed':
      return 'Alert when a session exits with an error.'
  }
}

function getSessionDeepLink(sessionId: string) {
  return `#session=${encodeURIComponent(sessionId)}`
}

function readSessionIdFromHash() {
  const hash = globalThis.location?.hash
  if (!hash) {
    return undefined
  }

  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const sessionId = params.get('session')
  return sessionId && sessionId.trim().length > 0 ? sessionId : undefined
}

function writeSessionIdToHash(sessionId?: string) {
  if (!globalThis.location) {
    return
  }

  if (!sessionId) {
    globalThis.history?.replaceState?.(
      null,
      '',
      `${globalThis.location.pathname}${globalThis.location.search}`,
    )
    return
  }

  globalThis.location.hash = `session=${encodeURIComponent(sessionId)}`
}

function createDefaultBrowserNotificationApi(): BrowserNotificationApi {
  return {
    getPermission() {
      return typeof Notification === 'undefined'
        ? 'unsupported'
        : Notification.permission
    },
    isSupported() {
      return typeof Notification !== 'undefined'
    },
    async requestPermission() {
      if (typeof Notification === 'undefined') {
        return 'denied'
      }

      return await Notification.requestPermission()
    },
    show(title, options) {
      if (typeof Notification === 'undefined') {
        return undefined
      }

      const notification = new Notification(title, {
        body: options.body,
        data: options.data,
        tag: options.tag,
      })

      let clickHandler: ((event?: Event) => void) | null = null

      notification.onclick = (event) => {
        clickHandler?.(event)
      }

      return {
        close() {
          notification.close()
        },
        get onclick() {
          return clickHandler
        },
        set onclick(value) {
          clickHandler = value
        },
      }
    },
  }
}

function createAttentionNotification(
  event: ControlPlaneEventRecord,
): AttentionNotification | undefined {
  if (event.envelope.type === 'approval.requested') {
    const approval = event.envelope.payload as ProviderApprovalRecord

    return {
      body: approval.message,
      category: 'approval-required',
      deepLink: getSessionDeepLink(approval.sessionId),
      sessionId: approval.sessionId,
      tag: `approval-${approval.id}`,
      title: 'Approval required',
    }
  }

  if (event.envelope.type !== 'session.state.changed') {
    return undefined
  }

  const payload = event.envelope.payload as {
    detail?: string
    session?: SessionRecord
  }
  const session = payload.session
  if (!session) {
    return undefined
  }

  if (session.state === 'completed') {
    return {
      body: payload.detail ?? `${session.id} completed successfully.`,
      category: 'session-completed',
      deepLink: getSessionDeepLink(session.id),
      sessionId: session.id,
      tag: `session-completed-${session.id}`,
      title: 'Session completed',
    }
  }

  if (session.state === 'failed') {
    return {
      body: payload.detail ?? `${session.id} failed.`,
      category: 'session-failed',
      deepLink: getSessionDeepLink(session.id),
      sessionId: session.id,
      tag: `session-failed-${session.id}`,
      title: 'Session failed',
    }
  }

  return undefined
}

function renderCount(label: string, value: number) {
  return `
    <article class="overview-card">
      <p class="eyebrow">${escapeHtml(label)}</p>
      <p class="overview-value">${value}</p>
    </article>
  `
}

function renderHosts(hosts: HostRecord[]) {
  if (hosts.length === 0) {
    return '<p class="empty-state">No enrolled hosts.</p>'
  }

  return hosts
    .map(
      (host) => `
        <article class="surface-card inventory-card">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(host.name)}</h3>
              <p>${escapeHtml(formatHostLocation(host))} • ${escapeHtml(formatHostConnection(host))}</p>
            </div>
            <span class="status-pill ${escapeHtml(host.status)}">${escapeHtml(host.status)}</span>
          </header>
          <dl class="meta-grid">
            <div><dt>Runtime</dt><dd>${escapeHtml(host.platform)} • ${escapeHtml(host.runtimeVersion)}</dd></div>
            <div><dt>Host</dt><dd>${escapeHtml(host.id)}</dd></div>
            <div><dt>Health</dt><dd>${escapeHtml(host.health)}</dd></div>
            <div><dt>Connectivity</dt><dd>${escapeHtml(host.connectivity)}</dd></div>
            <div><dt>Registered</dt><dd>${escapeHtml(formatTimestamp(host.registeredAt))}</dd></div>
            <div><dt>Seen</dt><dd>${escapeHtml(formatTimestamp(host.lastSeenAt))}</dd></div>
          </dl>
        </article>
      `,
    )
    .join('')
}

function renderWorkspaces(workspaces: WorkspaceRecord[]) {
  if (workspaces.length === 0) {
    return '<p class="empty-state">No registered workspaces.</p>'
  }

  return workspaces
    .map(
      (workspace) => `
        <article class="surface-card inventory-card">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(workspace.id)}</h3>
              <p>${escapeHtml(workspace.defaultBranch)} on ${escapeHtml(workspace.hostId)}</p>
            </div>
            <span class="runtime-tag">${escapeHtml(workspace.runtimeHostId)}</span>
          </header>
          <p class="code-path">${escapeHtml(workspace.path)}</p>
          <p class="minor-text">Created ${escapeHtml(formatTimestamp(workspace.createdAt))}</p>
        </article>
      `,
    )
    .join('')
}

function renderSessions(sessions: SessionRecord[], selectedSessionId?: string) {
  if (sessions.length === 0) {
    return '<p class="empty-state">No sessions yet.</p>'
  }

  return sortByNewest(sessions)
    .map(
      (session) => `
        <article class="surface-card inventory-card session-card ${selectedSessionId === session.id ? 'selected-session' : ''}">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(session.id)}</h3>
              <p>${escapeHtml(getProviderLabel(session.provider as 'claude-code' | 'codex' | 'opencode'))}</p>
            </div>
            <span class="status-pill ${escapeHtml(session.state)}">${escapeHtml(session.state)}</span>
          </header>
          <dl class="meta-grid">
            <div><dt>Workspace</dt><dd>${escapeHtml(session.workspaceId)}</dd></div>
            <div><dt>Execution</dt><dd>${escapeHtml(formatSessionMode(session))}</dd></div>
            <div><dt>Updated</dt><dd>${escapeHtml(formatTimestamp(session.updatedAt))}</dd></div>
            <div><dt>Output lines</dt><dd>${session.output.length}</dd></div>
          </dl>
          <p class="code-path">${escapeHtml(session.executionPath)}</p>
          <div class="card-actions">
            <button class="accent-button" data-action="resume-session" data-session-id="${escapeHtml(session.id)}">
              ${selectedSessionId === session.id ? 'Context open' : 'Resume context'}
            </button>
            <button class="secondary-button" data-action="review-session" data-session-id="${escapeHtml(session.id)}">
              Review diff
            </button>
          </div>
        </article>
      `,
    )
    .join('')
}

function renderSessionHistory(session?: SessionRecord) {
  if (!session) {
    return '<p class="empty-state">Pick a session to reopen its recovered state, recent logs, and recent messages.</p>'
  }

  const recentLogs = session.logs.slice(-recentHistoryLimit).reverse()
  const recentOutput = session.output.slice(-recentHistoryLimit).reverse()

  return `
    <div class="history-stack">
      <article class="inventory-card session-history-card">
        <header class="inventory-header">
          <div>
            <p class="eyebrow">Recovered session</p>
            <h3>${escapeHtml(session.id)}</h3>
            <p>${escapeHtml(getProviderLabel(session.provider as 'claude-code' | 'codex' | 'opencode'))}</p>
          </div>
          <span class="status-pill ${escapeHtml(session.state)}">${escapeHtml(session.state)}</span>
        </header>
        <dl class="meta-grid">
          <div><dt>Workspace</dt><dd>${escapeHtml(session.workspaceId)}</dd></div>
          <div><dt>Mode</dt><dd>${escapeHtml(formatSessionMode(session))}</dd></div>
          <div><dt>Created</dt><dd>${escapeHtml(formatTimestamp(session.createdAt))}</dd></div>
          <div><dt>Updated</dt><dd>${escapeHtml(formatTimestamp(session.updatedAt))}</dd></div>
          <div><dt>Started</dt><dd>${escapeHtml(formatTimestamp(session.startedAt))}</dd></div>
          <div><dt>Completed</dt><dd>${escapeHtml(formatTimestamp(session.completedAt))}</dd></div>
        </dl>
        <p class="code-path">${escapeHtml(session.workspacePath)}</p>
      </article>
      <div class="history-grid">
        <section>
          <p class="eyebrow">Recent logs</p>
          ${
            recentLogs.length === 0
              ? '<p class="empty-state compact-empty-state">No logs recovered yet.</p>'
              : `
                <div class="history-list">
                  ${recentLogs
                    .map(
                      (entry) => `
                        <article class="history-entry">
                          <p class="event-type">${escapeHtml(entry.level)} • ${escapeHtml(formatTimestamp(entry.timestamp))}</p>
                          <p>${escapeHtml(entry.message)}</p>
                        </article>
                      `,
                    )
                    .join('')}
                </div>
              `
          }
        </section>
        <section>
          <p class="eyebrow">Recent messages</p>
          ${
            recentOutput.length === 0
              ? '<p class="empty-state compact-empty-state">No output recovered yet.</p>'
              : `
                <div class="history-list">
                  ${recentOutput
                    .map(
                      (entry) => `
                        <article class="history-entry">
                          <p class="event-type">${escapeHtml(entry.stream)} • ${escapeHtml(formatTimestamp(entry.timestamp))}</p>
                          <p>${escapeHtml(formatOutputPreview(entry.text))}</p>
                        </article>
                      `,
                    )
                    .join('')}
                </div>
              `
          }
        </section>
      </div>
    </div>
  `
}

function renderApprovals(approvals: ProviderApprovalRecord[], busyId?: string) {
  if (approvals.length === 0) {
    return '<p class="empty-state">No approvals waiting.</p>'
  }

  return approvals
    .map((approval) => {
      const pending = approval.status === 'pending'
      return `
        <article class="surface-card approval-card">
          <header class="inventory-header">
            <div>
              <h3>${escapeHtml(approval.action)}</h3>
              <p>${escapeHtml(approval.sessionId)} • ${escapeHtml(getProviderLabel(approval.provider))}</p>
            </div>
            <span class="status-pill ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
          </header>
          <p>${escapeHtml(approval.message)}</p>
          <p class="minor-text">Requested ${escapeHtml(formatTimestamp(approval.requestedAt))}</p>
          ${
            pending
              ? `
                <div class="card-actions">
                  <button
                    class="accent-button"
                    data-action="approval-decision"
                    data-approval-id="${escapeHtml(approval.id)}"
                    data-status="approved"
                    ${busyId === approval.id ? 'disabled' : ''}
                  >
                    ${busyId === approval.id ? 'Sending…' : 'Approve'}
                  </button>
                  <button
                    class="ghost-button"
                    data-action="approval-decision"
                    data-approval-id="${escapeHtml(approval.id)}"
                    data-status="rejected"
                    ${busyId === approval.id ? 'disabled' : ''}
                  >
                    Reject
                  </button>
                </div>
              `
              : `<p class="minor-text">Decided ${escapeHtml(formatTimestamp(approval.decidedAt))}</p>`
          }
        </article>
      `
    })
    .join('')
}

function renderPortCard(port: ForwardedPortRecord) {
  const previewLink =
    port.protocol === 'http' && port.managedUrl
      ? `<a class="preview-link" href="${escapeHtml(port.managedUrl)}" target="_blank" rel="noreferrer">Open preview</a>`
      : '<span class="minor-text">TCP forward</span>'

  return `
    <article class="surface-card port-card">
      <header class="inventory-header">
        <div>
          <h3>${escapeHtml(port.label)}</h3>
          <p>${escapeHtml(port.targetHost)}:${port.port}</p>
        </div>
        <span class="status-pill ${escapeHtml(port.forwardingState ?? port.state)}">${escapeHtml(port.forwardingState ?? port.state)}</span>
      </header>
      <dl class="meta-grid">
        <div><dt>Visibility</dt><dd>${escapeHtml(port.visibility)}</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(port.sessionId ?? port.workspaceId ?? port.hostId)}</dd></div>
      </dl>
      <div class="card-actions">
        ${previewLink}
      </div>
    </article>
  `
}

function renderDetectedPortCard(port: ForwardedPortRecord, busyId?: string) {
  return `
    <article class="surface-card port-card detected-port">
      <header class="inventory-header">
        <div>
          <h3>${escapeHtml(port.label)}</h3>
          <p>${escapeHtml(port.targetHost)}:${port.port}</p>
        </div>
        <span class="status-pill detected">${escapeHtml(port.state)}</span>
      </header>
      <dl class="meta-grid">
        <div><dt>Visibility</dt><dd>${escapeHtml(port.visibility)}</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(port.sessionId ?? port.workspaceId ?? port.hostId)}</dd></div>
      </dl>
      <p class="minor-text">Detected only. Not externally exposed until promoted to a managed forward.</p>
      <div class="card-actions">
        <button
          class="accent-button"
          data-action="promote-port"
          data-port-id="${escapeHtml(port.id)}"
          ${busyId === port.id ? 'disabled' : ''}
        >
          ${busyId === port.id ? 'Opening…' : 'Open forward'}
        </button>
      </div>
    </article>
  `
}

function renderReview(review?: ReviewState) {
  if (!review) {
    return '<p class="empty-state">Pick a session to inspect its changed files and patch pages.</p>'
  }

  if (review.loading) {
    return '<p class="empty-state">Loading review data…</p>'
  }

  if (review.error) {
    return `<p class="empty-state error-text">${escapeHtml(review.error)}</p>`
  }

  const changes = review.changes
  if (!changes || changes.files.length === 0) {
    return '<p class="empty-state">No changed files were found for this session.</p>'
  }

  const diff = review.diff
  return `
    <div class="review-shell">
      <div class="review-sidebar">
        <p class="eyebrow">Patch summary</p>
        <pre class="summary-block">${escapeHtml(changes.summary.text)}</pre>
        <div class="file-list">
          ${changes.files
            .map(
              (file) => `
                <button
                  class="file-chip ${review.selectedPath === file.path ? 'selected' : ''}"
                  data-action="select-diff-path"
                  data-session-id="${escapeHtml(review.sessionId)}"
                  data-path="${escapeHtml(file.path)}"
                >
                  <span>${escapeHtml(file.kind.toUpperCase())}</span>
                  <strong>${escapeHtml(file.path)}</strong>
                </button>
              `,
            )
            .join('')}
        </div>
      </div>
      <div class="review-main">
        <div class="review-toolbar">
          <div>
            <p class="eyebrow">Diff page</p>
            <h3>${escapeHtml(diff?.path ?? review.selectedPath ?? 'Combined diff')}</h3>
          </div>
          ${
            diff
              ? `
                <div class="pagination">
                  <button
                    class="ghost-button"
                    data-action="page-diff"
                    data-session-id="${escapeHtml(review.sessionId)}"
                    data-page="${diff.previousPage ?? diff.page}"
                    ${diff.previousPage === undefined ? 'disabled' : ''}
                  >
                    Previous
                  </button>
                  <span>Page ${diff.page} / ${diff.totalPages}</span>
                  <button
                    class="ghost-button"
                    data-action="page-diff"
                    data-session-id="${escapeHtml(review.sessionId)}"
                    data-page="${diff.nextPage ?? diff.page}"
                    ${diff.nextPage === undefined ? 'disabled' : ''}
                  >
                    Next
                  </button>
                </div>
              `
              : ''
          }
        </div>
        <pre class="diff-block">${escapeHtml(diff?.text ?? changes.summary.text)}</pre>
      </div>
    </div>
  `
}

function renderEvents(events: ControlPlaneEventRecord[]) {
  if (events.length === 0) {
    return '<p class="empty-state">No live events received yet.</p>'
  }

  return events
    .map(
      (event) => `
        <article class="event-row">
          <p class="event-type">${escapeHtml(event.envelope.type)}</p>
          <p class="minor-text">${escapeHtml(formatTimestamp(event.timestamp))}</p>
        </article>
      `,
    )
    .join('')
}

function renderConnectionCard(state: WebClientState) {
  const connection = state.connection
  const permissionLabel =
    state.notificationPermission === 'unsupported'
      ? 'unsupported'
      : state.notificationPreferences.enabled
        ? 'enabled'
        : state.notificationPermission
  const permissionTone =
    state.notificationPermission === 'granted' && state.notificationPreferences.enabled
      ? 'live'
      : state.notificationPermission === 'denied'
        ? 'error'
        : 'disconnected'
  const permissionCopy =
    state.notificationPermission === 'unsupported'
      ? 'Browser notifications are unavailable in this environment.'
      : state.notificationPermission === 'granted'
        ? state.notificationPreferences.enabled
          ? 'Browser alerts are active for the selected categories.'
          : 'Browser permission is granted. Alerts are currently muted.'
        : state.notificationPermission === 'denied'
          ? 'Browser permission is blocked. Re-enable notifications in the browser to use alerts.'
          : 'Enable browser permission to receive approval, failure, and completion alerts.'
  return `
    <section class="surface-card connection-panel">
      <div>
        <p class="eyebrow">Operator access</p>
        <h2>Attach this browser to any control plane.</h2>
        <p class="panel-copy">
          Use the server URL and an operator token. The web client stores them in local browser storage for this single-user setup.
        </p>
      </div>
      <form data-role="connect-form" class="connect-form">
        <label>
          <span>Server URL</span>
          <input name="baseUrl" type="url" placeholder="http://127.0.0.1:4318" value="${escapeHtml(connection?.baseUrl ?? '')}" required />
        </label>
        <label>
          <span>Operator token</span>
          <input name="token" type="password" value="${escapeHtml(connection?.token ?? '')}" required />
        </label>
        <div class="card-actions">
          <button class="accent-button" type="submit">${state.loading ? 'Connecting…' : connection ? 'Reconnect' : 'Sign in'}</button>
          <button class="secondary-button" type="button" data-action="refresh-dashboard" ${connection ? '' : 'disabled'}>
            Refresh
          </button>
          <button class="ghost-button" type="button" data-action="sign-out" ${connection ? '' : 'disabled'}>
            Sign out
          </button>
        </div>
      </form>
      <div class="connection-meta">
        <span class="status-pill ${escapeHtml(state.streamStatus)}">${escapeHtml(state.streamStatus)}</span>
        ${state.error ? `<p class="error-text">${escapeHtml(state.error)}</p>` : ''}
      </div>
      <div class="notification-panel">
        <div>
          <p class="eyebrow">Attention alerts</p>
          <h3>Browser notifications</h3>
          <p class="minor-text">
            Opt in on this browser, mute categories independently, and click alerts to reopen the related session context.
          </p>
        </div>
        <div class="notification-actions">
          <span class="status-pill ${escapeHtml(permissionTone)}">${escapeHtml(permissionLabel)}</span>
          <button
            class="${state.notificationPreferences.enabled ? 'ghost-button' : 'accent-button'}"
            type="button"
            data-action="toggle-browser-notifications"
            ${state.notificationPermission === 'unsupported' ? 'disabled' : ''}
          >
            ${state.notificationPreferences.enabled ? 'Mute browser alerts' : 'Enable browser alerts'}
          </button>
        </div>
        <p class="minor-text">${escapeHtml(permissionCopy)}</p>
        <div class="notification-grid">
          ${notificationCategories
            .map(
              (category) => `
                <label class="notification-toggle">
                  <input
                    type="checkbox"
                    data-action="toggle-notification-category"
                    data-category="${escapeHtml(category)}"
                    ${state.notificationPreferences.categories[category] ? 'checked' : ''}
                    ${state.notificationPermission === 'unsupported' ? 'disabled' : ''}
                  />
                  <span>${escapeHtml(getNotificationCategoryLabel(category))}</span>
                  <small>${escapeHtml(getNotificationCategoryDescription(category))}</small>
                </label>
              `,
            )
            .join('')}
        </div>
      </div>
    </section>
  `
}

function renderAppShell(state: WebClientState) {
  const dashboard = state.dashboard
  const approvals = dashboard?.approvals ?? []
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending')
  const forwardedPorts = dashboard?.forwardedPorts ?? []
  const detectedPorts = dashboard?.detectedPorts ?? []

  return `
    <div class="console-shell">
      <section class="hero-panel">
        <div class="hero-copy">
          <p class="eyebrow">RemoteAgentServer</p>
          <h1>Web Console</h1>
          <p>
            A browser-based operator surface for sessions, approvals, forwarded previews, and live session events.
          </p>
        </div>
        <div class="overview-grid">
          ${renderCount('Hosts', dashboard?.hosts.length ?? 0)}
          ${renderCount('Workspaces', dashboard?.workspaces.length ?? 0)}
          ${renderCount('Sessions', dashboard?.sessions.length ?? 0)}
          ${renderCount('Pending approvals', pendingApprovals.length)}
          ${renderCount('Forwarded ports', forwardedPorts.length)}
          ${renderCount('Detected ports', detectedPorts.length)}
        </div>
      </section>

      ${renderConnectionCard(state)}

      <section class="content-grid">
        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Hosts</p>
            <h2>Enrolled machines</h2>
          </header>
          <div class="panel-list">${renderHosts(dashboard?.hosts ?? [])}</div>
        </article>

        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Workspaces</p>
            <h2>Managed repositories</h2>
          </header>
          <div class="panel-list">${renderWorkspaces(dashboard?.workspaces ?? [])}</div>
        </article>
      </section>

      <section class="content-grid">
        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Sessions</p>
            <h2>Active and historical runs</h2>
          </header>
          <div class="panel-list">${renderSessions(dashboard?.sessions ?? [], state.selectedSessionId)}</div>
        </article>

        <article class="panel-stack review-panel">
          <header class="section-header">
            <p class="eyebrow">Session recovery</p>
            <h2>Recovered context and diffs</h2>
          </header>
          ${renderSessionHistory(
            dashboard?.sessions.find((session) => session.id === state.selectedSessionId),
          )}
          <div class="panel-divider"></div>
          <header class="section-header compact-section-header">
            <p class="eyebrow">Diff review</p>
            <h2>Changed files and patch pages</h2>
          </header>
          ${renderReview(state.review)}
        </article>
      </section>

      <section class="content-grid">
        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Approvals</p>
            <h2>Privileged actions</h2>
          </header>
          <div class="panel-list">${renderApprovals(sortByNewest(approvals), state.approvalBusyId)}</div>
        </article>

        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Forwarded previews</p>
            <h2>HTTP and TCP forwards</h2>
          </header>
          <div class="panel-list">
            ${
              forwardedPorts.length === 0
                ? '<p class="empty-state">No forwarded ports are registered.</p>'
                : forwardedPorts.map((port) => renderPortCard(port)).join('')
            }
          </div>
        </article>
      </section>

      <section class="content-grid">
        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Detected ports</p>
            <h2>Suggestions from runtimes</h2>
          </header>
          <div class="panel-list">
            ${
              detectedPorts.length === 0
                ? '<p class="empty-state">No detected ports are visible.</p>'
                : detectedPorts
                    .map((port) => renderDetectedPortCard(port, state.portBusyId))
                    .join('')
            }
          </div>
        </article>

        <article class="panel-stack">
          <header class="section-header">
            <p class="eyebrow">Live stream</p>
            <h2>Session events</h2>
          </header>
          <div class="events-panel">${renderEvents(state.events)}</div>
        </article>
      </section>
    </div>
  `
}

function safeStorage(options?: RenderWebClientOptions) {
  return options?.storage ?? globalThis.localStorage
}

function readStoredConnection(options?: RenderWebClientOptions) {
  try {
    const storage = safeStorage(options)
    const raw = storage.getItem(storageKey)
    if (!raw) {
      return undefined
    }

    const parsed = JSON.parse(raw) as Partial<ConnectionSettings>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string') {
      return undefined
    }

    return {
      baseUrl: parsed.baseUrl,
      token: parsed.token,
    }
  } catch {
    return undefined
  }
}

function writeStoredConnection(connection: ConnectionSettings, options?: RenderWebClientOptions) {
  safeStorage(options).setItem(storageKey, JSON.stringify(connection))
}

function clearStoredConnection(options?: RenderWebClientOptions) {
  safeStorage(options).removeItem(storageKey)
}

function readStoredNotificationPreferences(
  options?: RenderWebClientOptions,
): NotificationPreferences {
  try {
    const raw = safeStorage(options).getItem(notificationPreferencesStorageKey)
    if (!raw) {
      return createDefaultNotificationPreferences()
    }

    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>
    const defaults = createDefaultNotificationPreferences()

    return {
      enabled: parsed.enabled === true,
      categories: {
        'approval-required':
          parsed.categories?.['approval-required'] ??
          defaults.categories['approval-required'],
        'session-completed':
          parsed.categories?.['session-completed'] ??
          defaults.categories['session-completed'],
        'session-failed':
          parsed.categories?.['session-failed'] ??
          defaults.categories['session-failed'],
      },
    }
  } catch {
    return createDefaultNotificationPreferences()
  }
}

function writeStoredNotificationPreferences(
  preferences: NotificationPreferences,
  options?: RenderWebClientOptions,
) {
  safeStorage(options).setItem(
    notificationPreferencesStorageKey,
    JSON.stringify(preferences),
  )
}

export function renderWebClient(
  container: HTMLElement,
  options?: RenderWebClientOptions,
) {
  const notificationApi =
    options?.notifications ?? createDefaultBrowserNotificationApi()
  const initialNotificationPermission = notificationApi.getPermission()
  const initialNotificationPreferences = readStoredNotificationPreferences(options)
  const state: WebClientState = {
    connection: readStoredConnection(options),
    dashboard: undefined,
    events: [],
    loading: false,
    notificationPermission: initialNotificationPermission,
    notificationPreferences: {
      ...initialNotificationPreferences,
      enabled:
        initialNotificationPermission === 'granted' &&
        initialNotificationPreferences.enabled,
    },
    selectedSessionId: readSessionIdFromHash(),
    streamStatus: 'disconnected',
  }
  let client: ControlPlaneClient | undefined
  let eventStream: EventStreamHandle | undefined
  let refreshTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let destroyed = false
  const onHashChange = () => {
    state.selectedSessionId = readSessionIdFromHash()
    render()
  }

  function writeNotificationPreferences(preferences: NotificationPreferences) {
    state.notificationPreferences = preferences
    writeStoredNotificationPreferences(preferences, options)
  }

  function selectSession(sessionId?: string) {
    state.selectedSessionId = sessionId
    writeSessionIdToHash(sessionId)
  }

  function openAttentionSession(attention: AttentionNotification) {
    if (attention.sessionId) {
      selectSession(attention.sessionId)
      render()
    }

    globalThis.focus?.()
  }

  function maybeSendBrowserNotification(event: ControlPlaneEventRecord) {
    const attention = createAttentionNotification(event)
    if (!attention) {
      return
    }

    if (
      !state.notificationPreferences.enabled ||
      state.notificationPermission !== 'granted' ||
      !state.notificationPreferences.categories[attention.category]
    ) {
      return
    }

    const notification = notificationApi.show(attention.title, {
      body: attention.body,
      data: {
        deepLink: attention.deepLink,
        sessionId: attention.sessionId,
      },
      tag: attention.tag,
    })

    if (notification) {
      notification.onclick = () => {
        openAttentionSession(attention)
      }
    }
  }

  function render() {
    container.innerHTML = renderAppShell(state)
  }

  async function refreshDashboard() {
    if (!client) {
      return
    }

    state.loading = true
    state.error = undefined
    render()

    try {
      const [hosts, workspaces, sessions, approvals, allPorts] = await Promise.all([
        client.listHosts(),
        client.listWorkspaces(),
        client.listSessions(),
        client.listApprovals(),
        client.listPorts({
          includeInactive: true,
          includeDetected: true,
        }),
      ])

      const forwardedPorts = allPorts.filter((port) => port.state === 'forwarded')
      const detectedPorts = allPorts.filter((port) => port.state === 'detected')
      state.dashboard = {
        hosts,
        workspaces,
        sessions,
        approvals,
        forwardedPorts,
        detectedPorts,
      }
      if (
        state.selectedSessionId &&
        !sessions.some((session) => session.id === state.selectedSessionId)
      ) {
        selectSession(undefined)
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Failed to load data.'
    } finally {
      state.loading = false
      render()
    }
  }

  function scheduleRefresh() {
    if (refreshTimer !== undefined) {
      globalThis.clearTimeout(refreshTimer)
    }

    refreshTimer = globalThis.setTimeout(() => {
      refreshTimer = undefined
      void refreshDashboard()
    }, 200)
  }

  function stopEventStream() {
    eventStream?.close()
    eventStream = undefined
    if (reconnectTimer !== undefined) {
      globalThis.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    state.streamStatus = 'disconnected'
  }

  function connectEvents(connection: ConnectionSettings) {
    if (!client || destroyed) {
      return
    }

    stopEventStream()
    state.streamStatus = 'connecting'
    render()

    const localClient = client
    eventStream = localClient.connectEvents((event) => {
      if (destroyed) {
        return
      }

      state.lastEventId = event.id
      state.streamStatus = 'live'
      state.events = [event, ...state.events].slice(0, maxVisibleEvents)
      maybeSendBrowserNotification(event)
      render()

      if (event.envelope.type !== 'control-plane.connected') {
        scheduleRefresh()
      }
    }, state.lastEventId)

    eventStream.done.catch((error: unknown) => {
      if (destroyed) {
        return
      }

      const candidate = error as { name?: string }
      if (candidate.name === 'AbortError') {
        return
      }

      state.streamStatus = 'error'
      state.error = error instanceof Error ? error.message : 'Live stream disconnected.'
      render()

      reconnectTimer = globalThis.setTimeout(() => {
        if (destroyed) {
          return
        }

        client = createControlPlaneClient({
          baseUrl: connection.baseUrl,
          token: connection.token,
          fetch: options?.fetch,
        } satisfies ControlPlaneClientOptions)
        connectEvents(connection)
      }, reconnectDelayMs)
    })
  }

  async function connect(connection: ConnectionSettings) {
    state.connection = {
      baseUrl: connection.baseUrl.replace(/\/+$/, ''),
      token: connection.token,
    }
    writeStoredConnection(state.connection, options)

    client = createControlPlaneClient({
      baseUrl: state.connection.baseUrl,
      token: state.connection.token,
      fetch: options?.fetch,
    })
    state.events = []
    state.lastEventId = undefined
    state.review = undefined
    state.selectedSessionId = readSessionIdFromHash()
    await refreshDashboard()
    connectEvents(state.connection)
  }

  async function toggleBrowserNotifications() {
    if (!notificationApi.isSupported()) {
      return
    }

    if (state.notificationPreferences.enabled) {
      writeNotificationPreferences({
        ...state.notificationPreferences,
        enabled: false,
      })
      render()
      return
    }

    const permission =
      state.notificationPermission === 'granted'
        ? 'granted'
        : await notificationApi.requestPermission()
    state.notificationPermission = permission

    writeNotificationPreferences({
      ...state.notificationPreferences,
      enabled: permission === 'granted',
    })
    render()
  }

  function toggleNotificationCategory(category: WebNotificationCategory) {
    writeNotificationPreferences({
      ...state.notificationPreferences,
      categories: {
        ...state.notificationPreferences.categories,
        [category]: !state.notificationPreferences.categories[category],
      },
    })
    render()
  }

  async function loadReview(sessionId: string, path?: string, page = 1) {
    if (!client) {
      return
    }

    state.review = {
      sessionId,
      selectedPath: path ?? state.review?.selectedPath,
      loading: true,
    }
    render()

    try {
      const changes = await client.listChangedFiles(sessionId)
      const selectedPath = path ?? state.review?.selectedPath ?? changes.files[0]?.path
      const diff =
        changes.files.length === 0
          ? undefined
          : await client.viewDiff(sessionId, {
              path: selectedPath,
              page,
              pageSize: diffPageSize,
            })

      state.review = {
        sessionId,
        selectedPath,
        changes,
        diff,
        loading: false,
      }
    } catch (error) {
      state.review = {
        sessionId,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load diff review.',
      }
    }

    render()
  }

  async function decideApproval(approvalId: string, status: 'approved' | 'rejected') {
    if (!client) {
      return
    }

    state.approvalBusyId = approvalId
    render()

    try {
      await client.decideApproval(approvalId, status)
      await refreshDashboard()
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Failed to send approval decision.'
    } finally {
      state.approvalBusyId = undefined
      render()
    }
  }

  async function promotePort(portId: string) {
    if (!client) {
      return
    }

    state.portBusyId = portId
    render()

    try {
      await client.openPort(portId)
      await refreshDashboard()
    } catch (error) {
      state.error =
        error instanceof Error ? error.message : 'Failed to open the detected port.'
    } finally {
      state.portBusyId = undefined
      render()
    }
  }

  container.addEventListener('submit', (event) => {
    const target = event.target
    if (!(target instanceof HTMLFormElement)) {
      return
    }

    if (target.dataset.role !== 'connect-form') {
      return
    }

    event.preventDefault()
    const formData = new FormData(target)
    const baseUrl = formData.get('baseUrl')
    const token = formData.get('token')

    if (typeof baseUrl !== 'string' || typeof token !== 'string') {
      return
    }

    void connect({
      baseUrl,
      token,
    })
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
    if (action === 'refresh-dashboard') {
      void refreshDashboard()
      return
    }

    if (action === 'sign-out') {
      clearStoredConnection(options)
      stopEventStream()
      client = undefined
      state.connection = undefined
      state.dashboard = undefined
      selectSession(undefined)
      state.events = []
      state.review = undefined
      state.error = undefined
      render()
      return
    }

    if (action === 'review-session') {
      const sessionId = actionButton.dataset.sessionId
      if (sessionId) {
        selectSession(sessionId)
        void loadReview(sessionId)
      }
      return
    }

    if (action === 'resume-session') {
      const sessionId = actionButton.dataset.sessionId
      if (sessionId) {
        selectSession(sessionId)
        render()
      }
      return
    }

    if (action === 'select-diff-path') {
      const sessionId = actionButton.dataset.sessionId
      const path = actionButton.dataset.path
      if (sessionId && path) {
        void loadReview(sessionId, path, 1)
      }
      return
    }

    if (action === 'page-diff') {
      const sessionId = actionButton.dataset.sessionId
      const page = Number(actionButton.dataset.page)
      if (sessionId && Number.isInteger(page)) {
        void loadReview(sessionId, state.review?.selectedPath, page)
      }
      return
    }

    if (action === 'approval-decision') {
      const approvalId = actionButton.dataset.approvalId
      const status = actionButton.dataset.status
      if (
        approvalId &&
        (status === 'approved' || status === 'rejected')
      ) {
        void decideApproval(approvalId, status)
      }
      return
    }

    if (action === 'promote-port') {
      const portId = actionButton.dataset.portId
      if (portId) {
        void promotePort(portId)
      }
      return
    }

    if (action === 'toggle-browser-notifications') {
      void toggleBrowserNotifications()
    }
  })

  container.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) {
      return
    }

    if (target.dataset.action !== 'toggle-notification-category') {
      return
    }

    const category = target.dataset.category as
      | WebNotificationCategory
      | undefined
    if (category && notificationCategories.includes(category)) {
      toggleNotificationCategory(category)
    }
  })

  render()
  globalThis.addEventListener?.('hashchange', onHashChange)

  if (state.connection) {
    void connect(state.connection)
  }

  return {
    destroy() {
      destroyed = true
      stopEventStream()
      globalThis.removeEventListener?.('hashchange', onHashChange)
      if (refreshTimer !== undefined) {
        globalThis.clearTimeout(refreshTimer)
      }
      container.innerHTML = ''
    },
  }
}
