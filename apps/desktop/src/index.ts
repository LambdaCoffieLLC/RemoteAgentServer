import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, type ProviderDescriptor } from '@remote-agent-server/providers'
import { createSessionDescriptor, type SessionDescriptor } from '@remote-agent-server/sessions'
import { createNavigationItem, createStatusBadge, type NavigationItem, type StatusBadge } from '@remote-agent-server/ui'

export interface DesktopManifest {
  id: string
  kind: 'desktop'
  auth: AuthPolicy
  session: SessionDescriptor
  provider: ProviderDescriptor
  previewPort: ManagedPort
  navigation: NavigationItem[]
  status: StatusBadge
  stream: ProtocolEnvelope<{ sessionId: string }>
}

export function createDesktopManifest(): DesktopManifest {
  const provider = createProviderDescriptor('claude-code', 'claude')
  const session = createSessionDescriptor({
    id: 'desktop-session-1',
    workspaceId: 'workspace-desktop',
    provider: provider.kind,
    state: 'running',
    mode: 'worktree',
  })

  return {
    id: createWorkspacePackageId('desktop'),
    kind: 'desktop',
    auth: createAuthPolicy(['operator-token']),
    session,
    provider,
    previewPort: createManagedPort({
      id: 'desktop-preview',
      port: 5173,
      protocol: 'http',
      visibility: 'shared',
      state: 'forwarded',
    }),
    navigation: [
      createNavigationItem('workspaces', 'Workspaces', '/workspaces'),
      createNavigationItem('sessions', 'Sessions', '/sessions'),
    ],
    status: createStatusBadge('Synced', 'info'),
    stream: createProtocolEnvelope('session.stream', 'desktop', {
      sessionId: session.id,
    }),
  }
}
