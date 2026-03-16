export const portProtocols = ['http', 'tcp'] as const
export const portVisibilities = ['private', 'shared'] as const
export const portStates = ['detected', 'forwarded'] as const

export type PortProtocol = (typeof portProtocols)[number]
export type PortVisibility = (typeof portVisibilities)[number]
export type PortState = (typeof portStates)[number]

export interface ManagedPort {
  id: string
  port: number
  protocol: PortProtocol
  visibility: PortVisibility
  state: PortState
}

export function createManagedPort(
  port: Omit<ManagedPort, 'state'> & Partial<Pick<ManagedPort, 'state'>>,
): ManagedPort {
  return {
    state: 'detected',
    ...port,
  }
}

export function createManagedPortLabel(port: ManagedPort) {
  return `${port.protocol.toUpperCase()} ${port.port} (${port.visibility})`
}
