import { createManifest } from '@remote-agent/shared'

export function describeRuntimeApp() {
  return createManifest('runtime', 'Runtime bootstrap scaffolded in the monorepo.')
}
