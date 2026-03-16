import { execFile as execFileCallback, spawn as spawnChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname as getHostname } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { createForwardedPort } from '@remote-agent/ports'
import {
  createManifest,
  type HostId,
  type IsoTimestamp,
  type RuntimeConnectivityStatus,
  type RuntimeHealthStatus,
  type RuntimeId,
  type RuntimeStatusSnapshot,
  type SessionId,
  type WorkspaceId,
} from '@remote-agent/protocol'
import {
  coreProviderDescriptors,
  createProviderAdapterRegistry,
  type ProviderAdapter,
  type ProviderAdapterEvent,
  type ProviderApprovalDecision,
  type ProviderApprovalRequest,
  ProviderApprovalRejectedError,
  type ProviderAdapterRegistry,
  type ProviderCommandSpec,
  type ProviderId,
  type ProviderLaunchRequest,
  type ProviderRuntimeIO,
} from '@remote-agent/providers'
import { createSessionEvent, createSessionSummary, type SessionEvent, type SessionLogLevel, type SessionSummary } from '@remote-agent/sessions'

export { createProviderAdapterRegistry }
export type {
  ProviderAdapter,
  ProviderAdapterEvent,
  ProviderApprovalDecision,
  ProviderApprovalRequest,
  ProviderAdapterRegistry,
  ProviderCommandSpec,
  ProviderLaunchRequest,
  ProviderRuntimeIO,
} from '@remote-agent/providers'

const hostId = 'host_runtime' as HostId
const runtimeId = 'runtime_runtime' as RuntimeId
const workspaceId = 'workspace_runtime' as WorkspaceId
const sessionId = 'session_runtime_probe' as SessionId
const runtimeVersion = '0.1.0-dev'
const runtimeServiceName = 'remote-agent-runtime'
const execFile = promisify(execFileCallback)

export interface InstalledLinuxRuntimeConfig {
  configVersion: 1
  hostId: HostId
  hostLabel: string
  platform: 'linux'
  runtimeId: RuntimeId
  runtimeLabel: string
  serverOrigin: string
  bootstrapToken: string
  version: string
  installedAt: IsoTimestamp
}

export interface LinuxRuntimeInstallOptions {
  installRoot: string
  serverOrigin: string
  bootstrapToken: string
  hostLabel?: string
  runtimeLabel?: string
  hostname?: string
  version?: string
  clock?: () => IsoTimestamp
}

export interface LinuxRuntimeInstallResult {
  config: InstalledLinuxRuntimeConfig
  wasAlreadyInstalled: boolean
  paths: {
    binPath: string
    configPath: string
    envPath: string
    serviceUnitPath: string
  }
  status: RuntimeStatusSnapshot
}

export interface RuntimeControlPlaneHost {
  id: HostId
  label: string
  platform: 'linux' | 'macos' | 'windows'
  connectionMode: 'local' | 'remote'
  runtimeStatus: 'online' | 'offline' | 'degraded'
  enrolledAt: IsoTimestamp
  lastSeenAt: IsoTimestamp
  runtime?: {
    runtimeId: RuntimeId
    label: string
    version: string
    health: RuntimeHealthStatus
    connectivity: RuntimeConnectivityStatus
    reportedAt: IsoTimestamp
    enrolledAt: IsoTimestamp
    enrollmentMethod: 'bootstrap-token' | 'local-registration' | 'development-attach'
  }
}

export interface RuntimeControlPlaneWorkspace {
  id: WorkspaceId
  hostId: HostId
  hostConnectionMode: 'local' | 'remote'
  name: string
  path: string
  repositoryPath: string
  defaultBranch: string
  runtimeLabel: string
  runtimeAssociation: {
    hostId: HostId
    runtimeId?: RuntimeId
    label: string
  }
}

export interface RuntimeEnrollmentOptions {
  install: LinuxRuntimeInstallResult
  health?: RuntimeHealthStatus
  connectivity?: RuntimeConnectivityStatus
  fetchImpl?: typeof fetch
}

export interface RuntimeStatusReportOptions {
  install: LinuxRuntimeInstallResult
  version?: string
  health: RuntimeHealthStatus
  connectivity: RuntimeConnectivityStatus
  fetchImpl?: typeof fetch
}

