import { createWorkspacePackageId } from '@remote-agent-server/shared'

export function createRuntimeManifest(name = 'remote-runtime') {
  return {
    id: createWorkspacePackageId('runtime'),
    kind: 'runtime' as const,
    name,
  }
}
