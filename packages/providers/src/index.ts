export type ProviderId = 'claude-code' | 'codex' | 'opencode'

export type ProviderCapability = 'logs' | 'notifications' | 'approvals' | 'port-discovery'

export interface ProviderDescriptor {
  id: ProviderId
  displayName: string
  capabilities: ProviderCapability[]
}

export const coreProviderDescriptors: readonly ProviderDescriptor[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: ['logs', 'notifications', 'approvals'],
  },
  {
    id: 'codex',
    displayName: 'Codex',
    capabilities: ['logs', 'notifications', 'approvals', 'port-discovery'],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    capabilities: ['logs', 'notifications'],
  },
]
