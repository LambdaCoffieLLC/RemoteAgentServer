export const portProtocols = ['http', 'tcp'] as const
export const portVisibilities = ['private', 'shared'] as const
export const portStates = ['detected', 'forwarded'] as const
export const portForwardingStates = ['open', 'closed', 'expired'] as const
export const commonDevelopmentPorts = [
  3000,
  3001,
  4173,
  4200,
  4321,
  5173,
  6006,
  8000,
  8080,
  8081,
  8787,
] as const

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

export function suggestManagedPortLabel(port: Pick<ManagedPort, 'port' | 'protocol'>) {
  switch (port.port) {
    case 3000:
      return 'Next.js dev server'
    case 3001:
      return port.protocol === 'http' ? 'Secondary web app' : 'Secondary service'
    case 4173:
      return 'Vite preview'
    case 4200:
      return 'Angular dev server'
    case 4321:
      return 'Storybook'
    case 5173:
      return 'Vite dev server'
    case 6006:
      return 'Storybook'
    case 8000:
      return 'Django dev server'
    case 8080:
      return port.protocol === 'http' ? 'Preview app' : 'TCP service'
    case 8081:
      return 'Dev server'
    case 8787:
      return 'Wrangler dev server'
    default:
      return undefined
  }
}

export function isManagedPortActive(port: ManagedPort) {
  return port.state === 'forwarded' && port.forwardingState === 'open'
}
