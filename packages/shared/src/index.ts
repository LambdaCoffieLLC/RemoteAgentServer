export const workspacePackages = ['server', 'runtime', 'web', 'mobile', 'desktop', 'shared'] as const

export type WorkspacePackageName = (typeof workspacePackages)[number]

export function createWorkspacePackageId(name: WorkspacePackageName) {
  return `@remote-agent-server/${name}`
}
