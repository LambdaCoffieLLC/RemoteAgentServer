import { createRuntimeManifest } from '@remote-agent-server/runtime'
import { createWorkspacePackageId } from '@remote-agent-server/shared'

export function createServerManifest() {
  return {
    id: createWorkspacePackageId('server'),
    kind: 'server' as const,
    runtime: createRuntimeManifest(),
  }
}
