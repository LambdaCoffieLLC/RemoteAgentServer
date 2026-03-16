import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMobileControlPlaneClient } from '../../../apps/mobile/src/index.js'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'
import { detectRuntimePorts } from '../../../apps/runtime/src/index.js'
import { createWebControlPlaneClient } from '../../../apps/web/src/index.js'

const operatorHeaders = {
  authorization: 'Bearer control-plane-operator',
  'content-type': 'application/json',
}

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

test('US-013 auto-detects common development ports, surfaces them in clients, and promotes them into managed forwards', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-013-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const repositoryPath = join(tempDir, 'repositories', 'preview-app')

  initializeCommittedGitRepository(repositoryPath)

  const handle = await startControlPlaneHttpServer({ storagePath })

  try {
    await postCreatedJson(handle.origin, '/v1/hosts', {
      id: 'host_preview',
      label: 'Preview Host',
      platform: 'linux',
      runtimeStatus: 'online',
    })
    await postCreatedJson(handle.origin, '/v1/workspaces', {
      id: 'workspace_preview',
      hostId: 'host_preview',
      repositoryPath,
    })
    await postCreatedJson(handle.origin, '/v1/sessions', {
      id: 'session_preview',
      hostId: 'host_preview',
      workspaceId: 'workspace_preview',
      provider: 'codex',
      workspaceMode: 'direct',
    })

    const detectedPorts = await detectRuntimePorts({
      hostId: 'host_preview',
      clock: () => '2026-03-16T14:00:00.000Z',
      observations: [
        {
          hostId: 'host_preview',
          workspaceId: 'workspace_preview',
          sessionId: 'session_preview',
          localPort: 4173,
          command: 'vite --host 0.0.0.0',
        },
        {
          hostId: 'host_preview',
          workspaceId: 'workspace_preview',
          localPort: 9229,
          command: 'node --inspect',
        },
      ],
    })

    assert.equal(detectedPorts[0]?.label, 'Vite dev server')
    assert.equal(detectedPorts[0]?.protocol, 'http')
    assert.equal(detectedPorts[1]?.label, 'Node Inspector')
    assert.equal(detectedPorts[1]?.protocol, 'tcp')

    for (const detectedPort of detectedPorts) {
      await postCreatedJson(handle.origin, '/v1/detected-ports', {
        ...detectedPort,
      })
    }

    const forwardedPortsBeforePromotion = await getJson<Array<{ id: string }>>(handle.origin, '/v1/ports?workspaceId=workspace_preview')
    assert.deepEqual(forwardedPortsBeforePromotion.data, [])

    const workspaceDetectedPorts = await getJson<
      Array<{
        id: string
        label: string
        sessionId?: string
        workspaceId?: string
        forwardedPortId?: string
        managedUrl?: string
      }>
    >(handle.origin, '/v1/detected-ports?workspaceId=workspace_preview')
    assert.equal(workspaceDetectedPorts.data.length, 2)
    assert.equal(workspaceDetectedPorts.data[0]?.workspaceId, 'workspace_preview')
    assert.equal(workspaceDetectedPorts.data[0]?.sessionId, 'session_preview')
    assert.equal(workspaceDetectedPorts.data[0]?.label, 'Vite dev server')
    assert.equal('managedUrl' in (workspaceDetectedPorts.data[0] ?? {}), false)
    assert.equal(workspaceDetectedPorts.data[0]?.forwardedPortId, undefined)

    const webClient = createWebControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-operator',
    })
    const mobileClient = createMobileControlPlaneClient({
      baseUrl: handle.origin,
      token: 'control-plane-viewer',
    })

    const webDashboard = await webClient.signIn()
    const mobileDashboard = await mobileClient.signIn()
    assert.equal(webDashboard.detectedPorts.length, 2)
    assert.equal(mobileDashboard.detectedPorts.length, 2)
    assert.equal(webDashboard.detectedPorts.find((port) => port.localPort === 4173)?.label, 'Vite dev server')
    assert.equal(mobileDashboard.detectedPorts.find((port) => port.localPort === 9229)?.label, 'Node Inspector')

    const promotion = await webClient.promoteDetectedPort(detectedPorts[0]!.id, {
      forwardedPortId: 'port_preview_app',
      visibility: 'private',
    })
    assert.equal(promotion.detectedPort.forwardedPortId, 'port_preview_app')
    assert.equal(promotion.forwardedPort.managedUrl, 'http://private-port_preview_app.ports.remote-agent.local')

    const forwardedPortsAfterPromotion = await getJson<Array<{ id: string; managedUrl?: string }>>(
      handle.origin,
      '/v1/ports?workspaceId=workspace_preview',
    )
    assert.deepEqual(forwardedPortsAfterPromotion.data.map((port) => port.id), ['port_preview_app'])
    assert.equal(forwardedPortsAfterPromotion.data[0]?.managedUrl, 'http://private-port_preview_app.ports.remote-agent.local')

    const promotedDetectedPorts = await getJson<Array<{ id: string; forwardedPortId?: string }>>(
      handle.origin,
      '/v1/detected-ports?forwardedOnly=true&workspaceId=workspace_preview',
    )
    assert.deepEqual(
      promotedDetectedPorts.data.map((port) => ({
        id: port.id,
        forwardedPortId: port.forwardedPortId,
      })),
      [
      {
        id: detectedPorts[0]!.id,
        forwardedPortId: 'port_preview_app',
      },
      ],
    )

    const viewerDetectedPort = await fetch(`${handle.origin}/v1/detected-ports/${detectedPorts[0]!.id}`, {
      headers: viewerHeaders,
    })
    assert.equal(viewerDetectedPort.status, 200)
  } finally {
    await handle.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function initializeCommittedGitRepository(repositoryPath: string) {
  execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Remote Agent Tests'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'tests@example.com'], { stdio: 'ignore' })
  writeFileSync(join(repositoryPath, 'README.md'), '# preview app\n', 'utf8')
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' })
}

async function getJson<T>(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)
  return (await response.json()) as { data: T }
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
