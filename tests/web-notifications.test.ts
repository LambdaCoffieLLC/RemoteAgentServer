import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import {
  renderWebClient,
  type BrowserNotificationApi,
} from '../apps/web/src/app.js'
import { startControlPlaneServer } from '../apps/server/src/index.js'
import {
  createClaudeCodeProviderAdapter,
  createCodexProviderAdapter,
  createOpenCodeProviderAdapter,
} from '../packages/runtime/src/index.js'

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
  return await mkdtemp(join(tmpdir(), 'remote-agent-server-web-notifications-'))
}

async function createCommittedRepository(rootDir: string, repoName = 'repo') {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test User'])
  await writeFile(join(repositoryPath, 'README.md'), '# web notifications smoke\n', 'utf8')
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
    : new Error('Timed out while waiting for the web notification assertion.')
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
    location: globalThis.location,
    history: globalThis.history,
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
    location: window.location,
    history: window.history,
  })

  return () => {
    Object.assign(globalThis, previous)
  }
}

interface NotificationStubRecord {
  onclick: ((event?: Event) => void) | null
  options: {
    body: string
    data?: {
      deepLink?: string
      sessionId?: string
    }
    tag?: string
  }
  title: string
}

function createNotificationApiStub() {
  let permission: NotificationPermission = 'default'
  const notifications: NotificationStubRecord[] = []

  const api: BrowserNotificationApi = {
    getPermission() {
      return permission
    },
    isSupported() {
      return true
    },
    async requestPermission() {
      permission = 'granted'
      return permission
    },
    show(title, options) {
      const notification: NotificationStubRecord = {
        onclick: null,
        options,
        title,
      }
      notifications.push(notification)
      return notification
    },
  }

  return {
    api,
    notifications,
  }
}

