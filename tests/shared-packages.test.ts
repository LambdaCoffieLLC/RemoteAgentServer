import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  createAuthPolicy,
  createTokenCredential,
} from '../packages/auth/src/index.js'
import {
  commonDevelopmentPorts,
  createManagedPort,
  createManagedPortLabel,
  isManagedPortActive,
  suggestManagedPortLabel,
} from '../packages/ports/src/index.js'
import {
  createProtocolEnvelope,
  createWorkspacePackageId,
} from '../packages/protocol/src/index.js'
import {
  createProviderApprovalDecision,
  createProviderApprovalRequest,
  createProviderDescriptor,
  getProviderDisplayName,
} from '../packages/providers/src/index.js'
import {
  createSessionDescriptor,
  createSessionLogEntry,
  createSessionOutputEntry,
  isTerminalSessionState,
} from '../packages/sessions/src/index.js'
import {
  createNavigationItem,
  createStatusBadge,
} from '../packages/ui/src/index.js'

type PackageJson = {
  name?: string
  main?: string
  types?: string
  exports?: {
    '.': {
      import?: string
      types?: string
    }
  }
  dependencies?: Record<string, string>
}

const repoRoot = resolve(import.meta.dirname, '..')
const sharedPackages = ['auth', 'ports', 'protocol', 'providers', 'sessions', 'ui'] as const
const consumerEntryPoints = [
  'apps/server/src/index.ts',
  'apps/web/src/index.ts',
  'apps/mobile/src/index.ts',
  'apps/desktop/src/index.ts',
  'packages/runtime/src/index.ts',
]

const uiConsumers = new Set(['apps/web/src/index.ts', 'apps/mobile/src/index.ts', 'apps/desktop/src/index.ts'])

let built = false

function readText(relativePath: string) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

function readJson<T>(relativePath: string) {
  return JSON.parse(readText(relativePath)) as T
}

