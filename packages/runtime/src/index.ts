import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, type ProviderDescriptor } from '@remote-agent-server/providers'
import { createSessionDescriptor, type SessionDescriptor } from '@remote-agent-server/sessions'

export * from './status.js'
export * from './provider-adapters.js'
export * from './session-manager.js'

export interface RuntimeManifest {
  id: string
  kind: 'runtime'
  name: string
  auth: AuthPolicy
  provider: ProviderDescriptor
  session: SessionDescriptor
  tunnel: ManagedPort
  controlChannel: ProtocolEnvelope<{ sessionId: string }>
}

export function createRuntimeManifest(name = 'remote-runtime'): RuntimeManifest {
  const provider = createProviderDescriptor('codex', 'codex')
  const session = createSessionDescriptor({
    id: 'runtime-bootstrap',
    workspaceId: 'workspace-local',
    provider: provider.kind,
    state: 'running',
  })

  return {
    id: createWorkspacePackageId('runtime'),
    kind: 'runtime',
    name,
    auth: createAuthPolicy(['bootstrap-token']),
    provider,
    session,
    tunnel: createManagedPort({
      id: 'runtime-control-port',
      port: 3000,
      protocol: 'http',
      visibility: 'private',
      state: 'forwarded',
    }),
    controlChannel: createProtocolEnvelope('runtime.connected', 'runtime', {
      sessionId: session.id,
    }),
  }
}
