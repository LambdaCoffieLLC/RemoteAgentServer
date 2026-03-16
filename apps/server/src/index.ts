import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createTokenCredential, type AuthHeaderName, type AuthPolicy, type AuthScheme } from '@remote-agent-server/auth'
import { createManagedPort, type ManagedPort, type PortProtocol, type PortState, type PortVisibility } from '@remote-agent-server/ports'
import { createProtocolEnvelope, createWorkspacePackageId, type ProtocolEnvelope } from '@remote-agent-server/protocol'
import { createProviderDescriptor, providerKinds, type ProviderKind } from '@remote-agent-server/providers'
import {
  createRuntimeManifest,
  createRuntimeSessionManager,
  type RuntimeSessionHandle,
} from '@remote-agent-server/runtime'
import {
  type SessionChangedFile,
  type SessionChangeKind,
  type SessionChangeSet,
  type SessionDiffPage,
  createSessionDescriptor,
  type SessionDescriptor,
  type SessionLogEntry,
  type SessionMode,
  type SessionOutputEntry,
  type SessionState,
  type SessionWorktreeMetadata,
} from '@remote-agent-server/sessions'
import { fileURLToPath } from 'node:url'

const defaultBindHost = '127.0.0.1'
const defaultBindPort = 4318
const defaultDataFile = '.remote-agent-server/control-plane.json'
const jsonContentType = 'application/json; charset=utf-8'
const eventStreamContentType = 'text/event-stream; charset=utf-8'
const execFileAsync = promisify(execFile)
const defaultDiffPageSize = 200
const maxDiffPageSize = 1000
const gitCommandMaxBuffer = 10 * 1024 * 1024

export interface HostRecord {
  id: string
  name: string
  platform: string
  runtimeVersion: string
  status: 'online' | 'offline'
  health: 'healthy' | 'degraded' | 'unhealthy'
  connectivity: 'connected' | 'disconnected'
  registeredAt: string
  lastSeenAt: string
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
  hostId: string
  runtimeHostId: string
  workspacePath: string
  executionPath: string
  allowDirtyWorkspace: boolean
  worktree?: SessionWorktreeMetadata
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  logs: SessionLogEntry[]
  output: SessionOutputEntry[]
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

interface SessionStartRequest {
  descriptor: SessionDescriptor
  workspace: WorkspaceRecord
  allowDirtyWorkspace: boolean
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  logs: SessionLogEntry[]
  output: SessionOutputEntry[]
}

interface SessionExecutionTarget {
  executionPath: string
  worktree?: SessionWorktreeMetadata
}

type SessionMutableFields = Pick<
  SessionRecord,
  'state' | 'updatedAt' | 'startedAt' | 'completedAt' | 'logs' | 'output'
>

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
      sessions: (parsed.sessions ?? []).map((session) => {
        const sessionRecord = session as Partial<SessionRecord>
        return {
          ...sessionRecord,
          executionPath: sessionRecord.executionPath ?? sessionRecord.workspacePath ?? '',
          allowDirtyWorkspace: sessionRecord.allowDirtyWorkspace ?? false,
        } as SessionRecord
      }),
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
  return await new Promise<T>((resolveBody, rejectBody) => {
    let body = ''

    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (body.length === 0) {
        resolveBody({} as T)
        return
      }

      try {
        resolveBody(JSON.parse(body) as T)
      } catch (error) {
        rejectBody(error)
      }
    })
    request.on('error', rejectBody)
    request.resume()
  })
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

function createEvent(type: string, payload: unknown, origin: ProtocolEnvelope['origin'] = 'server'): ControlPlaneEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    envelope: createProtocolEnvelope(type, origin, payload),
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

function requireOptionalBoolean(value: unknown, fieldName: string) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'boolean') {
    throw new Error(`"${fieldName}" must be a boolean.`)
  }

  return value
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

  const timestamp = new Date().toISOString()

  return {
    id: requireString(record.id ?? `host-${randomUUID()}`, 'id'),
    name: requireString(record.name, 'name'),
    platform: requireString(record.platform, 'platform'),
    runtimeVersion: requireString(record.runtimeVersion, 'runtimeVersion'),
    status: requireEnum(record.status ?? 'online', 'status', ['online', 'offline']),
    health: requireEnum(record.health ?? 'healthy', 'health', ['healthy', 'degraded', 'unhealthy']),
    connectivity: requireEnum(record.connectivity ?? 'connected', 'connectivity', ['connected', 'disconnected']),
    registeredAt: typeof record.registeredAt === 'string' ? record.registeredAt : timestamp,
    lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : timestamp,
  }
}

