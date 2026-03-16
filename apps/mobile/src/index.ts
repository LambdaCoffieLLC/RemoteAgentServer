import { createWorkspacePackageId } from '@remote-agent-server/shared'

export function createMobileManifest() {
  return {
    id: createWorkspacePackageId('mobile'),
    kind: 'mobile' as const,
  }
}
