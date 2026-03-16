import type { HostId, SessionId, WorkspaceId } from '@remote-agent/protocol'

export type ForwardedPortId = `port_${string}`
export type PortVisibility = 'private' | 'shared'

export interface ForwardedPort {
  id: ForwardedPortId
  hostId: HostId
  workspaceId?: WorkspaceId
  sessionId?: SessionId
  localPort: number
  targetPort: number
  visibility: PortVisibility
  label: string
}

export function createForwardedPort(port: ForwardedPort): ForwardedPort {
  return { ...port }
}
