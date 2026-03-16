import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createApprovalClient } from '../apps/web/src/index.js'
import {
  startControlPlaneServer,
  type ControlPlaneEvent,
} from '../apps/server/src/index.js'
import {
  createCodexProviderAdapter,
  enrollRuntime,
} from '../packages/runtime/src/index.js'

const execFileAsync = promisify(execFile)

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

async function createGitRepository(rootDir: string, repoName = 'repo') {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  return realpath(repositoryPath)
}

async function createPreviewServer() {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`preview:${request.url ?? '/'}`)
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

async function findAvailablePort(candidates: number[]) {
  for (const candidate of candidates) {
    const server = createHttpServer()

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(candidate, '127.0.0.1', () => {
          server.off('error', rejectListen)
          resolveListen()
        })
      })

      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error)
            return
          }

          resolveClose()
        })
      })

      return candidate
    } catch {
      server.close()
    }
  }

  throw new Error('Failed to reserve a common development port for the detection test.')
}

function getExpectedDetectedLabel(port: number) {
  switch (port) {
    case 4173:
      return 'Vite preview'
    case 4321:
      return 'Storybook'
    case 5173:
      return 'Vite dev server'
    case 8787:
      return 'Wrangler dev server'
    default:
      return `Detected port ${port}`
  }
}

