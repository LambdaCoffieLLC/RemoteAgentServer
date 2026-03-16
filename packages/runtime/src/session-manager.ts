import { randomUUID } from 'node:crypto'
import {
  type ProviderApprovalDecision,
  type ProviderApprovalHandler,
  type ProviderApprovalRequest,
} from '@remote-agent-server/providers'
import {
  createSessionDescriptor,
  createSessionLogEntry,
  createSessionOutputEntry,
  isTerminalSessionState,
  type SessionDescriptor,
  type SessionLogEntry,
  type SessionMode,
  type SessionOutputEntry,
  type SessionState,
} from '@remote-agent-server/sessions'
import {
  createRuntimeProviderAdapterRegistry,
  type RuntimeProviderAdapter,
  type RuntimeProviderAdapterRegistry,
  type RuntimeProviderLaunchRequest,
  type RuntimeProviderProcess,
} from './provider-adapters.js'

export interface RuntimeSessionStartRequest extends Omit<RuntimeProviderLaunchRequest, 'mode'> {
  mode?: SessionMode
}

export interface RuntimeSessionSnapshot {
  session: SessionDescriptor
  workspacePath: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  logs: SessionLogEntry[]
  output: SessionOutputEntry[]
}

export interface RuntimeSessionEnvelope<TPayload = unknown> {
  id: string
  timestamp: string
  type: 'session.state.changed' | 'session.log' | 'session.output'
  payload: TPayload
}

export type RuntimeSessionEvent =
  | RuntimeSessionEnvelope<{ session: SessionDescriptor; detail?: string }>
  | RuntimeSessionEnvelope<{ sessionId: string; entry: SessionLogEntry }>
  | RuntimeSessionEnvelope<{ sessionId: string; entry: SessionOutputEntry }>

export interface RuntimeSessionHandle {
  readonly id: string
  getSnapshot(): RuntimeSessionSnapshot
  subscribe(listener: (event: RuntimeSessionEvent) => void): () => void
  pause(): RuntimeSessionSnapshot
  resume(): RuntimeSessionSnapshot
  cancel(): RuntimeSessionSnapshot
  dispose(): void
}

export interface RuntimeSessionManager {
  startSession(request: RuntimeSessionStartRequest): RuntimeSessionHandle
  getSession(sessionId: string): RuntimeSessionHandle | undefined
  dispose(): void
}

export interface RuntimeSessionManagerOptions {
  providerAdapters?: RuntimeProviderAdapterRegistry | Iterable<RuntimeProviderAdapter>
  approvalHandler?: ProviderApprovalHandler
}

class InProcessRuntimeSession implements RuntimeSessionHandle {
  readonly id: string

  private readonly listeners = new Set<(event: RuntimeSessionEvent) => void>()
  private readonly logs: SessionLogEntry[] = []
  private readonly output: SessionOutputEntry[] = []
  private readonly createdAt = new Date().toISOString()
  private readonly session: SessionDescriptor
  private readonly workspacePath: string

  private updatedAt = this.createdAt
  private startedAt?: string
  private completedAt?: string
  private launchTimer?: NodeJS.Timeout
  private providerProcess?: RuntimeProviderProcess
  private pendingApprovalId?: string

  constructor(
    private readonly request: RuntimeSessionStartRequest,
    private readonly providerAdapters: RuntimeProviderAdapterRegistry,
    private readonly approvalHandler: ProviderApprovalHandler | undefined,
    private readonly onTerminal: (sessionId: string) => void,
  ) {
    this.id = request.sessionId
    this.session = createSessionDescriptor({
      id: request.sessionId,
      workspaceId: request.workspaceId,
      provider: request.provider,
      mode: request.mode,
      state: 'queued',
    })
    this.workspacePath = request.workspacePath

    this.launchTimer = setTimeout(() => {
      this.launchTimer = undefined

      if (this.session.state !== 'queued') {
        return
      }

      this.startProvider()
    }, 0)
  }

  getSnapshot(): RuntimeSessionSnapshot {
    return {
      session: { ...this.session },
      workspacePath: this.workspacePath,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      logs: [...this.logs],
      output: [...this.output],
    }
  }