export interface RuntimeControlPlaneResponse {
  statusCode: number
  host: RuntimeControlPlaneHost
}

export interface LocalRuntimeOptions {
  repositoryPath: string
  hostId?: HostId
  hostLabel?: string
  workspaceId?: WorkspaceId
  workspaceName?: string
  runtimeId?: RuntimeId
  runtimeLabel?: string
  version?: string
  defaultBranch?: string
  platform?: RuntimeControlPlaneHost['platform']
  hostname?: string
  health?: RuntimeHealthStatus
  connectivity?: RuntimeConnectivityStatus
  clock?: () => IsoTimestamp
}

export interface AttachLocalRuntimeOptions extends LocalRuntimeOptions {
  sessionManager?: RuntimeSessionManager
  sessionManagerOptions?: RuntimeSessionManagerOptions
}

export interface RegisterLocalRuntimeOptions extends LocalRuntimeOptions {
  serverOrigin: string
  token: string
  fetchImpl?: typeof fetch
}

export interface LocalRuntimeAttachment {
  mode: 'development-attach'
  host: RuntimeControlPlaneHost
  workspace: RuntimeControlPlaneWorkspace
  sessionManager: RuntimeSessionManager
  startSession: (
    // eslint-disable-next-line no-unused-vars
    options: Omit<StartRuntimeSessionOptions, 'hostId' | 'workspaceId' | 'workspacePath'>,
  ) => Promise<RuntimeManagedSession>
}

export interface LocalRuntimeRegistrationResult {
  mode: 'server-registration'
  host: RuntimeControlPlaneHost
  workspace: RuntimeControlPlaneWorkspace
  responses: {
    hostStatusCode: number
    workspaceStatusCode: number
  }
}

export interface CoreProviderCommandTemplate {
  command: string
  // eslint-disable-next-line no-unused-vars
  args?: (request: ProviderLaunchRequest) => string[]
  env?: Record<string, string | undefined>
}

export interface CoreProviderAdapterOptions {
  commands?: Partial<Record<ProviderId, CoreProviderCommandTemplate>>
}

export interface RuntimeSessionManagerOptions {
  clock?: () => IsoTimestamp
  providerRegistry?: ProviderAdapterRegistry
  approvalHandler?: RuntimeApprovalHandler
}

export interface StartRuntimeSessionOptions {
  id: SessionId
  hostId: HostId
  workspaceId: WorkspaceId
  workspacePath: string
  provider: ProviderId
  prompt: string
  requestedBy?: SessionSummary['requestedBy']
  startedAt?: IsoTimestamp
  env?: Record<string, string | undefined>
}

export interface RuntimeManagedSession {
  session: SessionSummary
  events: SessionEvent[]
  approvals: RuntimeApprovalRecord[]
  command?: ProviderCommandSpec
  failure?: {
    provider: ProviderId
    message: string
  }
}

export interface RuntimeApprovalRecord extends ProviderApprovalRequest {
  sessionId: SessionId
  provider: ProviderId
  requestedAt: IsoTimestamp
  requestedBy: SessionSummary['requestedBy']
  status: 'pending' | ProviderApprovalDecision
  decidedAt?: IsoTimestamp
  decidedBy?: SessionSummary['requestedBy']
}

export type RuntimeApprovalHandlerDecision =
  | ProviderApprovalDecision
  | {
      status: ProviderApprovalDecision
      decidedBy?: SessionSummary['requestedBy']
      message?: string
    }

export type RuntimeApprovalHandler = (
  // eslint-disable-next-line no-unused-vars
  approval: RuntimeApprovalRecord,
) => Promise<RuntimeApprovalHandlerDecision> | RuntimeApprovalHandlerDecision