function ensureBuilt() {
  if (built) {
    return
  }

  execFileSync('pnpm', ['build'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  built = true
}

test('shared core packages exist and the legacy shared scaffold is gone', () => {
  for (const packageName of sharedPackages) {
    const packageRoot = `packages/${packageName}`
    assert.equal(existsSync(join(repoRoot, packageRoot, 'package.json')), true, `${packageRoot} should exist`)
    assert.equal(existsSync(join(repoRoot, packageRoot, 'src/index.ts')), true, `${packageRoot} source should exist`)
  }

  assert.equal(existsSync(join(repoRoot, 'packages/shared/package.json')), false)
})

test('shared package factories cover the core business logic defaults', () => {
  assert.deepEqual(createTokenCredential('operator-token', 'operator-secret'), {
    scheme: 'operator-token',
    value: 'operator-secret',
    headerName: 'authorization',
  })
  assert.deepEqual(createTokenCredential('bootstrap-token', 'bootstrap-secret'), {
    scheme: 'bootstrap-token',
    value: 'bootstrap-secret',
    headerName: 'x-bootstrap-token',
  })
  assert.deepEqual(createAuthPolicy([]), {
    required: false,
    acceptedSchemes: [],
  })
  assert.deepEqual(createAuthPolicy(['operator-token']), {
    required: true,
    acceptedSchemes: ['operator-token'],
  })

  assert.equal(createWorkspacePackageId('runtime'), '@remote-agent-server/runtime')
  assert.deepEqual(createProtocolEnvelope('session.started', 'server', { id: 'session-1' }), {
    type: 'session.started',
    origin: 'server',
    payload: { id: 'session-1' },
  })

  const detectedPort = createManagedPort({
    id: 'detected-1',
    port: 4318,
    protocol: 'http',
    visibility: 'private',
  })
  assert.deepEqual(detectedPort, {
    id: 'detected-1',
    port: 4318,
    protocol: 'http',
    visibility: 'private',
    state: 'detected',
    forwardingState: undefined,
  })

  const forwardedPort = createManagedPort({
    id: 'forwarded-1',
    port: 8080,
    protocol: 'tcp',
    visibility: 'shared',
    state: 'forwarded',
    managedUrl: 'http://127.0.0.1:4318/ports/forwarded-1',
  })
  assert.equal(createManagedPortLabel(forwardedPort), 'TCP 8080 (shared)')
  assert.equal(commonDevelopmentPorts.includes(5173), true)
  assert.equal(
    suggestManagedPortLabel({
      port: 5173,
      protocol: 'http',
    }),
    'Vite dev server',
  )
  assert.equal(
    suggestManagedPortLabel({
      port: 9999,
      protocol: 'tcp',
    }),
    undefined,
  )
  assert.equal(isManagedPortActive(forwardedPort), true)
  assert.equal(
    isManagedPortActive({
      ...forwardedPort,
      forwardingState: 'closed',
    }),
    false,
  )

  assert.equal(getProviderDisplayName('codex'), 'Codex')
  assert.deepEqual(createProviderDescriptor('claude-code', 'claude'), {
    kind: 'claude-code',
    command: 'claude',
    displayName: 'Claude Code',
    approvalMode: 'manual',
  })

  const requestedAt = '2026-01-02T03:04:05.000Z'
  const approvalRequest = createProviderApprovalRequest({
    id: 'approval-1',
    sessionId: 'session-1',
    provider: 'codex',
    action: 'sudo apt install ripgrep',
    message: 'Approval required.',
    requestedAt,
  })
  assert.deepEqual(approvalRequest, {
    id: 'approval-1',
    sessionId: 'session-1',
    provider: 'codex',
    action: 'sudo apt install ripgrep',
    message: 'Approval required.',
    status: 'pending',
    requestedAt,
  })
  assert.deepEqual(
    createProviderApprovalDecision({
      ...approvalRequest,
      status: 'approved',
      decidedAt: '2026-01-02T03:05:00.000Z',
    }),
    {
      id: 'approval-1',
      sessionId: 'session-1',
      provider: 'codex',
      action: 'sudo apt install ripgrep',
      message: 'Approval required.',
      status: 'approved',
      requestedAt,
      decidedAt: '2026-01-02T03:05:00.000Z',
    },
  )

  assert.deepEqual(createSessionDescriptor({ id: 'session-1', workspaceId: 'workspace-1', provider: 'codex' }), {
    id: 'session-1',
    workspaceId: 'workspace-1',
    provider: 'codex',
    state: 'queued',
    mode: 'workspace',
  })
  assert.equal(isTerminalSessionState('running'), false)
  assert.equal(isTerminalSessionState('completed'), true)

  const sessionLogEntry = createSessionLogEntry('warning', 'Approval required.', requestedAt)
  assert.equal(sessionLogEntry.timestamp, requestedAt)
  assert.equal(sessionLogEntry.level, 'warning')
  assert.equal(sessionLogEntry.message, 'Approval required.')
  assert.match(sessionLogEntry.id, /^session-log-/)

  const sessionOutputEntry = createSessionOutputEntry('stdout', 'hello world', requestedAt)
  assert.equal(sessionOutputEntry.timestamp, requestedAt)
  assert.equal(sessionOutputEntry.stream, 'stdout')
  assert.equal(sessionOutputEntry.text, 'hello world')
  assert.match(sessionOutputEntry.id, /^session-output-/)

  assert.deepEqual(createNavigationItem('sessions', 'Sessions', '/sessions'), {
    id: 'sessions',
    label: 'Sessions',
    href: '/sessions',
  })
  assert.deepEqual(createStatusBadge('Running'), {
    label: 'Running',
    tone: 'neutral',
  })
  assert.deepEqual(createStatusBadge('Failed', 'danger'), {
    label: 'Failed',
    tone: 'danger',
  })
})

test('shared package entrypoints point at runtime-safe build outputs', async () => {
  ensureBuilt()

  for (const packageName of sharedPackages) {
    const packageJson = readJson<PackageJson>(`packages/${packageName}/package.json`)

    assert.equal(packageJson.name, `@remote-agent-server/${packageName}`)
    assert.equal(packageJson.main, 'dist/index.js')
    assert.equal(packageJson.types, 'src/index.ts')
    assert.equal(packageJson.exports?.['.']?.import, './dist/index.js')
    assert.equal(packageJson.exports?.['.']?.types, './src/index.ts')
    assert.equal(existsSync(join(repoRoot, 'packages', packageName, 'dist/index.js')), true)

    const moduleExports = (await import(
      pathToFileURL(join(repoRoot, 'packages', packageName, 'dist/index.js')).href
    )) as Record<string, unknown>

    assert.ok(Object.keys(moduleExports).length > 0, `${packageName} should expose runtime exports`)
  }
})

test('server, runtime, and clients import the shared domain packages', () => {
  const requiredImports = [
    '@remote-agent-server/auth',
    '@remote-agent-server/ports',
    '@remote-agent-server/protocol',
    '@remote-agent-server/providers',
    '@remote-agent-server/sessions',
  ]

  for (const entryPoint of consumerEntryPoints) {
    const source = readText(entryPoint)

    for (const importPath of requiredImports) {
      assert.match(source, new RegExp(importPath.replaceAll('/', '\\/')))
    }

    if (uiConsumers.has(entryPoint)) {
      assert.match(source, /@remote-agent-server\/ui/)
    }

    assert.doesNotMatch(source, /@remote-agent-server\/shared/)
  }
})

test('README documents package responsibilities and dependency boundaries', () => {
  const readme = readText('README.md')

  assert.match(readme, /Shared Package Boundaries/)
  assert.match(readme, /@remote-agent-server\/protocol/)
  assert.match(readme, /@remote-agent-server\/auth/)
  assert.match(readme, /@remote-agent-server\/sessions/)
  assert.match(readme, /@remote-agent-server\/ports/)
  assert.match(readme, /@remote-agent-server\/providers/)
  assert.match(readme, /@remote-agent-server\/ui/)
  assert.match(readme, /dependency direction/i)
})
