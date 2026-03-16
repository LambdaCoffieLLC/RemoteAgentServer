import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, type ProviderDescriptor } from '@remote-agent-server/providers'
import { createSessionDescriptor, type SessionDescriptor } from '@remote-agent-server/sessions'
import { createNavigationItem, createStatusBadge, type NavigationItem, type StatusBadge } from '@remote-agent-server/ui'

export interface MobileManifest {
  id: string
  kind: 'mobile'
  auth: AuthPolicy
  session: SessionDescriptor
  provider: ProviderDescriptor
  previewPort: ManagedPort
  tabs: NavigationItem[]
  status: StatusBadge
  notifications: ProtocolEnvelope<{ sessionId: string }>
}

export function createMobileManifest(): MobileManifest {
  const provider = createProviderDescriptor('opencode', 'opencode')
  const session = createSessionDescriptor({
    id: 'mobile-session-1',
    workspaceId: 'workspace-phone',
    provider: provider.kind,
    state: 'blocked',
  })

  return {
    id: createWorkspacePackageId('mobile'),
    kind: 'mobile',
    auth: createAuthPolicy(['operator-token']),
    session,
    provider,
    previewPort: createManagedPort({
      id: 'mobile-preview',
      port: 8080,
      protocol: 'http',
      visibility: 'private',
    }),
    tabs: [
      createNavigationItem('sessions', 'Sessions', '/sessions'),
      createNavigationItem('approvals', 'Approvals', '/approvals'),
    ],
    status: createStatusBadge('Attention needed', 'warning'),
    notifications: createProtocolEnvelope('session.blocked', 'mobile', {
      sessionId: session.id,
    }),
  }
}