async function startWorkspaceDevelopmentServer(
  workspacePath: string,
  port: number,
) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('detected-preview:' + (request.url ?? '/'))
        })
        server.listen(${port}, '127.0.0.1', () => {
          process.stdout.write('ready\\n')
        })
        process.on('SIGTERM', () => {
          server.close(() => process.exit(0))
        })
      `,
    ],
    {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup()
      child.kill('SIGTERM')
      rejectReady(new Error('Timed out while waiting for the detected dev server to start.'))
    }, 5000)

    function cleanup() {
      clearTimeout(timeout)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
    }

    function onStdout(chunk: Buffer) {
      if (chunk.toString('utf8').includes('ready')) {
        cleanup()
        resolveReady()
      }
    }

    function onStderr(chunk: Buffer) {
      cleanup()
      rejectReady(new Error(`Detected dev server failed to start: ${chunk.toString('utf8').trim()}`))
    }

    function onExit(code: number | null) {
      cleanup()
      rejectReady(new Error(`Detected dev server exited before startup with code ${code}.`))
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('exit', onExit)
  })

  return {
    port,
    async close() {
      if (child.exitCode !== null) {
        return
      }

      child.kill('SIGTERM')
      await new Promise<void>((resolveClose) => {
        child.once('exit', () => resolveClose())
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
    : new Error('Timed out while waiting for the control-plane assertion.')
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
        throw new Error(
          'Event stream closed before the expected event arrived.',
        )
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

        const event = JSON.parse(
          dataLine.slice('data: '.length),
        ) as ControlPlaneEvent
        if (predicate(event)) {
          return event
        }
      }
    }
  } finally {
    await reader.cancel()
  }
}

async function openEventStream(
  baseUrl: string,
  token: string,
  lastEventId?: string,
) {
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
  })

  assert.equal(response.status, 200)
  assert.ok(response.body)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  return {
    async nextEvent(predicate: (event: ControlPlaneEvent) => boolean) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          throw new Error(
            'Event stream closed before the expected event arrived.',
          )
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

          const event = JSON.parse(
            dataLine.slice('data: '.length),
          ) as ControlPlaneEvent
          if (predicate(event)) {
            return event
          }
        }
      }
    },
    async close() {
      await reader.cancel()
    },
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

test('local runtimes can register or attach in development mode and share the same session lifecycle as remote runtimes', async () => {
  const tempDir = await createTempDir()
  const localRepositoryPath = await createGitRepository(tempDir, 'local-repo')
  const remoteRepositoryPath = await createGitRepository(tempDir, 'remote-repo')
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    developmentMode: true,
    localRuntimeHost: {
      id: 'local-attached',
      name: 'Local workstation',
      platform: 'darwin',
    },
    runtimeProviderAdapters: [createCodexProviderAdapter({ stepDelayMs: 10 })],
  })

  try {
    const localEnrollment = await enrollRuntime({
      serverUrl: server.url,
      bootstrapToken: 'bootstrap-secret',
      hostId: 'local-registered',
      name: 'Laptop runtime',
      platform: 'darwin',
      hostMode: 'local',
    })
    assert.equal(localEnrollment.host.hostMode, 'local')
    assert.equal(localEnrollment.host.connectionMode, 'registered')

    const remoteRegistration = await fetch(`${server.url}/api/hosts`, {
      method: 'POST',
      headers: bootstrapHeaders('bootstrap-secret'),
      body: JSON.stringify({
        id: 'remote-host',
        name: 'buildbox',
        platform: 'linux',
        runtimeVersion: '0.1.0',
        status: 'online',
      }),
    })
    assert.equal(remoteRegistration.status, 201)

    const hostsResponse = await fetch(`${server.url}/api/hosts`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })
    assert.equal(hostsResponse.status, 200)
    const hosts = (await readJson(hostsResponse)).data as Array<{
      id: string
      hostMode: string
      connectionMode: string
    }>
    assert.deepEqual(
      hosts
        .map((host) => ({
          id: host.id,
          hostMode: host.hostMode,
          connectionMode: host.connectionMode,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [
        {
          id: 'local-attached',
          hostMode: 'local',
          connectionMode: 'attached',
        },
        {
          id: 'local-registered',
          hostMode: 'local',
          connectionMode: 'registered',
        },
        {
          id: 'remote-host',
          hostMode: 'remote',
          connectionMode: 'registered',
        },
      ],
    )

    const workspaceRequests = [
      fetch(`${server.url}/api/workspaces`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'workspace-local',
          hostId: 'local-attached',
          runtimeHostId: 'local-attached',
          path: localRepositoryPath,
        }),
      }),
      fetch(`${server.url}/api/workspaces`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'workspace-remote',
          hostId: 'remote-host',
          runtimeHostId: 'remote-host',
          path: remoteRepositoryPath,
        }),
      }),
    ]

    for (const response of await Promise.all(workspaceRequests)) {
      assert.equal(response.status, 201)
    }

    const sessionRequests = [
      fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'session-local',
          workspaceId: 'workspace-local',
          provider: 'codex',
        }),
      }),
      fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'session-remote',
          workspaceId: 'workspace-remote',
          provider: 'codex',
        }),
      }),
    ]

    for (const response of await Promise.all(sessionRequests)) {
      assert.equal(response.status, 201)
    }

    const [localSessionRecord, remoteSessionRecord] = await Promise.all([
      waitFor(async () => {
        const response = await fetch(`${server.url}/api/sessions/session-local`, {
          headers: {
            authorization: 'Bearer operator-secret',
          },
        })
        assert.equal(response.status, 200)
        const record = (await readJson(response)).data as {
          id: string
          hostId: string
          runtimeHostId: string
          state: string
          logs: Array<{ message: string }>
          output: Array<{ text: string }>
        }
        return record.state === 'completed' ? record : undefined
      }),
      waitFor(async () => {
        const response = await fetch(`${server.url}/api/sessions/session-remote`, {
          headers: {
            authorization: 'Bearer operator-secret',
          },
        })
        assert.equal(response.status, 200)
        const record = (await readJson(response)).data as {
          id: string
          hostId: string
          runtimeHostId: string
          state: string
          logs: Array<{ message: string }>
          output: Array<{ text: string }>
        }
        return record.state === 'completed' ? record : undefined
      }),
    ])

    assert.ok(localSessionRecord)
    assert.ok(remoteSessionRecord)
    assert.equal(localSessionRecord.hostId, 'local-attached')
    assert.equal(localSessionRecord.runtimeHostId, 'local-attached')
    assert.equal(remoteSessionRecord.hostId, 'remote-host')
    assert.equal(remoteSessionRecord.runtimeHostId, 'remote-host')
    assert.deepEqual(
      localSessionRecord.logs.map((entry) => entry.message),
      remoteSessionRecord.logs.map((entry) => entry.message),
    )
    assert.deepEqual(
      localSessionRecord.output.map((entry) => entry.text),
      remoteSessionRecord.output.map((entry) => entry.text),
    )
  } finally {
    await server.close()
  }
})

test('control plane persists hosts, workspaces, sessions, approvals, notifications, and forwarded ports across restart', async () => {
  const tempDir = await createTempDir()
  const configFile = join(tempDir, 'control-plane.config.json')
  const dataFile = join(tempDir, 'control-plane-state.json')
  const repositoryPath = await createGitRepository(tempDir, 'persisted-repo')

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
    const hostResponse = await fetch(`${firstServer.url}/api/hosts`, {
      method: 'POST',
      headers: bootstrapHeaders('config-bootstrap-secret'),
      body: JSON.stringify({
        id: 'host-1',
        name: 'devbox',
        platform: 'linux',
        runtimeVersion: '0.1.0',
        status: 'online',
      }),
    })
    assert.equal(hostResponse.status, 201)

    const workspaceResponse = await fetch(`${firstServer.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('config-operator-secret'),
      body: JSON.stringify({
        id: 'workspace-1',
        hostId: 'host-1',
        path: repositoryPath,
        runtimeHostId: 'host-1',
      }),
    })
    assert.equal(workspaceResponse.status, 201)

    const sessionResponse = await fetch(`${firstServer.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('config-operator-secret'),
      body: JSON.stringify({
        id: 'session-1',
        workspaceId: 'workspace-1',
        provider: 'codex',
      }),
    })
    assert.equal(sessionResponse.status, 201)

    const requests = [
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
    auditLog: unknown[]
    notifications: unknown[]
    forwardedPorts: unknown[]
  }

  assert.equal(persistedState.version, 1)
  assert.equal(persistedState.hosts.length, 1)
  assert.equal(persistedState.workspaces.length, 1)
  assert.equal(persistedState.sessions.length, 1)
  assert.equal(persistedState.approvals.length, 1)
  assert.equal(persistedState.auditLog.length, 0)
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
      assert.equal(
        ((await readJson(response)).data as unknown[]).length,
        1,
        `${key} should survive restart`,
      )
    }
  } finally {
    await restartedServer.close()
  }
})

test('control plane forwards ports with filtered active listings, managed URLs, visibility controls, and expiration', async () => {
  const tempDir = await createTempDir()
  const dataFile = join(tempDir, 'state.json')
  const repositoryPath = await createGitRepository(tempDir)
  const previewServer = await createPreviewServer()
  const server = await startControlPlaneServer({
    port: 0,
    dataFile,
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    runtimeProviderAdapters: [createCodexProviderAdapter()],
  })

  try {
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
        path: repositoryPath,
        runtimeHostId: 'host-1',
      }),
    })
    assert.equal(workspaceResponse.status, 201)

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

    const sharedPortResponse = await fetch(`${server.url}/api/ports`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'preview-shared',
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        port: previewServer.port,
        protocol: 'http',
        visibility: 'shared',
        label: 'Shared Preview',
        targetHost: '127.0.0.1',
      }),
    })
    assert.equal(sharedPortResponse.status, 201)
    const sharedPort = (await readJson(sharedPortResponse)).data as {
      managedUrl: string
      forwardingState: string
      workspaceId: string
      sessionId: string
    }
    assert.equal(sharedPort.forwardingState, 'open')
    assert.equal(sharedPort.workspaceId, 'workspace-1')
    assert.equal(sharedPort.sessionId, 'session-1')
    assert.equal(sharedPort.managedUrl, `${server.url}/ports/preview-shared`)

    const privatePortResponse = await fetch(`${server.url}/api/ports`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'preview-private',
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        port: previewServer.port,
        protocol: 'http',
        visibility: 'private',
        label: 'Private Preview',
        targetHost: '127.0.0.1',
      }),
    })
    assert.equal(privatePortResponse.status, 201)
    const privatePort = (await readJson(privatePortResponse)).data as {
      managedUrl: string
      visibility: string
    }
    assert.equal(privatePort.visibility, 'private')

    const tcpPortResponse = await fetch(`${server.url}/api/ports`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'postgres-1',
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        port: 5432,
        protocol: 'tcp',
        visibility: 'private',
        label: 'Postgres',
        targetHost: '127.0.0.1',
      }),
    })
    assert.equal(tcpPortResponse.status, 201)
    const tcpPort = (await readJson(tcpPortResponse)).data as {
      protocol: string
      managedUrl?: string
    }
    assert.equal(tcpPort.protocol, 'tcp')
    assert.equal(tcpPort.managedUrl, undefined)

    const workspacePortsResponse = await fetch(
      `${server.url}/api/ports?workspaceId=workspace-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(workspacePortsResponse.status, 200)
    const workspacePorts = (await readJson(workspacePortsResponse))
      .data as Array<{ id: string }>
    assert.deepEqual(workspacePorts.map((entry) => entry.id).sort(), [
      'postgres-1',
      'preview-private',
      'preview-shared',
    ])

    const sessionPortsResponse = await fetch(
      `${server.url}/api/ports?sessionId=session-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(sessionPortsResponse.status, 200)
    const sessionPorts = (await readJson(sessionPortsResponse)).data as Array<{
      id: string
    }>
    assert.deepEqual(sessionPorts.map((entry) => entry.id).sort(), [
      'postgres-1',
      'preview-private',
      'preview-shared',
    ])

    const sharedPreviewResponse = await fetch(
      `${sharedPort.managedUrl}/nested/path?source=shared`,
    )
    assert.equal(sharedPreviewResponse.status, 200)
    assert.equal(
      await sharedPreviewResponse.text(),
      'preview:/nested/path?source=shared',
    )

    const privatePreviewUnauthorized = await fetch(
      `${privatePort.managedUrl}/private`,
    )
    assert.equal(privatePreviewUnauthorized.status, 401)

    const privatePreviewAuthorized = await fetch(
      `${privatePort.managedUrl}/private`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(privatePreviewAuthorized.status, 200)
    assert.equal(await privatePreviewAuthorized.text(), 'preview:/private')

    const closePortResponse = await fetch(
      `${server.url}/api/ports/preview-shared/close`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
      },
    )
    assert.equal(closePortResponse.status, 200)
    assert.equal(
      ((await readJson(closePortResponse)).data as { forwardingState: string })
        .forwardingState,
      'closed',
    )

    const activePortsAfterCloseResponse = await fetch(
      `${server.url}/api/ports?workspaceId=workspace-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(activePortsAfterCloseResponse.status, 200)
    const activePortsAfterClose = (
      await readJson(activePortsAfterCloseResponse)
    ).data as Array<{ id: string }>
    assert.deepEqual(activePortsAfterClose.map((entry) => entry.id).sort(), [
      'postgres-1',
      'preview-private',
    ])

    const closedManagedUrlResponse = await fetch(sharedPort.managedUrl)
    assert.equal(closedManagedUrlResponse.status, 409)

    const reopenPortResponse = await fetch(
      `${server.url}/api/ports/preview-shared/open`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
      },
    )
    assert.equal(reopenPortResponse.status, 200)
    assert.equal(
      ((await readJson(reopenPortResponse)).data as { forwardingState: string })
        .forwardingState,
      'open',
    )

    const expiringPortResponse = await fetch(`${server.url}/api/ports`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'preview-expiring',
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        port: previewServer.port,
        protocol: 'http',
        visibility: 'shared',
        label: 'Expiring Preview',
        targetHost: '127.0.0.1',
      }),
    })
    assert.equal(expiringPortResponse.status, 201)

    const expiresAt = new Date(Date.now() - 60_000).toISOString()
    const markExpiringResponse = await fetch(
      `${server.url}/api/ports/preview-expiring/open`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({ expiresAt }),
      },
    )
    assert.equal(markExpiringResponse.status, 200)

    const allPortsResponse = await fetch(
      `${server.url}/api/ports?workspaceId=workspace-1&includeInactive=true`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(allPortsResponse.status, 200)
    const allPorts = (await readJson(allPortsResponse)).data as Array<{
      id: string
      forwardingState: string
      expiredAt?: string
    }>
    const expiredPort = allPorts.find(
      (entry) => entry.id === 'preview-expiring',
    )
    assert.ok(expiredPort)
    assert.equal(expiredPort.forwardingState, 'expired')
    assert.equal(typeof expiredPort.expiredAt, 'string')

    const activePortsAfterExpireResponse = await fetch(
      `${server.url}/api/ports?sessionId=session-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(activePortsAfterExpireResponse.status, 200)
    const activePortsAfterExpire = (
      await readJson(activePortsAfterExpireResponse)
    ).data as Array<{ id: string }>
    assert.deepEqual(activePortsAfterExpire.map((entry) => entry.id).sort(), [
      'postgres-1',
      'preview-private',
      'preview-shared',
    ])

    const expiredManagedUrlResponse = await fetch(
      `${server.url}/ports/preview-expiring`,
    )
    assert.equal(expiredManagedUrlResponse.status, 410)
  } finally {
    await server.close()
    await previewServer.close()
  }
})

test('control plane auto-detects common development ports and promotes them into managed forwards', async () => {
  const tempDir = await createTempDir()
  const dataFile = join(tempDir, 'state.json')
  const repositoryPath = await createGitRepository(tempDir)
  const detectedPortNumber = await findAvailablePort([5173, 4173, 8787, 4321])
  const server = await startControlPlaneServer({
    port: 0,
    dataFile,
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    runtimeProviderAdapters: [
      createCodexProviderAdapter({
        stepDelayMs: 300,
      }),
    ],
  })

  const detectedServer = await startWorkspaceDevelopmentServer(
    repositoryPath,
    detectedPortNumber,
  )

  try {
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
        path: repositoryPath,
        runtimeHostId: 'host-1',
      }),
    })
    assert.equal(workspaceResponse.status, 201)

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

    const detectedPort = await waitFor(async () => {
      const detectedResponse = await fetch(
        `${server.url}/api/ports?sessionId=session-1&includeDetected=true`,
        {
          headers: {
            authorization: 'Bearer operator-secret',
          },
        },
      )
      assert.equal(detectedResponse.status, 200)
      const detectedPorts = (await readJson(detectedResponse)).data as Array<{
        id: string
        port: number
        state: string
        sessionId?: string
        workspaceId?: string
        label: string
        managedUrl?: string
      }>
      const match = detectedPorts.find((entry) => entry.port === detectedPortNumber)
      assert.ok(match)
      assert.equal(match.state, 'detected')
      assert.equal(match.sessionId, 'session-1')
      assert.equal(match.workspaceId, 'workspace-1')
      assert.equal(match.label, getExpectedDetectedLabel(detectedPortNumber))
      assert.equal(match.managedUrl, undefined)
      return match
    })

    const promotedResponse = await fetch(
      `${server.url}/api/ports/${detectedPort.id}/open`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          visibility: 'shared',
        }),
      },
    )
    assert.equal(promotedResponse.status, 200)
    const promotedPort = (await readJson(promotedResponse)).data as {
      id: string
      state: string
      forwardingState: string
      visibility: string
      sessionId?: string
      workspaceId?: string
      managedUrl?: string
    }
    assert.equal(promotedPort.id, detectedPort.id)
    assert.equal(promotedPort.state, 'forwarded')
    assert.equal(promotedPort.forwardingState, 'open')
    assert.equal(promotedPort.visibility, 'shared')
    assert.equal(promotedPort.sessionId, 'session-1')
    assert.equal(promotedPort.workspaceId, 'workspace-1')
    assert.equal(typeof promotedPort.managedUrl, 'string')

    const promotedManagedUrlResponse = await fetch(
      `${promotedPort.managedUrl}/preview`,
    )
    assert.equal(promotedManagedUrlResponse.status, 200)
    assert.equal(
      await promotedManagedUrlResponse.text(),
      'detected-preview:/preview',
    )

    const forwardedPortsResponse = await fetch(
      `${server.url}/api/ports?sessionId=session-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(forwardedPortsResponse.status, 200)
    const forwardedPorts = (await readJson(forwardedPortsResponse)).data as Array<{
      id: string
      state: string
    }>
    assert.equal(
      forwardedPorts.some(
        (entry) => entry.id === detectedPort.id && entry.state === 'forwarded',
      ),
      true,
    )
  } finally {
    await detectedServer.close()
    await server.close()
  }
})

