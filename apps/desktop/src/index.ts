import type { AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary } from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

const actor: AuthenticatedActor = {
  id: 'user_desktop',
  kind: 'user',
  displayName: 'Desktop Operator',
  scopes: ['hosts:read', 'sessions:read', 'sessions:write', 'ports:read'],
}

const hostId = 'host_desktop' as HostId
const workspaceId = 'workspace_desktop' as WorkspaceId
const sessionId = 'session_desktop' as SessionId

export function describeDesktopApp() {
  return createSurfaceSummary({
    manifest: createManifest('desktop', 'Desktop client scaffolded in the monorepo.', [
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
        provider: 'opencode',
        requestedBy: {
          id: actor.id,
          displayName: actor.displayName,
        },
        status: 'completed',
        startedAt: '2026-03-16T00:00:00.000Z',
      }),
    ],
    ports: [
      createForwardedPort({
        id: 'port_desktop_preview',
        hostId,
        workspaceId,
        sessionId,
        localPort: 6006,
        targetPort: 6006,
        visibility: 'shared',
        label: 'Desktop preview',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Workspaces', href: '/workspaces', badgeTone: 'neutral' },
      { label: 'Diffs', href: '/diffs', badgeTone: 'success' },
    ],
  })
}
