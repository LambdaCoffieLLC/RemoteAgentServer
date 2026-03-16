export type AppManifest = {
  name: string
  purpose: string
}

export function createManifest(name: string, purpose: string): AppManifest {
  return { name, purpose }
}
