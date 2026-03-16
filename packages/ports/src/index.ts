import type { HostId, IsoTimestamp, SessionId, WorkspaceId } from '@remote-agent/protocol'

export type ForwardedPortId = `port_${string}`
export type DetectedPortId = `detected_port_${string}`
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

export interface DetectedPort {
  id: DetectedPortId
  hostId: HostId
  workspaceId?: WorkspaceId
  sessionId?: SessionId
  localPort: number
  targetPort: number
  protocol: ForwardedPortProtocol
  label: string
  suggestedLabel?: string
  command?: string
  processId?: number
  detectedAt: IsoTimestamp
  lastSeenAt: IsoTimestamp
  forwardedPortId?: ForwardedPortId
}

export interface DetectedPortInput extends Omit<DetectedPort, 'targetPort' | 'protocol' | 'label' | 'detectedAt' | 'lastSeenAt'> {
  targetPort?: number
  protocol?: ForwardedPortProtocol
  label?: string
  suggestedLabel?: string
  detectedAt?: IsoTimestamp
  lastSeenAt?: IsoTimestamp
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

export function createDetectedPort(port: DetectedPortInput): DetectedPort {
  const suggestion = suggestDetectedPort({
    localPort: port.localPort,
    protocol: port.protocol,
    command: port.command,
  })

  return {
    ...port,
    targetPort: port.targetPort ?? port.localPort,
    protocol: port.protocol ?? suggestion.protocol,
    suggestedLabel: port.suggestedLabel ?? suggestion.label,
    label: normalizePortLabel(port.label ?? port.suggestedLabel ?? suggestion.label, port.localPort),
    detectedAt: port.detectedAt ?? port.lastSeenAt ?? new Date(0).toISOString(),
    lastSeenAt: port.lastSeenAt ?? port.detectedAt ?? new Date(0).toISOString(),
  }
}

export function hasForwardedPortExpired(port: Pick<ForwardedPort, 'expiresAt'>, now: IsoTimestamp) {
  return Boolean(port.expiresAt && port.expiresAt <= now)
}

export function isForwardedPortActive(port: ForwardedPort, now: IsoTimestamp) {
  return port.status === 'open' && !hasForwardedPortExpired(port, now)
}

export function isDetectedPortPromoted(port: Pick<DetectedPort, 'forwardedPortId'>) {
  return Boolean(port.forwardedPortId)
}

export function suggestDetectedPort(input: {
  localPort: number
  protocol?: ForwardedPortProtocol
  command?: string
}) {
  const command = input.command?.toLowerCase() ?? ''

  if (command.includes('storybook') || input.localPort === 6006) {
    return {
      label: 'Storybook',
      protocol: 'http' as const,
    }
  }

  if (command.includes('next')) {
    return {
      label: 'Next.js dev server',
      protocol: inferPortProtocol(input.localPort, input.protocol),
    }
  }

  if (command.includes('vite')) {
    return {
      label: 'Vite dev server',
      protocol: inferPortProtocol(input.localPort, input.protocol),
    }
  }

  if (command.includes('react-scripts')) {
    return {
      label: 'React dev server',
      protocol: inferPortProtocol(input.localPort, input.protocol),
    }
  }

  if (command.includes('webpack')) {
    return {
      label: 'Webpack dev server',
      protocol: inferPortProtocol(input.localPort, input.protocol),
    }
  }

  if (input.localPort === 9229 || command.includes('--inspect')) {
    return {
      label: 'Node Inspector',
      protocol: 'tcp' as const,
    }
  }

  if (input.localPort === 5432 || command.includes('postgres')) {
    return {
      label: 'PostgreSQL',
      protocol: 'tcp' as const,
    }
  }

  if (input.localPort === 6379 || command.includes('redis')) {
    return {
      label: 'Redis',
      protocol: 'tcp' as const,
    }
  }

  if (isCommonPreviewPort(input.localPort)) {
    return {
      label: 'Web preview',
      protocol: inferPortProtocol(input.localPort, input.protocol),
    }
  }

  return {
    label: `Port ${input.localPort}`,
    protocol: inferPortProtocol(input.localPort, input.protocol),
  }
}

function normalizePortLabel(label: string | undefined, localPort: number) {
  const trimmed = label?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : `Port ${localPort}`
}

function inferPortProtocol(localPort: number, protocol?: ForwardedPortProtocol): ForwardedPortProtocol {
  if (protocol) {
    return protocol
  }

  if ([443, 8443, 9443].includes(localPort)) {
    return 'https'
  }

  return isCommonPreviewPort(localPort) ? 'http' : 'tcp'
}

function isCommonPreviewPort(localPort: number) {
  return [3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081].includes(localPort)
}