test('control plane runs approval requests through client decisions, audit logging, and session outcomes', async () => {
  const tempDir = await createTempDir()
  const dataFile = join(tempDir, 'state.json')
  const repositoryPath = await createGitRepository(tempDir)
  const server = await startControlPlaneServer({
    port: 0,
    dataFile,
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    runtimeProviderAdapters: [
      createCodexProviderAdapter({
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

  const approvalClient = createApprovalClient({
    baseUrl: server.url,
    token: 'operator-secret',
  })

  try {
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
        path: repositoryPath,
        runtimeHostId: 'host-1',
      }),
    })
    assert.equal(workspaceResponse.status, 201)

    const eventStream = await openEventStream(server.url, 'operator-secret')

    const approvedSessionResponse = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'session-approved',
        workspaceId: 'workspace-1',
        provider: 'codex',
      }),
    })
    assert.equal(approvedSessionResponse.status, 201)

    const approvalRequestedEvent = await eventStream.nextEvent((event) => {
      const payload = event.envelope.payload as { sessionId?: string }
      return (
        event.envelope.type === 'approval.requested' &&
        payload.sessionId === 'session-approved'
      )
    })
    const requestedApproval = approvalRequestedEvent.envelope.payload as {
      id: string
      sessionId: string
      status: string
    }
    assert.equal(requestedApproval.status, 'pending')

    const pendingApprovals = await approvalClient.listApprovals()
    assert.equal(
      pendingApprovals.some(
        (entry) =>
          entry.id === requestedApproval.id && entry.status === 'pending',
      ),
      true,
    )

    const approvedDecision = await approvalClient.decideApproval(
      requestedApproval.id,
      'approved',
    )
    assert.equal(approvedDecision.status, 'approved')

    await eventStream.nextEvent((event) => {
      const payload = event.envelope.payload as {
        session?: { id?: string; state?: string }
      }
      return (
        event.envelope.type === 'session.state.changed' &&
        payload.session?.id === 'session-approved' &&
        payload.session.state === 'completed'
      )
    })

    const approvedSession = await fetch(
      `${server.url}/api/sessions/session-approved`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(approvedSession.status, 200)
    const approvedSessionRecord = (await readJson(approvedSession)).data as {
      state: string
      logs: Array<{ message: string }>
    }
    assert.equal(approvedSessionRecord.state, 'completed')
    assert.equal(
      approvedSessionRecord.logs.some((entry) =>
        entry.message.includes(
          'Approved privileged action "sudo apt install ripgrep".',
        ),
      ),
      true,
    )

    const rejectedSessionResponse = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'session-rejected',
        workspaceId: 'workspace-1',
        provider: 'codex',
      }),
    })
    assert.equal(rejectedSessionResponse.status, 201)

    const rejectionRequestedEvent = await eventStream.nextEvent((event) => {
      const payload = event.envelope.payload as { sessionId?: string }
      return (
        event.envelope.type === 'approval.requested' &&
        payload.sessionId === 'session-rejected'
      )
    })
    const rejectedApproval = rejectionRequestedEvent.envelope.payload as {
      id: string
    }

    const rejectedDecision = await approvalClient.decideApproval(
      rejectedApproval.id,
      'rejected',
    )
    assert.equal(rejectedDecision.status, 'rejected')

    await eventStream.nextEvent((event) => {
      const payload = event.envelope.payload as {
        session?: { id?: string; state?: string }
      }
      return (
        event.envelope.type === 'session.state.changed' &&
        payload.session?.id === 'session-rejected' &&
        payload.session.state === 'failed'
      )
    })

    const rejectedSession = await fetch(
      `${server.url}/api/sessions/session-rejected`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(rejectedSession.status, 200)
    const rejectedSessionRecord = (await readJson(rejectedSession)).data as {
      state: string
      logs: Array<{ level: string; message: string }>
    }
    assert.equal(rejectedSessionRecord.state, 'failed')
    assert.equal(
      rejectedSessionRecord.logs.some(
        (entry) =>
          entry.level === 'error' &&
          entry.message.includes('was rejected by the operator'),
      ),
      true,
    )

    await eventStream.close()

    const persistedState = JSON.parse(await readFile(dataFile, 'utf8')) as {
      approvals: Array<{ id: string; status: string; decidedAt?: string }>
      auditLog: Array<{ targetId: string; outcome: string; action: string }>
    }
    assert.equal(
      persistedState.approvals.some(
        (entry) =>
          entry.id === requestedApproval.id &&
          entry.status === 'approved' &&
          Boolean(entry.decidedAt),
      ),
      true,
    )
    assert.equal(
      persistedState.approvals.some(
        (entry) =>
          entry.id === rejectedApproval.id &&
          entry.status === 'rejected' &&
          Boolean(entry.decidedAt),
      ),
      true,
    )
    assert.equal(
      persistedState.auditLog.some(
        (entry) =>
          entry.targetId === requestedApproval.id &&
          entry.outcome === 'approved' &&
          entry.action === 'approval.approved',
      ),
      true,
    )
    assert.equal(
      persistedState.auditLog.some(
        (entry) =>
          entry.targetId === rejectedApproval.id &&
          entry.outcome === 'rejected' &&
          entry.action === 'approval.rejected',
      ),
      true,
    )
  } finally {
    await server.close()
  }
})