  subscribe(listener: (event: RuntimeSessionEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  pause() {
    if (this.session.state !== 'running') {
      throw new Error('Only running sessions can be paused.')
    }

    this.providerProcess?.pause()
    this.setState('paused', 'Paused by operator request.')
    return this.getSnapshot()
  }

  resume() {
    if (this.session.state !== 'paused') {
      throw new Error('Only paused sessions can be resumed.')
    }

    this.providerProcess?.resume()
    this.setState('running', 'Resumed by operator request.')
    return this.getSnapshot()
  }

  cancel() {
    if (isTerminalSessionState(this.session.state)) {
      throw new Error('Terminal sessions cannot be canceled again.')
    }

    this.clearLaunchTimer()
    this.providerProcess?.cancel()
    this.pushLog('warning', 'Canceled by operator request.')
    this.setState('canceled', 'Canceled by operator request.')
    return this.getSnapshot()
  }

  dispose() {
    this.clearLaunchTimer()
    this.providerProcess?.dispose()
    this.providerProcess = undefined
    this.listeners.clear()
  }

  private startProvider() {
    const adapter = this.providerAdapters.getAdapter(this.request.provider)
    if (!adapter) {
      this.failSession(new Error(`No runtime provider adapter is registered for "${this.request.provider}".`))
      return
    }

    this.startedAt = new Date().toISOString()

    try {
      this.providerProcess = adapter.launch(
        {
          sessionId: this.request.sessionId,
          workspaceId: this.request.workspaceId,
          workspacePath: this.request.workspacePath,
          provider: this.request.provider,
          mode: this.request.mode ?? 'workspace',
        },
        {
          onLog: (level, message) => {
            if (this.isTerminal()) {
              return
            }

            this.pushLog(level, message)
          },
          onOutput: (stream, text) => {
            if (this.isTerminal()) {
              return
            }

            this.pushOutput(stream, text)
          },
          onApprovalRequest: async (approval) => {
            return await this.handleApprovalRequest(approval)
          },
          onExit: (result) => {
            if (this.isTerminal()) {
              return
            }

            if (result.code === 0) {
              const detail = result.detail ?? `${this.request.provider} completed the session successfully.`
              this.pushLog('info', detail)
              this.setState('completed', detail)
              return
            }

            this.failSession(new Error(result.detail ?? `${this.request.provider} exited with code ${result.code}.`))
          },
          onFailure: (error) => {
            if (this.isTerminal()) {
              return
            }

            this.failSession(error)
          },
        },
      )
      this.setState('running', `Started ${this.request.provider} for ${this.request.workspacePath}.`)
    } catch (error) {
      this.failSession(error)
    }
  }

  private pushLog(level: SessionLogEntry['level'], message: string) {
    const entry = createSessionLogEntry(level, message)
    this.logs.push(entry)
    this.updatedAt = entry.timestamp
    this.emit({
      id: `runtime-event-${randomUUID()}`,
      timestamp: entry.timestamp,
      type: 'session.log',
      payload: {
        sessionId: this.id,
        entry,
      },
    })
  }

  private pushOutput(stream: SessionOutputEntry['stream'], text: string) {
    const entry = createSessionOutputEntry(stream, text)
    this.output.push(entry)
    this.updatedAt = entry.timestamp
    this.emit({
      id: `runtime-event-${randomUUID()}`,
      timestamp: entry.timestamp,
      type: 'session.output',
      payload: {
        sessionId: this.id,
        entry,
      },
    })
  }

  private setState(state: SessionState, detail?: string) {
    const timestamp = new Date().toISOString()
    this.session.state = state
    this.updatedAt = timestamp
    if (isTerminalSessionState(state)) {
      this.completedAt = timestamp
      this.clearLaunchTimer()
      this.providerProcess?.dispose()
      this.providerProcess = undefined
    }

    this.emit({
      id: `runtime-event-${randomUUID()}`,
      timestamp,
      type: 'session.state.changed',
      payload: {
        session: { ...this.session },
        detail,
      },
    })

    if (isTerminalSessionState(state)) {
      this.onTerminal(this.id)
    }
  }

  private failSession(error: unknown) {
    const message = error instanceof Error ? error.message : 'Unexpected provider failure.'
    this.pushLog('error', message)
    this.setState('failed', message)
  }

  private async handleApprovalRequest(approval: ProviderApprovalRequest): Promise<ProviderApprovalDecision> {
    if (!this.approvalHandler) {
      throw new Error(`No approval handler is configured for privileged action "${approval.action}".`)
    }

    if (this.pendingApprovalId) {
      throw new Error(`Session "${this.id}" is already waiting on approval "${this.pendingApprovalId}".`)
    }

    this.pendingApprovalId = approval.id
    this.pushLog('warning', approval.message)
    this.setState('blocked', `Awaiting approval for "${approval.action}".`)

    try {
      const decision = await this.approvalHandler.requestApproval(approval)
      if (this.isTerminal()) {
        return decision
      }

      if (decision.status === 'approved') {
        this.pushLog('info', `Approved privileged action "${decision.action}".`)
        this.setState('running', `Approved privileged action "${decision.action}".`)
        return decision
      }

      this.pushLog('warning', `Rejected privileged action "${decision.action}".`)
      throw new Error(`Privileged action "${decision.action}" was rejected by the operator.`)
    } finally {
      if (this.pendingApprovalId === approval.id) {
        this.pendingApprovalId = undefined
      }
    }
  }

  private clearLaunchTimer() {
    if (this.launchTimer) {
      clearTimeout(this.launchTimer)
      this.launchTimer = undefined
    }
  }

  private isTerminal() {
    return isTerminalSessionState(this.session.state)
  }

  private emit(event: RuntimeSessionEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

function isProviderAdapterRegistry(value: RuntimeSessionManagerOptions['providerAdapters']): value is RuntimeProviderAdapterRegistry {
  return typeof value === 'object' && value !== null && 'getAdapter' in value && 'listAdapters' in value
}

export function createRuntimeSessionManager(options: RuntimeSessionManagerOptions = {}): RuntimeSessionManager {
  const sessions = new Map<string, RuntimeSessionHandle>()
  const providerAdapters = isProviderAdapterRegistry(options.providerAdapters)
    ? options.providerAdapters
    : createRuntimeProviderAdapterRegistry(options.providerAdapters)

  return {
    startSession(request) {
      if (sessions.has(request.sessionId)) {
        throw new Error(`Session "${request.sessionId}" is already active in the runtime.`)
      }

      const session = new InProcessRuntimeSession(
        request,
        providerAdapters,
        options.approvalHandler,
        (sessionId) => {
          sessions.delete(sessionId)
        },
      )
      sessions.set(request.sessionId, session)
      return session
    },
    getSession(sessionId) {
      return sessions.get(sessionId)
    },
    dispose() {
      for (const session of sessions.values()) {
        session.dispose()
      }

      sessions.clear()
    },
  }
}
