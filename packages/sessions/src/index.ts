export const sessionStates = ['queued', 'running', 'blocked', 'completed', 'failed', 'canceled'] as const

export type SessionState = (typeof sessionStates)[number]
export type SessionMode = 'workspace' | 'worktree'

export interface SessionDescriptor {
  id: string
  workspaceId: string
  provider: string
  state: SessionState
  mode: SessionMode
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