export function describeRuntimeApp() {
  const provider = coreProviderDescriptors.find(({ id }) => id === 'opencode') ?? coreProviderDescriptors[0]

  return {
    manifest: createManifest('runtime', 'Runtime installation and enrollment flow for remote Linux hosts.', [
      '@remote-agent/protocol',
      '@remote-agent/sessions',
      '@remote-agent/ports',
      '@remote-agent/providers',
    ]),
    provider,
    installFlow: {
      supportedLinuxSystems: ['Ubuntu/Debian with systemd', 'RHEL/Fedora with systemd'],
      rerunnable: true,
      enrollEndpoint: '/v1/runtime/enroll',
      statusEndpoint: '/v1/runtime/status',
    },
    reportedStatus: createRuntimeStatus(runtimeId, runtimeVersion),
    session: createSessionSummary({
      id: sessionId,
      hostId,
      workspaceId,
      provider: provider.id,
      requestedBy: {
        id: 'runtime',
        displayName: 'Runtime Agent',
      },
      status: 'queued',
      startedAt: '2026-03-16T00:00:00.000Z',
    }),
    detectedPort: createForwardedPort({
      id: 'port_runtime_probe',
      hostId,
      workspaceId,
      sessionId,
      localPort: 8080,
      targetPort: 8080,
      visibility: 'private',
      label: 'Runtime health endpoint',
    }),
  }
}

export class RuntimeSessionManager {
  private readonly clock: () => IsoTimestamp

  private readonly providerRegistry: ProviderAdapterRegistry

  private readonly approvalHandler?: RuntimeApprovalHandler

  constructor(options: RuntimeSessionManagerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.providerRegistry = options.providerRegistry ?? createRuntimeProviderRegistry()
    this.approvalHandler = options.approvalHandler
  }

  async startSession(options: StartRuntimeSessionOptions): Promise<RuntimeManagedSession> {
    const adapter = this.providerRegistry.get(options.provider)

    if (!adapter) {
      throw new Error(`Provider adapter ${options.provider} is not registered.`)
    }

    let session = createSessionSummary({
      id: options.id,
      hostId: options.hostId,
      workspaceId: options.workspaceId,
      provider: options.provider,
      requestedBy: options.requestedBy ?? {
        id: 'runtime',
        displayName: 'Runtime Agent',
      },
      status: 'running',
      startedAt: options.startedAt ?? this.clock(),
    })
    const events: SessionEvent[] = [
      createSessionEvent({
        id: toRuntimeSessionEventId(options.id, 1),
        sessionId: options.id,
        sequence: 1,
        kind: 'status',
        createdAt: this.clock(),
        status: 'running',
        message: `Session started with provider ${options.provider}.`,
      }),
    ]
    const approvals: RuntimeApprovalRecord[] = []

    try {
      const handle = await adapter.launchSession({
        sessionId: options.id,
        workspacePath: options.workspacePath,
        prompt: options.prompt,
        env: options.env,
        requestApproval: async (request) => {
          const pendingApproval: RuntimeApprovalRecord = {
            ...request,
            sessionId: options.id,
            provider: options.provider,
            requestedAt: this.clock(),
            requestedBy: session.requestedBy,
            status: 'pending',
          }
          approvals.push(pendingApproval)
          events.push(
            createSessionEvent({
              id: toRuntimeSessionEventId(options.id, events.length + 1),
              sessionId: options.id,
              sequence: events.length + 1,
              kind: 'log',
              createdAt: this.clock(),
              level: 'warn',
              message: describeApprovalRequiredMessage(request),
            }),
          )

          const decision = normalizeApprovalDecision(await this.resolveApprovalDecision(pendingApproval))
          const decidedApproval: RuntimeApprovalRecord = {
            ...pendingApproval,
            status: decision.status,
            decidedAt: this.clock(),
            decidedBy: decision.decidedBy,
          }

          approvals[approvals.length - 1] = decidedApproval
          events.push(
            createSessionEvent({
              id: toRuntimeSessionEventId(options.id, events.length + 1),
              sessionId: options.id,
              sequence: events.length + 1,
              kind: 'log',
              createdAt: this.clock(),
              level: decision.status === 'approved' ? 'info' : 'warn',
              message:
                decision.message ??
                (decision.status === 'approved'
                  ? `Approval approved for ${request.action}.`
                  : `Approval rejected for ${request.action}.`),
            }),
          )

          if (decision.status === 'rejected') {
            session = createSessionSummary({
              ...session,
              status: 'failed',
            })
            events.push(
              createSessionEvent({
                id: toRuntimeSessionEventId(options.id, events.length + 1),
                sessionId: options.id,
                sequence: events.length + 1,
                kind: 'status',
                createdAt: this.clock(),
                status: 'failed',
                message: 'Session failed because a privileged action was rejected.',
              }),
            )
            throw new ProviderApprovalRejectedError(request, decision.message ?? `Approval rejected for ${request.action}.`)
          }

          return decision.status
        },
      })
      const runtime = createProviderRuntimeIO(handle.command)
      const adapterEvents = await handle.monitor(runtime)

      for (const adapterEvent of adapterEvents) {
        const sessionEvent = this.createSessionEventFromAdapter(options.id, events.length + 1, adapterEvent)
        events.push(sessionEvent)

        if (adapterEvent.kind === 'status' && adapterEvent.status) {
          session = createSessionSummary({
            ...session,
            status: toSessionStatus(adapterEvent.status),
          })
        }
      }

      return {
        session,
        events,
        approvals,
        command: handle.command,
      }
    } catch (error) {
      const message = toErrorMessage(error)
      if (!(error instanceof ProviderApprovalRejectedError)) {
        events.push(
          createSessionEvent({
            id: toRuntimeSessionEventId(options.id, events.length + 1),
            sessionId: options.id,
            sequence: events.length + 1,
            kind: 'log',
            createdAt: this.clock(),
            level: 'error',
            message: `${adapter.descriptor.displayName} failed: ${message}`,
          }),
        )
      }

      if (events.at(-1)?.kind !== 'status' || events.at(-1)?.status !== 'failed') {
        events.push(
          createSessionEvent({
            id: toRuntimeSessionEventId(options.id, events.length + 1),
            sessionId: options.id,
            sequence: events.length + 1,
            kind: 'status',
            createdAt: this.clock(),
            status: 'failed',
            message:
              error instanceof ProviderApprovalRejectedError
                ? 'Session failed because a privileged action was rejected.'
                : `Session failed with provider ${options.provider}.`,
          }),
        )
      }
      session = createSessionSummary({
        ...session,
        status: 'failed',
      })

      return {
        session,
        events,
        approvals,
        failure: {
          provider: options.provider,
          message,
        },
      }
    }
  }

