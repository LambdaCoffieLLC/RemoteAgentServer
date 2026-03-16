import { createManifest } from '@remote-agent/shared'

export function describeServerApp() {
  return createManifest('server', 'Control plane entrypoint scaffolded in the monorepo.')
}
