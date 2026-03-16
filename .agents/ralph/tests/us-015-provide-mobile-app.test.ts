import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'
import {
  applyMobileControlPlaneEvent,
  buildMobileBrowseItems,
  createMobileControlPlaneClient,
  resolveForwardedPreviewUrl,
  type MobileControlPlaneEvent,
} from '../../../apps/mobile/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

test('US-015 provides an Expo mobile client for auth, browsing, live session updates, approvals, and previews', async () => {
  const mobilePackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/mobile/package.json'), 'utf8')) as {
    main?: string
    dependencies?: Record<string, string>
  }
  const appConfig = JSON.parse(readFileSync(join(process.cwd(), 'apps/mobile/app.json'), 'utf8')) as {
    expo?: {
      name?: string
      slug?: string
      scheme?: string
    }
  }

  assert.equal(mobilePackage.main, 'src/main.ts')
  assert.ok(mobilePackage.dependencies?.expo)
  assert.ok(mobilePackage.dependencies?.['react-native'])
  assert.ok(appConfig.expo?.name)
  assert.equal(appConfig.expo?.slug, 'remote-agent-mobile')

  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-015-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'mobile-app')

  initializeCommittedGitRepository(repositoryPath)

  const handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_mobile_console',
      label: 'Mobile Console Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_mobile_console',
      hostId: 'host_mobile_console',
      repositoryPath,
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_mobile_console',
      hostId: 'host_mobile_console',
      workspaceId: 'workspace_mobile_console',
      provider: 'codex',
      workspaceMode: 'direct',
    })
    await postCreatedJson(handle.origin, '/v1/approvals', {
      id: 'approval_mobile_console',
      sessionId: 'session_mobile_console',
      action: 'Approve production migration',
    })
    const forwardedPort = await postCreatedJson(handle.origin, '/v1/ports', {
      id: 'port_mobile_console_preview',
      hostId: 'host_mobile_console',
      workspaceId: 'workspace_mobile_console',
      sessionId: 'session_mobile_console',
      localPort: 8080,
      targetPort: 8080,
      protocol: 'http',
      visibility: 'shared',
      label: 'Preview App',
    })

    const client = createMobileControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-operator',
    })

    const dashboard = await client.signIn()
    assert.equal(dashboard.hosts.length, 1)
    assert.equal(dashboard.sessions.length, 1)
    assert.equal(dashboard.approvals.length, 1)
    assert.equal(dashboard.ports.length, 1)

    const hostBrowseItems = buildMobileBrowseItems(dashboard, 'hosts')
    const sessionBrowseItems = buildMobileBrowseItems(dashboard, 'sessions')
    assert.equal(hostBrowseItems[0]?.title, 'Mobile Console Host')
    assert.equal(sessionBrowseItems[0]?.badge, 'running')
    assert.match(sessionBrowseItems[0]?.subtitle ?? '', /codex/)

    const abortController = new AbortController()
    const iterator = client.streamEvents({ signal: abortController.signal })[Symbol.asyncIterator]()

    const snapshotEvent = await waitForEvent(iterator, (event) => event.type === 'control-plane.snapshot')
    const snapshotDashboard = applyMobileControlPlaneEvent(undefined, snapshotEvent)
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
        ).sessionEvent?.sessionId === 'session_mobile_console' &&
        (
          event.payload as {
            sessionEvent?: {
              sessionId?: string
              status?: string
            }
          }
        ).sessionEvent?.status === 'paused',
    )

    await patchJson(handle.origin, '/v1/sessions/session_mobile_console/actions', {
      action: 'pause',
    })

    const pausedEvent = await pausedEventPromise
    const updatedDashboard = applyMobileControlPlaneEvent(dashboard, pausedEvent)
    assert.equal(updatedDashboard?.sessions[0]?.status, 'paused')

    const sessionEvents = await client.listSessionEvents('session_mobile_console')
    assert.equal(sessionEvents.some((event) => event.kind === 'status' && event.status === 'paused'), true)

    const approvalDecision = await client.decideApproval('approval_mobile_console', 'approved')
    assert.equal(approvalDecision.status, 'approved')

    const previewCalls: Array<{ mode: 'in-app' | 'system'; url: string }> = []
    assert.equal(resolveForwardedPreviewUrl(dashboard.ports[0]!), forwardedPort.data.managedUrl)

    const inAppUrl = await client.openForwardedPreview(dashboard.ports[0]!, {
      mode: 'in-app',
      previewOpeners: {
        openInAppBrowser: async (url) => {
          previewCalls.push({ mode: 'in-app', url })
        },
        openSystemBrowser: async (url) => {
          previewCalls.push({ mode: 'system', url })
        },
      },
    })
    assert.equal(inAppUrl, forwardedPort.data.managedUrl)

    await client.openForwardedPreview(dashboard.ports[0]!, {
      mode: 'system',
      previewOpeners: {
        openInAppBrowser: async (url) => {
          previewCalls.push({ mode: 'in-app', url })
        },
        openSystemBrowser: async (url) => {
          previewCalls.push({ mode: 'system', url })
        },
      },
    })

    assert.deepEqual(previewCalls, [
      { mode: 'in-app', url: forwardedPort.data.managedUrl! },
      { mode: 'system', url: forwardedPort.data.managedUrl! },
    ])

    abortController.abort()
    await iterator.return?.()
  } finally {
    await handle.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function waitForEvent(
  iterator: AsyncIterator<MobileControlPlaneEvent>,
  // eslint-disable-next-line no-unused-vars
  predicate: (event: MobileControlPlaneEvent) => boolean,
  timeoutMs = 5_000,
) {
  return await new Promise<MobileControlPlaneEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for a matching mobile client event.'))
    }, timeoutMs)

    void (async () => {
      try {
        while (true) {
          const next = await iterator.next()

          if (next.done || !next.value) {
            throw new Error('The mobile client event stream ended before the expected event arrived.')
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
  writeFileSync(join(repositoryPath, 'README.md'), '# mobile app\n', 'utf8')
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
  return (await response.json()) as {
    data: {
      managedUrl?: string
    }
  }
}

async function patchJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  return (await response.json()) as {
    data: Record<string, unknown>
  }
}
