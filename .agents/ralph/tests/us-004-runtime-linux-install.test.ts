import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startControlPlaneHttpServer } from '../../../apps/server/src/index.js'
import {
  enrollInstalledRuntime,
  installLinuxRuntime,
  renderLinuxInstallScript,
  reportInstalledRuntimeStatus,
} from '../../../apps/runtime/src/index.js'

const viewerHeaders = {
  authorization: 'Bearer control-plane-viewer',
}

test('US-004 installs a rerunnable Linux runtime that enrolls with a bootstrap token and reports status', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'remote-agent-server-us-004-'))
  const storagePath = join(tempDir, 'control-plane-state.json')
  const installRoot = join(tempDir, 'linux-host')
  const docsPath = join(process.cwd(), 'docs', 'runtime-linux-install.md')

  let handle: Awaited<ReturnType<typeof startControlPlaneHttpServer>> | undefined = await startControlPlaneHttpServer({
    bootstrapTokens: ['bootstrap-us-004'],
    storagePath,
  })

  try {
    const installDocs = readFileSync(docsPath, 'utf8')
    assert.match(installDocs, /Ubuntu\/Debian/i)
    assert.match(installDocs, /RHEL\/Fedora/i)
    assert.match(installDocs, /bootstrap token/i)
    assert.match(installDocs, /safe to rerun/i)

    const installScript = renderLinuxInstallScript({
      installRoot,
      serverOrigin: handle.origin,
      bootstrapToken: 'bootstrap-us-004',
    })
    assert.match(installScript, /safe to rerun/i)
    assert.match(installScript, /REMOTE_AGENT_BOOTSTRAP_TOKEN/)

    const firstInstall = await installLinuxRuntime({
      installRoot,
      serverOrigin: handle.origin,
      bootstrapToken: 'bootstrap-us-004',
      hostLabel: 'Primary Linux Host',
      runtimeLabel: 'Primary Runtime',
      hostname: 'ci-linux-01',
      version: '1.2.3',
    })
    assert.equal(firstInstall.wasAlreadyInstalled, false)

    const secondInstall = await installLinuxRuntime({
      installRoot,
      serverOrigin: handle.origin,
      bootstrapToken: 'bootstrap-us-004',
      hostLabel: 'Primary Linux Host',
      runtimeLabel: 'Primary Runtime',
      hostname: 'ci-linux-01',
      version: '1.2.3',
    })
    assert.equal(secondInstall.wasAlreadyInstalled, true)
    assert.equal(secondInstall.config.hostId, firstInstall.config.hostId)
    assert.equal(secondInstall.config.runtimeId, firstInstall.config.runtimeId)
    assert.equal(secondInstall.config.installedAt, firstInstall.config.installedAt)

    const firstEnrollment = await enrollInstalledRuntime({
      install: firstInstall,
    })
    assert.equal(firstEnrollment.statusCode, 201)

    const secondEnrollment = await enrollInstalledRuntime({
      install: secondInstall,
    })
    assert.equal(secondEnrollment.statusCode, 200)

    const statusReport = await reportInstalledRuntimeStatus({
      install: secondInstall,
      version: '1.2.4',
      health: 'degraded',
      connectivity: 'connected',
    })
    assert.equal(statusReport.statusCode, 200)
    assert.equal(statusReport.host.runtime?.version, '1.2.4')
    assert.equal(statusReport.host.runtime?.health, 'degraded')
    assert.equal(statusReport.host.runtime?.connectivity, 'connected')

    await assertRuntimeHostSnapshot(handle.origin)

    await handle.close()
    handle = undefined
    handle = await startControlPlaneHttpServer({
      bootstrapTokens: ['bootstrap-us-004'],
      storagePath,
    })

    await assertRuntimeHostSnapshot(handle.origin)
  } finally {
    if (handle) {
      await handle.close()
    }

    rmSync(tempDir, { recursive: true, force: true })
  }
})

async function assertRuntimeHostSnapshot(origin: string) {
  const response = await fetch(`${origin}/v1/hosts`, {
    headers: viewerHeaders,
  })

  assert.equal(response.status, 200)

  const payload = (await response.json()) as {
    data: Array<{
      id: string
      platform: string
      runtimeStatus: string
      runtime?: {
        version: string
        health: string
        connectivity: string
      }
    }>
  }

  assert.equal(payload.data.length, 1)
  assert.equal(payload.data[0].platform, 'linux')
  assert.equal(payload.data[0].runtimeStatus, 'degraded')
  assert.equal(payload.data[0].runtime?.version, '1.2.4')
  assert.equal(payload.data[0].runtime?.health, 'degraded')
  assert.equal(payload.data[0].runtime?.connectivity, 'connected')
}
