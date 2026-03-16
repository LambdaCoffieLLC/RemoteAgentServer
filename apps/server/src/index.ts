import { createAuthPolicy, type AuthPolicy } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, type ProviderDescriptor } from '@remote-agent-server/providers'
import { createRuntimeManifest } from '@remote-agent-server/runtime'
import { createSessionDescriptor, type SessionDescriptor } from '@remote-agent-server/sessions'

export interface ServerManifest {
  id: string
  kind: 'server'
  runtime: ReturnType<typeof createRuntimeManifest>
  auth: AuthPolicy
  defaultProvider: ProviderDescriptor
  bootstrapSession: SessionDescriptor
  previewPort: ManagedPort
  events: ProtocolEnvelope<{ sessionId: string }>
}

export function createServerManifest(): ServerManifest {
  const defaultProvider = createProviderDescriptor('claude-code', 'claude')
  const bootstrapSession = createSessionDescriptor({
    id: 'srv-session-1',
    workspaceId: 'workspace-control-plane',
    provider: defaultProvider.kind,
  })

  return {
    id: createWorkspacePackageId('server'),
    kind: 'server',
    runtime: createRuntimeManifest(),
    auth: createAuthPolicy(['operator-token', 'bootstrap-token']),
    defaultProvider,
    bootstrapSession,
    previewPort: createManagedPort({
      id: 'server-preview',
      port: 4173,
      protocol: 'http',
      visibility: 'shared',
      state: 'forwarded',
    }),
    events: createProtocolEnvelope('session.created', 'server', {
      sessionId: bootstrapSession.id,
    }),
  }
}
