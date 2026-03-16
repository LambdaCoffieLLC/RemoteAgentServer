import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMobileControlPlaneClient, buildMobileBrowseItems } from '../../../apps/mobile/src/index.js'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'
import { attachLocalRuntime, createRuntimeProviderRegistry, registerLocalRuntime } from '../../../apps/runtime/src/index.js'
import { createWebControlPlaneClient } from '../../../apps/web/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

test('US-005 supports local runtime registration and direct development attachment on the same runtime contract', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-005-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'local-app')

  initializeCommittedGitRepository(repositoryPath)
  const canonicalRepositoryPath = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  const providerRegistry = createRuntimeProviderRegistry({
    commands: {
      codex: {
        command: process.execPath,
        args: (request) => [
          '-e',
          `process.stdout.write(${JSON.stringify(`local:${request.sessionId}\n`)})`,
        ],
      },
    },
  })

  const handle = await attachLocalRuntime({
    repositoryPath,
    hostId: 'host_local_dev',
    hostLabel: 'Local Dev Host',
    workspaceId: 'workspace_local_dev',
    workspaceName: 'local-app',
    runtimeId: 'runtime_local_dev',
    runtimeLabel: 'Local Dev Runtime',
    platform: 'macos',
    sessionManagerOptions: {
      providerRegistry,
    },
  })

  const directSession = await handle.startSession({
    id: 'session_local_direct',
    provider: 'codex',
    prompt: 'Inspect local workspace',
  })

  assert.equal(handle.mode, 'development-attach')
  assert.equal(handle.host.connectionMode, 'local')
  assert.equal(handle.host.runtime?.enrollmentMethod, 'development-attach')
  assert.equal(handle.workspace.hostConnectionMode, 'local')
  assert.equal(directSession.session.hostId, 'host_local_dev')
  assert.equal(directSession.session.workspaceId, 'workspace_local_dev')
  assert.equal(directSession.session.workspace?.path, canonicalRepositoryPath)
  assert.equal(directSession.session.status, 'completed')
  assert.equal(directSession.command?.cwd, canonicalRepositoryPath)
  assert.equal(directSession.events.some((event) => event.kind === 'output' && event.message === 'local:session_local_direct'), true)

  const server = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(server.origin, '/v1/hosts', {
      id: 'host_remote_linux',
      label: 'Remote Linux Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })

    const registration = await registerLocalRuntime({
      serverOrigin: server.origin,
      token: 'control-plane-operator',
      repositoryPath,
      hostId: 'host_local_console',
      hostLabel: 'Local Console Host',
      workspaceId: 'workspace_local_console',
      workspaceName: 'local-app',
      runtimeId: 'runtime_local_console',
      runtimeLabel: 'Local Console Runtime',
      platform: 'macos',
      version: '0.2.0',
    })

    assert.equal(registration.mode, 'server-registration')
    assert.equal(registration.responses.hostStatusCode, 201)
    assert.equal(registration.responses.workspaceStatusCode, 201)
    assert.equal(registration.host.connectionMode, 'local')
    assert.equal(registration.host.runtime?.enrollmentMethod, 'local-registration')
    assert.equal(registration.workspace.hostConnectionMode, 'local')
    assert.equal(registration.workspace.path, canonicalRepositoryPath)

    const createdSession = await postCreatedJson(server.origin, '/v1/sessions', {
      id: 'session_local_control_plane',
      hostId: 'host_local_console',
      workspaceId: 'workspace_local_console',
      provider: 'codex',
      workspaceMode: 'direct',
    })

    assert.equal(createdSession.data.hostId, 'host_local_console')
    assert.equal(createdSession.data.workspaceId, 'workspace_local_console')
    assert.equal(createdSession.data.workspace.mode, 'direct')
    assert.equal(createdSession.data.workspace.path, canonicalRepositoryPath)

    const sessionDetail = await getJson(server.origin, '/v1/sessions/session_local_control_plane')
    assert.equal(sessionDetail.data.hostId, 'host_local_console')
    assert.equal(sessionDetail.data.workspace.path, canonicalRepositoryPath)

    const sessionEvents = await getJson(server.origin, '/v1/sessions/session_local_control_plane/events')
    assert.equal(sessionEvents.data.length, 1)
    assert.equal(sessionEvents.data[0]?.kind, 'status')
    assert.equal(sessionEvents.data[0]?.status, 'running')

    const webClient = createWebControlPlaneClient({
      baseUrl: server.origin,
      token: 'control-plane-operator',
    })
    const mobileClient = createMobileControlPlaneClient({
      baseUrl: server.origin,
      token: 'control-plane-operator',
    })

    const webDashboard = await webClient.signIn()
    const mobileDashboard = await mobileClient.signIn()
    const mobileBrowseItems = buildMobileBrowseItems(mobileDashboard, 'hosts')

    assert.deepEqual(
      webDashboard.hosts.map((host) => [host.id, host.connectionMode]).sort(),
      [
        ['host_local_console', 'local'],
        ['host_remote_linux', 'remote'],
      ],
    )
    assert.deepEqual(
      webDashboard.workspaces.map((workspace) => [workspace.id, workspace.hostConnectionMode]),
      [['workspace_local_console', 'local']],
    )
    assert.deepEqual(
      mobileBrowseItems.map((item) => [item.id, item.subtitle]).sort(),
      [
        ['host_local_console', 'Local macos host'],
        ['host_remote_linux', 'Remote linux host'],
      ],
    )

    const pageResponse = await fetch(`${server.origin}/app`)
    assert.equal(pageResponse.status, 200)
    const pageHtml = await pageResponse.text()
    assert.match(pageHtml, /host\.connectionMode === 'local' \? 'Local ' : 'Remote '/)
    assert.match(pageHtml, /workspace\.hostConnectionMode === 'local' \? 'Local' : 'Remote'/)
  } finally {
    await server.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function initializeCommittedGitRepository(repositoryPath: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), '# local app\n', 'utf8')
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' })
}

async function postCreatedJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return (await response.json()) as { data: any }
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: {
      authorization: 'Bearer control-plane-operator',
    },
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: any }
}
