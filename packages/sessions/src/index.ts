import { randomUUID } from 'node:crypto'

export const sessionStates = ['queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'canceled'] as const
export const sessionLogLevels = ['info', 'warning', 'error'] as const
export const sessionOutputStreams = ['stdout', 'stderr'] as const

export type SessionState = (typeof sessionStates)[number]
export type SessionMode = 'workspace' | 'worktree'
export type SessionLogLevel = (typeof sessionLogLevels)[number]
export type SessionOutputStream = (typeof sessionOutputStreams)[number]

export interface SessionDescriptor {
  id: string
  workspaceId: string
  provider: string
  state: SessionState
  mode: SessionMode
}

export interface SessionLogEntry {
  id: string
  timestamp: string
  level: SessionLogLevel
  message: string
}

export interface SessionOutputEntry {
  id: string
  timestamp: string
  stream: SessionOutputStream
  text: string
}

export function createSessionDescriptor(
  session: Omit<SessionDescriptor, 'state' | 'mode'> & Partial<Pick<SessionDescriptor, 'state' | 'mode'>>,
): SessionDescriptor {
  return {
    state: 'queued',
    mode: 'workspace',
    ...session,
  }
}

export function isTerminalSessionState(state: SessionState) {
  return state === 'completed' || state === 'failed' || state === 'canceled'
}

export function createSessionLogEntry(
  level: SessionLogLevel,
  message: string,
  timestamp = new Date().toISOString(),
): SessionLogEntry {
  return {
    id: `session-log-${randomUUID()}`,
    timestamp,
    level,
    message,
  }
}

export function createSessionOutputEntry(
  stream: SessionOutputStream,
  text: string,
  timestamp = new Date().toISOString(),
): SessionOutputEntry {
  return {
    id: `session-output-${randomUUID()}`,
    timestamp,
    stream,
    text,
  }
}
