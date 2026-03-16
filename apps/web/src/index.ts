import { createWorkspacePackageId } from '@remote-agent-server/shared'

export function createWebManifest() {
  return {
    id: createWorkspacePackageId('web'),
    kind: 'web' as const,
  }
}
