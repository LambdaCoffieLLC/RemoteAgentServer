export const providerKinds = ['claude-code', 'codex', 'opencode'] as const
export const providerApprovalStatuses = ['pending', 'approved', 'rejected'] as const

export type ProviderKind = (typeof providerKinds)[number]
export type ApprovalMode = 'manual' | 'auto'
export type ProviderApprovalStatus = (typeof providerApprovalStatuses)[number]

export interface ProviderDescriptor {
  kind: ProviderKind
  displayName: string
  command: string
  approvalMode: ApprovalMode
}

export interface ProviderApprovalRequest {
  id: string
  sessionId: string
  provider: ProviderKind
  action: string
  message: string
  status: 'pending'
  requestedAt: string
}

export interface ProviderApprovalDecision {
  id: string
  sessionId: string
  provider: ProviderKind
  action: string
  message: string
  status: Extract<ProviderApprovalStatus, 'approved' | 'rejected'>
  requestedAt: string
  decidedAt: string
}

export type ProviderApprovalRecord = ProviderApprovalRequest | ProviderApprovalDecision

export interface ProviderApprovalHandler {
  requestApproval(request: ProviderApprovalRequest): Promise<ProviderApprovalDecision>
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

export function createProviderApprovalRequest(
  request: Omit<ProviderApprovalRequest, 'status' | 'requestedAt'> & Partial<Pick<ProviderApprovalRequest, 'requestedAt'>>,
): ProviderApprovalRequest {
  return {
    ...request,
    status: 'pending',
    requestedAt: request.requestedAt ?? new Date().toISOString(),
  }
}

export function createProviderApprovalDecision(
  decision: Omit<ProviderApprovalDecision, 'decidedAt'> & Partial<Pick<ProviderApprovalDecision, 'decidedAt'>>,
): ProviderApprovalDecision {
  return {
    ...decision,
    decidedAt: decision.decidedAt ?? new Date().toISOString(),
  }
}
