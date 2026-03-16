import type { HostId, IsoTimestamp, SessionId, WorkspaceId } from '@remote-agent/protocol'

export type ForwardedPortId = `port_${string}`
export type PortVisibility = 'private' | 'shared'
export type ForwardedPortProtocol = 'tcp' | 'http' | 'https'
export type ForwardedPortStatus = 'open' | 'closed' | 'expired'

export interface ForwardedPort {
  id: ForwardedPortId
  hostId: HostId
  workspaceId?: WorkspaceId
  sessionId?: SessionId
  localPort: number
  targetPort: number
  protocol: ForwardedPortProtocol
  status: ForwardedPortStatus
  visibility: PortVisibility
  label: string
  expiresAt?: IsoTimestamp
  managedUrl?: string
}

export interface ForwardedPortInput extends Omit<ForwardedPort, 'protocol' | 'status'> {
  protocol?: ForwardedPortProtocol
  status?: ForwardedPortStatus
}

export function createForwardedPort(port: ForwardedPortInput): ForwardedPort {
  const protocol = port.protocol ?? 'tcp'

  return {
    ...port,
    protocol,
    status: port.status ?? 'open',
    managedUrl: protocol === 'tcp' ? undefined : port.managedUrl,
  }
}

export function hasForwardedPortExpired(port: Pick<ForwardedPort, 'expiresAt'>, now: IsoTimestamp) {
  return Boolean(port.expiresAt && port.expiresAt <= now)
}

export function isForwardedPortActive(port: ForwardedPort, now: IsoTimestamp) {
  return port.status === 'open' && !hasForwardedPortExpired(port, now)
}
