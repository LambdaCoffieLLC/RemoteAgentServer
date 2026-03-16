import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createMobileControlPlaneClient } from '../apps/mobile/src/client.js'
import { MobileOperatorController } from '../apps/mobile/src/controller.js'
import { createMemoryConnectionSettingsStore } from '../apps/mobile/src/storage.js'
import type { PreviewOpener } from '../apps/mobile/src/types.js'
import { startControlPlaneServer } from '../apps/server/src/index.js'
import { createCodexProviderAdapter } from '../packages/runtime/src/index.js'

const execFileAsync = promisify(execFile)

function operatorHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
}

function bootstrapHeaders(token: string) {
  return {
    'content-type': 'application/json',
    'x-bootstrap-token': token,
  }
}

async function createTempDir() {
  return await mkdtemp(join(tmpdir(), 'remote-agent-server-mobile-client-'))
}

async function createCommittedRepository(rootDir: string, repoName = 'repo') {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test User'])
  await writeFile(join(repositoryPath, 'README.md'), '# mobile smoke\n', 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'add', '.'])
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial state'])
  return repositoryPath
}

async function createPreviewServer() {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<h1>Preview ${request.url ?? '/'}</h1>`)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Preview server failed to bind to a TCP port.')
  }

  return {
    port: address.port,
    async close() {
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

async function waitFor<T>(
  predicate: () => T | Promise<T>,
  timeoutMs = 5000,
  intervalMs = 40,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) {
        return value
      }
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out while waiting for the mobile smoke assertion.')
}

test('mobile controller smoke covers auth, hosts or sessions, live updates, approvals, previews, and stored connection bootstrap', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createCommittedRepository(tempDir)
  const previewServer = await createPreviewServer()
  const settingsStore = createMemoryConnectionSettingsStore()
  const openedPreviews: Array<{ portId: string; mode: string }> = []
  const previewOpener: PreviewOpener = {
    async open(port, mode) {
      openedPreviews.push({
        portId: port.id,
        mode,
      })
    },
  }
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    developmentMode: true,
    localRuntimeHost: {
      id: 'local-dev-host',
      name: 'local-devbox',
      platform: 'darwin',
    },
    runtimeProviderAdapters: [
      createCodexProviderAdapter({
        stepDelayMs: 20,
        approvals: [
          {
            action: 'sudo apt install ripgrep',
            message: 'Approval required for sudo apt install ripgrep.',
            afterStep: 2,
          },
        ],
      }),
    ],
  })

  const createController = () =>
    new MobileOperatorController({
      createClient: (settings) =>
        createMobileControlPlaneClient({
          ...settings,
          fetch,
        }),
      previewOpener,
      settingsStore,
      reconnectDelayMs: 50,
    })

  const controller = createController()

  try {
    await controller.bootstrap()
    assert.equal(controller.getState().phase, 'signed-out')

    const hostResponse = await fetch(`${server.url}/api/hosts`, {
      method: 'POST',
      headers: bootstrapHeaders('bootstrap-secret'),
      body: JSON.stringify({
        id: 'host-1',
        name: 'devbox',
        platform: 'linux',
        runtimeVersion: '0.1.0',
        status: 'online',
      }),
    })
    assert.equal(hostResponse.status, 201)

    const workspaceResponse = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-1',
        hostId: 'host-1',
        runtimeHostId: 'host-1',
        path: repositoryPath,
      }),
    })
    assert.equal(workspaceResponse.status, 201)

    const previewResponse = await fetch(`${server.url}/api/ports`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'preview-shared',
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        label: 'Preview app',
        targetHost: '127.0.0.1',
        port: previewServer.port,
        protocol: 'http',
        visibility: 'shared',
        state: 'forwarded',
      }),
    })
    assert.equal(previewResponse.status, 201)

    await controller.connect({
      baseUrl: server.url,
      token: 'operator-secret',
    })

    await waitFor(() => {
      const state = controller.getState()
      assert.equal(state.phase, 'ready')
      assert.equal(state.dashboard.hosts.some((host) => host.id === 'host-1'), true)
      assert.equal(
        state.dashboard.hosts.some(
          (host) =>
            host.id === 'local-dev-host' &&
            host.hostMode === 'local' &&
            host.connectionMode === 'attached',
        ),
        true,
      )
      assert.equal(
        state.dashboard.hosts.some(
          (host) =>
            host.id === 'host-1' &&
            host.hostMode === 'remote' &&
            host.connectionMode === 'registered',
        ),
        true,
      )
      assert.equal(
        state.dashboard.forwardedPorts.some((port) => port.id === 'preview-shared'),
        true,
      )
      return true
    })

    assert.deepEqual(await settingsStore.load(), {
      baseUrl: server.url,
      token: 'operator-secret',
    })

    const sessionResponse = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'session-1',
        workspaceId: 'workspace-1',
        provider: 'codex',
      }),
    })
    assert.equal(sessionResponse.status, 201)

    const pendingApproval = await waitFor(() => {
      const state = controller.getState()
      assert.equal(state.liveConnection, 'live')
      assert.equal(
        state.dashboard.sessions.some((session) => session.id === 'session-1'),
        true,
      )
      const approval = state.dashboard.approvals.find(
        (entry) => entry.status === 'pending',
      )
      assert.ok(approval)
      assert.equal(state.lastEventType, 'approval.requested')
      return approval
    })

    await controller.decideApproval(pendingApproval.id, 'approved')

    await waitFor(() => {
      const approval = controller
        .getState()
        .dashboard.approvals.find((entry) => entry.id === pendingApproval.id)
      assert.ok(approval)
      assert.equal(approval.status, 'approved')
      return true
    })

    await waitFor(() => {
      const session = controller
        .getState()
        .dashboard.sessions.find((entry) => entry.id === 'session-1')
      assert.ok(session)
      return session.state === 'completed'
    }, 5000)

    await controller.openPreview('preview-shared', 'in-app')
    await controller.openPreview('preview-shared', 'browser')

    assert.deepEqual(openedPreviews, [
      { portId: 'preview-shared', mode: 'in-app' },
      { portId: 'preview-shared', mode: 'browser' },
    ])

    const restoredController = createController()
    try {
      await restoredController.bootstrap()
      await waitFor(() => {
        const state = restoredController.getState()
        assert.equal(state.phase, 'ready')
        assert.equal(state.connection?.baseUrl, server.url)
        assert.equal(
          state.dashboard.sessions.some((session) => session.id === 'session-1'),
          true,
        )
        return true
      })
    } finally {
      restoredController.destroy()
    }
  } finally {
    controller.destroy()
    await server.close()
    await previewServer.close()
    try {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      // Best-effort cleanup for temporary test state on platforms with delayed file handles.
    }
  }
})