test('web client sends opt-in browser notifications with category muting and session deep links', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createCommittedRepository(tempDir)
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    runtimeProviderAdapters: [
      createCodexProviderAdapter({
        stepDelayMs: 20,
        approvals: [
          {
            action: 'sudo apt install ripgrep',
            message: 'Approval required for sudo apt install ripgrep.',
            afterStep: 2,
          },
        ],
      }),
      createClaudeCodeProviderAdapter({
        stepDelayMs: 20,
      }),
      createOpenCodeProviderAdapter({
        stepDelayMs: 20,
        failure: {
          afterSteps: 2,
          message: 'OpenCode verification failed.',
          phase: 'runtime',
        },
      }),
    ],
  })
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'http://web-client.test/',
  })
  const restoreGlobals = installDomGlobals(dom.window)
  const notificationStub = createNotificationApiStub()

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

    const mount = dom.window.document.getElementById('app')
    assert.ok(mount instanceof dom.window.HTMLElement)

    const app = renderWebClient(mount, {
      fetch,
      notifications: notificationStub.api,
      storage: dom.window.localStorage,
    })

    try {
      const form = await waitFor(() => {
        const candidate =
          mount.querySelector<HTMLFormElement>('form[data-role="connect-form"]')
        assert.ok(candidate)
        return candidate
      })
      const baseUrlInput =
        form.querySelector<HTMLInputElement>('input[name="baseUrl"]')
      const tokenInput =
        form.querySelector<HTMLInputElement>('input[name="token"]')
      assert.ok(baseUrlInput)
      assert.ok(tokenInput)

      baseUrlInput.value = server.url
      tokenInput.value = 'operator-secret'
      form.dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      )

      await waitFor(() => {
        assert.match(mount.textContent ?? '', /devbox/)
        assert.match(mount.textContent ?? '', /workspace-1/)
        return true
      })

      const enableNotificationsButton = await waitFor(() => {
        const candidate = mount.querySelector<HTMLButtonElement>(
          '[data-action="toggle-browser-notifications"]',
        )
        assert.ok(candidate)
        return candidate
      })
      enableNotificationsButton.click()

      await waitFor(() => {
        assert.match(mount.textContent ?? '', /Browser alerts are active/)
        return true
      })

      const completedCheckbox = mount.querySelector<HTMLInputElement>(
        'input[data-action="toggle-notification-category"][data-category="session-completed"]',
      )
      assert.ok(completedCheckbox)
      completedCheckbox.dispatchEvent(
        new dom.window.Event('change', { bubbles: true }),
      )

      await waitFor(() => {
        const settings = JSON.parse(
          dom.window.localStorage.getItem(
            'remote-agent-server-web-notifications-v1',
          ) ?? '{}',
        ) as {
          categories?: Record<string, boolean>
        }
        assert.equal(settings.categories?.['session-completed'], false)
        return true
      })

      const approvalSessionResponse = await fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'session-approval',
          workspaceId: 'workspace-1',
          provider: 'codex',
        }),
      })
      assert.equal(approvalSessionResponse.status, 201)

      const approvalNotification = await waitFor(() => {
        const candidate = notificationStub.notifications.find(
          (notification) =>
            notification.title === 'Approval required' &&
            notification.options.data?.sessionId === 'session-approval',
        )
        assert.ok(candidate)
        return candidate
      })
      assert.equal(
        approvalNotification.options.data?.deepLink,
        '#session=session-approval',
      )

      approvalNotification.onclick?.()
      await waitFor(() => {
        assert.equal(dom.window.location.hash, '#session=session-approval')
        assert.match(mount.textContent ?? '', /Context open/)
        return true
      })

      const approveButton = await waitFor(() => {
        const candidate = mount.querySelector<HTMLButtonElement>(
          '[data-action="approval-decision"][data-status="approved"]',
        )
        assert.ok(candidate)
        return candidate
      })
      approveButton.click()

      await waitFor(async () => {
        const sessionResponse = await fetch(
          `${server.url}/api/sessions/session-approval`,
          {
            headers: {
              authorization: 'Bearer operator-secret',
            },
          },
        )
        const payload = (await sessionResponse.json()) as {
          data?: {
            state?: string
          }
        }
        assert.equal(payload.data?.state, 'completed')
        return true
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(
        notificationStub.notifications.some(
          (notification) =>
            notification.title === 'Session completed' &&
            notification.options.data?.sessionId === 'session-approval',
        ),
        false,
      )

      const completedCheckboxEnabled = await waitFor(() => {
        const candidate = mount.querySelector<HTMLInputElement>(
          'input[data-action="toggle-notification-category"][data-category="session-completed"]',
        )
        assert.ok(candidate)
        return candidate
      })
      completedCheckboxEnabled.dispatchEvent(
        new dom.window.Event('change', { bubbles: true }),
      )

      await waitFor(() => {
        const settings = JSON.parse(
          dom.window.localStorage.getItem(
            'remote-agent-server-web-notifications-v1',
          ) ?? '{}',
        ) as {
          categories?: Record<string, boolean>
        }
        assert.equal(settings.categories?.['session-completed'], true)
        return true
      })

      const successSessionResponse = await fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'session-success',
          workspaceId: 'workspace-1',
          provider: 'claude-code',
        }),
      })
      assert.equal(successSessionResponse.status, 201)

      const completedNotification = await waitFor(() => {
        const candidate = notificationStub.notifications.find(
          (notification) =>
            notification.title === 'Session completed' &&
            notification.options.data?.sessionId === 'session-success',
        )
        assert.ok(candidate)
        return candidate
      })
      completedNotification.onclick?.()

      await waitFor(() => {
        assert.equal(dom.window.location.hash, '#session=session-success')
        const selectedButton = mount.querySelector<HTMLButtonElement>(
          '[data-action="resume-session"][data-session-id="session-success"]',
        )
        assert.ok(selectedButton)
        assert.match(selectedButton.textContent ?? '', /Context open/)
        return true
      })

      const failedSessionResponse = await fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: operatorHeaders('operator-secret'),
        body: JSON.stringify({
          id: 'session-failed',
          workspaceId: 'workspace-1',
          provider: 'opencode',
        }),
      })
      assert.equal(failedSessionResponse.status, 201)

      const failedNotification = await waitFor(() => {
        const candidate = notificationStub.notifications.find(
          (notification) =>
            notification.title === 'Session failed' &&
            notification.options.data?.sessionId === 'session-failed',
        )
        assert.ok(candidate)
        return candidate
      })
      assert.match(failedNotification.options.body, /OpenCode verification failed\./)

      assert.equal(notificationStub.notifications.length, 3)
    } finally {
      app.destroy()
    }
  } finally {
    restoreGlobals()
    dom.window.close()
    await server.close()
    await rm(tempDir, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 })
  }
})