async function resolveGitRepository(path: string) {
  try {
    await access(path)
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Repository path "${path}" does not exist or is not accessible.`)
    }

    throw new Error(`Repository path "${path}" is not accessible.`)
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel'])
    return stdout.trim()
  } catch {
    throw new Error(`Repository path "${path}" is not an accessible git repository.`)
  }
}

async function runGitCommand(path: string, args: string[], maxBuffer = gitCommandMaxBuffer) {
  return await execFileAsync('git', ['-C', path, ...args], { maxBuffer })
}

async function listGitStatusEntries(path: string) {
  const { stdout } = await runGitCommand(path, ['status', '--porcelain', '--untracked-files=normal'])
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

async function assertCleanGitCheckout(path: string, allowDirtyWorkspace: boolean) {
  if (allowDirtyWorkspace) {
    return
  }

  const entries = await listGitStatusEntries(path)
  if (entries.length === 0) {
    return
  }

  throw new Error(`Workspace path "${path}" has uncommitted changes. Set "allowDirtyWorkspace" to true to run anyway.`)
}

async function hasCommittedHead(path: string) {
  try {
    await runGitCommand(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

async function resolveWorktreeBaseRef(path: string, defaultBranch: string) {
  const candidateRefs = [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`, 'HEAD']

  for (const candidateRef of candidateRefs) {
    try {
      const { stdout } = await runGitCommand(path, ['rev-parse', '--verify', '--quiet', candidateRef])
      if (stdout.trim().length > 0) {
        return candidateRef
      }
    } catch {
      // Try the next candidate ref.
    }
  }

  throw new Error(`Repository path "${path}" could not resolve a base ref for worktree creation.`)
}

function sanitizeGitRefComponent(value: string) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return sanitized.length > 0 ? sanitized : 'session'
}

function createSessionWorktreeBranchName(workspaceId: string, sessionId: string) {
  return `${sanitizeGitRefComponent(workspaceId)}-${sanitizeGitRefComponent(sessionId)}`
}

function createSessionWorktreePath(workspace: WorkspaceRecord, branchName: string) {
  return join(dirname(workspace.path), '.remote-agent-server-worktrees', workspace.id, branchName)
}

async function prepareSessionExecutionTarget(
  request: SessionStartRequest,
): Promise<SessionExecutionTarget> {
  await assertCleanGitCheckout(request.workspace.path, request.allowDirtyWorkspace)

  if (request.descriptor.mode === 'workspace') {
    return {
      executionPath: request.workspace.path,
    }
  }

  const branchName = createSessionWorktreeBranchName(request.workspace.id, request.descriptor.id)
  const worktreePath = createSessionWorktreePath(request.workspace, branchName)
  const createdAt = new Date().toISOString()

  await mkdir(dirname(worktreePath), { recursive: true })

  if (await hasCommittedHead(request.workspace.path)) {
    const baseRef = await resolveWorktreeBaseRef(request.workspace.path, request.workspace.defaultBranch)
    await runGitCommand(request.workspace.path, ['worktree', 'add', '-b', branchName, worktreePath, baseRef])
  } else {
    await runGitCommand(request.workspace.path, ['worktree', 'add', '--orphan', worktreePath])
  }

  return {
    executionPath: worktreePath,
    worktree: {
      path: worktreePath,
      branch: branchName,
      baseBranch: request.workspace.defaultBranch,
      createdAt,
    },
  }
}

async function detectDefaultBranch(path: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    const remoteBranch = stdout.trim()

    if (remoteBranch.length > 0) {
      return remoteBranch.replace(/^origin\//, '')
    }
  } catch {
    // Fall through to the local HEAD branch lookup.
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
    const branch = stdout.trim()

    if (branch.length > 0) {
      return branch
    }
  } catch {
    // Surface a clearer error below.
  }

  throw new Error(`Repository path "${path}" does not expose a default branch. Provide "defaultBranch" explicitly.`)
}

