export const providerKinds = ['claude-code', 'codex', 'opencode'] as const

export type ProviderKind = (typeof providerKinds)[number]
export type ApprovalMode = 'manual' | 'auto'

export interface ProviderDescriptor {
  kind: ProviderKind
  displayName: string
  command: string
  approvalMode: ApprovalMode
}

const providerDisplayNames: Record<ProviderKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

export function getProviderDisplayName(kind: ProviderKind) {
  return providerDisplayNames[kind]
}

export function createProviderDescriptor(kind: ProviderKind, command: string): ProviderDescriptor {
  return {
    kind,
    command,
    displayName: getProviderDisplayName(kind),
    approvalMode: 'manual',
  }
}
