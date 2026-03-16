import { spawn as spawnChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname as getHostname } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
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
    enrollmentMethod: 'bootstrap-token'
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
  command?: ProviderCommandSpec
  failure?: {
    provider: ProviderId
    message: string
  }
}

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

  constructor(options: RuntimeSessionManagerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.providerRegistry = options.providerRegistry ?? createRuntimeProviderRegistry()
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

    try {
      const handle = await adapter.launchSession({
        sessionId: options.id,
        workspacePath: options.workspacePath,
        prompt: options.prompt,
        env: options.env,
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
        command: handle.command,
      }
    } catch (error) {
      const message = toErrorMessage(error)
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
      events.push(
        createSessionEvent({
          id: toRuntimeSessionEventId(options.id, events.length + 1),
          sessionId: options.id,
          sequence: events.length + 1,
          kind: 'status',
          createdAt: this.clock(),
          status: 'failed',
          message: `Session failed with provider ${options.provider}.`,
        }),
      )
      session = createSessionSummary({
        ...session,
        status: 'failed',
      })

      return {
        session,
        events,
        failure: {
          provider: options.provider,
          message,
        },
      }
    }
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

function toHostId(hostname: string) {
  return `host_${toSlug(hostname)}` as HostId
}

function toRuntimeId(hostname: string) {
  return `runtime_${toSlug(hostname)}` as RuntimeId
}

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'linux-host'
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
