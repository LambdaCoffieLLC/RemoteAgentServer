import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createTokenCredential, type AuthHeaderName, type AuthPolicy, type AuthScheme } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort, type PortProtocol, type PortState, type PortVisibility } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor } from '@remote-agent-server/providers'
import { createRuntimeManifest } from '@remote-agent-server/runtime'
import { createSessionDescriptor, type SessionDescriptor, type SessionMode, type SessionState } from '@remote-agent-server/sessions'
import { fileURLToPath } from 'node:url'

const defaultBindHost = '127.0.0.1'
const defaultBindPort = 4318
const defaultDataFile = '.remote-agent-server/control-plane.json'
const jsonContentType = 'application/json; charset=utf-8'
const eventStreamContentType = 'text/event-stream; charset=utf-8'

export interface HostRecord {
  id: string
  name: string
  platform: string
  runtimeVersion: string
  status: 'online' | 'offline'
  registeredAt: string
}

export interface WorkspaceRecord {
  id: string
  hostId: string
  path: string
  defaultBranch: string
  runtimeHostId: string
  createdAt: string
}

export interface SessionRecord extends SessionDescriptor {
  createdAt: string
  updatedAt: string
}

export interface ApprovalRecord {
  id: string
  sessionId: string
  action: string
  status: 'pending' | 'approved' | 'rejected'
  requestedAt: string
  decidedAt?: string
}

export interface NotificationRecord {
  id: string
  level: 'info' | 'warning' | 'error'
  message: string
  sessionId?: string
  createdAt: string
}

export interface ForwardedPortRecord extends ManagedPort {
  hostId: string
  workspaceId?: string
  sessionId?: string
  label: string
  targetHost: string
  createdAt: string
}

export interface ControlPlaneState {
  hosts: HostRecord[]
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  approvals: ApprovalRecord[]
  notifications: NotificationRecord[]
  forwardedPorts: ForwardedPortRecord[]
}

interface PersistedControlPlaneState extends ControlPlaneState {
  version: 1
}

export interface ControlPlaneConfigFile {
  host?: string
  port?: number
  dataFile?: string
  operatorTokens?: string[]
  bootstrapTokens?: string[]
}

export interface ControlPlaneConfig {
  host: string
  port: number
  dataFile: string
  operatorTokens: string[]
  bootstrapTokens: string[]
}

export interface StartControlPlaneOptions extends Partial<ControlPlaneConfigFile> {
  configFile?: string
}

export interface ControlPlaneEvent<TPayload = unknown> {
  id: string
  timestamp: string
  envelope: ProtocolEnvelope<TPayload>
}

export interface ControlPlaneServerHandle {
  readonly config: ControlPlaneConfig
  readonly runtime: ReturnType<typeof createRuntimeManifest>
  readonly url: string
  getState(): ControlPlaneState
  close(): Promise<void>
}

export interface ServerManifest {
  id: string
  kind: 'server'
  runtime: ReturnType<typeof createRuntimeManifest>
  auth: AuthPolicy
  defaultProvider: ReturnType<typeof createProviderDescriptor>
  bootstrapSession: SessionDescriptor
  previewPort: ManagedPort
  events: ProtocolEnvelope<{ sessionId: string }>
}

function createEmptyState(): ControlPlaneState {
  return {
    hosts: [],
    workspaces: [],
    sessions: [],
    approvals: [],
    notifications: [],
    forwardedPorts: [],
  }
}

function cloneState(state: ControlPlaneState): ControlPlaneState {
  return {
    hosts: [...state.hosts],
    workspaces: [...state.workspaces],
    sessions: [...state.sessions],
    approvals: [...state.approvals],
    notifications: [...state.notifications],
    forwardedPorts: [...state.forwardedPorts],
  }
}

function splitTokenList(value?: string) {
  return value
    ?.split(',')
    .map((token) => token.trim())
    .filter(Boolean) ?? []
}

async function readConfigFile(configFile?: string): Promise<ControlPlaneConfigFile> {
  const configPath = configFile ?? process.env.REMOTE_AGENT_SERVER_CONFIG

  if (!configPath) {
    return {}
  }

  const fileContents = await readFile(resolve(configPath), 'utf8')
  return JSON.parse(fileContents) as ControlPlaneConfigFile
}

