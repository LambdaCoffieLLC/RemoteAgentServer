export type AppKind = 'server' | 'runtime' | 'web' | 'mobile' | 'desktop'

export type HostId = `host_${string}`
export type WorkspaceId = `workspace_${string}`
export type SessionId = `session_${string}`
export type IsoTimestamp = string

export interface ProtocolEnvelope<TType extends string, TPayload> {
  type: TType
  payload: TPayload
}

export interface AppManifest {
  kind: AppKind
  packageName: `@remote-agent/${AppKind}`
  purpose: string
  sharedPackages: string[]
}

export function createManifest(kind: AppKind, purpose: string, sharedPackages: readonly string[]): AppManifest {
  return {
    kind,
    packageName: `@remote-agent/${kind}`,
    purpose,
    sharedPackages: [...sharedPackages],
  }
}
