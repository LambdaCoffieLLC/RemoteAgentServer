import type { AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary } from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

const actor: AuthenticatedActor = {
  id: 'user_web',
  kind: 'user',
  displayName: 'Browser Operator',
  scopes: ['hosts:read', 'sessions:read', 'ports:read'],
}

const hostId = 'host_web' as HostId
const workspaceId = 'workspace_web' as WorkspaceId
const sessionId = 'session_web' as SessionId

export function describeWebApp() {
  return createSurfaceSummary({
    manifest: createManifest('web', 'Browser client scaffolded in the monorepo.', [
      '@remote-agent/protocol',
      '@remote-agent/auth',
      '@remote-agent/sessions',
      '@remote-agent/ports',
      '@remote-agent/providers',
      '@remote-agent/ui',
    ]),
    actor: {
      displayName: actor.displayName,
    },
    sessions: [
      createSessionSummary({
        id: sessionId,
        hostId,
        workspaceId,
        provider: 'codex',
        requestedBy: {
          id: actor.id,
          displayName: actor.displayName,
        },
        status: 'running',
        startedAt: '2026-03-16T00:00:00.000Z',
      }),
    ],
    ports: [
      createForwardedPort({
        id: 'port_web_preview',
        hostId,
        workspaceId,
        sessionId,
        localPort: 4173,
        targetPort: 4173,
        visibility: 'shared',
        label: 'Web preview',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Sessions', href: '/sessions', badgeTone: 'info' },
      { label: 'Ports', href: '/ports', badgeTone: 'neutral' },
    ],
  })
}
