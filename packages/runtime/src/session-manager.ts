import { randomUUID } from 'node:crypto'
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
import { type ProviderKind } from '@remote-agent-server/providers'

type RuntimeSessionStep =
  | { kind: 'log'; level: SessionLogEntry['level']; message: string }
  | { kind: 'output'; stream: SessionOutputEntry['stream']; text: string }

export interface RuntimeSessionStartRequest {
  sessionId: string
  workspaceId: string
  workspacePath: string
  provider: ProviderKind
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

const providerScripts: Record<ProviderKind, RuntimeSessionStep[]> = {
  'claude-code': [
    { kind: 'log', level: 'info', message: 'Collecting repository context.' },
    { kind: 'output', stream: 'stdout', text: 'claude> reading workspace files\n' },
    { kind: 'log', level: 'info', message: 'Drafting an implementation plan.' },
    { kind: 'output', stream: 'stdout', text: 'claude> plan ready for execution\n' },
    { kind: 'log', level: 'info', message: 'Applying the requested changes.' },
  ],
  codex: [
    { kind: 'log', level: 'info', message: 'Inspecting the workspace before changes.' },
    { kind: 'output', stream: 'stdout', text: 'codex> rg --files\n' },
    { kind: 'log', level: 'info', message: 'Implementing the active user story.' },
    { kind: 'output', stream: 'stdout', text: 'codex> apply_patch\n' },
    { kind: 'log', level: 'info', message: 'Running verification for the session changes.' },
  ],
  opencode: [
    { kind: 'log', level: 'info', message: 'Indexing the workspace.' },
    { kind: 'output', stream: 'stdout', text: 'opencode> workspace indexed\n' },
    { kind: 'log', level: 'info', message: 'Producing code changes.' },
    { kind: 'output', stream: 'stdout', text: 'opencode> patch generated\n' },
    { kind: 'log', level: 'info', message: 'Preparing a completion summary.' },
  ],
}

const runtimeStepDelayMs = 40

class InProcessRuntimeSession implements RuntimeSessionHandle {
  readonly id: string

  private readonly listeners = new Set<(event: RuntimeSessionEvent) => void>()
  private readonly logs: SessionLogEntry[] = []
  private readonly output: SessionOutputEntry[] = []
  private readonly createdAt = new Date().toISOString()
  private readonly script: RuntimeSessionStep[]

  private readonly session: SessionDescriptor
  private readonly workspacePath: string

  private updatedAt = this.createdAt
  private startedAt?: string
  private completedAt?: string
  private timeout?: NodeJS.Timeout
  private nextStepIndex = 0

  constructor(
    request: RuntimeSessionStartRequest,
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
    this.script = providerScripts[request.provider]

    setTimeout(() => {
      if (this.session.state !== 'queued') {
        return
      }

      this.startedAt = new Date().toISOString()
      this.setState('running', `Started ${request.provider} for ${request.workspacePath}.`)
      this.scheduleNextStep()
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

    this.clearScheduledStep()
    this.setState('paused', 'Paused by operator request.')
    return this.getSnapshot()
  }

  resume() {
    if (this.session.state !== 'paused') {
      throw new Error('Only paused sessions can be resumed.')
    }

    this.setState('running', 'Resumed by operator request.')
    this.scheduleNextStep()
    return this.getSnapshot()
  }

  cancel() {
    if (isTerminalSessionState(this.session.state)) {
      throw new Error('Terminal sessions cannot be canceled again.')
    }

    this.clearScheduledStep()
    this.pushLog('warning', 'Canceled by operator request.')
    this.setState('canceled', 'Canceled by operator request.')
    return this.getSnapshot()
  }

  dispose() {
    this.clearScheduledStep()
    this.listeners.clear()
  }

  private scheduleNextStep() {
    if (this.session.state !== 'running') {
      return
    }

    this.timeout = setTimeout(() => {
      this.timeout = undefined

      if (this.session.state !== 'running') {
        return
      }

      const step = this.script[this.nextStepIndex]
      if (!step) {
        this.pushLog('info', 'Provider finished the session workload.')
        this.setState('completed', 'Provider completed the session successfully.')
        return
      }

      this.nextStepIndex += 1
      if (step.kind === 'log') {
        this.pushLog(step.level, step.message)
      } else {
        this.pushOutput(step.stream, step.text)
      }

      this.scheduleNextStep()
    }, runtimeStepDelayMs)
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

  private clearScheduledStep() {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }
  }

  private emit(event: RuntimeSessionEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export function createRuntimeSessionManager(): RuntimeSessionManager {
  const sessions = new Map<string, RuntimeSessionHandle>()

  return {
    startSession(request) {
      if (sessions.has(request.sessionId)) {
        throw new Error(`Session "${request.sessionId}" is already active in the runtime.`)
      }

      const session = new InProcessRuntimeSession(request, (sessionId) => {
        sessions.delete(sessionId)
      })
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
