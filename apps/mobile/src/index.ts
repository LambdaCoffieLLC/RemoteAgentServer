import { createAuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort } from '@remote-agent-server/ports'
import type { ProtocolEnvelope } from '@remote-agent-server/protocol'
import { getProviderDisplayName } from '@remote-agent-server/providers'
import { isTerminalSessionState } from '@remote-agent-server/sessions'
import { createNavigationItem, createStatusBadge } from '@remote-agent-server/ui'

export const mobileAuthPolicy = createAuthPolicy(['operator-token'])
export const mobileNavigation = [
  createNavigationItem('sessions', 'Sessions', '/sessions'),
  createNavigationItem('approvals', 'Approvals', '/approvals'),
  createNavigationItem('previews', 'Previews', '/previews'),
]
export const mobileStatusBadge = createStatusBadge('Live control', 'info')
export const mobilePreviewPort = createManagedPort({
  id: 'mobile-preview-template',
  port: 4318,
  protocol: 'http',
  visibility: 'shared',
  state: 'forwarded',
})

export function describeMobileSessionState(
  state: Parameters<typeof isTerminalSessionState>[0],
  envelope?: ProtocolEnvelope<{ sessionId?: string }>,
) {
  const detail = envelope?.payload.sessionId ? ` for ${envelope.payload.sessionId}` : ''
  return isTerminalSessionState(state)
    ? `Session finished${detail}`
    : `${getProviderDisplayName('codex')} operator flow is ${state}${detail}`
}

export * from './client.js'
export * from './controller.js'
export * from './preview.js'
export * from './storage.js'
export * from './types.js'