test('control plane registers git workspaces and supports list, inspect, and remove', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createGitRepository(tempDir)
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    const hostRegistration = await fetch(`${server.url}/api/hosts`, {
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
    assert.equal(hostRegistration.status, 201)

    const createWorkspace = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-1',
        hostId: 'host-1',
        path: repositoryPath,
      }),
    })

    assert.equal(createWorkspace.status, 201)
    const createdWorkspace = (await readJson(createWorkspace)).data as {
      id: string
      hostId: string
      path: string
      defaultBranch: string
      runtimeHostId: string
    }
    assert.equal(createdWorkspace.id, 'workspace-1')
    assert.equal(createdWorkspace.hostId, 'host-1')
    assert.equal(createdWorkspace.path, repositoryPath)
    assert.equal(createdWorkspace.defaultBranch, 'main')
    assert.equal(createdWorkspace.runtimeHostId, 'host-1')

    const listedWorkspaces = await fetch(`${server.url}/api/workspaces`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })
    assert.equal(listedWorkspaces.status, 200)
    assert.equal(
      ((await readJson(listedWorkspaces)).data as unknown[]).length,
      1,
    )

    const inspectedWorkspace = await fetch(
      `${server.url}/api/workspaces/workspace-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(inspectedWorkspace.status, 200)
    assert.equal(
      ((await readJson(inspectedWorkspace)).data as { id: string }).id,
      'workspace-1',
    )

    const removedWorkspace = await fetch(
      `${server.url}/api/workspaces/workspace-1`,
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(removedWorkspace.status, 200)
    assert.equal(
      ((await readJson(removedWorkspace)).data as { id: string }).id,
      'workspace-1',
    )

    const emptyWorkspaces = await fetch(`${server.url}/api/workspaces`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })
    assert.equal(emptyWorkspaces.status, 200)
    assert.deepEqual((await readJson(emptyWorkspaces)).data, [])
  } finally {
    await server.close()
  }
})

test('control plane rejects workspaces for missing hosts and inaccessible git paths', async () => {
  const tempDir = await createTempDir()
  const missingRepositoryPath = join(tempDir, 'missing-repo')
  const nonRepositoryPath = join(tempDir, 'not-a-repo')
  await mkdir(nonRepositoryPath, { recursive: true })
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    const hostRegistration = await fetch(`${server.url}/api/hosts`, {
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
    assert.equal(hostRegistration.status, 201)

    const missingHost = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-missing-host',
        hostId: 'host-404',
        path: missingRepositoryPath,
      }),
    })
    assert.equal(missingHost.status, 400)
    assert.equal(
      (await readJson(missingHost)).error,
      '"hostId" must reference a registered host.',
    )

    const missingRepository = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-missing-repo',
        hostId: 'host-1',
        path: missingRepositoryPath,
      }),
    })
    assert.equal(missingRepository.status, 400)
    assert.equal(
      (await readJson(missingRepository)).error,
      `Repository path "${missingRepositoryPath}" does not exist or is not accessible.`,
    )

    const invalidRepository = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-not-git',
        hostId: 'host-1',
        path: nonRepositoryPath,
      }),
    })
    assert.equal(invalidRepository.status, 400)
    assert.equal(
      (await readJson(invalidRepository)).error,
      `Repository path "${nonRepositoryPath}" is not an accessible git repository.`,
    )
  } finally {
    await server.close()
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
    const eventPromise = waitForEvent(
      server.url,
      'operator-secret',
      (event) => event.envelope.type === 'notification.created',
    )

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
    assert.equal(
      (event.envelope.payload as { id: string }).id,
      'notification-1',
    )
  } finally {
    await server.close()
  }
})

test('control plane starts managed sessions, streams runtime events, supports pause resume cancel, and recovers state after reconnect', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createGitRepository(tempDir, 'session-repo')
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    const hostRegistration = await fetch(`${server.url}/api/hosts`, {
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
    assert.equal(hostRegistration.status, 201)

    const workspaceRegistration = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-1',
        hostId: 'host-1',
        path: repositoryPath,
      }),
    })
    assert.equal(workspaceRegistration.status, 201)

    const firstStream = await openEventStream(server.url, 'operator-secret')
    await firstStream.nextEvent(
      (event) => event.envelope.type === 'session.snapshot',
    )

    const createSession = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'session-1',
        workspaceId: 'workspace-1',
        provider: 'codex',
      }),
    })
    assert.equal(createSession.status, 201)
    const createdSession = (await readJson(createSession)).data as {
      state: string
      mode: string
      workspacePath: string
      executionPath: string
      worktree?: unknown
    }
    assert.equal(createdSession.state, 'queued')
    assert.equal(createdSession.mode, 'workspace')
    assert.equal(createdSession.workspacePath, repositoryPath)
    assert.equal(createdSession.executionPath, repositoryPath)
    assert.equal(createdSession.worktree, undefined)

    const runningEvent = await firstStream.nextEvent((event) => {
      return (
        event.envelope.type === 'session.state.changed' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.id === 'session-1' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.state === 'running'
      )
    })
    assert.equal(
      (runningEvent.envelope.payload as { session: { state: string } }).session
        .state,
      'running',
    )

    const logEvent = await firstStream.nextEvent((event) => {
      return (
        event.envelope.type === 'session.log' &&
        (event.envelope.payload as { sessionId: string }).sessionId ===
          'session-1'
      )
    })
    assert.equal(
      (logEvent.envelope.payload as { sessionId: string }).sessionId,
      'session-1',
    )

    const outputEvent = await firstStream.nextEvent((event) => {
      return (
        event.envelope.type === 'session.output' &&
        (event.envelope.payload as { sessionId: string }).sessionId ===
          'session-1'
      )
    })
    assert.equal(
      (outputEvent.envelope.payload as { sessionId: string }).sessionId,
      'session-1',
    )

    const pauseSession = await fetch(
      `${server.url}/api/sessions/session-1/pause`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
      },
    )
    assert.equal(pauseSession.status, 200)
    assert.equal(
      ((await readJson(pauseSession)).data as { state: string }).state,
      'paused',
    )

    const pausedEvent = await firstStream.nextEvent((event) => {
      return (
        event.envelope.type === 'session.state.changed' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.id === 'session-1' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.state === 'paused'
      )
    })
    assert.equal(
      (pausedEvent.envelope.payload as { session: { state: string } }).session
        .state,
      'paused',
    )

    const pausedSession = await fetch(`${server.url}/api/sessions/session-1`, {
      headers: {
        authorization: 'Bearer operator-secret',
      },
    })
    assert.equal(pausedSession.status, 200)
    const pausedSessionState = (await readJson(pausedSession)).data as {
      state: string
      logs: unknown[]
      output: unknown[]
    }
    assert.equal(pausedSessionState.state, 'paused')
    assert.ok(pausedSessionState.logs.length >= 1)
    assert.ok(pausedSessionState.output.length >= 1)

    await firstStream.close()

    const resumeSession = await fetch(
      `${server.url}/api/sessions/session-1/resume`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
      },
    )
    assert.equal(resumeSession.status, 200)
    assert.equal(
      ((await readJson(resumeSession)).data as { state: string }).state,
      'running',
    )

    const replayStream = await openEventStream(
      server.url,
      'operator-secret',
      pausedEvent.id,
    )
    const replayedRunningEvent = await replayStream.nextEvent((event) => {
      return (
        event.envelope.type === 'session.state.changed' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.id === 'session-1' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.state === 'running'
      )
    })
    assert.equal(
      (replayedRunningEvent.envelope.payload as { session: { state: string } })
        .session.state,
      'running',
    )

    const cancelSession = await fetch(
      `${server.url}/api/sessions/session-1/cancel`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
      },
    )
    assert.equal(cancelSession.status, 200)
    assert.equal(
      ((await readJson(cancelSession)).data as { state: string }).state,
      'canceled',
    )

    const canceledEvent = await replayStream.nextEvent((event) => {
      return (
        event.envelope.type === 'session.state.changed' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.id === 'session-1' &&
        (event.envelope.payload as { session: { id: string; state: string } })
          .session.state === 'canceled'
      )
    })
    assert.equal(
      (canceledEvent.envelope.payload as { session: { state: string } }).session
        .state,
      'canceled',
    )
    await replayStream.close()

    const canceledSession = await fetch(
      `${server.url}/api/sessions/session-1`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(canceledSession.status, 200)
    const canceledSessionState = (await readJson(canceledSession)).data as {
      state: string
      logs: unknown[]
      output: unknown[]
    }
    assert.equal(canceledSessionState.state, 'canceled')
    assert.ok(canceledSessionState.logs.length >= 2)
    assert.ok(canceledSessionState.output.length >= 1)
  } finally {
    await server.close()
  }
})

test('control plane can start sessions in isolated worktrees and rejects dirty repositories unless explicitly allowed', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createGitRepository(tempDir, 'worktree-repo')
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  try {
    const hostRegistration = await fetch(`${server.url}/api/hosts`, {
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
    assert.equal(hostRegistration.status, 201)

    const workspaceRegistration = await fetch(`${server.url}/api/workspaces`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'workspace-1',
        hostId: 'host-1',
        path: repositoryPath,
      }),
    })
    assert.equal(workspaceRegistration.status, 201)

    await writeFile(
      join(repositoryPath, 'dirty.txt'),
      'pending change\n',
      'utf8',
    )

    const rejectedDirtySession = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'session-dirty-rejected',
        workspaceId: 'workspace-1',
        provider: 'codex',
        mode: 'worktree',
      }),
    })
    assert.equal(rejectedDirtySession.status, 400)
    assert.match(
      (await readJson(rejectedDirtySession)).error ?? '',
      /allowDirtyWorkspace/,
    )

    const allowedDirtySession = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'session-worktree',
        workspaceId: 'workspace-1',
        provider: 'codex',
        mode: 'worktree',
        allowDirtyWorkspace: true,
      }),
    })
    assert.equal(allowedDirtySession.status, 201)

    const createdSession = (await readJson(allowedDirtySession)).data as {
      id: string
      mode: string
      workspacePath: string
      executionPath: string
      allowDirtyWorkspace: boolean
      worktree?: {
        path: string
        branch: string
        baseBranch: string
        createdAt: string
      }
    }
    assert.equal(createdSession.id, 'session-worktree')
    assert.equal(createdSession.mode, 'worktree')
    assert.equal(createdSession.workspacePath, repositoryPath)
    assert.notEqual(createdSession.executionPath, repositoryPath)
    assert.equal(createdSession.allowDirtyWorkspace, true)
    assert.ok(createdSession.worktree)
    assert.equal(createdSession.worktree?.path, createdSession.executionPath)
    assert.equal(createdSession.worktree?.baseBranch, 'main')
    assert.match(
      createdSession.worktree?.branch ?? '',
      /^workspace-1-session-worktree$/,
    )
    await access(createdSession.executionPath)

    const listedWorktrees = await execFileAsync('git', [
      '-C',
      repositoryPath,
      'worktree',
      'list',
      '--porcelain',
    ])
    assert.match(
      listedWorktrees.stdout,
      new RegExp(
        createdSession.executionPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    )

    const persistedSession = await fetch(
      `${server.url}/api/sessions/session-worktree`,
      {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      },
    )
    assert.equal(persistedSession.status, 200)
    const persisted = (await readJson(persistedSession)).data as {
      executionPath: string
      worktree?: {
        path: string
      }
    }
    assert.equal(persisted.executionPath, createdSession.executionPath)
    assert.equal(persisted.worktree?.path, createdSession.worktree?.path)
  } finally {
    await server.close()
  }
})
