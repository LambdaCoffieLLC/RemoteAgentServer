import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDesktopControlPlaneClient } from '../../../apps/desktop/src/index.js'
import { createMobileControlPlaneClient } from '../../../apps/mobile/src/index.js'
import { startControlPlaneHttpServer, type ControlPlaneEvent } from '../../../apps/server/src/index.js'
import { createWebControlPlaneClient, type WebControlPlaneEvent } from '../../../apps/web/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

test('US-017 persists session history and reopens sessions across web, mobile, and desktop clients', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-017-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'shared-app')

  initializeCommittedGitRepository(repositoryPath)

  let handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_shared',
      label: 'Shared Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_shared',
      hostId: 'host_shared',
      repositoryPath,
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_shared',
      hostId: 'host_shared',
      workspaceId: 'workspace_shared',
      provider: 'codex',
      workspaceMode: 'direct',
    })
    await postCreatedJson(handle.origin, '/v1/sessions/session_shared/events', {
      kind: 'log',
      level: 'info',
      message: 'Installing dependencies',
    })
    await postCreatedJson(handle.origin, '/v1/sessions/session_shared/events', {
      kind: 'output',
      stream: 'stdout',
      message: 'pnpm install',
    })

    const webClient = createWebControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-viewer',
    })
    const mobileClient = createMobileControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-viewer',
    })

    const webDashboard = await webClient.signIn()
    assert.equal(webDashboard.sessions.length, 1)
    assert.equal(webDashboard.sessions[0]?.provider, 'codex')
    assert.equal(webDashboard.sessions[0]?.workspaceId, 'workspace_shared')
    assert.equal(webDashboard.sessions[0]?.status, 'running')
    assert.ok(webDashboard.sessions[0]?.workspace?.path.endsWith(join('repositories', 'shared-app')))
    assert.ok(webDashboard.sessions[0]?.startedAt)
    assert.ok(webDashboard.sessions[0]?.updatedAt)
    assert.ok(webDashboard.sessions[0]?.lastActivityAt)

    const webRecovery = await webClient.recoverSession('session_shared', { limit: 2 })
    assert.equal(webRecovery.session.id, 'session_shared')
    assert.equal(webRecovery.session.provider, 'codex')
    assert.ok(webRecovery.session.workspace?.repositoryPath.endsWith(join('repositories', 'shared-app')))
    assert.deepEqual(
      webRecovery.recentEvents.map((event) => event.message),
      ['Installing dependencies', 'pnpm install'],
    )

    const abortController = new AbortController()
    const iterator = webClient.streamEvents({ signal: abortController.signal })[Symbol.asyncIterator]()
    await waitForWebEvent(iterator, (event) => event.type === 'control-plane.snapshot')
    abortController.abort()
    await iterator.return?.()

    await postCreatedJson(handle.origin, '/v1/sessions/session_shared/events', {
      kind: 'log',
      level: 'info',
      message: 'Tests passed',
    })

    const mobileRecovery = await mobileClient.recoverSession('session_shared', { limit: 3 })
    const mobileUpdatedAt = mobileRecovery.session.updatedAt
    const mobileLastActivityAt = mobileRecovery.session.lastActivityAt
    assert.equal(mobileRecovery.session.id, 'session_shared')
    assert.equal(mobileRecovery.session.status, 'running')
    assert.ok(mobileUpdatedAt)
    assert.ok(mobileLastActivityAt)
    assert.ok(mobileUpdatedAt >= mobileRecovery.session.startedAt)
    assert.deepEqual(
      mobileRecovery.recentEvents.map((event) => event.message),
      ['Installing dependencies', 'pnpm install', 'Tests passed'],
    )

    const disconnectedState = await getJson(handle.origin, '/v1/sessions/session_shared')
    assert.equal(disconnectedState.data.status, 'running')

    await handle.close()
    handle = await startControlPlaneHttpServer({ storagePath })

    const desktopClient = createDesktopControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-viewer',
    })

    const desktopDashboard = await desktopClient.signIn()
    assert.equal(desktopDashboard.sessions.length, 1)
    assert.equal(desktopDashboard.sessions[0]?.id, 'session_shared')
    assert.equal(desktopDashboard.sessions[0]?.provider, 'codex')
    assert.ok(desktopDashboard.sessions[0]?.workspace?.path.endsWith(join('repositories', 'shared-app')))

    const desktopRecovery = await desktopClient.recoverSession('session_shared', { limit: 2 })
    assert.equal(desktopRecovery.session.id, 'session_shared')
    assert.equal(desktopRecovery.session.status, 'running')
    assert.equal(desktopRecovery.session.provider, 'codex')
    assert.ok(desktopRecovery.session.workspace?.path.endsWith(join('repositories', 'shared-app')))
    assert.equal(desktopRecovery.session.updatedAt, mobileUpdatedAt)
    assert.equal(desktopRecovery.session.lastActivityAt, mobileLastActivityAt)
    assert.deepEqual(
      desktopRecovery.recentEvents.map((event) => event.message),
      ['pnpm install', 'Tests passed'],
    )
  } finally {
    await handle.close().catch(() => undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function waitForWebEvent(
  iterator: AsyncIterator<WebControlPlaneEvent>,
  // eslint-disable-next-line no-unused-vars
  predicate: (event: ControlPlaneEvent) => boolean,
  timeoutMs = 5_000,
) {
  return await new Promise<WebControlPlaneEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for a matching web event.'))
    }, timeoutMs)

    void (async () => {
      try {
        while (true) {
          const next = await iterator.next()

          if (next.done || !next.value) {
            throw new Error('The web client event stream ended before the expected event arrived.')
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

function initializeCommittedGitRepository(repositoryPath: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), '# shared app\n', 'utf8')
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' })
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: {
      authorization: 'Bearer control-plane-viewer',
    },
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: any }
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
