import { createAuthorizationPolicy } from '@remote-agent/auth'
import { createForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary } from '@remote-agent/sessions'

const hostId = 'host_control_plane' as HostId
const workspaceId = 'workspace_server' as WorkspaceId
const sessionId = 'session_server_bootstrap' as SessionId

export function describeServerApp() {
  const provider = coreProviderDescriptors.find(({ id }) => id === 'codex') ?? coreProviderDescriptors[0]

  return {
    manifest: createManifest('server', 'Control plane entrypoint scaffolded in the monorepo.', [
      '@remote-agent/protocol',
      '@remote-agent/auth',
      '@remote-agent/sessions',
      '@remote-agent/ports',
      '@remote-agent/providers',
    ]),
    authorization: createAuthorizationPolicy('control-plane', [
      'hosts:read',
      'sessions:read',
      'sessions:write',
      'ports:write',
    ]),
    session: createSessionSummary({
      id: sessionId,
      hostId,
      workspaceId,
      provider: provider.id,
      requestedBy: {
        id: 'system',
        displayName: 'RemoteAgentServer',
      },
      status: 'running',
      startedAt: '2026-03-16T00:00:00.000Z',
    }),
    forwardedPort: createForwardedPort({
      id: 'port_server_preview',
      hostId,
      workspaceId,
      sessionId,
      localPort: 3000,
      targetPort: 3000,
      visibility: 'private',
      label: 'Server preview',
    }),
    provider,
  }
}