  private async resolveApprovalDecision(approval: RuntimeApprovalRecord): Promise<RuntimeApprovalHandlerDecision> {
    if (!this.approvalHandler) {
      return {
        status: 'rejected',
        message: `Approval rejected for ${approval.action} because no approval handler is configured.`,
      }
    }

    return this.approvalHandler(approval)
  }

  private createSessionEventFromAdapter(sessionId: SessionId, sequence: number, event: ProviderAdapterEvent): SessionEvent {
    return createSessionEvent({
      id: toRuntimeSessionEventId(sessionId, sequence),
      sessionId,
      sequence,
      kind: event.kind,
      createdAt: this.clock(),
      message: event.message,
      status: event.status ? toSessionStatus(event.status) : undefined,
      level: event.level as SessionLogLevel | undefined,
      stream: event.stream,
    })
  }
}

export function createRuntimeProviderRegistry(options: CoreProviderAdapterOptions = {}): ProviderAdapterRegistry {
  return createProviderAdapterRegistry(createCoreProviderAdapters(options))
}

export function createCoreProviderAdapters(options: CoreProviderAdapterOptions = {}): readonly ProviderAdapter[] {
  return coreProviderDescriptors.map((descriptor) => {
    const template = options.commands?.[descriptor.id] ?? defaultProviderCommandTemplates[descriptor.id]

    return {
      descriptor,
      async launchSession(request) {
        return {
          command: {
            command: template.command,
            args: template.args?.(request) ?? ['run', request.prompt],
            cwd: request.workspacePath,
            env: {
              REMOTE_AGENT_PROVIDER: descriptor.id,
              REMOTE_AGENT_SESSION_ID: request.sessionId,
              ...template.env,
              ...request.env,
            },
          },
          monitor: async (runtime) => buildProcessMonitorEvents(descriptor.id, descriptor.displayName, runtime),
        }
      },
    }
  })
}

