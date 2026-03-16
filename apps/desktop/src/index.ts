import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import {
  createProtocolEnvelope,
  createWorkspacePackageId,
  type ProtocolEnvelope,
} from '@remote-agent-server/protocol'
import {
  createProviderDescriptor,
  type ProviderDescriptor,
} from '@remote-agent-server/providers'
import {
  createSessionDescriptor,
  type SessionDescriptor,
} from '@remote-agent-server/sessions'
import {
  createNavigationItem,
  createStatusBadge,
  type NavigationItem,
  type StatusBadge,
} from '@remote-agent-server/ui'

export interface DesktopAppManifest {
  auth: AuthPolicy
  id: string
  kind: 'desktop'
  navigation: NavigationItem[]
  previewPort: ManagedPort
  provider: ProviderDescriptor
  session: SessionDescriptor
  status: StatusBadge
  stream: ProtocolEnvelope<{ workspaceScope: 'local' | 'remote' }>
}

export function createDesktopAppManifest(): DesktopAppManifest {
  const provider = createProviderDescriptor('codex', 'codex')
  const session = createSessionDescriptor({
    id: 'desktop-session-bootstrap',
    mode: 'workspace',
    provider: provider.kind,
    state: 'running',
    workspaceId: 'desktop-workspace',
  })

  return {
    auth: createAuthPolicy(['operator-token']),
    id: createWorkspacePackageId('desktop'),
    kind: 'desktop',
    navigation: [
      createNavigationItem('remote-workspaces', 'Remote Workspaces', '#remote'),
      createNavigationItem('local-workspaces', 'Local Workspaces', '#local'),
      createNavigationItem('sessions', 'Sessions', '#sessions'),
    ],
    previewPort: createManagedPort({
      id: 'desktop-preview',
      port: 4173,
      protocol: 'http',
      state: 'forwarded',
      visibility: 'shared',
    }),
    provider,
    session,
    status: createStatusBadge('Desktop ready', 'info'),
    stream: createProtocolEnvelope('desktop.scope.changed', 'desktop', {
      workspaceScope: 'remote',
    }),
  }
}

export * from './app.js'
export * from './client.js'
export * from './controller.js'
export * from './storage.js'
export * from './types.js'
