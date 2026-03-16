import { createWorkspacePackageId } from '@remote-agent-server/shared'

export function createDesktopManifest() {
  return {
    id: createWorkspacePackageId('desktop'),
    kind: 'desktop' as const,
  }
}
