import { createManifest } from '@remote-agent/shared'

export function describeMobileApp() {
  return createManifest('mobile', 'Mobile client scaffolded in the monorepo.')
}
