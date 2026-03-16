import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import { renderWebClient } from '../apps/web/src/app.js'
import { startControlPlaneServer } from '../apps/server/src/index.js'
import { createCodexProviderAdapter } from '../packages/runtime/src/index.js'

const execFileAsync = promisify(execFile)

async function createTempDir() {
  return await mkdtemp(join(tmpdir(), 'remote-agent-server-web-client-'))
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

async function createCommittedRepository(rootDir: string, repoName = 'repo') {
  const repositoryPath = join(rootDir, repoName)
  await mkdir(repositoryPath, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', repositoryPath])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test User'])

  await writeFile(join(repositoryPath, 'modified.txt'), 'base line\n', 'utf8')
  await writeFile(join(repositoryPath, 'old-name.txt'), 'rename me\n', 'utf8')
  await writeFile(join(repositoryPath, 'removed.txt'), 'remove me\n', 'utf8')

  await execFileAsync('git', ['-C', repositoryPath, 'add', '.'])
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial state'])
  return repositoryPath
}

async function createReviewChanges(repositoryPath: string) {
  await writeFile(join(repositoryPath, 'modified.txt'), `${'changed line\n'.repeat(8)}`, 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'mv', 'old-name.txt', 'renamed.txt'])
  await rm(join(repositoryPath, 'removed.txt'))
  await writeFile(join(repositoryPath, 'added.txt'), `${'new line\n'.repeat(20)}`, 'utf8')
  await execFileAsync('git', ['-C', repositoryPath, 'add', '-A'])
}

async function createPreviewServer() {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<h1>Preview ${request.url ?? '/'}</h1>`)
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

  throw new Error('Failed to reserve a detected development port for the web smoke test.')
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
          response.end('web-detected-preview:' + (request.url ?? '/'))
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
      rejectReady(new Error('Timed out while waiting for the detected web dev server to start.'))
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
      rejectReady(new Error(`Detected web dev server failed to start: ${chunk.toString('utf8').trim()}`))
    }

    function onExit(code: number | null) {
      cleanup()
      rejectReady(new Error(`Detected web dev server exited before startup with code ${code}.`))
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
    : new Error('Timed out while waiting for the web client smoke assertion.')
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

test('web client smoke covers sign-in, live events, diff review, approvals, previews, and detected ports', async () => {
  const tempDir = await createTempDir()
  const repositoryPath = await createCommittedRepository(tempDir)
  const previewServer = await createPreviewServer()
  const detectedPortNumber = await findAvailablePort([5173, 4173, 8787, 4321])
  const server = await startControlPlaneServer({
    port: 0,
    dataFile: join(tempDir, 'state.json'),
    operatorTokens: ['operator-secret'],
    bootstrapTokens: ['bootstrap-secret'],
    developmentMode: true,
    localRuntimeHost: {
      id: 'local-dev-host',
      name: 'local-devbox',
      platform: 'darwin',
    },
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
    ],
  })

  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'http://web-client.test/',
  })
  const restoreGlobals = installDomGlobals(dom.window)
  let detectedServer:
    | Awaited<ReturnType<typeof startWorkspaceDevelopmentServer>>
    | undefined

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
    detectedServer = await startWorkspaceDevelopmentServer(
      repositoryPath,
      detectedPortNumber,
    )

    const forwardedPortResponse = await fetch(`${server.url}/api/ports`, {
      method: 'POST',
      headers: operatorHeaders('operator-secret'),
      body: JSON.stringify({
        id: 'preview-shared',
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        label: 'Preview app',
        targetHost: '127.0.0.1',
        port: previewServer.port,
        protocol: 'http',
        visibility: 'shared',
        state: 'forwarded',
      }),
    })
    assert.equal(forwardedPortResponse.status, 201)

    const mount = dom.window.document.getElementById('app')
    assert.ok(mount instanceof dom.window.HTMLElement)

    const app = renderWebClient(mount, {
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

      await waitFor(() => {
        assert.match(mount.textContent ?? '', /devbox/)
        assert.match(mount.textContent ?? '', /local-devbox/)
        assert.match(mount.textContent ?? '', /Local • Attached runtime/)
        assert.match(mount.textContent ?? '', /Remote • Registered runtime/)
        assert.match(mount.textContent ?? '', /workspace-1/)
        assert.match(mount.textContent ?? '', /Preview app/)
        assert.match(
          mount.textContent ?? '',
          new RegExp(getExpectedDetectedLabel(detectedPortNumber)),
        )
        return true
      })

      const previewLink = mount.querySelector<HTMLAnchorElement>('a.preview-link')
      assert.ok(previewLink)
      assert.equal(previewLink.href, `${server.url}/ports/preview-shared`)

      const promoteButton = await waitFor(() => {
        const candidate = mount.querySelector<HTMLButtonElement>('[data-action="promote-port"]')
        assert.ok(candidate)
        return candidate
      })
      promoteButton.click()

      await waitFor(async () => {
        const portResponse = await fetch(
          `${server.url}/api/ports?workspaceId=workspace-1`,
          {
            headers: {
              authorization: 'Bearer operator-secret',
            },
          },
        )
        const payload = (await portResponse.json()) as {
          data?: Array<{ port: number; state: string }>
        }
        assert.equal(
          payload.data?.some(
            (entry) =>
              entry.port === detectedPortNumber && entry.state === 'forwarded',
          ),
          true,
        )
        const previewLinks = mount.querySelectorAll('a.preview-link')
        assert.equal(previewLinks.length >= 2, true)
        return true
      })

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

      await createReviewChanges(repositoryPath)

      await waitFor(() => {
        assert.match(mount.textContent ?? '', /session-1/)
        assert.match(mount.textContent ?? '', /approval\.requested/)
        assert.match(mount.textContent ?? '', /sudo apt install ripgrep/)
        return true
      })

      const reviewButton = await waitFor(() => {
        const candidate = mount.querySelector<HTMLButtonElement>('[data-action="review-session"]')
        assert.ok(candidate)
        return candidate
      })
      reviewButton.click()

      await waitFor(() => {
        assert.match(mount.textContent ?? '', /4 changed files/)
        const diffBlock = mount.querySelector('.diff-block')
        assert.ok(diffBlock)
        assert.match(diffBlock.textContent ?? '', /diff --git a\/added\.txt b\/added\.txt/)
        return true
      })

      const approveButton = await waitFor(() => {
        const candidate = mount.querySelector<HTMLButtonElement>('[data-action="approval-decision"][data-status="approved"]')
        assert.ok(candidate)
        return candidate
      })
      approveButton.click()

      await waitFor(async () => {
        const approvalResponse = await fetch(`${server.url}/api/approvals`, {
          headers: {
            authorization: 'Bearer operator-secret',
          },
        })
        const payload = (await approvalResponse.json()) as {
          data?: Array<{ id: string; status: string }>
        }
        assert.equal(
          payload.data?.some(
            (entry) => entry.id.startsWith('approval-') && entry.status === 'approved',
          ),
          true,
        )
        assert.match(mount.textContent ?? '', /approved/)
        return true
      })
    } finally {
      app.destroy()
    }
  } finally {
    restoreGlobals()
    dom.window.close()
    await detectedServer?.close()
    await server.close()
    await previewServer.close()
  }
})
