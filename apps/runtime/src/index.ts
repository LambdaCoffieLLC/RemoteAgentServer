import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname as getHostname } from 'node:os'
import { join } from 'node:path'
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
import { coreProviderDescriptors } from '@remote-agent/providers'
import { createSessionSummary } from '@remote-agent/sessions'

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