function classifySessionChange(indexStatus: string, workingTreeStatus: string): SessionChangeKind {
  if (indexStatus === 'R' || workingTreeStatus === 'R') {
    return 'renamed'
  }

  if (indexStatus === 'D' || workingTreeStatus === 'D') {
    return 'removed'
  }

  if (indexStatus === 'A' || workingTreeStatus === 'A' || workingTreeStatus === '?') {
    return 'added'
  }

  return 'modified'
}

function parseGitStatusEntries(output: string): SessionChangedFile[] {
  const records = output.split('\0').filter((entry) => entry.length > 0)
  const files: SessionChangedFile[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) {
      continue
    }

    const indexStatus = record[0] ?? ' '
    const workingTreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    let previousPath: string | undefined

    if (indexStatus === 'R' || workingTreeStatus === 'R') {
      previousPath = records[index + 1]
      index += 1
    }

    files.push({
      path,
      previousPath,
      kind: classifySessionChange(indexStatus, workingTreeStatus),
      indexStatus,
      workingTreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: workingTreeStatus !== ' ',
    })
  }

  return files.sort((left, right) => left.path.localeCompare(right.path))
}

interface DetectedRename {
  path: string
  previousPath: string
}

function parseGitNameStatusEntries(output: string) {
  const records = output.split('\0').filter((entry) => entry.length > 0)
  const renames: DetectedRename[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record.startsWith('R')) {
      continue
    }

    const previousPath = records[index + 1]
    const path = records[index + 2]
    if (!previousPath || !path) {
      continue
    }

    renames.push({
      path,
      previousPath,
    })
    index += 2
  }

  return renames
}

async function listDetectedRenames(path: string) {
  if (await hasCommittedHead(path)) {
    const { stdout } = await runGitCommand(path, ['diff', '--find-renames', '--name-status', '-z', 'HEAD'])
    return parseGitNameStatusEntries(stdout)
  }

  const staged = await runGitCommand(path, ['diff', '--cached', '--find-renames', '--name-status', '-z', '--root'])
  const unstaged = await runGitCommand(path, ['diff', '--find-renames', '--name-status', '-z'])
  return [...parseGitNameStatusEntries(staged.stdout), ...parseGitNameStatusEntries(unstaged.stdout)]
}

function mergeDetectedRenames(files: SessionChangedFile[], renames: DetectedRename[]) {
  const mergedFiles = [...files]

  for (const rename of renames) {
    const existingRenameIndex = mergedFiles.findIndex(
      (file) => file.path === rename.path && file.previousPath === rename.previousPath && file.kind === 'renamed',
    )
    if (existingRenameIndex !== -1) {
      continue
    }

    const removedIndex = mergedFiles.findIndex((file) => file.path === rename.previousPath && file.kind === 'removed')
    const addedIndex = mergedFiles.findIndex((file) => file.path === rename.path && file.kind === 'added')
    const addedFile = addedIndex === -1 ? undefined : mergedFiles[addedIndex]

    const renamedFile: SessionChangedFile = {
      path: rename.path,
      previousPath: rename.previousPath,
      kind: 'renamed',
      indexStatus: 'R',
      workingTreeStatus: addedFile?.workingTreeStatus ?? ' ',
      staged: true,
      unstaged: addedFile?.unstaged ?? false,
    }

    if (removedIndex !== -1) {
      mergedFiles.splice(removedIndex, 1)
    }

    const adjustedAddedIndex = mergedFiles.findIndex((file) => file.path === rename.path && file.kind === 'added')
    if (adjustedAddedIndex !== -1) {
      mergedFiles.splice(adjustedAddedIndex, 1, renamedFile)
    } else {
      mergedFiles.push(renamedFile)
    }
  }

  return mergedFiles.sort((left, right) => left.path.localeCompare(right.path))
}

async function listSessionChangedFiles(path: string) {
  const { stdout } = await runGitCommand(path, ['status', '--porcelain=1', '-z', '--find-renames'])
  const files = parseGitStatusEntries(stdout)
  const renames = await listDetectedRenames(path)
  return mergeDetectedRenames(files, renames)
}