export async function installLinuxRuntime(options: LinuxRuntimeInstallOptions): Promise<LinuxRuntimeInstallResult> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const installRoot = options.installRoot
  const paths = {
    binPath: join(installRoot, 'bin', `${runtimeServiceName}.mjs`),
    configPath: join(installRoot, 'config', `${runtimeServiceName}.json`),
    envPath: join(installRoot, 'config', `${runtimeServiceName}.env`),
    serviceUnitPath: join(installRoot, 'systemd', `${runtimeServiceName}.service`),
  }
  const existingConfig = await readInstalledRuntimeConfig(paths.configPath)
  const machineName = options.hostname ?? getHostname()
  const hostLabel = existingConfig?.hostLabel ?? options.hostLabel ?? machineName
  const runtimeLabel = existingConfig?.runtimeLabel ?? options.runtimeLabel ?? `${hostLabel} Runtime`
  const config: InstalledLinuxRuntimeConfig = {
    configVersion: 1,
    hostId: existingConfig?.hostId ?? toHostId(machineName),
    hostLabel,
    platform: 'linux',
    runtimeId: existingConfig?.runtimeId ?? toRuntimeId(machineName),
    runtimeLabel,
    serverOrigin: normalizeOrigin(options.serverOrigin),
    bootstrapToken: options.bootstrapToken,
    version: options.version ?? existingConfig?.version ?? runtimeVersion,
    installedAt: existingConfig?.installedAt ?? clock(),
  }

  await mkdir(join(installRoot, 'bin'), { recursive: true })
  await mkdir(join(installRoot, 'config'), { recursive: true })
  await mkdir(join(installRoot, 'systemd'), { recursive: true })
  await writeTextFile(paths.binPath, renderLauncherScript(config, paths.configPath))
  await chmod(paths.binPath, 0o755)
  await writeTextFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`)
  await writeTextFile(paths.envPath, renderEnvironmentFile(config))
  await writeTextFile(paths.serviceUnitPath, renderSystemdUnit(paths.binPath, paths.envPath))

  return {
    config,
    wasAlreadyInstalled: existingConfig !== undefined,
    paths,
    status: createRuntimeStatus(config.runtimeId, config.version),
  }
}

export async function enrollInstalledRuntime(options: RuntimeEnrollmentOptions): Promise<RuntimeControlPlaneResponse> {
  const { install, fetchImpl } = options
  const health = options.health ?? 'healthy'
  const connectivity = options.connectivity ?? 'connected'

  return postControlPlaneRequest(
    install.config.serverOrigin,
    '/v1/runtime/enroll',
    install.config.bootstrapToken,
    {
      hostId: install.config.hostId,
      label: install.config.hostLabel,
      platform: install.config.platform,
      runtimeId: install.config.runtimeId,
      runtimeLabel: install.config.runtimeLabel,
      version: install.config.version,
      health,
      connectivity,
    },
    fetchImpl,
  )
}

export async function reportInstalledRuntimeStatus(options: RuntimeStatusReportOptions): Promise<RuntimeControlPlaneResponse> {
  const { install, fetchImpl } = options

  return postControlPlaneRequest(
    install.config.serverOrigin,
    '/v1/runtime/status',
    install.config.bootstrapToken,
    {
      hostId: install.config.hostId,
      runtimeId: install.config.runtimeId,
      version: options.version ?? install.config.version,
      health: options.health,
      connectivity: options.connectivity,
    },
    fetchImpl,
  )
}

export async function attachLocalRuntime(options: AttachLocalRuntimeOptions): Promise<LocalRuntimeAttachment> {
  const descriptor = await createLocalRuntimeDescriptor(options, 'development-attach')
  const sessionManager = options.sessionManager ?? new RuntimeSessionManager(options.sessionManagerOptions)

  return {
    mode: 'development-attach',
    host: descriptor.host,
    workspace: descriptor.workspace,
    sessionManager,
    startSession: async (sessionOptions) => {
      const session = await sessionManager.startSession({
        ...sessionOptions,
        hostId: descriptor.host.id,
        workspaceId: descriptor.workspace.id,
        workspacePath: descriptor.workspace.path,
      })

      return {
        ...session,
        session: createSessionSummary({
          ...session.session,
          workspace: {
            mode: 'direct',
            repositoryPath: descriptor.workspace.repositoryPath,
            path: descriptor.workspace.path,
            allowDirtyWorkspace: false,
          },
        }),
      }
    },
  }
}

export async function registerLocalRuntime(options: RegisterLocalRuntimeOptions): Promise<LocalRuntimeRegistrationResult> {
  const descriptor = await createLocalRuntimeDescriptor(options, 'local-registration')
  const fetchImplementation = options.fetchImpl ?? fetch

  const hostResponse = await postAuthorizedControlPlaneRequest<RuntimeControlPlaneHost>(
    options.serverOrigin,
    '/v1/hosts',
    options.token,
    {
      id: descriptor.host.id,
      label: descriptor.host.label,
      platform: descriptor.host.platform,
      connectionMode: descriptor.host.connectionMode,
      runtimeStatus: descriptor.host.runtimeStatus,
      runtime: descriptor.host.runtime,
    },
    fetchImplementation,
  )
  const workspaceResponse = await postAuthorizedControlPlaneRequest<RuntimeControlPlaneWorkspace>(
    options.serverOrigin,
    '/v1/workspaces',
    options.token,
    {
      id: descriptor.workspace.id,
      hostId: descriptor.workspace.hostId,
      name: descriptor.workspace.name,
      repositoryPath: descriptor.workspace.repositoryPath,
      defaultBranch: descriptor.workspace.defaultBranch,
      runtimeLabel: descriptor.workspace.runtimeLabel,
    },
    fetchImplementation,
  )

  return {
    mode: 'server-registration',
    host: hostResponse.data,
    workspace: workspaceResponse.data,
    responses: {
      hostStatusCode: hostResponse.statusCode,
      workspaceStatusCode: workspaceResponse.statusCode,
    },
  }
}

export function renderLinuxInstallScript(options: Pick<LinuxRuntimeInstallOptions, 'installRoot' | 'serverOrigin' | 'bootstrapToken'>) {
  const installRoot = options.installRoot
  const serverOrigin = normalizeOrigin(options.serverOrigin)

  return `#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${installRoot}"