export async function resolveControlPlaneConfig(options: StartControlPlaneOptions = {}): Promise<ControlPlaneConfig> {
  const fileConfig = await readConfigFile(options.configFile)
  const operatorTokens = normalizeTokens([
    ...(options.operatorTokens ?? []),
    ...splitTokenList(process.env.REMOTE_AGENT_SERVER_OPERATOR_TOKENS),
    ...(fileConfig.operatorTokens ?? []),
  ])
  const bootstrapTokens = normalizeTokens([
    ...(options.bootstrapTokens ?? []),
    ...splitTokenList(process.env.REMOTE_AGENT_SERVER_BOOTSTRAP_TOKENS),
    ...(fileConfig.bootstrapTokens ?? []),
  ])

  if (operatorTokens.length === 0) {
    throw new Error('Control plane configuration must provide at least one operator token.')
  }

  if (bootstrapTokens.length === 0) {
    throw new Error('Control plane configuration must provide at least one bootstrap token.')
  }

  const host = options.host ?? process.env.REMOTE_AGENT_SERVER_HOST ?? fileConfig.host ?? defaultBindHost
  const envPort = process.env.REMOTE_AGENT_SERVER_PORT ? Number(process.env.REMOTE_AGENT_SERVER_PORT) : undefined
  const port = options.port ?? envPort ?? fileConfig.port ?? defaultBindPort
  const configuredDataFile = options.dataFile ?? process.env.REMOTE_AGENT_SERVER_DATA_FILE ?? fileConfig.dataFile ?? defaultDataFile

  return {
    host,
    port,
    dataFile: isAbsolute(configuredDataFile) ? configuredDataFile : resolve(configuredDataFile),
    operatorTokens,
    bootstrapTokens,
  }
}

function normalizeTokens(tokens: string[]) {
  return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))]
}

async function loadPersistedState(dataFile: string) {
  try {
    const raw = await readFile(dataFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedControlPlaneState>

    return {
      ...createEmptyState(),
      ...parsed,
      hosts: parsed.hosts ?? [],
      workspaces: parsed.workspaces ?? [],
      sessions: parsed.sessions ?? [],
      approvals: parsed.approvals ?? [],
      notifications: parsed.notifications ?? [],
      forwardedPorts: parsed.forwardedPorts ?? [],
    } satisfies ControlPlaneState
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyState()
    }

    throw error
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function persistState(dataFile: string, state: ControlPlaneState) {
  const serializedState: PersistedControlPlaneState = {
    version: 1,
    ...cloneState(state),
  }
  const temporaryFile = `${dataFile}.tmp`

  await mkdir(dirname(dataFile), { recursive: true })
  await writeFile(temporaryFile, JSON.stringify(serializedState, null, 2), 'utf8')
  await rename(temporaryFile, dataFile)
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { 'content-type': jsonContentType })
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, statusCode: number, error: string) {
  sendJson(response, statusCode, { error })
}

async function readJsonBody<T>(request: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return {} as T
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function getBearerToken(request: IncomingMessage) {
  const authorizationHeader = request.headers.authorization

  if (!authorizationHeader) {
    return undefined
  }

  const [scheme, token] = authorizationHeader.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined
  }

  return token
}

function authenticateRequest(
  request: IncomingMessage,
  config: ControlPlaneConfig,
  acceptedSchemes: readonly AuthScheme[],
): { scheme: AuthScheme; token: string; headerName: AuthHeaderName } | undefined {
  for (const scheme of acceptedSchemes) {
    const credential = createTokenCredential(scheme, '')
    const token =
      credential.headerName === 'authorization'
        ? getBearerToken(request)
        : request.headers[credential.headerName]?.toString()

    if (!token) {
      continue
    }

    const tokenPool = scheme === 'operator-token' ? config.operatorTokens : config.bootstrapTokens
    if (tokenPool.includes(token)) {
      return {
        scheme,
        token,
        headerName: credential.headerName,
      }
    }
  }

  return undefined
}

function writeSseEvent(response: ServerResponse, event: ControlPlaneEvent) {
  response.write(`id: ${event.id}\n`)
  response.write(`event: ${event.envelope.type}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function createEvent(type: string, payload: unknown): ControlPlaneEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    envelope: createProtocolEnvelope(type, 'server', payload),
  }
}

function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function requireString(value: unknown, fieldName: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${fieldName}" must be a non-empty string.`)
  }

  return value.trim()
}

