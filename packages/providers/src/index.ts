export type ProviderId = 'claude-code' | 'codex' | 'opencode'

export type ProviderCapability = 'logs' | 'notifications' | 'approvals' | 'port-discovery'
export type ProviderAdapterEventKind = 'status' | 'log' | 'output'
export type ProviderAdapterEventStatus = 'running' | 'completed' | 'failed'
export type ProviderAdapterLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ProviderAdapterOutputStream = 'stdout' | 'stderr'
export type ProviderApprovalDecision = 'approved' | 'rejected'

export interface ProviderApprovalRequest {
  approvalId: `approval_${string}`
  action: string
  reason?: string
}

export interface ProviderDescriptor {
  id: ProviderId
  displayName: string
  capabilities: ProviderCapability[]
}

export interface ProviderCommandSpec {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string | undefined>
}

export interface ProviderLaunchRequest {
  sessionId: string
  workspacePath: string
  prompt: string
  env?: Record<string, string | undefined>
  // eslint-disable-next-line no-unused-vars
  requestApproval?: (request: ProviderApprovalRequest) => Promise<ProviderApprovalDecision>
}

export interface ProviderRuntimeIO {
  stdout: Promise<string>
  stderr: Promise<string>
  exitCode: Promise<number | null>
}

export interface ProviderAdapterEvent {
  kind: ProviderAdapterEventKind
  message: string
  status?: ProviderAdapterEventStatus
  level?: ProviderAdapterLogLevel
  stream?: ProviderAdapterOutputStream
}

export interface ProviderSessionHandle {
  command: ProviderCommandSpec
  // eslint-disable-next-line no-unused-vars
  monitor: (runtime: ProviderRuntimeIO) => Promise<ProviderAdapterEvent[]>
}

export interface ProviderAdapter {
  descriptor: ProviderDescriptor
  // eslint-disable-next-line no-unused-vars
  launchSession: (request: ProviderLaunchRequest) => Promise<ProviderSessionHandle>
}

export interface ProviderAdapterRegistry {
  // eslint-disable-next-line no-unused-vars
  get: (id: ProviderId) => ProviderAdapter | undefined
  list: () => readonly ProviderAdapter[]
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

export function createProviderAdapterRegistry(adapters: readonly ProviderAdapter[]): ProviderAdapterRegistry {
  const adapterMap = new Map(adapters.map((adapter) => [adapter.descriptor.id, adapter]))

  return {
    get(id) {
      return adapterMap.get(id)
    },
    list() {
      return [...adapterMap.values()]
    },
  }
}

export class ProviderApprovalRejectedError extends Error {
  readonly approvalId: ProviderApprovalRequest['approvalId']

  readonly action: string

  constructor(request: ProviderApprovalRequest, message = `Approval rejected for ${request.action}.`) {
    super(message)
    this.name = 'ProviderApprovalRejectedError'
    this.approvalId = request.approvalId
    this.action = request.action
  }
}