function createPatchSummary(files: SessionChangedFile[]) {
  const lines = [`${files.length} changed file${files.length === 1 ? '' : 's'}`]

  for (const file of files) {
    if (file.kind === 'renamed' && file.previousPath) {
      lines.push(`R ${file.previousPath} -> ${file.path}`)
      continue
    }

    const prefix = file.kind === 'added'
      ? 'A'
      : file.kind === 'removed'
        ? 'D'
        : 'M'
    lines.push(`${prefix} ${file.path}`)
  }

  return {
    text: lines.join('\n'),
    lineCount: lines.length,
  }
}

async function readUntrackedFileDiff(path: string, filePath: string) {
  try {
    const { stdout } = await runGitCommand(path, ['diff', '--no-index', '--', '/dev/null', filePath])
    return stdout
  } catch (error) {
    const candidate = error as { stdout?: string }
    if (typeof candidate.stdout === 'string') {
      return candidate.stdout
    }

    throw error
  }
}

async function createTrackedDiffText(path: string, filePaths?: string[]) {
  const pathArgs = filePaths && filePaths.length > 0 ? ['--', ...filePaths] : []

  if (await hasCommittedHead(path)) {
    const { stdout } = await runGitCommand(path, ['diff', '--find-renames', 'HEAD', ...pathArgs])
    return stdout
  }

  const staged = await runGitCommand(path, ['diff', '--cached', '--find-renames', '--root', ...pathArgs])
  const unstaged = await runGitCommand(path, ['diff', '--find-renames', ...pathArgs])
  return `${staged.stdout}${unstaged.stdout}`
}

async function createSessionDiffText(path: string, files: SessionChangedFile[], requestedPath?: string) {
  const selectedFiles = requestedPath
    ? files.filter((file) => file.path === requestedPath || file.previousPath === requestedPath)
    : files

  if (selectedFiles.length === 0) {
    throw new Error(
      requestedPath
        ? `Session change "${requestedPath}" was not found.`
        : 'No changed files were found for the session.',
    )
  }

  const trackedPaths = new Set<string>()
  const diffSections: string[] = []

  for (const file of selectedFiles) {
    if (file.previousPath) {
      trackedPaths.add(file.previousPath)
    }

    if (file.workingTreeStatus === '?' && file.indexStatus === '?') {
      diffSections.push(await readUntrackedFileDiff(path, file.path))
      continue
    }

    trackedPaths.add(file.path)
  }

  if (trackedPaths.size > 0) {
    const trackedDiff = await createTrackedDiffText(path, [...trackedPaths])
    if (trackedDiff.length > 0) {
      diffSections.unshift(trackedDiff)
    }
  }

  return diffSections.join('').trimEnd()
}

function paginateDiffText(sessionId: string, text: string, page: number, pageSize: number, path?: string): SessionDiffPage {
  const totalLines = text.length === 0 ? 0 : text.split('\n').length
  const totalPages = Math.max(1, Math.ceil(totalLines / pageSize))
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const start = totalLines === 0 ? 0 : (safePage - 1) * pageSize
  const end = totalLines === 0 ? 0 : Math.min(start + pageSize, totalLines)
  const lines = totalLines === 0 ? [] : text.split('\n')

  return {
    sessionId,
    path,
    page: safePage,
    pageSize,
    totalLines,
    totalPages,
    truncated: totalLines > pageSize,
    previousPage: safePage > 1 ? safePage - 1 : undefined,
    nextPage: end < totalLines ? safePage + 1 : undefined,
    text: lines.slice(start, end).join('\n'),
  }
}

function requirePositiveInteger(value: string | null, fieldName: string, fallback: number) {
  if (value === null || value.trim().length === 0) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`"${fieldName}" must be a positive integer.`)
  }

  return parsed
}

async function getSessionChangeSet(session: SessionRecord): Promise<SessionChangeSet> {
  const files = await listSessionChangedFiles(session.executionPath)
  return {
    sessionId: session.id,
    workspacePath: session.workspacePath,
    executionPath: session.executionPath,
    files,
    summary: createPatchSummary(files),
  }
}

function requireRegisteredHost(state: ControlPlaneState, hostId: string, fieldName: string) {
  if (!state.hosts.some((host) => host.id === hostId)) {
    throw new Error(`"${fieldName}" must reference a registered host.`)
  }
}