function requireOptionalString(value: unknown, fieldName: string) {
  if (value === undefined) {
    return undefined
  }

  return requireString(value, fieldName)
}

function requireEnum<TValue extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly TValue[],
): TValue {
  if (typeof value !== 'string' || !allowedValues.includes(value as TValue)) {
    throw new Error(`"${fieldName}" must be one of: ${allowedValues.join(', ')}.`)
  }

  return value as TValue
}

function requireHostRecord(body: unknown): HostRecord {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  return {
    id: requireString(record.id ?? `host-${randomUUID()}`, 'id'),
    name: requireString(record.name, 'name'),
    platform: requireString(record.platform, 'platform'),
    runtimeVersion: requireString(record.runtimeVersion, 'runtimeVersion'),
    status: requireEnum(record.status ?? 'online', 'status', ['online', 'offline']),
    registeredAt: typeof record.registeredAt === 'string' ? record.registeredAt : new Date().toISOString(),
  }
}

function requireWorkspaceRecord(body: unknown): WorkspaceRecord {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  return {
    id: requireString(record.id ?? `workspace-${randomUUID()}`, 'id'),
    hostId: requireString(record.hostId, 'hostId'),
    path: requireString(record.path, 'path'),
    defaultBranch: requireString(record.defaultBranch ?? 'main', 'defaultBranch'),
    runtimeHostId: requireString(record.runtimeHostId ?? record.hostId, 'runtimeHostId'),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
  }
}

function requireSessionRecord(body: unknown): SessionRecord {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  const timestamp = new Date().toISOString()
  const descriptor = createSessionDescriptor({
    id: requireString(record.id ?? `session-${randomUUID()}`, 'id'),
    workspaceId: requireString(record.workspaceId, 'workspaceId'),
    provider: requireString(record.provider, 'provider'),
    state: requireEnum(record.state ?? 'queued', 'state', [
      'queued',
      'running',
      'blocked',
      'completed',
      'failed',
      'canceled',
    ] satisfies readonly SessionState[]),
    mode: requireEnum(record.mode ?? 'workspace', 'mode', ['workspace', 'worktree'] satisfies readonly SessionMode[]),
  })

  return {
    ...descriptor,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : timestamp,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : timestamp,
  }
}

function requireApprovalRecord(body: unknown): ApprovalRecord {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  return {
    id: requireString(record.id ?? `approval-${randomUUID()}`, 'id'),
    sessionId: requireString(record.sessionId, 'sessionId'),
    action: requireString(record.action, 'action'),
    status: requireEnum(record.status ?? 'pending', 'status', ['pending', 'approved', 'rejected']),
    requestedAt: typeof record.requestedAt === 'string' ? record.requestedAt : new Date().toISOString(),
    decidedAt: requireOptionalString(record.decidedAt, 'decidedAt'),
  }
}

function requireNotificationRecord(body: unknown): NotificationRecord {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  return {
    id: requireString(record.id ?? `notification-${randomUUID()}`, 'id'),
    level: requireEnum(record.level ?? 'info', 'level', ['info', 'warning', 'error']),
    message: requireString(record.message, 'message'),
    sessionId: requireOptionalString(record.sessionId, 'sessionId'),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
  }
}

function requireForwardedPortRecord(body: unknown): ForwardedPortRecord {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  return {
    ...createManagedPort({
      id: requireString(record.id ?? `port-${randomUUID()}`, 'id'),
      port: requireValidPort(record.port),
      protocol: requireEnum(record.protocol ?? 'http', 'protocol', ['http', 'tcp'] satisfies readonly PortProtocol[]),
      visibility: requireEnum(record.visibility ?? 'private', 'visibility', [
        'private',
        'shared',
      ] satisfies readonly PortVisibility[]),
      state: requireEnum(record.state ?? 'forwarded', 'state', ['detected', 'forwarded'] satisfies readonly PortState[]),
    }),
    hostId: requireString(record.hostId, 'hostId'),
    workspaceId: requireOptionalString(record.workspaceId, 'workspaceId'),
    sessionId: requireOptionalString(record.sessionId, 'sessionId'),
    label: requireString(record.label, 'label'),
    targetHost: requireString(record.targetHost ?? '127.0.0.1', 'targetHost'),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
  }
}