SERVER_ORIGIN="${serverOrigin}"
BOOTSTRAP_TOKEN="${options.bootstrapToken}"

mkdir -p "$INSTALL_ROOT/bin" "$INSTALL_ROOT/config" "$INSTALL_ROOT/systemd"

cat > "$INSTALL_ROOT/config/${runtimeServiceName}.env" <<EOF
REMOTE_AGENT_SERVER_ORIGIN=$SERVER_ORIGIN
REMOTE_AGENT_BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN
EOF

echo "Install layout prepared under $INSTALL_ROOT"
echo "This script is safe to rerun because existing runtime ids are reused from ${runtimeServiceName}.json."
`
}

const defaultProviderCommandTemplates: Record<ProviderId, CoreProviderCommandTemplate> = {
  'claude-code': {
    command: 'claude-code',
  },
  codex: {
    command: 'codex',
  },
  opencode: {
    command: 'opencode',
  },
}

async function buildProcessMonitorEvents(
  providerId: ProviderId,
  displayName: string,
  runtime: ProviderRuntimeIO,
): Promise<ProviderAdapterEvent[]> {
  const [stdout, stderr, exitCode] = await Promise.all([runtime.stdout, runtime.stderr, runtime.exitCode])
  const events: ProviderAdapterEvent[] = []

  for (const line of splitOutputLines(stdout)) {
    events.push({
      kind: 'output',
      stream: 'stdout',
      message: line,
    })
  }

  for (const line of splitOutputLines(stderr)) {
    events.push({
      kind: 'output',
      stream: 'stderr',
      message: line,
    })
  }

  if (exitCode === 0) {
    events.push({
      kind: 'status',
      status: 'completed',
      message: `${displayName} completed successfully.`,
    })
    return events
  }

  events.push({
    kind: 'log',
    level: 'error',
    message: `${displayName} exited with code ${exitCode ?? 'unknown'}.`,
  })
  events.push({
    kind: 'status',
    status: 'failed',
    message: `${displayName} session failed.`,
  })

  // This is intentionally unused for now, but keeps the provider id bound to the monitor surface.
  void providerId

  return events
}

function createProviderRuntimeIO(command: ProviderCommandSpec): ProviderRuntimeIO {
  const child = spawnChildProcess(command.command, command.args, {
    cwd: command.cwd,
    env: {
      ...process.env,
      ...command.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    stdout: readProcessStream(child.stdout),
    stderr: readProcessStream(child.stderr),
    exitCode: waitForProcessExit(child),
  }
}

async function readProcessStream(stream: Readable): Promise<string> {
  let buffer = ''

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }

  return buffer
}

function waitForProcessExit(child: ReturnType<typeof spawnChildProcess>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      resolve(code)
    })
  })
}

function splitOutputLines(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function describeApprovalRequiredMessage(request: ProviderApprovalRequest) {
  if (request.reason?.trim()) {
    return `Approval required for ${request.action}: ${request.reason.trim()}`
  }

  return `Approval required for ${request.action}.`
}

function normalizeApprovalDecision(decision: RuntimeApprovalHandlerDecision) {
  if (typeof decision === 'string') {
    return {
      status: decision,
      decidedBy: undefined,
      message: undefined,
    }
  }

  return {
    status: decision.status,
    decidedBy: decision.decidedBy,
    message: decision.message,
  }
}

async function createLocalRuntimeDescriptor(
  options: LocalRuntimeOptions,
  enrollmentMethod: NonNullable<RuntimeControlPlaneHost['runtime']>['enrollmentMethod'],
) {
  const clock = options.clock ?? (() => new Date().toISOString())
  const repository = await resolveLocalRepository(options.repositoryPath, options.defaultBranch)
  const machineName = options.hostname ?? getHostname()
  const hostLabel = options.hostLabel ?? `Local ${machineName}`
  const runtimeLabel = options.runtimeLabel ?? `${hostLabel} Runtime`
  const hostId = options.hostId ?? toHostId(`local-${machineName}`)
  const runtimeId = options.runtimeId ?? toRuntimeId(`local-${machineName}`)
  const workspaceId = options.workspaceId ?? toWorkspaceId(basename(repository.path))
  const timestamp = clock()
  const health = options.health ?? 'healthy'
  const connectivity = options.connectivity ?? 'connected'
  const runtimeStatus: RuntimeControlPlaneHost['runtimeStatus'] =
    connectivity === 'disconnected' ? 'offline' : health === 'healthy' ? 'online' : 'degraded'

  return {
    host: {
      id: hostId,
      label: hostLabel,
      platform: options.platform ?? detectLocalPlatform(),
      connectionMode: 'local' as const,
      runtimeStatus,
      enrolledAt: timestamp,
      lastSeenAt: timestamp,
      runtime: {
        runtimeId,
        label: runtimeLabel,
        version: options.version ?? runtimeVersion,
        health,
        connectivity,
        reportedAt: timestamp,
        enrolledAt: timestamp,
        enrollmentMethod,
      },
    },
    workspace: {
      id: workspaceId,
      hostId,
      hostConnectionMode: 'local' as const,
      name: options.workspaceName ?? basename(repository.path),
      path: repository.path,
      repositoryPath: repository.path,
      defaultBranch: repository.defaultBranch,
      runtimeLabel,
      runtimeAssociation: {
        hostId,
        runtimeId,
        label: runtimeLabel,
      },
    },
  }
}

function createRuntimeStatus(id: RuntimeId, version: string): RuntimeStatusSnapshot {
  return {
    runtimeId: id,
    version,
    health: 'healthy',
    connectivity: 'connected',
    reportedAt: '2026-03-16T00:00:00.000Z',
  }
}

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, '')
}

function detectLocalPlatform(): RuntimeControlPlaneHost['platform'] {
  if (process.platform === 'darwin') {
    return 'macos'
  }

  if (process.platform === 'win32') {
    return 'windows'
  }

  return 'linux'
}

function toHostId(hostname: string) {
  return `host_${toSlug(hostname)}` as HostId
}

function toRuntimeId(hostname: string) {
  return `runtime_${toSlug(hostname)}` as RuntimeId
}

function toWorkspaceId(name: string) {
  return `workspace_${toSlug(name, 'workspace')}` as WorkspaceId
}

function toSlug(value: string, fallback = 'linux-host') {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

async function readInstalledRuntimeConfig(configPath: string) {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as InstalledLinuxRuntimeConfig
  } catch (error) {
    const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT'

    if (!isMissing) {
      throw error
    }

    return undefined
  }
}

async function writeTextFile(path: string, contents: string) {
  const existing = await readOptionalTextFile(path)

  if (existing === contents) {
    return
  }

  await writeFile(path, contents, 'utf8')
}

async function readOptionalTextFile(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT'

    if (!isMissing) {
      throw error
    }

    return undefined
  }
}

function renderLauncherScript(config: InstalledLinuxRuntimeConfig, configPath: string) {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const rawConfig = await readFile(${JSON.stringify(configPath)}, 'utf8')
const runtimeConfig = JSON.parse(rawConfig)

console.log(JSON.stringify({
  runtimeId: runtimeConfig.runtimeId,
  hostId: runtimeConfig.hostId,
  version: runtimeConfig.version,
  serverOrigin: runtimeConfig.serverOrigin,
}, null, 2))
`
}

