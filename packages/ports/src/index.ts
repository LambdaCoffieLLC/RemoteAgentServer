export const portProtocols = ['http', 'tcp'] as const
export const portVisibilities = ['private', 'shared'] as const
export const portStates = ['detected', 'forwarded'] as const
export const portForwardingStates = ['open', 'closed', 'expired'] as const

export type PortProtocol = (typeof portProtocols)[number]
export type PortVisibility = (typeof portVisibilities)[number]
export type PortState = (typeof portStates)[number]
export type PortForwardingState = (typeof portForwardingStates)[number]

export interface ManagedPort {
  id: string
  port: number
  protocol: PortProtocol
  visibility: PortVisibility
  state: PortState
  forwardingState?: PortForwardingState
  managedUrl?: string
  expiresAt?: string
  expiredAt?: string
}

export function createManagedPort(
  port: Omit<ManagedPort, 'state' | 'forwardingState'> &
    Partial<
      Pick<
        ManagedPort,
        'state' | 'forwardingState' | 'managedUrl' | 'expiresAt' | 'expiredAt'
      >
    >,
): ManagedPort {
  return {
    state: 'detected',
    forwardingState: port.state === 'forwarded' ? 'open' : undefined,
    ...port,
  }
}

export function createManagedPortLabel(port: ManagedPort) {
  return `${port.protocol.toUpperCase()} ${port.port} (${port.visibility})`
}

export function isManagedPortActive(port: ManagedPort) {
  return port.state === 'forwarded' && port.forwardingState === 'open'
}
