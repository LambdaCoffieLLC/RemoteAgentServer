import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyDesktopControlPlaneEvent,
  attachDesktopLocalRuntime,
  buildDesktopWorkspaceTargets,
  createDesktopControlPlaneClient,
  createRuntimeProviderRegistry,
  describeDesktopApp,
  registerDesktopLocalRuntime,
  type DesktopControlPlaneEvent,
} from '../../../apps/desktop/src/index.js'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

test('US-016 provides a desktop app for remote session control and local runtime workspace switching', async () => {
  const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }

  assert.equal(desktopPackage.dependencies?.['@remote-agent/runtime'], 'workspace:*')
  assert.equal(desktopPackage.dependencies?.['@remote-agent/sessions'], 'workspace:*')
  assert.equal(desktopPackage.dependencies?.['@remote-agent/ui'], 'workspace:*')
  assert.equal(describeDesktopApp().manifest.sharedPackages.includes('@remote-agent/runtime'), true)

  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-016-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const remoteRepositoryPath = join(tempDir, 'repositories', 'remote-app')
  const localRegisteredRepositoryPath = join(tempDir, 'repositories', 'local-registered-app')
  const localDirectRepositoryPath = join(tempDir, 'repositories', 'local-direct-app')

  initializeCommittedGitRepository(remoteRepositoryPath, '# remote app\n')
  initializeCommittedGitRepository(localRegisteredRepositoryPath, '# local registered app\n')
  initializeCommittedGitRepository(localDirectRepositoryPath, '# local direct app\n')

  const handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_remote_console',
      label: 'Remote Console Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_remote_console',
      hostId: 'host_remote_console',
      repositoryPath: remoteRepositoryPath,
    })

    const localRegistration = await registerDesktopLocalRuntime({
      serverOrigin: handle.origin,
      token: 'control-plane-operator',
      repositoryPath: localRegisteredRepositoryPath,
      hostId: 'host_local_console',
      hostLabel: 'Local Console Host',
      workspaceId: 'workspace_local_console',
      workspaceName: 'local-registered-app',
      runtimeId: 'runtime_local_console',
      runtimeLabel: 'Local Console Runtime',
      platform: 'macos',
      version: '0.3.0',
    })

    assert.equal(localRegistration.host.connectionMode, 'local')
    assert.equal(localRegistration.workspace.hostConnectionMode, 'local')

    const client = createDesktopControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-operator',
    })

    const createdSession = await client.createSession({
      id: 'session_remote_console',
      hostId: 'host_remote_console',
      workspaceId: 'workspace_remote_console',
      provider: 'codex',
      workspaceMode: 'direct',
    })

    assert.equal(createdSession.status, 'running')
    assert.equal(createdSession.workspace?.path.endsWith(join('repositories', 'remote-app')), true)

    const dashboard = await client.signIn()
    assert.equal(dashboard.hosts.length, 2)
    assert.equal(dashboard.workspaces.length, 2)
    assert.equal(dashboard.sessions.length, 1)

    const initialTargets = buildDesktopWorkspaceTargets({
      dashboard,
      selectedWorkspaceId: 'workspace_local_console',
    })

    assert.deepEqual(
      initialTargets.map((target) => [target.workspaceId, target.connectionMode, target.source, target.selected]),
      [
        ['workspace_local_console', 'local', 'control-plane', true],
        ['workspace_remote_console', 'remote', 'control-plane', false],
      ],
    )

    const abortController = new AbortController()
    const iterator = client.streamEvents({ signal: abortController.signal })[Symbol.asyncIterator]()

    const snapshotEvent = await waitForEvent(iterator, (event) => event.type === 'control-plane.snapshot')
    const snapshotDashboard = applyDesktopControlPlaneEvent(undefined, snapshotEvent)
    assert.equal(snapshotDashboard?.sessions[0]?.status, 'running')

    const pausedEventPromise = waitForEvent(
      iterator,
      (event) =>
        event.type === 'session.event.created' &&
        (
          event.payload as {
            sessionEvent?: {
              sessionId?: string
              status?: string
            }
          }
        ).sessionEvent?.sessionId === 'session_remote_console' &&
        (
          event.payload as {
            sessionEvent?: {
              sessionId?: string
              status?: string
            }
          }
        ).sessionEvent?.status === 'paused',
    )

    const pausedSession = await client.applySessionAction('session_remote_console', 'pause')
    assert.equal(pausedSession.status, 'paused')

    const pausedEvent = await pausedEventPromise
    const pausedDashboard = applyDesktopControlPlaneEvent(snapshotDashboard, pausedEvent)
    assert.equal(pausedDashboard?.sessions[0]?.status, 'paused')

    const resumedSession = await client.applySessionAction('session_remote_console', 'resume')
    const canceledSession = await client.applySessionAction('session_remote_console', 'cancel')
    assert.equal(resumedSession.status, 'running')
    assert.equal(canceledSession.status, 'canceled')

    const sessionEvents = await client.listSessionEvents('session_remote_console')
    assert.deepEqual(
      sessionEvents
        .filter((event) => event.kind === 'status')
        .map((event) => event.status),
      ['running', 'paused', 'running', 'canceled'],
    )

    const directLocalAttachment = await attachDesktopLocalRuntime({
      repositoryPath: localDirectRepositoryPath,
      hostId: 'host_local_direct',
      hostLabel: 'Local Direct Host',
      workspaceId: 'workspace_local_direct',
      workspaceName: 'local-direct-app',
      runtimeId: 'runtime_local_direct',
      runtimeLabel: 'Local Direct Runtime',
      platform: 'macos',
      sessionManagerOptions: {
        providerRegistry: createRuntimeProviderRegistry({
          commands: {
            codex: {
              command: process.execPath,
              args: (request) => [
                '--input-type=module',
                '-e',
                `process.stdout.write(${JSON.stringify(`desktop-local:${request.sessionId}\n`)})`,
              ],
            },
          },
        }),
      },
    })

    const directLocalSession = await directLocalAttachment.startSession({
      id: 'session_local_direct',
      provider: 'codex',
      prompt: 'Inspect local workspace',
    })

    assert.equal(directLocalAttachment.mode, 'development-attach')
    assert.equal(directLocalAttachment.workspace.hostConnectionMode, 'local')
    assert.equal(directLocalSession.session.status, 'completed')
    assert.equal(directLocalSession.session.workspace?.path.endsWith(join('repositories', 'local-direct-app')), true)
    assert.equal(
      directLocalSession.events.some((event) => event.kind === 'output' && event.message === 'desktop-local:session_local_direct'),
      true,
    )

    const switchTargets = buildDesktopWorkspaceTargets({
      dashboard: await client.signIn(),
      localAttachments: [directLocalAttachment],
      selectedWorkspaceId: 'workspace_local_direct',
    })

    assert.deepEqual(
      switchTargets.map((target) => [target.workspaceId, target.connectionMode, target.source, target.selected]),
      [
        ['workspace_local_direct', 'local', 'development-attach', true],
        ['workspace_local_console', 'local', 'control-plane', false],
        ['workspace_remote_console', 'remote', 'control-plane', false],
      ],
    )

    abortController.abort()
    await iterator.return?.()
  } finally {
    await handle.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function waitForEvent(
  iterator: AsyncIterator<DesktopControlPlaneEvent>,
  // eslint-disable-next-line no-unused-vars
  predicate: (event: DesktopControlPlaneEvent) => boolean,
  timeoutMs = 5_000,
) {
  return await new Promise<DesktopControlPlaneEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for a matching desktop client event.'))
    }, timeoutMs)

    void (async () => {
      try {
        while (true) {
          const next = await iterator.next()

          if (next.done || !next.value) {
            throw new Error('The desktop client event stream ended before the expected event arrived.')
          }

          if (predicate(next.value)) {
            clearTimeout(timeout)
            resolve(next.value)
            return
          }
        }
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
      }
    })()
  })
}

function initializeCommittedGitRepository(repositoryPath: string, readmeContents: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), readmeContents, 'utf8')
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
