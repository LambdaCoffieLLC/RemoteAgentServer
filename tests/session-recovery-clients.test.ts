import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import { MobileOperatorController } from '../apps/mobile/src/controller.js'
import { createMobileControlPlaneClient } from '../apps/mobile/src/client.js'
import { createMemoryConnectionSettingsStore } from '../apps/mobile/src/storage.js'
import type { PreviewOpener } from '../apps/mobile/src/types.js'
import { startControlPlaneServer } from '../apps/server/src/index.js'
import { renderWebClient } from '../apps/web/src/app.js'
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
  return await mkdtemp(join(tmpdir(), 'remote-agent-server-session-recovery-'))
}

async function createCommittedRepository(rootDir: string, repoName = 'repo') {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test User'])
  await writeFile(join(repositoryPath, 'README.md'), '# session recovery\n', 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'add', '.'])
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial state'])
  return repositoryPath
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
    : new Error('Timed out while waiting for session recovery assertions.')
}

function installDomGlobals(window: JSDOM['window']) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    Element: globalThis.Element,
    Event: globalThis.Event,
    FormData: globalThis.FormData,
    localStorage: globalThis.localStorage,
  }

  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Event: window.Event,
    FormData: window.FormData,
    localStorage: window.localStorage,
  })

  return () => {
    Object.assign(globalThis, previous)
  }
}

test('mobile and web clients can reopen the same persisted session with recovered logs and messages', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createCommittedRepository(tempDir)
  const settingsStore = createMemoryConnectionSettingsStore()
  const previewOpener: PreviewOpener = {
    async open() {
      throw new Error('Preview opening is not part of the session recovery test.')
    },
  }
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    runtimeProviderAdapters: [
      createCodexProviderAdapter({
        stepDelayMs: 20,
      }),
    ],
  })
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'http://web-client.test/',
  })
  const restoreGlobals = installDomGlobals(dom.window)

  const mobileController = new MobileOperatorController({
    createClient: (settings) =>
      createMobileControlPlaneClient({
        ...settings,
        fetch,
      }),
    previewOpener,
    settingsStore,
    reconnectDelayMs: 50,
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
        runtimeHostId: 'host-1',
        path: repositoryPath,
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

    await waitFor(async () => {
      const response = await fetch(`${server.url}/api/sessions/session-1`, {
        headers: {
          authorization: 'Bearer operator-secret',
        },
      })
      assert.equal(response.status, 200)
      const payload = (await response.json()) as {
        data?: {
          state: string
          logs: Array<{ message: string }>
          output: Array<{ text: string }>
        }
      }
      const session = payload.data
      assert.ok(session)
      assert.equal(
        session.logs.some((entry) => entry.message === 'Inspecting the workspace before changes.'),
        true,
      )
      assert.equal(
        session.output.some((entry) => entry.text.includes('codex> rg --files')),
        true,
      )
      return session.state === 'running' || session.state === 'completed'
    })

    await mobileController.connect({
      baseUrl: server.url,
      token: 'operator-secret',
    })
    mobileController.openSession('session-1')

    await waitFor(() => {
      const state = mobileController.getState()
      assert.equal(state.selectedSessionId, 'session-1')
      const session = state.dashboard.sessions.find((entry) => entry.id === 'session-1')
      assert.ok(session)
      assert.equal(
        session.logs.some((entry) => entry.message === 'Inspecting the workspace before changes.'),
        true,
      )
      assert.equal(
        session.output.some((entry) => entry.text.includes('codex> rg --files')),
        true,
      )
      return true
    })

    const mount = dom.window.document.getElementById('app')
    assert.ok(mount instanceof dom.window.HTMLElement)
    const webApp = renderWebClient(mount, {
      fetch,
      storage: dom.window.localStorage,
    })

    try {
      const form = await waitFor(() => {
        const candidate = mount.querySelector<HTMLFormElement>('form[data-role="connect-form"]')
        assert.ok(candidate)
        return candidate
      })
      const baseUrlInput = form.querySelector<HTMLInputElement>('input[name="baseUrl"]')
      const tokenInput = form.querySelector<HTMLInputElement>('input[name="token"]')
      assert.ok(baseUrlInput)
      assert.ok(tokenInput)

      baseUrlInput.value = server.url
      tokenInput.value = 'operator-secret'
      form.dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      )

      const reopenButton = await waitFor(() => {
        const candidate = mount.querySelector<HTMLButtonElement>('[data-action="resume-session"][data-session-id="session-1"]')
        assert.ok(candidate)
        return candidate
      })
      reopenButton.click()

      await waitFor(() => {
        assert.match(mount.textContent ?? '', /Recovered session/)
        assert.match(mount.textContent ?? '', /session-1/)
        assert.match(mount.textContent ?? '', /Inspecting the workspace before changes\./)
        assert.match(mount.textContent ?? '', /codex> rg --files/)
        return true
      })
    } finally {
      webApp.destroy()
    }
  } finally {
    mobileController.destroy()
    restoreGlobals()
    dom.window.close()
    await server.close()
    try {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      // Best-effort cleanup for temporary test state on platforms with delayed file handles.
    }
  }
})
