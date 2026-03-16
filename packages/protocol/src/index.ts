export const applicationKinds = ['server', 'runtime', 'web', 'mobile', 'desktop'] as const
export const sharedPackageKinds = ['protocol', 'auth', 'sessions', 'ports', 'providers', 'ui'] as const

export type ApplicationKind = (typeof applicationKinds)[number]
export type SharedPackageKind = (typeof sharedPackageKinds)[number]
export type WorkspacePackageName = ApplicationKind | SharedPackageKind

export interface ProtocolEnvelope<TPayload = unknown> {
  type: string
  origin: ApplicationKind
  payload: TPayload
}

export function createWorkspacePackageId(name: WorkspacePackageName) {
  return `@remote-agent-server/${name}` as const
}

export function createProtocolEnvelope<TPayload>(
  type: string,
  origin: ApplicationKind,
  payload: TPayload,
): ProtocolEnvelope<TPayload> {
  return {
    type,
    origin,
    payload,
  }
}
