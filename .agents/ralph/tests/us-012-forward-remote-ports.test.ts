import assert from 'node:assert/strict'
import test from 'node:test'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

test('US-012 forwards remote ports with lifecycle controls, filters, managed URLs, and visibility modes', async () => {
  let now = '2026-03-16T12:00:00.000Z'

  const handle = await startControlPlaneHttpServer({
    clock: () => now,
  })

  try {
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
      repositoryPath: process.cwd(),
      defaultBranch: 'main',
      runtimeLabel: 'runtime-primary',
    })
    await postJson(handle.origin, '/v1/sessions', {
      id: 'session_alpha',
      hostId: 'host_primary',
      workspaceId: 'workspace_app',
      provider: 'codex',
    })

    const privateHttpPort = await postJson<{
      protocol: string
      status: string
      managedUrl?: string
    }>(handle.origin, '/v1/ports', {
      id: 'port_preview_private',
      hostId: 'host_primary',
      workspaceId: 'workspace_app',
      sessionId: 'session_alpha',
      localPort: 3000,
      targetPort: 3000,
      protocol: 'http',
      visibility: 'private',
      label: 'Preview',
    })
    assert.equal(privateHttpPort.data.protocol, 'http')
    assert.equal(privateHttpPort.data.status, 'open')
    assert.equal(privateHttpPort.data.managedUrl, 'http://private-port_preview_private.ports.remote-agent.local')

    const sharedTcpPort = await postJson<{
      protocol: string
      managedUrl?: string
    }>(handle.origin, '/v1/ports', {
      id: 'port_debug_shared',
      hostId: 'host_primary',
      workspaceId: 'workspace_app',
      localPort: 9229,
      targetPort: 9229,
      protocol: 'tcp',
      visibility: 'shared',
      label: 'Node Inspector',
    })
    assert.equal(sharedTcpPort.data.protocol, 'tcp')
    assert.equal(sharedTcpPort.data.managedUrl, undefined)

    const sharedHttpsPort = await postJson<{
      protocol: string
      managedUrl?: string
    }>(handle.origin, '/v1/ports', {
      id: 'port_docs_shared',
      hostId: 'host_primary',
      workspaceId: 'workspace_app',
      localPort: 8443,
      targetPort: 8443,
      protocol: 'https',
      visibility: 'shared',
      label: 'Docs',
      expiresAt: '2026-03-16T12:30:00.000Z',
    })
    assert.equal(sharedHttpsPort.data.protocol, 'https')
    assert.equal(sharedHttpsPort.data.managedUrl, 'https://shared-port_docs_shared.ports.remote-agent.local')

    const sessionPorts = await getJson<Array<{ id: string }>>(handle.origin, '/v1/ports?sessionId=session_alpha&activeOnly=true')
    assert.deepEqual(
      sessionPorts.data.map((port) => port.id),
      ['port_preview_private'],
    )

    const workspacePorts = await getJson<Array<{ id: string }>>(handle.origin, '/v1/forwarded-ports?workspaceId=workspace_app&activeOnly=true')
    assert.deepEqual(
      workspacePorts.data.map((port) => port.id).sort(),
      ['port_debug_shared', 'port_docs_shared', 'port_preview_private'],
    )

    const closedPort = await patchJson<{ status: string }>(handle.origin, '/v1/ports/port_preview_private', {
      action: 'close',
    })
    assert.equal(closedPort.data.status, 'closed')

    const reopenedPort = await patchJson<{ status: string }>(handle.origin, '/v1/ports/port_preview_private', {
      action: 'open',
    })
    assert.equal(reopenedPort.data.status, 'open')

    const expiredPort = await patchJson<{ status: string }>(handle.origin, '/v1/ports/port_preview_private', {
      action: 'expire',
    })
    assert.equal(expiredPort.data.status, 'expired')

    now = '2026-03-16T13:00:00.000Z'

    const autoExpiredPort = await getJson<{ status: string }>(handle.origin, '/v1/ports/port_docs_shared')
    assert.equal(autoExpiredPort.data.status, 'expired')

    const activeWorkspacePorts = await getJson<Array<{ id: string }>>(handle.origin, '/v1/ports?workspaceId=workspace_app&activeOnly=true')
    assert.deepEqual(
      activeWorkspacePorts.data.map((port) => port.id),
      ['port_debug_shared'],
    )

    const expiredPorts = await getJson<Array<{ id: string }>>(handle.origin, '/v1/ports?workspaceId=workspace_app&status=expired')
    assert.deepEqual(
      expiredPorts.data.map((port) => port.id).sort(),
      ['port_docs_shared', 'port_preview_private'],
    )
  } finally {
    await handle.close()
  }
})

async function getJson<T>(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: T }
}

async function postJson<T>(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 201)
  return (await response.json()) as { data: T }
}

async function patchJson<T>(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'PATCH',
    headers: operatorHeaders,
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: T }
}
