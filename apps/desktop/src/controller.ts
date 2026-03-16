import { isManagedPortActive } from '@remote-agent-server/ports'
import type { ProviderApprovalRecord } from '@remote-agent-server/providers'
import type {
  ConnectionSettingsStore,
  DesktopConnectionSettings,
  DesktopControlPlaneClient,
  DesktopOperatorState,
  DesktopWorkspaceScope,
  EventStreamHandle,
  ForwardedPortRecord,
  HostRecord,
  PreviewOpener,
  SessionRecord,
  SessionStartRequest,
  WorkspaceRecord,
} from './types.js'

interface DesktopOperatorControllerOptions {
  createClient(settings: DesktopConnectionSettings): DesktopControlPlaneClient
  previewOpener: PreviewOpener
  reconnectDelayMs?: number
  settingsStore: ConnectionSettingsStore
}

type StateListener = () => void

function createEmptyDashboard() {
  return {
    approvals: [],
    forwardedPorts: [],
    hosts: [],
    sessions: [],
    workspaces: [],
  }
}

function sortByNewest<
  T extends { createdAt?: string; requestedAt?: string; updatedAt?: string },
>(records: T[]) {
  return [...records].sort((left, right) => {
    const leftTimestamp =
      left.updatedAt ?? left.createdAt ?? left.requestedAt ?? ''
    const rightTimestamp =
      right.updatedAt ?? right.createdAt ?? right.requestedAt ?? ''

    return rightTimestamp.localeCompare(leftTimestamp)
  })
}

function sortHostsByLastSeen(hosts: HostRecord[]) {
  return [...hosts].sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt),
  )
}

function filterForwardedPorts(ports: ForwardedPortRecord[]) {
  return sortByNewest(
    ports.filter(
      (port) =>
        port.state === 'forwarded' &&
        port.protocol === 'http' &&
        isManagedPortActive(port),
    ),
  )
}

function getHostMap(hosts: HostRecord[]) {
  return new Map(hosts.map((host) => [host.id, host]))
}

export function filterWorkspacesByScope(
  workspaces: WorkspaceRecord[],
  hosts: HostRecord[],
  scope: DesktopWorkspaceScope,
) {
  const hostsById = getHostMap(hosts)

  return sortByNewest(
    workspaces.filter((workspace) => hostsById.get(workspace.hostId)?.hostMode === scope),
  )
}

function resolveWorkspaceScope(
  currentScope: DesktopWorkspaceScope,
  workspaces: WorkspaceRecord[],
  hosts: HostRecord[],
) {
  if (filterWorkspacesByScope(workspaces, hosts, currentScope).length > 0) {
    return currentScope
  }

  return filterWorkspacesByScope(workspaces, hosts, currentScope === 'local' ? 'remote' : 'local').length > 0
    ? (currentScope === 'local' ? 'remote' : 'local')
    : currentScope
}

function resolveSelectedWorkspaceId(
  selectedWorkspaceId: string | undefined,
  workspaces: WorkspaceRecord[],
  hosts: HostRecord[],
  scope: DesktopWorkspaceScope,
) {
  const visibleWorkspaces = filterWorkspacesByScope(workspaces, hosts, scope)
  if (!selectedWorkspaceId) {
    return visibleWorkspaces[0]?.id
  }

  return visibleWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ? selectedWorkspaceId
    : visibleWorkspaces[0]?.id
}

export class DesktopOperatorController {
  private readonly createClient: DesktopOperatorControllerOptions['createClient']
  private readonly listeners = new Set<StateListener>()
  private readonly previewOpener: PreviewOpener
  private readonly reconnectDelayMs: number
  private readonly settingsStore: ConnectionSettingsStore

  private client?: DesktopControlPlaneClient
  private disposed = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private state: DesktopOperatorState = {
    dashboard: createEmptyDashboard(),
    liveConnection: 'idle',
    phase: 'booting',
    workspaceScope: 'remote',
  }
  private streamHandle?: EventStreamHandle

  constructor(options: DesktopOperatorControllerOptions) {
    this.createClient = options.createClient
    this.previewOpener = options.previewOpener
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1500
    this.settingsStore = options.settingsStore
  }

