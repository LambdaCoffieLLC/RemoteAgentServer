import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { startControlPlaneServer } from '../apps/server/src/index.js'

const repoRoot = resolve(import.meta.dirname, '..')
const runtimePackageRoot = join(repoRoot, 'packages/runtime')
const installerPath = join(runtimePackageRoot, 'scripts/install-linux-runtime.sh')
const execFileAsync = promisify(execFile)

let runtimeBuilt = false

async function createTempDir() {
  return mkdtemp(join(tmpdir(), 'remote-agent-server-runtime-install-'))
}

function ensureRuntimeBuilt() {
  if (runtimeBuilt) {
    return
  }

  execFileSync('pnpm', ['--filter', '@remote-agent-server/runtime', 'build'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  runtimeBuilt = true
}

function operatorHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
  }
}

async function readJson<T>(response: Response) {
  return (await response.json()) as { data?: T; error?: string }
}

test('linux runtime installer is rerunnable and enrolls a host with version, health, and connectivity status', async () => {
  ensureRuntimeBuilt()

  const tempDir = await createTempDir()
  const installPrefix = join(tempDir, 'remote-runtime')
  const stateFile = join(installPrefix, 'var/runtime-state.json')
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'control-plane-state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
  })

  const installArguments = [
    installerPath,
    '--prefix',
    installPrefix,
    '--server-url',
    server.url,
    '--bootstrap-token',
    'bootstrap-secret',
    '--host-id',
    'linux-dev-1',
    '--host-name',
    'Linux Devbox',
    '--source-package-root',
    runtimePackageRoot,
  ]

  try {
    await execFileAsync('bash', installArguments, {
      cwd: repoRoot,
    })

    await execFileAsync('bash', installArguments, {
      cwd: repoRoot,
    })

    assert.equal(existsSync(join(installPrefix, 'bin/remote-agent-runtime-enroll')), true)
    assert.equal(existsSync(join(installPrefix, 'bin/remote-agent-runtime-status')), true)

    const envFileContents = await readFile(join(installPrefix, 'etc/remote-agent-runtime.env'), 'utf8')
    assert.match(envFileContents, /RAS_SERVER_URL=/)
    assert.match(envFileContents, /RAS_BOOTSTRAP_TOKEN=/)
    assert.match(envFileContents, /RAS_STATE_FILE=/)

    const enrollmentState = JSON.parse(
      (
        await execFileAsync(join(installPrefix, 'bin/remote-agent-runtime-enroll'), {
          cwd: repoRoot,
          encoding: 'utf8',
        })
      ).stdout,
    ) as {
      host: {
        id: string
        name: string
        runtimeVersion: string
        status: string
        health: string
        connectivity: string
      }
    }

    assert.equal(enrollmentState.host.id, 'linux-dev-1')
    assert.equal(enrollmentState.host.name, 'Linux Devbox')
    assert.equal(enrollmentState.host.runtimeVersion, '0.1.0')
    assert.equal(enrollmentState.host.status, 'online')
    assert.equal(enrollmentState.host.health, 'healthy')
    assert.equal(enrollmentState.host.connectivity, 'connected')

    const persistedState = JSON.parse(await readFile(stateFile, 'utf8')) as {
      host: {
        runtimeVersion: string
        health: string
        connectivity: string
      }
    }
    assert.equal(persistedState.host.runtimeVersion, '0.1.0')
    assert.equal(persistedState.host.health, 'healthy')
    assert.equal(persistedState.host.connectivity, 'connected')

    const statusState = JSON.parse(
      (
        await execFileAsync(join(installPrefix, 'bin/remote-agent-runtime-status'), {
          cwd: repoRoot,
          encoding: 'utf8',
        })
      ).stdout,
    ) as {
      host: {
        runtimeVersion: string
        health: string
        connectivity: string
      }
    }
    assert.equal(statusState.host.runtimeVersion, '0.1.0')
    assert.equal(statusState.host.health, 'healthy')
    assert.equal(statusState.host.connectivity, 'connected')

    await execFileAsync(join(installPrefix, 'bin/remote-agent-runtime-enroll'), {
      cwd: repoRoot,
    })

    const hostsResponse = await fetch(`${server.url}/api/hosts`, {
      headers: operatorHeaders('operator-secret'),
    })
    assert.equal(hostsResponse.status, 200)

    const hosts = ((await readJson<
      Array<{
        id: string
        runtimeVersion: string
        health: string
        connectivity: string
      }>
    >(hostsResponse)).data ?? []) as Array<{
      id: string
      runtimeVersion: string
      health: string
      connectivity: string
    }>

    assert.equal(hosts.length, 1)
    assert.equal(hosts[0]?.id, 'linux-dev-1')
    assert.equal(hosts[0]?.runtimeVersion, '0.1.0')
    assert.equal(hosts[0]?.health, 'healthy')
    assert.equal(hosts[0]?.connectivity, 'connected')
  } finally {
    await server.close()
  }
})
