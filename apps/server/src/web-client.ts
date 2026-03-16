const defaultTitle = 'Remote Agent Console'

export function renderControlPlaneWebClientDocument(title = defaultTitle) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #111417;
        --panel: #1a2024;
        --panel-soft: #21292f;
        --line: rgba(255, 255, 255, 0.08);
        --text: #f4ecd8;
        --muted: #b8b0a0;
        --accent: #f4b76b;
        --good: #83d59b;
        --bad: #ff8676;
        --mono: "IBM Plex Mono", "Menlo", monospace;
        --serif: "Iowan Old Style", "Palatino Linotype", serif;
        --sans: "Avenir Next", "Segoe UI", sans-serif;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(244, 183, 107, 0.18), transparent 28%),
          linear-gradient(180deg, #1a1e21, #101214);
        color: var(--text);
        font-family: var(--sans);
      }

      .shell {
        width: min(1400px, calc(100vw - 28px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }

      .hero,
      .card {
        border: 1px solid var(--line);
        background: rgba(26, 32, 36, 0.92);
        border-radius: 22px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
      }

      .hero {
        padding: 28px;
        margin-bottom: 18px;
      }

      .hero h1,
      .card h2 {
        margin: 0;
        font-family: var(--serif);
        font-weight: 600;
      }

      .hero h1 {
        font-size: clamp(2.4rem, 6vw, 4.6rem);
        line-height: 0.95;
        max-width: 10ch;
      }

      .eyebrow {
        margin: 0 0 10px;
        color: var(--accent);
        letter-spacing: 0.2em;
        text-transform: uppercase;
        font-size: 0.75rem;
        font-family: var(--mono);
      }

      .lede,
      .status {
        color: var(--muted);
        line-height: 1.6;
      }

      .layout {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 16px;
      }

      .card {
        padding: 20px;
      }

      .wide { grid-column: span 12; }
      .half { grid-column: span 6; }

      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
        margin-bottom: 14px;
      }

      .section-head h2 {
        font-size: 1.35rem;
      }

      .stack {
        display: grid;
        gap: 12px;
      }

      .record,
      .stat {
        border: 1px solid rgba(255, 255, 255, 0.05);
        background: var(--panel-soft);
        border-radius: 16px;
        padding: 14px 16px;
      }

      .record-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
      }

      .record h3 {
        margin: 0;
        font-size: 1rem;
      }

      .record p {
        margin: 8px 0 0;
        color: var(--muted);
      }

      .meta {
        margin-top: 10px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 0.8rem;
        font-family: var(--mono);
      }

      .badge {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.04);
        color: var(--accent);
        font-family: var(--mono);
        font-size: 0.78rem;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 12px;
      }

      .stat strong {
        display: block;
        margin-top: 10px;
        font-family: var(--serif);
        font-size: 2.1rem;
      }

      form,
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      input,
      button,
      a {
        font: inherit;
      }

      input {
        flex: 1 1 260px;
        min-width: 0;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text);
        padding: 13px 15px;
      }

      button,
      a.button {
        border-radius: 14px;
        border: 1px solid rgba(244, 183, 107, 0.35);
        background: linear-gradient(180deg, rgba(244, 183, 107, 0.24), rgba(244, 183, 107, 0.1));
        color: var(--text);
        padding: 12px 16px;
        text-decoration: none;
        cursor: pointer;
      }

      button.ghost,
      a.button.ghost {
        border-color: rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
      }

      .empty {
        border: 1px dashed rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        padding: 16px;
        color: var(--muted);
      }

      pre {
        margin: 12px 0 0;
        overflow: auto;
        padding: 14px;
        border-radius: 14px;
        background: #0d1114;
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #d8f0c8;
        font-family: var(--mono);
        font-size: 0.82rem;
        line-height: 1.45;
      }

      iframe {
        width: 100%;
        min-height: 420px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 16px;
        background: #0d1013;
      }

      @media (max-width: 1100px) {
        .half { grid-column: span 12; }
        .stats { grid-template-columns: 1fr 1fr; }
      }

      @media (max-width: 700px) {
        .shell { width: min(100vw - 20px, 100%); padding-top: 18px; }
        .hero, .card { padding: 18px; }
        .stats { grid-template-columns: 1fr; }
        .section-head, .record-head { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="hero">
        <p class="eyebrow">Browser control surface</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">Token sign-in, live session events, diff review, approval decisions, and forwarded HTTP previews from a single page.</p>
      </header>

      <main class="layout">
        <section class="card wide">
          <div class="section-head">
            <div>
              <p class="eyebrow">Access</p>
              <h2>Token sign-in</h2>
            </div>
            <button type="button" class="ghost" data-sign-out>Sign out</button>
          </div>
          <form data-sign-in-form>
            <input name="token" autocomplete="off" spellcheck="false" placeholder="control-plane-operator" data-token-input />
            <button type="submit">Connect</button>
          </form>
          <p class="status" data-auth-status>Signed out.</p>
        </section>

        <section class="card wide">
          <div class="section-head">
            <div>
              <p class="eyebrow">Inventory</p>
              <h2>Hosts, workspaces, sessions, approvals, ports</h2>
            </div>
            <span class="badge" data-stream-status>Stream idle</span>
          </div>
          <div class="stats" data-stats></div>
        </section>

        <section class="card half">
          <div class="section-head"><div><p class="eyebrow">Topology</p><h2>Hosts</h2></div></div>
          <div class="stack" data-hosts-list></div>
        </section>

        <section class="card half">
          <div class="section-head"><div><p class="eyebrow">Repositories</p><h2>Workspaces</h2></div></div>
          <div class="stack" data-workspaces-list></div>
        </section>

        <section class="card half">
          <div class="section-head"><div><p class="eyebrow">Execution</p><h2>Sessions</h2></div></div>
          <div class="stack" data-sessions-list></div>
        </section>

        <section class="card half">
          <div class="section-head"><div><p class="eyebrow">Risk gates</p><h2>Approvals</h2></div></div>
          <div class="stack" data-approvals-list></div>
        </section>

        <section class="card half">
          <div class="section-head"><div><p class="eyebrow">Connectivity</p><h2>Forwarded Ports</h2></div></div>
          <div class="stack" data-ports-list></div>
        </section>

        <section class="card half">
          <div class="section-head">
            <div><p class="eyebrow">Code review</p><h2>Diff review</h2></div>
            <button type="button" class="ghost" data-refresh-diff>Refresh diff</button>
          </div>
          <p class="status" data-diff-status>Select a session to inspect changes.</p>
          <div class="stack" data-diff-list></div>
        </section>

        <section class="card half">
          <div class="section-head"><div><p class="eyebrow">Live feed</p><h2>Session events</h2></div></div>
          <div class="stack" data-events-list></div>
        </section>

        <section class="card half">
          <div class="section-head">
            <div><p class="eyebrow">HTTP preview</p><h2>Forwarded preview</h2></div>
            <a class="button ghost" href="" target="_blank" rel="noreferrer" data-preview-link>Open in tab</a>
          </div>
          <p class="status" data-preview-status>Select an HTTP forwarded port to load the preview frame.</p>
          <iframe title="Forwarded preview" data-preview-frame loading="lazy"></iframe>
        </section>
      </main>
    </div>
    <script type="module">
${WEB_CLIENT_SCRIPT}
    </script>
  </body>
</html>`
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const WEB_CLIENT_SCRIPT = `
      const tokenKey = 'remote-agent.server.web.token'
      const state = {
        token: localStorage.getItem(tokenKey) || '',
        dashboard: null,
        selectedSessionId: '',
        diff: null,
        previewUrl: '',
        events: [],
        controller: null,
        streamStatus: 'idle',
      }

      const refs = {
        tokenInput: document.querySelector('[data-token-input]'),
        authStatus: document.querySelector('[data-auth-status]'),
        streamStatus: document.querySelector('[data-stream-status]'),
        stats: document.querySelector('[data-stats]'),
        hosts: document.querySelector('[data-hosts-list]'),
        workspaces: document.querySelector('[data-workspaces-list]'),
        sessions: document.querySelector('[data-sessions-list]'),
        approvals: document.querySelector('[data-approvals-list]'),
        ports: document.querySelector('[data-ports-list]'),
        diffStatus: document.querySelector('[data-diff-status]'),
        diffList: document.querySelector('[data-diff-list]'),
        events: document.querySelector('[data-events-list]'),
        previewStatus: document.querySelector('[data-preview-status]'),
        previewFrame: document.querySelector('[data-preview-frame]'),
        previewLink: document.querySelector('[data-preview-link]'),
      }

      if (refs.tokenInput) {
        refs.tokenInput.value = state.token
      }

      document.querySelector('[data-sign-in-form]')?.addEventListener('submit', async (event) => {
        event.preventDefault()
        const token = refs.tokenInput?.value.trim() || ''

        if (!token) {
          refs.authStatus.textContent = 'Enter a bearer token to sign in.'
          return
        }

        state.token = token
        localStorage.setItem(tokenKey, token)
        refs.authStatus.textContent = 'Connecting...'

        try {
          await refreshDashboard()
          startStream()
          refs.authStatus.textContent = 'Connected.'
        } catch (error) {
          refs.authStatus.textContent = formatError(error)
        }
      })

      document.querySelector('[data-sign-out]')?.addEventListener('click', () => {
        state.token = ''
        state.dashboard = null
        state.selectedSessionId = ''
        state.diff = null
        state.previewUrl = ''
        state.events = []
        localStorage.removeItem(tokenKey)
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

      document.addEventListener('click', (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null

        if (!target) {
          return
        }

        const sessionId = target.getAttribute('data-session-id')

        if (sessionId) {
          void loadDiff(sessionId)
          return
        }

        const approvalId = target.getAttribute('data-approval-id')
        const approvalStatus = target.getAttribute('data-approval-status')

        if (approvalId && approvalStatus) {
          void decideApproval(approvalId, approvalStatus)
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
        const headers = buildHeaders()
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
          const previewPort = ports.data.find((port) => toPreviewUrl(port))

          if (previewPort) {
            state.previewUrl = toPreviewUrl(previewPort)
          }
        }

        render()
      }

      async function loadDiff(sessionId) {
        state.selectedSessionId = sessionId
        refs.diffStatus.textContent = 'Loading diff...'

        try {
          const response = await requestJson('/v1/sessions/' + sessionId + '/changes/patch?limit=20&maxBytes=8192', {
            headers: buildHeaders(),
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
            headers: buildHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ status }),
          })
          await refreshDashboard()
        } catch (error) {
          refs.authStatus.textContent = formatError(error)
        }
      }

      function startStream() {
        stopStream()
        state.controller = new AbortController()
        state.streamStatus = 'connecting'
        render()
        void streamEvents(state.controller.signal)
      }

      function stopStream() {
        if (state.controller) {
          state.controller.abort()
          state.controller = null
        }

        state.streamStatus = state.token ? 'idle' : 'signed-out'
      }

      async function streamEvents(signal) {
        try {
          const response = await fetch('/v1/events', { headers: buildHeaders(), signal })

          if (!response.ok || !response.body) {
            throw new Error('Failed to open the event stream.')
          }

          state.streamStatus = 'live'
          render()

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          while (true) {
            const next = await reader.read()

            if (next.done) {
              break
            }

            buffer += decoder.decode(next.value, { stream: true })

            while (buffer.includes('\\n\\n')) {
              const boundary = buffer.indexOf('\\n\\n')
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const event = parseEvent(frame)

              if (!event) {
                continue
              }

              state.events = [event].concat(state.events).slice(0, 40)
              render()

              if (event.type !== 'control-plane.snapshot') {
                void refreshDashboard().catch((error) => {
                  refs.authStatus.textContent = formatError(error)
                })
              }
            }
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return
          }

          state.streamStatus = 'error'
          refs.authStatus.textContent = formatError(error)
          render()
        }
      }

      async function requestJson(path, options) {
        const response = await fetch(path, options)
        const payload = await response.json()

        if (!response.ok) {
          throw new Error(payload.error && payload.error.message ? payload.error.message : 'Request failed.')
        }

        return payload
      }

      function buildHeaders(extraHeaders) {
        return Object.assign({ authorization: 'Bearer ' + state.token }, extraHeaders || {})
      }

      function parseEvent(frame) {
        const dataLine = frame.split('\\n').find((line) => line.startsWith('data:'))
        return dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : undefined
      }

      function toPreviewUrl(port) {
        if (!port || port.status !== 'open') {
          return ''
        }

        if ((port.protocol === 'http' || port.protocol === 'https') && port.managedUrl) {
          return port.managedUrl
        }

        return ''
      }

      function setPreview(url) {
        state.previewUrl = url
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
        refs.streamStatus.textContent = state.streamStatus === 'live' ? 'Live stream connected' : state.streamStatus === 'connecting' ? 'Connecting stream' : state.streamStatus === 'error' ? 'Stream error' : 'Stream idle'

        if (!state.token) {
          refs.authStatus.textContent = 'Signed out.'
        }
      }

      function renderStats() {
        if (!state.dashboard) {
          refs.stats.innerHTML = empty('Sign in to load inventory.')
          return
        }

        refs.stats.innerHTML = [
          stat('Hosts', state.dashboard.hosts.length),
          stat('Workspaces', state.dashboard.workspaces.length),
          stat('Sessions', state.dashboard.sessions.length),
          stat('Approvals', state.dashboard.approvals.filter((approval) => approval.status === 'pending').length),
          stat('Ports', state.dashboard.ports.length),
        ].join('')
      }

      function renderHosts() {
        if (!state.dashboard || state.dashboard.hosts.length === 0) {
          refs.hosts.innerHTML = empty('No hosts visible.')
          return
        }

        refs.hosts.innerHTML = state.dashboard.hosts.map((host) => record(
          host.label,
          host.id,
          host.runtimeStatus,
          host.runtime ? 'Runtime ' + host.runtime.label + ' · ' + host.runtime.version : 'No enrolled runtime.',
          ['Platform ' + host.platform, 'Last seen ' + formatTime(host.lastSeenAt)],
        )).join('')
      }

      function renderWorkspaces() {
        if (!state.dashboard || state.dashboard.workspaces.length === 0) {
          refs.workspaces.innerHTML = empty('No registered workspaces.')
          return
        }

        refs.workspaces.innerHTML = state.dashboard.workspaces.map((workspace) => record(
          workspace.name,
          workspace.id,
          workspace.defaultBranch,
          workspace.path,
          ['Host ' + workspace.hostId, workspace.runtimeLabel],
        )).join('')
      }

      function renderSessions() {
        if (!state.dashboard || state.dashboard.sessions.length === 0) {
          refs.sessions.innerHTML = empty('No sessions available.')
          return
        }

        refs.sessions.innerHTML = state.dashboard.sessions.map((session) => {
          const actions = '<div class="actions"><button type="button" class="ghost" data-session-id="' + escapeHtml(session.id) + '">Review diff</button></div>'

          return record(
            session.id,
            session.provider + ' on ' + session.workspaceId,
            session.status,
            'Requested by ' + session.requestedBy.displayName,
            [formatTime(session.startedAt)],
            actions,
          )
        }).join('')
      }

      function renderApprovals() {
        if (!state.dashboard || state.dashboard.approvals.length === 0) {
          refs.approvals.innerHTML = empty('No approvals require attention.')
          return
        }

        refs.approvals.innerHTML = state.dashboard.approvals.map((approval) => {
          const actions = approval.status === 'pending'
            ? '<div class="actions">' +
                '<button type="button" data-approval-id="' + escapeHtml(approval.id) + '" data-approval-status="approved">Approve</button>' +
                '<button type="button" class="ghost" data-approval-id="' + escapeHtml(approval.id) + '" data-approval-status="rejected">Reject</button>' +
              '</div>'
            : ''

          return record(
            approval.action,
            approval.id,
            approval.status,
            'Session ' + approval.sessionId,
            ['Requested by ' + approval.requestedBy.displayName, formatTime(approval.requestedAt)],
            actions,
          )
        }).join('')
      }

      function renderPorts() {
        if (!state.dashboard || state.dashboard.ports.length === 0) {
          refs.ports.innerHTML = empty('No forwarded ports available.')
          return
        }

        refs.ports.innerHTML = state.dashboard.ports.map((port) => {
          const previewUrl = toPreviewUrl(port)
          const actions = previewUrl
            ? '<div class="actions"><button type="button" class="ghost" data-preview-url="' + escapeHtml(previewUrl) + '">Open Preview</button></div>'
            : ''

          return record(
            port.label,
            port.id,
            port.status,
            port.protocol.toUpperCase() + ' ' + port.targetPort,
            ['Visibility ' + port.visibility, 'Session ' + (port.sessionId || 'n/a')],
            actions,
          )
        }).join('')
      }

      function renderDiff() {
        if (!state.selectedSessionId) {
          refs.diffStatus.textContent = 'Select a session to inspect changes.'
          refs.diffList.innerHTML = empty('No session selected.')
          return
        }

        if (!state.diff) {
          refs.diffStatus.textContent = 'No diff loaded for ' + state.selectedSessionId + '.'
          refs.diffList.innerHTML = empty('Use Review diff on a session to load patch details.')
          return
        }

        refs.diffStatus.textContent = 'Reviewing ' + state.selectedSessionId + ': ' + state.diff.summary.totalFiles + ' changed files.'

        if (state.diff.items.length === 0) {
          refs.diffList.innerHTML = empty('This session has no current file changes.')
          return
        }

        refs.diffList.innerHTML = state.diff.items.map((entry) => {
          const rename = entry.previousPath ? '<p>Renamed from ' + escapeHtml(entry.previousPath) + '</p>' : ''

          return '<article class="record">' +
            '<div class="record-head"><div><h3>' + escapeHtml(entry.path) + '</h3>' + rename + '</div><span class="badge">' + escapeHtml(entry.changeType) + '</span></div>' +
            '<div class="meta"><span>+' + escapeHtml(String(entry.additions)) + '</span><span>-' + escapeHtml(String(entry.deletions)) + '</span></div>' +
            '<pre>' + escapeHtml(entry.patch || 'No textual patch available.') + '</pre>' +
          '</article>'
        }).join('')
      }

      function renderEvents() {
        if (state.events.length === 0) {
          refs.events.innerHTML = empty('Live session events will appear here after the stream connects.')
          return
        }

        refs.events.innerHTML = state.events.map((event) => record(
          event.type,
          formatTime(event.issuedAt),
          'live',
          summarizeEvent(event),
          [],
        )).join('')
      }

      function renderPreview() {
        if (!state.previewUrl) {
          refs.previewStatus.textContent = 'Select an HTTP forwarded port to load the preview frame.'
          refs.previewFrame.removeAttribute('src')
          refs.previewLink.removeAttribute('href')
          return
        }

        refs.previewStatus.textContent = 'Preview loaded from ' + state.previewUrl
        refs.previewFrame.src = state.previewUrl
        refs.previewLink.href = state.previewUrl
      }

      function record(title, subtitle, badge, body, metaItems, extra) {
        const meta = metaItems.length > 0 ? '<div class="meta">' + metaItems.map((item) => '<span>' + escapeHtml(item) + '</span>').join('') + '</div>' : ''
        return '<article class="record">' +
          '<div class="record-head"><div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(subtitle) + '</p></div><span class="badge">' + escapeHtml(badge) + '</span></div>' +
          '<p>' + escapeHtml(body) + '</p>' +
          meta +
          (extra || '') +
        '</article>'
      }

      function stat(label, value) {
        return '<article class="stat"><span class="badge">' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></article>'
      }

      function empty(message) {
        return '<div class="empty">' + escapeHtml(message) + '</div>'
      }

      function summarizeEvent(event) {
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

      function formatTime(value) {
        try {
          return new Date(value).toLocaleString()
        } catch {
          return value
        }
      }

      function formatError(error) {
        return error instanceof Error && error.message ? error.message : 'Unexpected client error.'
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