async function requireWorkspaceRecord(body: unknown, state: ControlPlaneState): Promise<WorkspaceRecord> {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  const hostId = requireString(record.hostId, 'hostId')
  const runtimeHostId = requireString(record.runtimeHostId ?? record.hostId, 'runtimeHostId')
  requireRegisteredHost(state, hostId, 'hostId')
  requireRegisteredHost(state, runtimeHostId, 'runtimeHostId')

  const repositoryPath = requireString(record.path, 'path')
  const resolvedRepositoryPath = isAbsolute(repositoryPath) ? repositoryPath : resolve(repositoryPath)
  const gitRepositoryPath = await resolveGitRepository(resolvedRepositoryPath)
  const defaultBranch =
    typeof record.defaultBranch === 'string' && record.defaultBranch.trim().length > 0
      ? requireString(record.defaultBranch, 'defaultBranch')
      : await detectDefaultBranch(gitRepositoryPath)

  return {
    id: requireString(record.id ?? `workspace-${randomUUID()}`, 'id'),
    hostId,
    path: gitRepositoryPath,
    defaultBranch,
    runtimeHostId,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
  }
}

function requireProviderKind(value: unknown, fieldName: string) {
  return requireEnum(value, fieldName, providerKinds satisfies readonly ProviderKind[])
}

function requireSessionStartRequest(body: unknown, state: ControlPlaneState): SessionStartRequest {
  const record = asRecord(body)
  if (!record) {
    throw new Error('Request body must be a JSON object.')
  }

  const timestamp = new Date().toISOString()
  const workspaceId = requireString(record.workspaceId, 'workspaceId')
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId)
  if (!workspace) {
    throw new Error('"workspaceId" must reference a registered workspace.')
  }

  const descriptor = createSessionDescriptor({
    id: requireString(record.id ?? `session-${randomUUID()}`, 'id'),
    workspaceId,
    provider: requireProviderKind(record.provider, 'provider'),
    state: requireEnum(record.state ?? 'queued', 'state', [
      'queued',
      'running',
      'paused',
      'blocked',
      'completed',
      'failed',
      'canceled',
    ] satisfies readonly SessionState[]),
    mode: requireEnum(record.mode ?? 'workspace', 'mode', ['workspace', 'worktree'] satisfies readonly SessionMode[]),
  })

  return {
    descriptor,
    workspace,
    allowDirtyWorkspace: requireOptionalBoolean(record.allowDirtyWorkspace, 'allowDirtyWorkspace') ?? false,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : timestamp,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : timestamp,
    startedAt: requireOptionalString(record.startedAt, 'startedAt'),
    completedAt: requireOptionalString(record.completedAt, 'completedAt'),
    logs: Array.isArray(record.logs) ? (record.logs as SessionLogEntry[]) : [],
    output: Array.isArray(record.output) ? (record.output as SessionOutputEntry[]) : [],
  }
}

function findSession(state: ControlPlaneState, sessionId: string) {
  return state.sessions.find((entry) => entry.id === sessionId)
}

function requireSession(state: ControlPlaneState, sessionId: string) {
  const session = findSession(state, sessionId)
  if (!session) {
    throw new Error(`Session "${sessionId}" was not found.`)
  }

  return session
}