  subscribe = (listener: StateListener) => {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.state

  async bootstrap() {
    this.setState({
      ...this.state,
      error: undefined,
      phase: 'booting',
    })

    const settings = await this.settingsStore.load()
    if (!settings) {
      this.setState({
        ...this.state,
        connection: undefined,
        dashboard: createEmptyDashboard(),
        liveConnection: 'idle',
        phase: 'signed-out',
        selectedWorkspaceId: undefined,
      })
      return
    }

    await this.connect(settings, { persist: false })
  }

  async connect(
    settings: DesktopConnectionSettings,
    options: { persist: boolean } = { persist: true },
  ) {
    this.clearRefreshTimer()
    this.clearReconnectTimer()
    this.closeEventStream()

    const normalizedSettings = {
      baseUrl: settings.baseUrl.replace(/\/+$/, ''),
      token: settings.token.trim(),
    } satisfies DesktopConnectionSettings

    this.setState({
      ...this.state,
      connection: normalizedSettings,
      error: undefined,
      liveConnection: 'connecting',
      phase: 'connecting',
    })

    const client = this.createClient(normalizedSettings)

    try {
      const [approvals, hosts, forwardedPorts, sessions, workspaces] = await Promise.all([
        client.listApprovals(),
        client.listHosts(),
        client.listPorts(),
        client.listSessions(),
        client.listWorkspaces(),
      ])

      if (options.persist) {
        await this.settingsStore.save(normalizedSettings)
      }

      this.client = client
      this.setReadyState(
        normalizedSettings,
        approvals,
        hosts,
        forwardedPorts,
        sessions,
        workspaces,
        'connecting',
      )
      this.startEventStream()
    } catch (error) {
      this.client = undefined
      this.setState({
        ...this.state,
        connection: normalizedSettings,
        error:
          error instanceof Error ? error.message : 'Desktop app failed to connect.',
        liveConnection: 'idle',
        phase: 'signed-out',
      })
    }
  }

  async refresh() {
    if (!this.client || !this.state.connection) {
      return
    }

    this.setState({
      ...this.state,
      error: undefined,
    })

    try {
      const [approvals, hosts, forwardedPorts, sessions, workspaces] = await Promise.all([
        this.client.listApprovals(),
        this.client.listHosts(),
        this.client.listPorts(),
        this.client.listSessions(),
        this.client.listWorkspaces(),
      ])

      this.setReadyState(
        this.state.connection,
        approvals,
        hosts,
        forwardedPorts,
        sessions,
        workspaces,
        this.state.liveConnection,
      )
    } catch (error) {
      this.setState({
        ...this.state,
        error:
          error instanceof Error ? error.message : 'Desktop app failed to refresh.',
      })
    }
  }

  async startSession(request: SessionStartRequest) {
    if (!this.client) {
      throw new Error('Connect to a control plane before starting a session.')
    }

    this.setState({
      ...this.state,
      busySessionAction: 'create',
      busySessionId: request.workspaceId,
      error: undefined,
    })

    try {
      await this.client.startSession(request)
      await this.refresh()
    } finally {
      this.setState({
        ...this.state,
        busySessionAction: undefined,
        busySessionId: undefined,
      })
    }
  }

  async controlSession(
    sessionId: string,
    action: 'pause' | 'resume' | 'cancel',
  ) {
    if (!this.client) {
      throw new Error('Connect to a control plane before managing sessions.')
    }

    this.setState({
      ...this.state,
      busySessionAction: action,
      busySessionId: sessionId,
      error: undefined,
    })

    try {
      await this.client.controlSession(sessionId, action)
      await this.refresh()
    } finally {
      this.setState({
        ...this.state,
        busySessionAction: undefined,
        busySessionId: undefined,
      })
    }
  }

  async decideApproval(
    approvalId: string,
    status: 'approved' | 'rejected',
  ) {
    if (!this.client) {
      throw new Error('Connect to a control plane before deciding approvals.')
    }

    this.setState({
      ...this.state,
      busyApprovalId: approvalId,
      error: undefined,
    })

    try {
      await this.client.decideApproval(approvalId, status)
      await this.refresh()
    } finally {
      this.setState({
        ...this.state,
        busyApprovalId: undefined,
      })
    }
  }

  async openPreview(portId: string) {
    const port = this.state.dashboard.forwardedPorts.find((entry) => entry.id === portId)
    if (!port?.managedUrl) {
      throw new Error('The selected desktop preview is not available yet.')
    }

    await this.previewOpener.open(port.managedUrl)
  }

  setWorkspaceScope(scope: DesktopWorkspaceScope) {
    this.setState({
      ...this.state,
      selectedWorkspaceId: resolveSelectedWorkspaceId(
        this.state.selectedWorkspaceId,
        this.state.dashboard.workspaces,
        this.state.dashboard.hosts,
        scope,
      ),
      workspaceScope: scope,
    })
  }

  selectWorkspace(workspaceId: string) {
    this.setState({
      ...this.state,
      selectedWorkspaceId: workspaceId,
    })
  }

  async forgetConnection() {
    await this.settingsStore.clear()
    this.clearReconnectTimer()
    this.clearRefreshTimer()
    this.closeEventStream()
    this.client = undefined
    this.setState({
      busyApprovalId: undefined,
      busySessionAction: undefined,
      busySessionId: undefined,
      connection: undefined,
      dashboard: createEmptyDashboard(),
      error: undefined,
      lastEventId: undefined,
      lastEventType: undefined,
      liveConnection: 'idle',
      phase: 'signed-out',
      selectedWorkspaceId: undefined,
      workspaceScope: 'remote',
    })
  }

  destroy() {
    this.disposed = true
    this.clearRefreshTimer()
    this.clearReconnectTimer()
    this.closeEventStream()
    this.listeners.clear()
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private clearRefreshTimer() {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  private closeEventStream() {
    this.streamHandle?.close()
    this.streamHandle = undefined
  }

  private emitState() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private scheduleRefresh() {
    this.clearRefreshTimer()
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh()
    }, 200)
  }

  private setReadyState(
    connection: DesktopConnectionSettings,
    approvals: ProviderApprovalRecord[],
    hosts: HostRecord[],
    forwardedPorts: ForwardedPortRecord[],
    sessions: SessionRecord[],
    workspaces: WorkspaceRecord[],
    liveConnection: DesktopOperatorState['liveConnection'],
  ) {
    const workspaceScope = resolveWorkspaceScope(
      this.state.workspaceScope,
      workspaces,
      hosts,
    )

    this.setState({
      ...this.state,
      connection,
      dashboard: {
        approvals: sortByNewest(approvals),
        forwardedPorts: filterForwardedPorts(forwardedPorts),
        hosts: sortHostsByLastSeen(hosts),
        sessions: sortByNewest(sessions),
        workspaces: sortByNewest(workspaces),
      },
      error: undefined,
      liveConnection,
      phase: 'ready',
      selectedWorkspaceId: resolveSelectedWorkspaceId(
        this.state.selectedWorkspaceId,
        workspaces,
        hosts,
        workspaceScope,
      ),
      workspaceScope,
    })
  }

  private setState(nextState: DesktopOperatorState) {
    this.state = nextState
    this.emitState()
  }

  private startEventStream() {
    if (!this.client || !this.state.connection) {
      return
    }

    this.closeEventStream()

    this.setState({
      ...this.state,
      liveConnection: 'connecting',
    })

    this.streamHandle = this.client.connectEvents((event) => {
      if (this.disposed) {
        return
      }

      this.setState({
        ...this.state,
        lastEventId: event.id,
        lastEventType: event.envelope.type,
        liveConnection: 'live',
      })

      if (event.envelope.type !== 'control-plane.connected') {
        this.scheduleRefresh()
      }
    }, this.state.lastEventId)

    this.streamHandle.done.catch((error: unknown) => {
      if (this.disposed) {
        return
      }

      const candidate = error as { name?: string }
      if (candidate.name === 'AbortError') {
        return
      }

      this.setState({
        ...this.state,
        error:
          error instanceof Error
            ? error.message
            : 'Desktop live stream disconnected.',
        liveConnection: 'reconnecting',
      })

      this.reconnectTimer = setTimeout(() => {
        if (this.disposed || !this.state.connection) {
          return
        }

        this.client = this.createClient(this.state.connection)
        this.startEventStream()
      }, this.reconnectDelayMs)
    })
  }
}
