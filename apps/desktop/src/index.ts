import { createManifest } from '@remote-agent/shared'

export function describeDesktopApp() {
  return createManifest('desktop', 'Desktop client scaffolded in the monorepo.')
}
