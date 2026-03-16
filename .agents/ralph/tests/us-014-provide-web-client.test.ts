import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'
import {
  createWebControlPlaneClient,
  resolveForwardedPreviewUrl,
  type WebControlPlaneEvent,
} from '../../../apps/web/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

test('US-014 provides a served web client for sign-in, live events, diff review, approvals, and HTTP previews', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-014-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'app')

  initializeCommittedGitRepository(repositoryPath)

  const handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_web_console',
      label: 'Web Console Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_web_console',
      hostId: 'host_web_console',
      repositoryPath,
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_web_console',
      hostId: 'host_web_console',
      workspaceId: 'workspace_web_console',
      provider: 'codex',
      workspaceMode: 'direct',
    })
    await postCreatedJson(handle.origin, '/v1/approvals', {
      id: 'approval_web_console',
      sessionId: 'session_web_console',
      action: 'Restart preview environment',
    })
    const forwardedPort = await postCreatedJson(handle.origin, '/v1/ports', {
      id: 'port_web_console_preview',
      hostId: 'host_web_console',
      workspaceId: 'workspace_web_console',
      sessionId: 'session_web_console',
      localPort: 4173,
      targetPort: 4173,
      protocol: 'http',
      visibility: 'shared',
      label: 'Preview App',
    })

    const pageResponse = await fetch(`${handle.origin}/app`)
    assert.equal(pageResponse.status, 200)
    assert.match(pageResponse.headers.get('content-type') ?? '', /text\/html/)

    const pageHtml = await pageResponse.text()
    assert.match(pageHtml, /Token sign-in/)
    assert.match(pageHtml, /Forwarded Ports/)
    assert.match(pageHtml, /Diff review/)
    assert.match(pageHtml, /Forwarded preview/)

    const client = createWebControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-operator',
    })

    const dashboard = await client.signIn()
    assert.equal(dashboard.hosts.length, 1)
    assert.equal(dashboard.workspaces.length, 1)
    assert.equal(dashboard.sessions.length, 1)
    assert.equal(dashboard.approvals.length, 1)
    assert.equal(dashboard.ports.length, 1)
    assert.equal(dashboard.sessions[0]?.id, 'session_web_console')
    assert.equal(dashboard.approvals[0]?.status, 'pending')

    assert.equal(resolveForwardedPreviewUrl(dashboard.ports[0]!), forwardedPort.data.managedUrl)

    const abortController = new AbortController()
    const iterator = client.streamEvents({ signal: abortController.signal })[Symbol.asyncIterator]()

    await waitForEvent(iterator, (event) => event.type === 'control-plane.snapshot')

    const liveEventPromise = waitForEvent(
      iterator,
      (event) =>
        event.type === 'session.event.created' &&
        (
          event.payload as {
            sessionEvent?: {
              sessionId?: string
              message?: string
            }
          }
        ).sessionEvent?.sessionId === 'session_web_console' &&
        (
          event.payload as {
            sessionEvent?: {
              sessionId?: string
              message?: string
            }
          }
        ).sessionEvent?.message === 'Preview server is live.',
    )

    await postCreatedJson(handle.origin, '/v1/sessions/session_web_console/events', {
      kind: 'log',
      message: 'Preview server is live.',
    })

    const liveEvent = await liveEventPromise
    assert.equal(
      (
        liveEvent.payload as {
          sessionEvent?: {
            message?: string
          }
        }
      ).sessionEvent?.message,
      'Preview server is live.',
    )

    writeFileSync(join(repositoryPath, 'README.md'), '# app\n\nweb client diff\n', 'utf8')

    const diff = await client.readSessionDiff('session_web_console', {
      limit: 5,
      maxBytes: 2048,
    })
    assert.equal(diff.summary.totalFiles, 1)
    assert.equal(diff.summary.modified, 1)
    assert.equal(diff.items[0]?.path, 'README.md')
    assert.match(diff.items[0]?.patch ?? '', /web client diff/)

    const approvalDecision = await client.decideApproval('approval_web_console', 'approved')
    assert.equal(approvalDecision.status, 'approved')

    const refreshedDashboard = await client.signIn()
    assert.equal(refreshedDashboard.approvals[0]?.status, 'approved')

    abortController.abort()
    await iterator.return?.()
  } finally {
    await handle.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function waitForEvent(
  iterator: AsyncIterator<WebControlPlaneEvent>,
  // eslint-disable-next-line no-unused-vars
  predicate: (event: WebControlPlaneEvent) => boolean,
  timeoutMs = 5_000,
) {
  return await new Promise<WebControlPlaneEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for a matching web client event.'))
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
  writeFileSync(join(repositoryPath, 'README.md'), '# app\n', 'utf8')
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