function requireValidPort(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('"port" must be an integer between 1 and 65535.')
  }

  return value
}

function upsertRecord<TRecord extends { id: string }>(collection: TRecord[], record: TRecord) {
  const index = collection.findIndex((item) => item.id === record.id)
  if (index === -1) {
    collection.push(record)
  } else {
    collection[index] = record
  }
}

function notFound(response: ServerResponse) {
  sendError(response, 404, 'Not found.')
}

export async function startControlPlaneServer(options: StartControlPlaneOptions = {}): Promise<ControlPlaneServerHandle> {
  const config = await resolveControlPlaneConfig(options)
  const state = await loadPersistedState(config.dataFile)
  const runtime = createRuntimeManifest('remote-control-plane-runtime')
  const clients = new Set<ServerResponse>()
  let persistSequence = Promise.resolve()

  function persistCurrentState() {
    const task = persistSequence.then(
      () => persistState(config.dataFile, state),
      () => persistState(config.dataFile, state),
    )
    persistSequence = task.catch(() => undefined)
    return task
  }

  async function commit<TRecord>(
    response: ServerResponse,
    record: TRecord,
    collectionName: keyof ControlPlaneState,
    eventType: string,
    statusCode = 201,
  ) {
    const collection = state[collectionName] as TRecord[]
    if (Array.isArray(collection) && record && typeof record === 'object' && 'id' in (record as Record<string, unknown>)) {
      upsertRecord(collection as Array<{ id: string }>, record as { id: string } & TRecord)
    } else {
      collection.push(record)
    }

    await persistCurrentState()

    const event = createEvent(eventType, record)
    for (const client of clients) {
      writeSseEvent(client, event)
    }

    sendJson(response, statusCode, { data: record })
  }

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendError(response, 400, 'Missing request URL.')
        return
      }

      const url = new URL(request.url, `http://${request.headers.host ?? `${config.host}:${config.port}`}`)
      const pathname = url.pathname

      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, {
          status: 'ok',
          runtime,
          persistedStateFile: config.dataFile,
        })
        return
      }

      if (request.method === 'GET' && pathname === '/api/events') {
        const authResult = authenticateRequest(request, config, ['operator-token'])
        if (!authResult) {
          sendError(response, 401, 'Unauthorized.')
          return
        }

        response.writeHead(200, {
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'content-type': eventStreamContentType,
        })

        clients.add(response)
        writeSseEvent(
          response,
          createEvent('control-plane.connected', {
            authScheme: authResult.scheme,
            counts: {
              hosts: state.hosts.length,
              workspaces: state.workspaces.length,
              sessions: state.sessions.length,
              approvals: state.approvals.length,
              notifications: state.notifications.length,
              forwardedPorts: state.forwardedPorts.length,
            },
          }),
        )

        request.on('close', () => {
          clients.delete(response)
        })
        return
      }

      const acceptedSchemes =
        request.method === 'POST' && pathname === '/api/hosts'
          ? (['operator-token', 'bootstrap-token'] as const)
          : (['operator-token'] as const)
      const authResult = authenticateRequest(request, config, acceptedSchemes)

      if (!authResult) {
        sendError(response, 401, 'Unauthorized.')
        return
      }

      if (request.method === 'GET' && pathname === '/api/hosts') {
        sendJson(response, 200, { data: state.hosts })
        return
      }

      if (request.method === 'POST' && pathname === '/api/hosts') {
        const host = requireHostRecord(await readJsonBody(request))
        await commit(response, host, 'hosts', 'host.upserted')
        return
      }

      if (request.method === 'GET' && pathname === '/api/workspaces') {
        sendJson(response, 200, { data: state.workspaces })
        return
      }

      if (request.method === 'POST' && pathname === '/api/workspaces') {
        const workspace = requireWorkspaceRecord(await readJsonBody(request))
        await commit(response, workspace, 'workspaces', 'workspace.upserted')
        return
      }

      if (request.method === 'GET' && pathname === '/api/sessions') {
        sendJson(response, 200, { data: state.sessions })
        return
      }

      if (request.method === 'POST' && pathname === '/api/sessions') {
        const session = requireSessionRecord(await readJsonBody(request))
        await commit(response, session, 'sessions', 'session.upserted')
        return
      }

      if (request.method === 'GET' && pathname === '/api/approvals') {
        sendJson(response, 200, { data: state.approvals })
        return
      }

      if (request.method === 'POST' && pathname === '/api/approvals') {
        const approval = requireApprovalRecord(await readJsonBody(request))
        await commit(response, approval, 'approvals', 'approval.upserted')
        return
      }

      const approvalDecisionMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/)
      if (request.method === 'POST' && approvalDecisionMatch) {
        const approvalId = approvalDecisionMatch[1]
        const approval = state.approvals.find((entry) => entry.id === approvalId)

        if (!approval) {
          notFound(response)
          return
        }

        const body = asRecord(await readJsonBody(request))
        const decision = requireEnum(body?.status, 'status', ['approved', 'rejected'])
        const updatedApproval: ApprovalRecord = {
          ...approval,
          status: decision,
          decidedAt: new Date().toISOString(),
        }
        await commit(response, updatedApproval, 'approvals', 'approval.decided')
        return
      }

      if (request.method === 'GET' && pathname === '/api/notifications') {
        sendJson(response, 200, { data: state.notifications })
        return
      }

      if (request.method === 'POST' && pathname === '/api/notifications') {
        const notification = requireNotificationRecord(await readJsonBody(request))
        await commit(response, notification, 'notifications', 'notification.created')
        return
      }

      if (request.method === 'GET' && pathname === '/api/ports') {
        sendJson(response, 200, { data: state.forwardedPorts })
        return
      }

      if (request.method === 'POST' && pathname === '/api/ports') {
        const forwardedPort = requireForwardedPortRecord(await readJsonBody(request))
        await commit(response, forwardedPort, 'forwardedPorts', 'port.upserted')
        return
      }

      notFound(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected server error.'
      sendError(response, 400, message)
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Control plane failed to bind to a TCP address.')
  }

  return {
    config,
    runtime,
    url: `http://${config.host}:${address.port}`,
    getState() {
      return cloneState(state)
    },
    async close() {
      for (const client of clients) {
        client.end()
      }

      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error)
            return
          }

          resolveClose()
        })
      })
    },
  }
}

