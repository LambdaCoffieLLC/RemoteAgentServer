import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startControlPlaneHttpServer, type ControlPlaneEvent } from '../../../apps/server/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

test('US-003 runs a persisted control plane with protected APIs and real-time events', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-003-'))
  const storagePath = join(tempDir, 'control-plane-state.json')

  let handle: Awaited<ReturnType<typeof startControlPlaneHttpServer>> | undefined = await startControlPlaneHttpServer({ storagePath })

  try {
    const unauthorizedResponse = await fetch(`${handle.origin}/v1/hosts`)
    assert.equal(unauthorizedResponse.status, 401)

    const forbiddenResponse = await fetch(`${handle.origin}/v1/hosts`, {
      method: 'POST',
      headers: {
        ...viewerHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'host_forbidden',
        label: 'Forbidden host',
        platform: 'linux',
        runtimeStatus: 'online',
      }),
    })
    assert.equal(forbiddenResponse.status, 403)

    const sessionEventPromise = readEvent(handle.origin, 'session.upserted')

    await postJson(handle.origin, '/v1/hosts', {
      id: 'host_primary',
      label: 'Primary Linux Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_app',
      hostId: 'host_primary',
      name: 'App Workspace',
      repositoryPath: '/srv/app',
      defaultBranch: 'main',
      runtimeLabel: 'runtime-primary',
    })
    await postJson(handle.origin, '/v1/sessions', {
      id: 'session_alpha',
      hostId: 'host_primary',
      workspaceId: 'workspace_app',
      provider: 'codex',
    })

    const sessionEvent = await sessionEventPromise
    assert.equal(sessionEvent.type, 'session.upserted')
    assert.equal((sessionEvent.payload as { session: { id: string } }).session.id, 'session_alpha')

    await postJson(handle.origin, '/v1/approvals', {
      id: 'approval_terminal',
      sessionId: 'session_alpha',
      action: 'Run privileged terminal command',
    })
    await patchJson(handle.origin, '/v1/approvals/approval_terminal', {
      status: 'approved',
    })
    await postJson(handle.origin, '/v1/ports', {
      id: 'port_preview',
      hostId: 'host_primary',
      workspaceId: 'workspace_app',
      sessionId: 'session_alpha',
      localPort: 3000,
      targetPort: 3000,
      visibility: 'private',
      label: 'Preview',
    })
    await patchJson(handle.origin, '/v1/sessions/session_alpha', {
      status: 'completed',
    })

    await assertResourceSnapshot(handle.origin)

    await handle.close()
    handle = undefined
    handle = await startControlPlaneHttpServer({ storagePath })

    await assertResourceSnapshot(handle.origin)
  } finally {
    if (handle) {
      await handle.close()
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function assertResourceSnapshot(origin: string) {
  const hosts = await getJson(origin, '/v1/hosts')
  const workspaces = await getJson(origin, '/v1/workspaces')
  const sessions = await getJson(origin, '/v1/sessions')
  const approvals = await getJson(origin, '/v1/approvals')
  const ports = await getJson(origin, '/v1/forwarded-ports')
  const notifications = await getJson(origin, '/v1/notifications')

  assert.equal(hosts.data.length, 1)
  assert.equal(workspaces.data.length, 1)
  assert.equal(sessions.data.length, 1)
  assert.equal(sessions.data[0].status, 'completed')
  assert.equal(approvals.data.length, 1)
  assert.equal(approvals.data[0].status, 'approved')
  assert.equal(ports.data.length, 1)
  assert.deepEqual(
    (notifications.data as Array<{ category: string }>).map((notification) => notification.category).sort(),
    ['approval-required', 'port-exposed', 'session-status'],
  )
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: Array<Record<string, unknown>> }
}

async function postJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return response.json()
}

async function patchJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'PATCH',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  return response.json()
}

async function readEvent(origin: string, expectedType: string) {
  const response = await fetch(`${origin}/v1/events`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  assert.ok(response.body)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      while (buffer.includes('\n\n')) {
        const boundary = buffer.indexOf('\n\n')
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const event = parseSseFrame(frame)

        if (event?.type === expectedType) {
          return event
        }
      }
    }
  } finally {
    await reader.cancel()
  }

  throw new Error(`Expected to receive ${expectedType} from the control-plane event stream.`)
}

function parseSseFrame(frame: string): ControlPlaneEvent | undefined {
  const eventName = frame
    .split('\n')
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim()
  const data = frame
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim()

  if (!eventName || !data) {
    return undefined
  }

  return JSON.parse(data) as ControlPlaneEvent
}
