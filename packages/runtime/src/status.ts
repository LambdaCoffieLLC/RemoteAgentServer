import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

export const runtimeVersion = '0.1.0'

export type RuntimeStatus = 'online' | 'offline'
export type RuntimeHealth = 'healthy' | 'degraded' | 'unhealthy'
export type RuntimeConnectivity = 'connected' | 'disconnected'
export type RuntimeHostMode = 'local' | 'remote'
export type RuntimeConnectionMode = 'attached' | 'registered'

export interface RuntimeStatusReport {
  id: string
  name: string
  platform: string
  runtimeVersion: string
  hostMode: RuntimeHostMode
  connectionMode: RuntimeConnectionMode
  status: RuntimeStatus
  health: RuntimeHealth
  connectivity: RuntimeConnectivity
  registeredAt: string
  lastSeenAt: string
}

export interface RuntimeEnrollmentState {
  serverUrl: string
  enrolledAt: string
  host: RuntimeStatusReport
}

export interface CreateRuntimeStatusReportOptions {
  hostId: string
  name?: string
  platform?: string
  hostMode?: RuntimeHostMode
  connectionMode?: RuntimeConnectionMode
  status?: RuntimeStatus
  health?: RuntimeHealth
  connectivity?: RuntimeConnectivity
  registeredAt?: string
  lastSeenAt?: string
}

export interface EnrollRuntimeOptions extends CreateRuntimeStatusReportOptions {
  serverUrl: string
  bootstrapToken: string
  stateFile?: string
  fetchImpl?: typeof fetch
}

function normalizeServerUrl(serverUrl: string) {
  return serverUrl.trim().replace(/\/+$/, '')
}

export function createRuntimeStatusReport(options: CreateRuntimeStatusReportOptions): RuntimeStatusReport {
  const timestamp = options.lastSeenAt ?? new Date().toISOString()

  return {
    id: options.hostId.trim(),
    name: options.name?.trim() || hostname(),
    platform: options.platform?.trim() || 'linux',
    runtimeVersion,
    hostMode: options.hostMode ?? 'remote',
    connectionMode: options.connectionMode ?? 'registered',
    status: options.status ?? 'online',
    health: options.health ?? 'healthy',
    connectivity: options.connectivity ?? 'connected',
    registeredAt: options.registeredAt ?? timestamp,
    lastSeenAt: timestamp,
  }
}

export async function enrollRuntime(options: EnrollRuntimeOptions): Promise<RuntimeEnrollmentState> {
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const report = createRuntimeStatusReport({
    hostId: options.hostId,
    name: options.name,
    platform: options.platform,
    hostMode: options.hostMode,
    connectionMode: options.connectionMode,
    status: options.status,
    health: options.health,
    connectivity: options.connectivity,
  })

  const response = await fetchImpl(`${serverUrl}/api/hosts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bootstrap-token': options.bootstrapToken,
    },
    body: JSON.stringify(report),
  })

  const payload = (await response.json()) as {
    data?: RuntimeStatusReport
    error?: string
  }

  if (!response.ok) {
    throw new Error(payload.error ?? `Runtime enrollment failed with status ${response.status}.`)
  }

  const state: RuntimeEnrollmentState = {
    serverUrl,
    enrolledAt: report.lastSeenAt,
    host: payload.data ?? report,
  }

  if (options.stateFile) {
    await writeRuntimeEnrollmentState(options.stateFile, state)
  }

  return state
}

export async function writeRuntimeEnrollmentState(stateFile: string, state: RuntimeEnrollmentState) {
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export async function readRuntimeEnrollmentState(stateFile: string) {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as RuntimeEnrollmentState
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }

    throw error
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
