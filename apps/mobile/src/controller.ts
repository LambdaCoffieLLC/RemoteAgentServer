import { isManagedPortActive } from '@remote-agent-server/ports'
import type { ProviderApprovalRecord, ProviderApprovalStatus } from '@remote-agent-server/providers'
import type {
  ConnectionSettingsStore,
  ControlPlaneEventRecord,
  EventStreamHandle,
  ForwardedPortRecord,
  HostRecord,
  MobileConnectionSettings,
  MobileControlPlaneClient,
  MobileOperatorState,
  PreviewOpenMode,
  PreviewOpener,
  SessionRecord,
} from './types.js'

interface MobileOperatorControllerOptions {
  createClient(settings: MobileConnectionSettings): MobileControlPlaneClient
  settingsStore: ConnectionSettingsStore
  previewOpener: PreviewOpener
  reconnectDelayMs?: number
}

type StateListener = () => void

function createEmptyDashboard() {
  return {
    hosts: [],
    sessions: [],
    approvals: [],
    forwardedPorts: [],
  }
}

function sortByNewest<T extends { updatedAt?: string; createdAt?: string; requestedAt?: string }>(
  items: T[],
) {
  return [...items].sort((left, right) => {
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

function upsertById<TRecord extends { id: string }>(
  records: TRecord[],
  record: TRecord,
) {
  const index = records.findIndex((entry) => entry.id === record.id)
  if (index === -1) {
    return [...records, record]
  }

  return records.map((entry, entryIndex) =>
    entryIndex === index ? record : entry,
  )
}

function mergeSnapshotRecords<TRecord extends { id: string }>(
  currentRecords: TRecord[],
  incomingRecords: TRecord[],
) {
  const incomingIds = new Set(incomingRecords.map((record) => record.id))
  const survivors = currentRecords.filter((record) => !incomingIds.has(record.id))
  return [...survivors, ...incomingRecords]
}

function applySessionEvent(
  sessions: SessionRecord[],
  event: ControlPlaneEventRecord,
) {
  if (event.envelope.type === 'session.snapshot') {
    const payload = event.envelope.payload as { active?: SessionRecord[] }
    return sortByNewest(
      mergeSnapshotRecords(sessions, payload.active ?? []),
    )
  }

  const payload = event.envelope.payload as { session?: SessionRecord }
  if (payload.session) {
    return sortByNewest(upsertById(sessions, payload.session))
  }

  return sessions
}

function applyApprovalEvent(
  approvals: ProviderApprovalRecord[],
  event: ControlPlaneEventRecord,
) {
  if (
    event.envelope.type !== 'approval.requested' &&
    event.envelope.type !== 'approval.upserted' &&
    event.envelope.type !== 'approval.decided'
  ) {
    return approvals
  }

  return sortByNewest(
    upsertById(
      approvals,
      event.envelope.payload as ProviderApprovalRecord,
    ),
  )
}

function applyPortEvent(
  ports: ForwardedPortRecord[],
  event: ControlPlaneEventRecord,
) {
  if (!event.envelope.type.startsWith('port.')) {
    return ports
  }

  return sortByNewest(
    upsertById(ports, event.envelope.payload as ForwardedPortRecord),
  )
}

function filterPreviewPorts(ports: ForwardedPortRecord[]) {
  return sortByNewest(
    ports.filter(
      (port) =>
        port.protocol === 'http' &&
        port.state === 'forwarded' &&
        isManagedPortActive(port),
    ),
  )
}

function resolveSelectedSessionId(
  selectedSessionId: string | undefined,
  sessions: SessionRecord[],
) {
  if (!selectedSessionId) {
    return undefined
  }

  return sessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : undefined
}

export class MobileOperatorController {
  private readonly listeners = new Set<StateListener>()
  private readonly reconnectDelayMs: number
  private readonly createClient: MobileOperatorControllerOptions['createClient']
  private readonly settingsStore: ConnectionSettingsStore
  private readonly previewOpener: PreviewOpener

  private disposed = false
  private streamHandle?: EventStreamHandle
  private streamVersion = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private client?: MobileControlPlaneClient

  private state: MobileOperatorState = {
    phase: 'booting',
    liveConnection: 'idle',
    dashboard: createEmptyDashboard(),
  }

  constructor(options: MobileOperatorControllerOptions) {
    this.createClient = options.createClient
    this.settingsStore = options.settingsStore
    this.previewOpener = options.previewOpener
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1500
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
      phase: 'booting',
      error: undefined,
    })

    const settings = await this.settingsStore.load()
    if (!settings) {
      this.setState({
        ...this.state,
        phase: 'signed-out',
        liveConnection: 'idle',
        selectedSessionId: undefined,
      })
      return
    }

    await this.connect(settings, { persist: false })
  }

  async connect(
    settings: MobileConnectionSettings,
    options: { persist: boolean } = { persist: true },
  ) {
    this.clearReconnectTimer()
    this.closeEventStream()

    this.setState({
      ...this.state,
      phase: 'connecting',
      liveConnection: 'connecting',
      connection: settings,
      error: undefined,
    })

    const client = this.createClient(settings)

    try {
      const [hosts, sessions, approvals, forwardedPorts] = await Promise.all([
        client.listHosts(),
        client.listSessions(),
        client.listApprovals(),
        client.listPorts(),
      ])

      if (options.persist) {
        await this.settingsStore.save(settings)
      }

      this.client = client
      const sortedSessions = sortByNewest(sessions)
      this.setState({
        ...this.state,
        phase: 'ready',
        liveConnection: 'connecting',
        connection: settings,
        selectedSessionId: resolveSelectedSessionId(
          this.state.selectedSessionId,
          sortedSessions,
        ),
        dashboard: {
          hosts,
          sessions: sortedSessions,
          approvals: sortByNewest(approvals),
          forwardedPorts: filterPreviewPorts(forwardedPorts),
        },
        error: undefined,
      })
      this.startEventStream()
    } catch (error) {
      this.client = undefined
      this.setState({
        ...this.state,
        phase: 'signed-out',
        liveConnection: 'idle',
        connection: settings,
        dashboard: createEmptyDashboard(),
        selectedSessionId: undefined,
        error:
          error instanceof Error
            ? error.message
            : 'Mobile app failed to connect to the control plane.',
      })
    }
  }

  async refresh() {
    if (!this.client || !this.state.connection) {
      return
    }

    const [hosts, sessions, approvals, forwardedPorts] = await Promise.all([
      this.client.listHosts(),
      this.client.listSessions(),
      this.client.listApprovals(),
      this.client.listPorts(),
    ])
    const sortedSessions = sortByNewest(sessions)

    this.setState({
      ...this.state,
      selectedSessionId: resolveSelectedSessionId(
        this.state.selectedSessionId,
        sortedSessions,
      ),
      dashboard: {
        hosts,
        sessions: sortedSessions,
        approvals: sortByNewest(approvals),
        forwardedPorts: filterPreviewPorts(forwardedPorts),
      },
      error: undefined,
    })
  }

  openSession(sessionId: string) {
    const session = this.state.dashboard.sessions.find((entry) => entry.id === sessionId)
    if (!session) {
      throw new Error(`Session "${sessionId}" is not available in the mobile dashboard.`)
    }

    this.setState({
      ...this.state,
      selectedSessionId: session.id,
      error: undefined,
    })
  }

  async decideApproval(
    approvalId: string,
    status: Extract<ProviderApprovalStatus, 'approved' | 'rejected'>,
  ) {
    if (!this.client) {
      throw new Error('Connect the mobile app before deciding approvals.')
    }

    this.setState({
      ...this.state,
      busyApprovalId: approvalId,
      error: undefined,
    })

    try {
      const approval = await this.client.decideApproval(approvalId, status)
      this.setState({
        ...this.state,
        busyApprovalId: undefined,
        dashboard: {
          ...this.state.dashboard,
          approvals: sortByNewest(
            upsertById(this.state.dashboard.approvals, approval),
          ),
        },
      })
    } catch (error) {
      this.setState({
        ...this.state,
        busyApprovalId: undefined,
        error:
          error instanceof Error ? error.message : 'Failed to decide approval.',
      })
      throw error
    }
  }

  async openPreview(portId: string, mode: PreviewOpenMode) {
    const port = this.state.dashboard.forwardedPorts.find(
      (entry) => entry.id === portId,
    )
    if (!port) {
      throw new Error(`Preview "${portId}" is not available.`)
    }

    await this.previewOpener.open(port, mode)
  }

  async forgetConnection() {
    await this.settingsStore.clear()
    this.client = undefined
    this.clearReconnectTimer()
    this.closeEventStream()
    this.setState({
      phase: 'signed-out',
      liveConnection: 'idle',
      dashboard: createEmptyDashboard(),
      selectedSessionId: undefined,
    })
  }

  destroy() {
    this.disposed = true
    this.client = undefined
    this.clearReconnectTimer()
    this.closeEventStream()
  }

  private setState(nextState: MobileOperatorState) {
    this.state = nextState
    for (const listener of this.listeners) {
      listener()
    }
  }

  private startEventStream() {
    if (!this.client) {
      return
    }

    const streamVersion = ++this.streamVersion
    const handle = this.client.connectEvents((event) => {
      if (streamVersion !== this.streamVersion) {
        return
      }

      const nextSessions = applySessionEvent(this.state.dashboard.sessions, event)

      this.setState({
        ...this.state,
        liveConnection: 'live',
        selectedSessionId: resolveSelectedSessionId(
          this.state.selectedSessionId,
          nextSessions,
        ),
        lastEventId: event.id,
        lastEventType: event.envelope.type,
        dashboard: {
          hosts:
            event.envelope.type === 'host.upserted'
              ? sortHostsByLastSeen(
                  upsertById(
                    this.state.dashboard.hosts,
                    event.envelope.payload as (typeof this.state.dashboard.hosts)[number],
                  ),
                )
              : this.state.dashboard.hosts,
          sessions: nextSessions,
          approvals: applyApprovalEvent(this.state.dashboard.approvals, event),
          forwardedPorts: filterPreviewPorts(
            applyPortEvent(this.state.dashboard.forwardedPorts, event),
          ),
        },
      })
    }, this.state.lastEventId)
    this.streamHandle = handle

    const onStreamEnd = (error?: Error) => {
      if (this.disposed || streamVersion !== this.streamVersion) {
        return
      }

      this.streamHandle = undefined
      this.setState({
        ...this.state,
        liveConnection: 'reconnecting',
        error: error?.message,
      })
      this.scheduleReconnect()
    }

    handle.done.then(
      () => {
        onStreamEnd()
      },
      (error: unknown) => {
        onStreamEnd(
          error instanceof Error
            ? error
            : new Error('Live updates disconnected.'),
        )
      },
    )
  }

  private scheduleReconnect() {
    if (!this.state.connection || this.disposed) {
      return
    }

    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      if (this.disposed || !this.state.connection) {
        return
      }

      this.startEventStream()
    }, this.reconnectDelayMs)
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private closeEventStream() {
    this.streamVersion += 1
    this.streamHandle?.close()
    this.streamHandle = undefined
  }
}
