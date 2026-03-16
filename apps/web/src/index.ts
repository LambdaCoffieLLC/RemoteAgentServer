import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, type ProviderDescriptor } from '@remote-agent-server/providers'
import { createSessionDescriptor, type SessionDescriptor } from '@remote-agent-server/sessions'
import { createNavigationItem, createStatusBadge, type NavigationItem, type StatusBadge } from '@remote-agent-server/ui'

export interface WebManifest {
  id: string
  kind: 'web'
  auth: AuthPolicy
  session: SessionDescriptor
  provider: ProviderDescriptor
  previewPort: ManagedPort
  nav: NavigationItem[]
  status: StatusBadge
  stream: ProtocolEnvelope<{ sessionId: string }>
}

export function createWebManifest(): WebManifest {
  const provider = createProviderDescriptor('codex', 'codex')
  const session = createSessionDescriptor({
    id: 'web-session-1',
    workspaceId: 'workspace-browser',
    provider: provider.kind,
    state: 'running',
  })

  return {
    id: createWorkspacePackageId('web'),
    kind: 'web',
    auth: createAuthPolicy(['operator-token']),
    session,
    provider,
    previewPort: createManagedPort({
      id: 'web-preview',
      port: 3001,
      protocol: 'http',
      visibility: 'shared',
      state: 'forwarded',
    }),
    nav: [
      createNavigationItem('hosts', 'Hosts', '/hosts'),
      createNavigationItem('sessions', 'Sessions', '/sessions'),
    ],
    status: createStatusBadge('Connected', 'success'),
    stream: createProtocolEnvelope('session.stream', 'web', {
      sessionId: session.id,
    }),
  }
}
