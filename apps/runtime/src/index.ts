import { createForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary } from '@remote-agent/sessions'

const hostId = 'host_runtime' as HostId
const workspaceId = 'workspace_runtime' as WorkspaceId
const sessionId = 'session_runtime_probe' as SessionId

export function describeRuntimeApp() {
  const provider = coreProviderDescriptors.find(({ id }) => id === 'opencode') ?? coreProviderDescriptors[0]

  return {
    manifest: createManifest('runtime', 'Runtime bootstrap scaffolded in the monorepo.', [
      '@remote-agent/protocol',
      '@remote-agent/sessions',
      '@remote-agent/ports',
      '@remote-agent/providers',
    ]),
    provider,
    session: createSessionSummary({
      id: sessionId,
      hostId,
      workspaceId,
      provider: provider.id,
      requestedBy: {
        id: 'runtime',
        displayName: 'Runtime Agent',
      },
      status: 'queued',
      startedAt: '2026-03-16T00:00:00.000Z',
    }),
    detectedPort: createForwardedPort({
      id: 'port_runtime_probe',
      hostId,
      workspaceId,
      sessionId,
      localPort: 8080,
      targetPort: 8080,
      visibility: 'private',
      label: 'Runtime health endpoint',
    }),
  }
}
