import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import { renderDesktopApp } from '../apps/desktop/src/app.js'
import { createFileConnectionSettingsStore } from '../apps/desktop/src/storage.js'
import type { DesktopBridge } from '../apps/desktop/src/types.js'
import { startControlPlaneServer } from '../apps/server/src/index.js'
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
  return await mkdtemp(join(tmpdir(), 'remote-agent-server-desktop-client-'))
}

async function createCommittedRepository(rootDir: string, repoName: string) {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test User'])
  await writeFile(join(repositoryPath, 'README.md'), `# ${repoName}\n`, 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'add', '.'])
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial state'])
  return repositoryPath
}

async function createPreviewServer() {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<h1>Desktop preview ${request.url ?? '/'}</h1>`)
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

async function waitFor<T>(
  predicate: () => T | Promise<T>,
  timeoutMs = 8000,
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
    : new Error('Timed out while waiting for the desktop smoke assertion.')
}

function installDomGlobals(window: JSDOM['window']) {
  const previous = {
    Element: globalThis.Element,
    Event: globalThis.Event,
    FormData: globalThis.FormData,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    MouseEvent: globalThis.MouseEvent,
    document: globalThis.document,
    window: globalThis.window,
  }

  Object.assign(globalThis, {
    Element: window.Element,
    Event: window.Event,
    FormData: window.FormData,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    MouseEvent: window.MouseEvent,
    document: window.document,
    window,
  })

  return () => {
    Object.assign(globalThis, previous)
  }
}

function clickElement(window: JSDOM['window'], element: Element) {
  element.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  )
}

function submitForm(window: JSDOM['window'], form: HTMLFormElement) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
}

function queryRequired<TElement extends Element>(
  container: ParentNode,
  selector: string,
) {
  const element = container.querySelector<TElement>(selector)
  assert.ok(element, `Expected selector ${selector} to exist.`)
  return element
}

test('desktop app smoke covers secure connection storage, remote and local workspace flows, session controls, approvals, and previews', async () => {
  const tempDir = await createTempDir()
  const remoteRepositoryPath = await createCommittedRepository(tempDir, 'remote-repo')
  const localRepositoryPath = await createCommittedRepository(tempDir, 'local-repo')
  const previewServer = await createPreviewServer()
  const connectionSettingsPath = join(tempDir, 'desktop-settings', 'connection.json')
  const openedPreviewUrls: string[] = []
  const fakeSafeStorage = {
    decryptString(value: Buffer) {
      return value.toString('utf8').split('').reverse().join('')
    },
    encryptString(value: string) {
      return Buffer.from(value.split('').reverse().join(''), 'utf8')
    },
    isEncryptionAvailable() {
      return true
    },
  }
  const bridge: DesktopBridge = {
    connectionSettings: createFileConnectionSettingsStore({
      filePath: connectionSettingsPath,
      safeStorage: fakeSafeStorage,
    }),
    preview: {
      async open(url) {
        openedPreviewUrls.push(url)
      },
    },
  }
  const server = await startControlPlaneServer({
    bootstrapTokens: ['bootstrap-secret'],
    dataFile: join(tempDir, 'state.json'),
    developmentMode: true,
    localRuntimeHost: {
      id: 'local-dev-host',
      name: 'local-devbox',
      platform: 'darwin',
    },
    operatorTokens: ['operator-secret'],
    port: 0,
    runtimeProviderAdapters: [
      createCodexProviderAdapter({
        approvals: [
          {
            action: 'sudo apt install ripgrep',
            afterStep: 2,
            message: 'Approval required for sudo apt install ripgrep.',
          },
        ],
        stepDelayMs: 90,
      }),
    ],
  })

  const hostResponse = await fetch(`${server.url}/api/hosts`, {
    body: JSON.stringify({
      id: 'host-1',
      name: 'remote-devbox',
      platform: 'linux',
      runtimeVersion: '0.1.0',
      status: 'online',
    }),
    headers: bootstrapHeaders('bootstrap-secret'),
    method: 'POST',
  })
  assert.equal(hostResponse.status, 201)

  const remoteWorkspaceResponse = await fetch(`${server.url}/api/workspaces`, {
    body: JSON.stringify({
      hostId: 'host-1',
      id: 'workspace-remote',
      path: remoteRepositoryPath,
      runtimeHostId: 'host-1',
    }),
    headers: operatorHeaders('operator-secret'),
    method: 'POST',
  })
  assert.equal(remoteWorkspaceResponse.status, 201)

  const localWorkspaceResponse = await fetch(`${server.url}/api/workspaces`, {
    body: JSON.stringify({
      hostId: 'local-dev-host',
      id: 'workspace-local',
      path: localRepositoryPath,
      runtimeHostId: 'local-dev-host',
    }),
    headers: operatorHeaders('operator-secret'),
    method: 'POST',
  })
  assert.equal(localWorkspaceResponse.status, 201)

  const previewResponse = await fetch(`${server.url}/api/ports`, {
    body: JSON.stringify({
      hostId: 'host-1',
      id: 'desktop-preview',
      label: 'Desktop web preview',
      port: previewServer.port,
      protocol: 'http',
      state: 'forwarded',
      targetHost: '127.0.0.1',
      visibility: 'shared',
      workspaceId: 'workspace-remote',
    }),
    headers: operatorHeaders('operator-secret'),
    method: 'POST',
  })
  assert.equal(previewResponse.status, 201)

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://desktop.example.test',
  })
  const restoreGlobals = installDomGlobals(dom.window)
  const container = queryRequired<HTMLElement>(dom.window.document, '#app')
  const app = renderDesktopApp(container, {
    bridge,
    fetch,
  })

  try {
    await waitFor(() => {
      assert.match(container.textContent ?? '', /Connect/)
      return true
    })

    const connectForm = queryRequired<HTMLFormElement>(container, '[data-role="connect-form"]')
    const baseUrlInput = queryRequired<HTMLInputElement>(connectForm, 'input[name="baseUrl"]')
    const tokenInput = queryRequired<HTMLInputElement>(connectForm, 'input[name="token"]')
    baseUrlInput.value = server.url
    tokenInput.value = 'operator-secret'
    submitForm(dom.window, connectForm)

    await waitFor(() => {
      const text = container.textContent ?? ''
      assert.match(text, /remote-devbox/)
      assert.match(text, /local-devbox/)
      assert.match(text, /workspace-remote/)
      return true
    })

    assert.equal(existsSync(connectionSettingsPath), true)
    const storedConnectionRaw = readFileSync(connectionSettingsPath, 'utf8')
    assert.doesNotMatch(storedConnectionRaw, /operator-secret/)

    const openPreviewButton = await waitFor(() =>
      queryRequired<HTMLButtonElement>(
        container,
        '[data-action="open-preview"][data-port-id="desktop-preview"]',
      ),
    )
    clickElement(dom.window, openPreviewButton)
    await waitFor(() => {
      assert.equal(openedPreviewUrls.length, 1)
      assert.match(openedPreviewUrls[0] ?? '', /\/ports\/desktop-preview$/)
      return true
    })

    submitForm(
      dom.window,
      queryRequired<HTMLFormElement>(container, '[data-role="start-session-form"]'),
    )

    const approveButton = await waitFor(() =>
      queryRequired<HTMLButtonElement>(
        container,
        '[data-action="approval-decision"][data-status="approved"]',
      ),
    )
    clickElement(dom.window, approveButton)

    await waitFor(() => {
      const text = container.textContent ?? ''
      assert.match(text, /completed/)
      assert.match(text, /Remote/)
      return true
    })

    const localScopeButton = queryRequired<HTMLButtonElement>(
      container,
      '[data-action="set-scope"][data-scope="local"]',
    )
    clickElement(dom.window, localScopeButton)

    await waitFor(() => {
      const text = container.textContent ?? ''
      assert.match(text, /workspace-local/)
      return true
    })

    submitForm(
      dom.window,
      queryRequired<HTMLFormElement>(container, '[data-role="start-session-form"]'),
    )

    const cancelButton = await waitFor(() =>
      queryRequired<HTMLButtonElement>(
        container,
        '[data-action="session-control"][data-session-action="cancel"]',
      ),
    )
    clickElement(dom.window, cancelButton)

    await waitFor(() => {
      const text = container.textContent ?? ''
      assert.match(text, /canceled/)
      assert.match(text, /Local/)
      return true
    })

    app.destroy()
    const rehydratedApp = renderDesktopApp(container, {
      bridge,
      fetch,
    })

    try {
      await waitFor(() => {
        const text = container.textContent ?? ''
        assert.match(text, /remote-devbox/)
        assert.match(text, /local-devbox/)
        return true
      })
    } finally {
      rehydratedApp.destroy()
    }
  } finally {
    restoreGlobals()
    dom.window.close()
    await previewServer.close()
    await server.close()
    await rm(tempDir, { force: true, recursive: true })
  }
})

test('desktop file connection settings store can save, load, and clear encrypted settings', async () => {
  const tempDir = await createTempDir()
  const filePath = join(tempDir, 'settings.json')
  const safeStorage = {
    decryptString(value: Buffer) {
      return value.toString('utf8').split('').reverse().join('')
    },
    encryptString(value: string) {
      return Buffer.from(value.split('').reverse().join(''), 'utf8')
    },
    isEncryptionAvailable() {
      return true
    },
  }
  const store = createFileConnectionSettingsStore({
    filePath,
    safeStorage,
  })

  try {
    await store.save({
      baseUrl: 'http://127.0.0.1:4318',
      token: 'desktop-secret-token',
    })

    const raw = readFileSync(filePath, 'utf8')
    assert.doesNotMatch(raw, /desktop-secret-token/)
    assert.deepEqual(await store.load(), {
      baseUrl: 'http://127.0.0.1:4318',
      token: 'desktop-secret-token',
    })

    await store.clear()
    assert.equal(await store.load(), null)
  } finally {
    await rm(tempDir, { force: true, recursive: true })
  }
})
