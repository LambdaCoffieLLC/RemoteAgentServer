import type { AuthenticatedActor } from '@remote-agent/auth'
import type { ForwardedPort } from '@remote-agent/ports'
import type { AppManifest } from '@remote-agent/protocol'
import type { ProviderDescriptor } from '@remote-agent/providers'
import type { SessionSummary } from '@remote-agent/sessions'

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning'

export interface NavigationItem {
  label: string
  href: string
  badgeTone?: BadgeTone
}

export interface SurfaceSummary {
  manifest: AppManifest
  actor: Pick<AuthenticatedActor, 'displayName'>
  sessions: SessionSummary[]
  ports: ForwardedPort[]
  providers: ProviderDescriptor[]
  navigation: NavigationItem[]
}

export function createSurfaceSummary(summary: SurfaceSummary): SurfaceSummary {
  return {
    manifest: {
      ...summary.manifest,
      sharedPackages: [...summary.manifest.sharedPackages],
    },
    actor: { ...summary.actor },
    sessions: [...summary.sessions],
    ports: [...summary.ports],
    providers: [...summary.providers],
    navigation: [...summary.navigation],
  }
}
