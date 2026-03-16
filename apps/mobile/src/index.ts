import type { AuthenticatedActor } from '@remote-agent/auth'
import { createForwardedPort } from '@remote-agent/ports'
import { createManifest, type HostId, type SessionId, type WorkspaceId } from '@remote-agent/protocol'
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary } from '@remote-agent/sessions'
import { createSurfaceSummary } from '@remote-agent/ui'

const actor: AuthenticatedActor = {
  id: 'user_mobile',
  kind: 'user',
  displayName: 'Mobile Operator',
  scopes: ['sessions:read', 'ports:read'],
}

const hostId = 'host_mobile' as HostId
const workspaceId = 'workspace_mobile' as WorkspaceId
const sessionId = 'session_mobile' as SessionId

export function describeMobileApp() {
  return createSurfaceSummary({
    manifest: createManifest('mobile', 'Mobile client scaffolded in the monorepo.', [
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
        provider: 'claude-code',
        requestedBy: {
          id: actor.id,
          displayName: actor.displayName,
        },
        status: 'paused',
        startedAt: '2026-03-16T00:00:00.000Z',
      }),
    ],
    ports: [
      createForwardedPort({
        id: 'port_mobile_preview',
        hostId,
        workspaceId,
        sessionId,
        localPort: 8081,
        targetPort: 8081,
        visibility: 'private',
        label: 'Mobile dev server',
      }),
    ],
    providers: [...coreProviderDescriptors],
    navigation: [
      { label: 'Approvals', href: '/approvals', badgeTone: 'warning' },
      { label: 'Sessions', href: '/sessions', badgeTone: 'info' },
    ],
  })
}