function toRuntimeSessionEventId(sessionId: SessionId, sequence: number) {
  return `session_event_${sessionId}_${sequence}` as const
}

function toSessionStatus(status: ProviderAdapterEvent['status']) {
  if (status === 'completed') {
    return 'completed' as const
  }

  if (status === 'failed') {
    return 'failed' as const
  }

  return 'running' as const
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return 'Unknown provider failure.'
}

function renderEnvironmentFile(config: InstalledLinuxRuntimeConfig) {
  return `REMOTE_AGENT_SERVER_ORIGIN=${config.serverOrigin}
REMOTE_AGENT_BOOTSTRAP_TOKEN=${config.bootstrapToken}
REMOTE_AGENT_HOST_ID=${config.hostId}
REMOTE_AGENT_RUNTIME_ID=${config.runtimeId}
REMOTE_AGENT_RUNTIME_VERSION=${config.version}
`
}

function renderSystemdUnit(binPath: string, envPath: string) {
  return `[Unit]
Description=Remote Agent Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${envPath}
ExecStart=${binPath}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`
}

async function resolveLocalRepository(repositoryPath: string, defaultBranch?: string) {
  const normalizedPath = resolve(repositoryPath)

  let repositoryRoot = normalizedPath

  try {
    const result = await execFile('git', ['-C', normalizedPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    })
    repositoryRoot = result.stdout.trim()
  } catch {
    throw new Error(`Repository path ${normalizedPath} is not a git repository.`)
  }

  const detectedDefaultBranch = defaultBranch ?? (await detectLocalDefaultBranch(repositoryRoot))

  return {
    path: repositoryRoot,
    defaultBranch: detectedDefaultBranch,
  }
}