export async function runControlPlaneCli() {
  const controlPlane = await startControlPlaneServer()

  process.stdout.write(`RemoteAgentServer control plane listening on ${controlPlane.url}\n`)
  process.stdout.write(`State file: ${controlPlane.config.dataFile}\n`)

  const shutdown = async () => {
    await controlPlane.close()
    process.exitCode = 0
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

export function createServerManifest(): ServerManifest {
  const defaultProvider = createProviderDescriptor('claude-code', 'claude')
  const bootstrapSession = createSessionDescriptor({
    id: 'srv-session-1',
    workspaceId: 'workspace-control-plane',
    provider: defaultProvider.kind,
  })

  return {
    id: createWorkspacePackageId('server'),
    kind: 'server',
    runtime: createRuntimeManifest(),
    auth: {
      required: true,
      acceptedSchemes: ['operator-token', 'bootstrap-token'],
    },
    defaultProvider,
    bootstrapSession,
    previewPort: createManagedPort({
      id: 'server-preview',
      port: 4173,
      protocol: 'http',
      visibility: 'shared',
      state: 'forwarded',
    }),
    events: createProtocolEnvelope('session.created', 'server', {
      sessionId: bootstrapSession.id,
    }),
  }
}

export async function removeControlPlaneStateFile(dataFile: string) {
  await rm(dataFile, { force: true })
}

function isDirectExecution() {
  const entrypoint = process.argv[1]
  if (!entrypoint) {
    return false
  }

  return resolve(entrypoint) === fileURLToPath(import.meta.url)
}

if (isDirectExecution()) {
  void runControlPlaneCli()
}
