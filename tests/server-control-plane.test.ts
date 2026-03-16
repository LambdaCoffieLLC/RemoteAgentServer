import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startControlPlaneServer, type ControlPlaneEvent } from '../apps/server/src/index.js'

async function createTempDir() {
  return mkdtemp(join(tmpdir(), 'remote-agent-server-control-plane-'))
}

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

async function readJson(response: Response) {
  return (await response.json()) as { data?: unknown; error?: string }
}

async function waitForEvent(
  baseUrl: string,
  token: string,
  predicate: (event: ControlPlaneEvent) => boolean,
): Promise<ControlPlaneEvent> {
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
    },
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
        throw new Error('Event stream closed before the expected event arrived.')
      }

      buffer += decoder.decode(value, { stream: true })

      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        separatorIndex = buffer.indexOf('\n\n')

        const dataLine = block
          .split('\n')
          .find((line) => line.startsWith('data: '))

        if (!dataLine) {
          continue
        }

        const event = JSON.parse(dataLine.slice('data: '.length)) as ControlPlaneEvent
        if (predicate(event)) {
          return event
        }
      }
    }
  } finally {
    await reader.cancel()
  }
}

test('control plane rejects unauthorized access and accepts bootstrap host registration', async () => {
  const tempDir = await createTempDir()
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    const unauthorized = await fetch(`${server.url}/api/sessions`)
    assert.equal(unauthorized.status, 401)
    assert.equal((await readJson(unauthorized)).error, 'Unauthorized.')

    const wrongToken = await fetch(`${server.url}/api/sessions`, {
      headers: {
        authorization: 'Bearer wrong-secret',
      },
    })
    assert.equal(wrongToken.status, 401)

    const authorized = await fetch(`${server.url}/api/sessions`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual((await readJson(authorized)).data, [])

    const bootstrapRegistration = await fetch(`${server.url}/api/hosts`, {
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
    assert.equal(bootstrapRegistration.status, 201)

    const hosts = await fetch(`${server.url}/api/hosts`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })
    assert.equal(hosts.status, 200)
    assert.equal(((await readJson(hosts)).data as unknown[]).length, 1)
  } finally {
    await server.close()
  }
})

test('control plane persists hosts, workspaces, sessions, approvals, notifications, and forwarded ports across restart', async () => {
  const tempDir = await createTempDir()
  const configFile = join(tempDir, 'control-plane.config.json')
  const dataFile = join(tempDir, 'control-plane-state.json')

  await writeFile(
    configFile,
    JSON.stringify(
      {
        port: 0,
        dataFile,
        operatorTokens: ['config-operator-secret'],
        bootstrapTokens: ['config-bootstrap-secret'],
      },
      null,
      2,
    ),
    'utf8',
  )

  const firstServer = await startControlPlaneServer({
    configFile,
  })

  try {
    const requests = [
      fetch(`${firstServer.url}/api/hosts`, {
        method: 'POST',
        headers: bootstrapHeaders('config-bootstrap-secret'),
        body: JSON.stringify({
          id: 'host-1',
          name: 'devbox',
          platform: 'linux',
          runtimeVersion: '0.1.0',
          status: 'online',
        }),
      }),
      fetch(`${firstServer.url}/api/workspaces`, {
        method: 'POST',
        headers: operatorHeaders('config-operator-secret'),
        body: JSON.stringify({
          id: 'workspace-1',
          hostId: 'host-1',
          path: '/srv/app',
          defaultBranch: 'main',
          runtimeHostId: 'host-1',
        }),
      }),
      fetch(`${firstServer.url}/api/sessions`, {
        method: 'POST',
        headers: operatorHeaders('config-operator-secret'),
        body: JSON.stringify({
          id: 'session-1',
          workspaceId: 'workspace-1',
          provider: 'codex',
          state: 'running',
        }),
      }),
      fetch(`${firstServer.url}/api/approvals`, {
        method: 'POST',
        headers: operatorHeaders('config-operator-secret'),
        body: JSON.stringify({
          id: 'approval-1',
          sessionId: 'session-1',
          action: 'sudo apt install',
        }),
      }),
      fetch(`${firstServer.url}/api/notifications`, {
        method: 'POST',
        headers: operatorHeaders('config-operator-secret'),
        body: JSON.stringify({
          id: 'notification-1',
          level: 'warning',
          message: 'Approval required',
          sessionId: 'session-1',
        }),
      }),
      fetch(`${firstServer.url}/api/ports`, {
        method: 'POST',
        headers: operatorHeaders('config-operator-secret'),
        body: JSON.stringify({
          id: 'port-1',
          hostId: 'host-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          port: 4173,
          protocol: 'http',
          visibility: 'shared',
          state: 'forwarded',
          label: 'Vite Preview',
          targetHost: '127.0.0.1',
        }),
      }),
    ]

    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 201)
    }
  } finally {
    await firstServer.close()
  }

  const persistedState = JSON.parse(await readFile(dataFile, 'utf8')) as {
    version: number
    hosts: unknown[]
    workspaces: unknown[]
    sessions: unknown[]
    approvals: unknown[]
    notifications: unknown[]
    forwardedPorts: unknown[]
  }

  assert.equal(persistedState.version, 1)
  assert.equal(persistedState.hosts.length, 1)
  assert.equal(persistedState.workspaces.length, 1)
  assert.equal(persistedState.sessions.length, 1)
  assert.equal(persistedState.approvals.length, 1)
  assert.equal(persistedState.notifications.length, 1)
  assert.equal(persistedState.forwardedPorts.length, 1)

  const restartedServer = await startControlPlaneServer({
    configFile,
  })

  try {
    const endpoints = [
      ['hosts', '/api/hosts'],
      ['workspaces', '/api/workspaces'],
      ['sessions', '/api/sessions'],
      ['approvals', '/api/approvals'],
      ['notifications', '/api/notifications'],
      ['ports', '/api/ports'],
    ] as const

    for (const [key, path] of endpoints) {
      const response = await fetch(`${restartedServer.url}${path}`, {
        headers: {
          authorization: 'Bearer config-operator-secret',
        },
      })

      assert.equal(response.status, 200)
      assert.equal(((await readJson(response)).data as unknown[]).length, 1, `${key} should survive restart`)
    }
  } finally {
    await restartedServer.close()
  }
})

test('control plane delivers real-time SSE events for protected mutations', async () => {
  const tempDir = await createTempDir()
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    const eventPromise = waitForEvent(server.url, 'operator-secret', (event) => event.envelope.type === 'notification.created')

    const createNotification = await fetch(`${server.url}/api/notifications`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'notification-1',
        level: 'info',
        message: 'Session completed',
      }),
    })

    assert.equal(createNotification.status, 201)

    const event = await eventPromise
    assert.equal(event.envelope.type, 'notification.created')
    assert.equal((event.envelope.payload as { id: string }).id, 'notification-1')
  } finally {
    await server.close()
  }
})
