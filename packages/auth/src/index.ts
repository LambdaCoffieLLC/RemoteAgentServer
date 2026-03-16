import type { HostId, WorkspaceId } from '@remote-agent/protocol'

export type SubjectKind = 'user' | 'service'

export type AuthScope =
  | 'hosts:read'
  | 'hosts:write'
  | 'workspaces:read'
  | 'workspaces:write'
  | 'sessions:read'
  | 'sessions:write'
  | 'approvals:read'
  | 'approvals:write'
  | 'notifications:read'
  | 'notifications:write'
  | 'ports:read'
  | 'ports:write'

export interface AuthenticatedActor {
  id: string
  kind: SubjectKind
  displayName: string
  scopes: AuthScope[]
  activeHostId?: HostId
  activeWorkspaceId?: WorkspaceId
}

export interface AuthorizationPolicy {
  resource: string
  scopes: AuthScope[]
}

export function createAuthorizationPolicy(resource: string, scopes: readonly AuthScope[]): AuthorizationPolicy {
  return {
    resource,
    scopes: [...scopes],
  }
}