function updateSession(state: ControlPlaneState, sessionId: string, update: SessionMutableFields) {
  const index = state.sessions.findIndex((entry) => entry.id === sessionId)
  if (index === -1) {
    throw new Error(`Session "${sessionId}" was not found.`)
  }

  const current = state.sessions[index]
  const next: SessionRecord = {
    ...current,
    ...update,
    logs: [...update.logs],
    output: [...update.output],
  }
  state.sessions[index] = next
  return next
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

function removeRecordById<TRecord extends { id: string }>(collection: TRecord[], id: string) {
  const index = collection.findIndex((item) => item.id === id)
  if (index === -1) {
    return undefined
  }

  const [record] = collection.splice(index, 1)
  return record
}

function notFound(response: ServerResponse) {
  sendError(response, 404, 'Not found.')
}

export async function startControlPlaneServer(options: StartControlPlaneOptions = {}): Promise<ControlPlaneServerHandle> {
  const config = await resolveControlPlaneConfig(options)
  const state = await loadPersistedState(config.dataFile)
  const runtime = createRuntimeManifest('remote-control-plane-runtime')
  const runtimeSessions = createRuntimeSessionManager()
  const clients = new Set<ServerResponse>()
  const activeRuntimeHandles = new Map<string, RuntimeSessionHandle>()
  const eventBacklog: ControlPlaneEvent[] = []
  let persistSequence = Promise.resolve()
  const maxEventBacklog = 250

  function persistCurrentState() {
    const task = persistSequence.then(
      () => persistState(config.dataFile, state),
      () => persistState(config.dataFile, state),
    )
    persistSequence = task.catch(() => undefined)
    return task
  }

  function broadcastEvent(event: ControlPlaneEvent) {
    eventBacklog.push(event)
    if (eventBacklog.length > maxEventBacklog) {
      eventBacklog.shift()
    }

    for (const client of clients) {
      writeSseEvent(client, event)
    }
  }

  async function upsertAndBroadcast<TRecord>(
    record: TRecord,
    collectionName: keyof ControlPlaneState,
    eventType: string,
    origin: ProtocolEnvelope['origin'] = 'server',
  ) {
    const collection = state[collectionName] as TRecord[]
    if (Array.isArray(collection) && record && typeof record === 'object' && 'id' in (record as Record<string, unknown>)) {
      upsertRecord(collection as Array<{ id: string }>, record as { id: string } & TRecord)
    } else {
      collection.push(record)
    }

    await persistCurrentState()

    broadcastEvent(createEvent(eventType, record, origin))
  }

  async function remove<TRecord extends { id: string }>(
    response: ServerResponse,
    collectionName: keyof ControlPlaneState,
    id: string,
    eventType: string,
  ) {
    const collection = state[collectionName] as unknown as TRecord[]
    const removedRecord = removeRecordById(collection, id)

    if (!removedRecord) {
      notFound(response)
      return
    }

    await persistCurrentState()
    broadcastEvent(createEvent(eventType, removedRecord))

    sendJson(response, 200, { data: removedRecord })
  }

  async function commit<TRecord>(
    response: ServerResponse,
    record: TRecord,
    collectionName: keyof ControlPlaneState,
    eventType: string,
    statusCode = 201,
    origin: ProtocolEnvelope['origin'] = 'server',
  ) {
    await upsertAndBroadcast(record, collectionName, eventType, origin)
    sendJson(response, statusCode, { data: record })
  }

  async function persistSessionSnapshot(snapshot: ReturnType<RuntimeSessionHandle['getSnapshot']>) {
    const record = updateSession(state, snapshot.session.id, {
      state: snapshot.session.state,
      updatedAt: snapshot.updatedAt,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      logs: snapshot.logs,
      output: snapshot.output,
    })

    await persistCurrentState()
    return record
  }

  function attachRuntimeSession(handle: RuntimeSessionHandle) {
    activeRuntimeHandles.set(handle.id, handle)
    const unsubscribe = handle.subscribe((event) => {
      void (async () => {
        const record = await persistSessionSnapshot(handle.getSnapshot())
        broadcastEvent(createEvent(event.type, { session: record, ...(event.payload as Record<string, unknown>) }, 'runtime'))

        if (record.state === 'completed' || record.state === 'failed' || record.state === 'canceled') {
          activeRuntimeHandles.delete(record.id)
          unsubscribe()
        }
      })()
    })
  }

  async function startManagedSession(body: unknown) {
    const candidate = requireSessionStartRequest(body, state)
    if (findSession(state, candidate.descriptor.id)) {
      throw new Error(`Session "${candidate.descriptor.id}" already exists.`)
    }

    const executionTarget = await prepareSessionExecutionTarget(candidate)

    const session: SessionRecord = {
      ...candidate.descriptor,
      hostId: candidate.workspace.hostId,
      runtimeHostId: candidate.workspace.runtimeHostId,
      workspacePath: candidate.workspace.path,
      executionPath: executionTarget.executionPath,
      allowDirtyWorkspace: candidate.allowDirtyWorkspace,
      worktree: executionTarget.worktree,
      createdAt: candidate.createdAt,
      state: 'queued',
      updatedAt: candidate.createdAt,
      startedAt: candidate.startedAt,
      completedAt: candidate.completedAt,
      logs: [],
      output: [],
    }
    await upsertAndBroadcast(session, 'sessions', 'session.upserted')

    const handle = runtimeSessions.startSession({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspacePath: session.executionPath,
      provider: session.provider as ProviderKind,
      mode: session.mode,
    })
    attachRuntimeSession(handle)

    return session
  }

  async function controlSession(sessionId: string, action: 'pause' | 'resume' | 'cancel') {
    requireSession(state, sessionId)
    const handle = activeRuntimeHandles.get(sessionId) ?? runtimeSessions.getSession(sessionId)
    if (!handle) {
      throw new Error(`Session "${sessionId}" is not active in the runtime.`)
    }

    if (action === 'pause') {
      handle.pause()
    } else if (action === 'resume') {
      handle.resume()
    } else {
      handle.cancel()
    }

    return await persistSessionSnapshot(handle.getSnapshot())
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
        const replayFrom = request.headers['last-event-id']?.toString()
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

        if (replayFrom) {
          const replayIndex = eventBacklog.findIndex((event) => event.id === replayFrom)
          if (replayIndex !== -1) {
            for (const event of eventBacklog.slice(replayIndex + 1)) {
              writeSseEvent(response, event)
            }
          } else {
            writeSseEvent(
              response,
              createEvent('session.snapshot', {
                active: state.sessions.filter((entry) => !['completed', 'failed', 'canceled'].includes(entry.state)),
              }),
            )
          }
        } else {
          writeSseEvent(
            response,
            createEvent('session.snapshot', {
              active: state.sessions.filter((entry) => !['completed', 'failed', 'canceled'].includes(entry.state)),
            }),
          )
        }

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
        const workspace = await requireWorkspaceRecord(await readJsonBody(request), state)
        await commit(response, workspace, 'workspaces', 'workspace.upserted')
        return
      }

      const workspaceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/)
      if (request.method === 'GET' && workspaceMatch) {
        const workspace = state.workspaces.find((entry) => entry.id === workspaceMatch[1])
        if (!workspace) {
          notFound(response)
          return
        }

        sendJson(response, 200, { data: workspace })
        return
      }

      if (request.method === 'DELETE' && workspaceMatch) {
        await remove<WorkspaceRecord>(response, 'workspaces', workspaceMatch[1], 'workspace.removed')
        return
      }

      if (request.method === 'GET' && pathname === '/api/sessions') {
        sendJson(response, 200, { data: state.sessions })
        return
      }

      if (request.method === 'POST' && pathname === '/api/sessions') {
        const session = await startManagedSession(await readJsonBody(request))
        sendJson(response, 201, { data: session })
        return
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (request.method === 'GET' && sessionMatch) {
        const session = findSession(state, sessionMatch[1])
        if (!session) {
          notFound(response)
          return
        }

        sendJson(response, 200, { data: session })
        return
      }

      const sessionChangesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/changes$/)
      if (request.method === 'GET' && sessionChangesMatch) {
        const session = requireSession(state, sessionChangesMatch[1])
        const changeSet = await getSessionChangeSet(session)
        sendJson(response, 200, { data: changeSet })
        return
      }

      const sessionDiffMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/diff$/)
      if (request.method === 'GET' && sessionDiffMatch) {
        const session = requireSession(state, sessionDiffMatch[1])
        const requestedPath = url.searchParams.get('path') ?? undefined
        const page = requirePositiveInteger(url.searchParams.get('page'), 'page', 1)
        const pageSize = Math.min(
          requirePositiveInteger(url.searchParams.get('pageSize'), 'pageSize', defaultDiffPageSize),
          maxDiffPageSize,
        )
        const changeSet = await getSessionChangeSet(session)
        const diffText = await createSessionDiffText(session.executionPath, changeSet.files, requestedPath)
        sendJson(response, 200, {
          data: paginateDiffText(session.id, diffText, page, pageSize, requestedPath),
        })
        return
      }

      const sessionControlMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(pause|resume|cancel)$/)
      if (request.method === 'POST' && sessionControlMatch) {
        const session = await controlSession(
          sessionControlMatch[1],
          sessionControlMatch[2] as 'pause' | 'resume' | 'cancel',
        )
        sendJson(response, 200, { data: session })
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
      runtimeSessions.dispose()
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

        server.closeIdleConnections()
        server.closeAllConnections()
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