async function detectLocalDefaultBranch(repositoryPath: string) {
  const originHead = await tryReadLocalGitOutput(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])

  if (originHead) {
    return originHead.replace(/^origin\//, '')
  }

  const currentHead = await tryReadLocalGitOutput(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])

  if (currentHead) {
    return currentHead
  }

  throw new Error(`Repository path ${repositoryPath} is missing a detectable default branch.`)
}

async function tryReadLocalGitOutput(repositoryPath: string, args: string[]) {
  try {
    const result = await execFile('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
    })
    const output = result.stdout.trim()
    return output.length > 0 ? output : undefined
  } catch {
    return undefined
  }
}

async function postControlPlaneRequest(
  serverOrigin: string,
  path: string,
  bootstrapToken: string,
  body: Record<string, unknown>,
  fetchImpl = fetch,
): Promise<RuntimeControlPlaneResponse> {
  const response = await fetchImpl(`${serverOrigin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bootstrap-token': bootstrapToken,
    },
    body: JSON.stringify(body),
  })
  const payloadText = await response.text()
  const payload = payloadText.length > 0 ? (JSON.parse(payloadText) as { data?: RuntimeControlPlaneHost; error?: { message?: string } }) : {}

  if (!response.ok || !payload.data) {
    throw new Error(payload.error?.message ?? `Runtime control-plane request failed with status ${response.status}.`)
  }

  return {
    statusCode: response.status,
    host: payload.data,
  }
}

async function postAuthorizedControlPlaneRequest<TData>(
  serverOrigin: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl = fetch,
) {
  const response = await fetchImpl(`${normalizeOrigin(serverOrigin)}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payloadText = await response.text()
  const payload = payloadText.length > 0 ? (JSON.parse(payloadText) as { data?: TData; error?: { message?: string } }) : {}

  if (!response.ok || !payload.data) {
    throw new Error(payload.error?.message ?? `Runtime control-plane request failed with status ${response.status}.`)
  }

  return {
    statusCode: response.status,
    data: payload.data,
  }
}
