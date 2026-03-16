import { createManifest } from '@remote-agent/shared'

export function describeWebApp() {
  return createManifest('web', 'Browser client scaffolded in the monorepo.')
}
